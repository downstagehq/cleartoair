// POST /api/early-access  { email }
//
// The landing page used to thank people and throw the address away. This is the
// endpoint that makes the promise true.
//
// There is no database. A signup is a single message that needs to reach a human
// once, so it is forwarded to whatever webhook the deployment is configured with
// (EA_WEBHOOK_URL) — a Discord channel, a Slack channel, a Zapier hook. If that is
// not set the endpoint says so honestly and the page shows the real state instead
// of a thank-you it cannot back up.
//
// Addresses are also written to the function log, which is the backup copy if a
// webhook delivery fails. That is the only place they are stored.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIMEOUT_MS = 6000;

// Discord and Slack each want their own key; anything else gets the whole record.
function payloadFor(url, record) {
  const line =
    `**Clear to Air — early access**\n` +
    `${record.email}\n` +
    `${record.at}${record.ref ? ` · from ${record.ref}` : ''}`;
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return { content: line };
  if (/hooks\.slack\.com/i.test(url)) return { text: line.replace(/\*\*/g, '*') };
  return record;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  const body = await readBody(req);

  // Honeypot: a real person never fills a field they cannot see. Answer 200 so a
  // bot learns nothing from the difference.
  if (String(body.company || '').trim()) return res.status(200).json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, error: 'That does not look like an email address.' });
  }

  const record = {
    email,
    at: new Date().toISOString(),
    ref: String(body.ref || '').slice(0, 120) || null,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };

  // The log is the backup copy — it survives a webhook that is down.
  console.log('early-access signup', JSON.stringify({ email: record.email, at: record.at, ref: record.ref }));

  const hook = process.env.EA_WEBHOOK_URL;
  if (!hook) {
    return res.status(503).json({
      ok: false,
      code: 'unconfigured',
      error: 'Sign-ups are not wired up yet. Nothing was stored.',
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(hook, record)),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  } catch (err) {
    // The address is in the log above, so this is recoverable. Say so plainly.
    console.error('early-access webhook failed', String(err && err.message ? err.message : err));
    return res.status(502).json({ ok: false, code: 'delivery', error: 'We could not record that just now. Please try again shortly.' });
  } finally {
    clearTimeout(timer);
  }

  return res.status(200).json({ ok: true });
}
