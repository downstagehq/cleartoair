// The cleartoair.com Worker. Static files are served from ./ (wrangler.toml [assets]);
// every request passes this script first (run_worker_first = true).
//
// - http:// and www.cleartoair.com -> https://cleartoair.com (301), so the canonical URL is the only URL.
// - POST /api/early-access: the "Get notified" form. Same contract as the Vercel
//   function in api/early-access.mjs: forwarded to EA_WEBHOOK_URL when that is set
//   (a Worker secret), otherwise an honest 503 and nothing is stored.

// Same set as _headers / the old vercel.json, applied here too because every request
// passes through the script.
const SECURITY_HEADERS = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['x-frame-options', 'SAMEORIGIN'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'],
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIMEOUT_MS = 6000;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

// Discord and Slack each want their own key; anything else gets the whole record.
function payloadFor(url, record) {
  const line = `**Clear to Air - early access**\n${record.email}\n${record.at}${record.ref ? ` · from ${record.ref}` : ''}`;
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return { content: line };
  if (/hooks\.slack\.com/i.test(url)) return { text: line.replace(/\*\*/g, '*') };
  return record;
}

async function earlyAccess(request, env) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Use POST.' }, { allow: 'POST' });
  let body = {};
  try { body = await request.json(); } catch { /* treated as empty */ }

  // Honeypot: a real person never fills a field they cannot see.
  if (String(body.company || '').trim()) return json(200, { ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return json(400, { ok: false, error: 'That does not look like an email address.' });

  const record = {
    email,
    at: new Date().toISOString(),
    ref: String(body.ref || '').slice(0, 120) || null,
    ua: String(request.headers.get('user-agent') || '').slice(0, 200),
  };
  // The log is the backup copy (wrangler tail / Workers logs).
  console.log('early-access signup', JSON.stringify({ email: record.email, at: record.at, ref: record.ref }));

  const hook = env.EA_WEBHOOK_URL;
  if (!hook) return json(503, { ok: false, code: 'unconfigured', error: 'Sign-ups are not wired up yet. Nothing was stored.' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payloadFor(hook, record)), signal: ctrl.signal });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  } catch (err) {
    console.error('early-access webhook failed', String(err && err.message ? err.message : err));
    return json(502, { ok: false, code: 'delivery', error: 'We could not record that just now. Please try again shortly.' });
  } finally {
    clearTimeout(timer);
  }
  return json(200, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // One URL: https on the apex. http and www both land there in a single hop.
    if (url.hostname === 'www.cleartoair.com' || url.protocol === 'http:') {
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (!local) {
        url.hostname = 'cleartoair.com';
        url.protocol = 'https:';
        return Response.redirect(url.toString(), 301);
      }
    }
    if (url.pathname === '/api/early-access') return earlyAccess(request, env);
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of SECURITY_HEADERS) if (!out.headers.has(k)) out.headers.set(k, v);
    return out;
  },
};
