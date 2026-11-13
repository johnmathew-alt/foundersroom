/**
 * Founders Room API — Cloudflare Pages Function (same origin as the page).
 *
 *   POST /api/apply   -> records the application as a Lead in Zoho CRM (India DC)
 *   GET  /api/health  -> { connected: true|false } to confirm the Zoho connection
 *
 * Settings > Variables and Secrets (Production):
 *   ZOHO_CLIENT_ID      secret
 *   ZOHO_CLIENT_SECRET  secret
 *   ZOHO_GRANT_CODE     secret, one-time code from Zoho Self Client (exchanged on first use)
 *   ZOHO_REFRESH_TOKEN  optional secret; if set, used instead of the grant code
 * Bindings:
 *   FR_KV               KV namespace (stores the refresh token after the grant code is exchanged)
 *
 * Zoho CRM free edition has no room for custom fields, so the application is stored in
 * standard fields + Description + tags.
 */

const ACCOUNTS_URL = 'https://accounts.zoho.in';
const API_URL = 'https://www.zohoapis.in';
const LEAD_SOURCE = 'Founders Room';
const MARKER = 'Founders Room application FR-';

const CATEGORY_TAGS = {
  'Founder': 'FR Founder',
  'Operator': 'FR Operator',
  'Ecosystem Enabler': 'FR Ecosystem Enabler',
  'Community Builder': 'FR Community Builder',
  'Advisor': 'FR Advisor',
  'Partner': 'FR Partner',
  'Other': 'FR Other'
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/* ---------------- Zoho OAuth ---------------- */
let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

async function oauth(params) {
  const res = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body: new URLSearchParams(params) });
  return res.json();
}

async function getRefreshToken(env) {
  if (env.ZOHO_REFRESH_TOKEN) return env.ZOHO_REFRESH_TOKEN;
  const stored = env.FR_KV ? await env.FR_KV.get('zoho_refresh_token') : null;
  if (stored) return stored;
  if (!env.ZOHO_GRANT_CODE) throw new Error('No Zoho credentials configured');
  if (!env.FR_KV) throw new Error('FR_KV binding missing');

  const body = await oauth({
    grant_type: 'authorization_code',
    code: env.ZOHO_GRANT_CODE,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET
  });
  if (!body.refresh_token) throw new Error('Grant code exchange failed: ' + (body.error || 'no refresh_token'));
  await env.FR_KV.put('zoho_refresh_token', body.refresh_token);
  if (body.access_token) {
    cachedAccessToken = body.access_token;
    accessTokenExpiresAt = Date.now() + (body.expires_in || 3600) * 1000;
  }
  return body.refresh_token;
}

async function getAccessToken(env) {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60000) return cachedAccessToken;
  const refreshToken = await getRefreshToken(env);
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60000) return cachedAccessToken;
  const body = await oauth({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET
  });
  if (!body.access_token) throw new Error('Token refresh failed: ' + (body.error || 'no access_token'));
  cachedAccessToken = body.access_token;
  accessTokenExpiresAt = Date.now() + (body.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function crm(env, path, options = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(`${API_URL}/crm/v6${path}`, {
    ...options,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok && res.status !== 204) throw new Error(`CRM ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null; // 204 = no search results
}

/* ---------------- Validation ---------------- */
function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function normaliseLinkedIn(input) {
  const t = clean(input, 300);
  if (!t) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
    const host = url.hostname.toLowerCase();
    if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return null;
    if (url.pathname.replace(/\//g, '').length < 2) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch (e) {
    return null;
  }
}

function validate(b) {
  const d = {
    fullName: clean(b.fullName, 120),
    email: clean(b.email, 254).toLowerCase(),
    linkedinUrl: normaliseLinkedIn(b.linkedinUrl),
    currentRole: clean(b.currentRole, 120),
    company: clean(b.company, 160),
    memberCategory: clean(b.memberCategory, 60),
    gain: clean(b.gain, 1000),
    contribution: clean(b.contribution, 1000)
  };
  const e = {};
  if (d.fullName.length < 2) e.fullName = 'Please enter your full name.';
  if (!EMAIL_RE.test(d.email)) e.email = 'Please enter a valid email address.';
  if (!d.linkedinUrl) e.linkedinUrl = 'Please enter a valid LinkedIn profile URL.';
  if (!d.currentRole) e.currentRole = 'Please tell us your current role.';
  if (!d.company) e.company = 'Please enter a company or project name, or choose “Use N/A”.';
  if (!CATEGORY_TAGS[d.memberCategory]) e.memberCategory = 'Please choose one of the listed categories.';
  if (d.gain.length < 10) e.gain = 'Please add a little more detail — a sentence or two is plenty.';
  return { data: d, errors: e };
}

/* ---------------- Helpers ---------------- */
function splitName(full) {
  const parts = full.split(/\s+/);
  const last = parts.pop();
  const out = { Last_Name: last };
  if (parts.length) out.First_Name = parts.join(' ');
  return out;
}

function newReference() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return 'FR-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function istNow() {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
}

function applicationText(d, reference) {
  return [
    `Founders Room application ${reference}`,
    `Applied: ${istNow()}`,
    `Category: ${d.memberCategory}`,
    `Role: ${d.currentRole}`,
    `Company/project: ${d.company}`,
    `LinkedIn: ${d.linkedinUrl}`,
    '',
    'What they want to gain:',
    d.gain,
    '',
    'How they could contribute:',
    d.contribution || '(not answered)'
  ].join('\n');
}

/* ---------------- Routes ---------------- */
async function handleApply(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(422, { success: false, message: 'Invalid request.' });
  }

  const { data, errors } = validate(body || {});
  if (Object.keys(errors).length) {
    return json(422, { success: false, message: 'Please check the highlighted fields.', errors });
  }

  const found = await crm(env, `/Leads/search?email=${encodeURIComponent(data.email)}&fields=id,Description,LinkedIn_URL`);
  const existing = found && found.data && found.data[0];

  if (existing && String(existing.Description || '').includes(MARKER)) {
    return json(409, {
      success: false,
      message: 'We already have a Founders Room request from this email. We’ll be in touch by email.'
    });
  }

  const reference = newReference();
  const text = applicationText(data, reference);
  let leadId;

  if (existing) {
    // Already in CRM (e.g. an outbound lead): append the application, keep their sales data.
    const update = {
      id: existing.id,
      Description: existing.Description ? `${existing.Description}\n\n---\n${text}` : text
    };
    if (!existing.LinkedIn_URL) update.LinkedIn_URL = data.linkedinUrl;
    await crm(env, '/Leads', { method: 'PUT', body: JSON.stringify({ data: [update] }) });
    leadId = existing.id;
  } else {
    const record = {
      ...splitName(data.fullName),
      Email: data.email,
      Company: data.company,
      Designation: data.currentRole,
      LinkedIn_URL: data.linkedinUrl,
      Lead_Source: LEAD_SOURCE,
      Lead_Status: 'Not Contacted',
      Track: 'Inbound - Webform',
      Description: text
    };
    const created = await crm(env, '/Leads', { method: 'POST', body: JSON.stringify({ data: [record] }) });
    const result = created && created.data && created.data[0];
    if (!result || result.status !== 'success') throw new Error('Lead not created: ' + JSON.stringify(created).slice(0, 300));
    leadId = result.details && result.details.id;
  }

  // Tags make the applications easy to filter; a tagging failure must not fail the application.
  if (leadId) {
    try {
      await crm(env, '/Leads/actions/add_tags', {
        method: 'POST',
        body: JSON.stringify({
          tags: [{ name: 'Founders Room' }, { name: CATEGORY_TAGS[data.memberCategory] }],
          ids: [leadId]
        })
      });
    } catch (e) {
      console.error('[founders-room] tagging failed', e.message);
    }
  }

  return json(200, { success: true, applicationReference: reference });
}

async function handleHealth(env) {
  try {
    await crm(env, '/Leads?fields=id&per_page=1');
    return json(200, { connected: true });
  } catch (e) {
    return json(200, { connected: false, reason: String(e.message).slice(0, 200) });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/apply' && request.method === 'POST') return await handleApply(request, env);
    if (path === '/api/health' && request.method === 'GET') return await handleHealth(env);
    return json(404, { success: false });
  } catch (err) {
    console.error('[founders-room]', err && err.message);
    return json(500, { success: false });
  }
}
