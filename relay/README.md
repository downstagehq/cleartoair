# cleartoair-room — the hosted control room

The control room is a web page served by the agent on the broadcast PC. This
Worker lets that same page open on someone else's laptop, with every call
tunnelled back into the rig over a connection the rig itself dialled out.

```
  producer's browser ──https──► cleartoair-room (Cloudflare)
                                      │  one WebSocket, dialled OUT by the rig
                                      ▼
                                 the agent ──► OBS
```

Nothing is opened on the broadcast PC. No port forwarding, no inbound firewall
rule, no static IP. It works on venue wifi and on a phone hotspot.

## What is in here

| File | What it is |
|---|---|
| `src/worker.js` | The front door: static assets, the invite door, and the proxy |
| `src/room.js` | The Durable Object — one per rig. Seats, invite codes, frames |
| `src/protocol.js` | The frame and code format, shared with the agent and the tests |
| `public/` | The built control room, staged by `tools/relay-assets.mjs` (gitignored) |
| `test/harness.mjs` | Node stand-ins for Cloudflare, so all of the above runs locally |
| `test/e2e.mjs` | A real agent + the real relay + a pretend browser |
| `test/serve.mjs` | Run the relay on this PC to try it without deploying |
| `test/shot.mjs` | Screenshot the hosted room and the rig's Remote panel |

The relay has **no dependencies**. `test/harness.mjs` borrows `ws` from
`agent/node_modules`.

## Try it without deploying

```
npm run build                 # the control room
node tools/relay-assets.mjs   # stage it into relay/public
node relay/test/serve.mjs     # the relay, on http://127.0.0.1:8788
```

Then on the rig: **Setup → Remote seats**, paste `http://127.0.0.1:8788`, switch
remote seats on, and press **Producer**. The invite link is on your clipboard.
Open it in another browser profile — or on your phone, with `127.0.0.1` swapped
for this PC's LAN address.

The local relay keeps its rooms in memory, so a restart forgets every seat. The
real one on Cloudflare does not.

## Deploy it

Needs a Cloudflare account. Everything used here is on the **free** plan:
static asset requests are free and unmetered, and a Durable Object hibernates
while a rig simply sits connected, so a quiet weekend costs nothing.

```
npm run build
node tools/relay-assets.mjs
cd relay
npx wrangler deploy
```

Wrangler prints the address — `https://cleartoair-room.<account>.workers.dev`.
Paste it into **Setup → Remote seats** on the rig. That writes it to
`agent/data/remote.json`; it is deliberately not a setting in the desk's state,
because whoever names the relay names where a show's control traffic goes.

A custom host later (`room.cleartoair.app`) is a `[[routes]]` entry here plus
the DNS record; the agent only ever needs the new address pasted in once.

## How a seat happens

1. The operator presses **Producer**, **Scorer** or **Viewer** on the rig. The
   agent makes a code (`K7P2-M9QX`), tells the room about it, and hands back a
   link: `https://<relay>/j/<room>/<code>`.
2. The guest opens it, types their name, and gets a seat cookie. One seat per
   link, good for an hour; the seat itself lasts a show day.
3. A **producer** lands on a waiting page until the operator admits them (that
   hold can be switched off). A scorer or viewer walks straight in.
4. The operator sees every seat, and can close one or all of them at any time.

## What the relay is not trusted with

It is someone else's computer, and the design says so:

- It stamps each request with the seat it came from, and **forwards**. Every
  allow and deny is decided on the broadcast PC, in
  `agent/src/remote-policy.js`.
- **No secret ever reaches it.** The OBS password, the GSI token, the start.gg
  token and the VDO.Ninja password are stripped out of `/api/state` and out of
  every `hello` and `state` frame before they leave the agent.
- It stores a hash of the room key, the live invite codes and the seat list.
  Nothing from a request or a response is kept.

A room id is 128 bits, generated on the broadcast PC; the first agent to
present one claims it, and its key hash is remembered. After that, only that
key gets in. Same trust model as a conference-room link: knowing the id is the
credential, and only the rig that invented it knows it.

## The two doors on an API call

Both are checked in `src/worker.js`, and they are the same two the agent uses
locally:

- The seat cookie is `HttpOnly; Secure; SameSite=Lax`. Lax rather than Strict
  because the invite link gets clicked out of WhatsApp or a DM, and a Strict
  cookie is not sent on that first navigation — the producer would land logged
  out.
- `Sec-Fetch-Site` must be `same-origin` on `/api/**`, `/packs/**` and `/ws`.
  That is what stops a third-party page — or somebody's widget inside an OBS
  browser source — from driving the desk with a borrowed cookie.

## Limits worth knowing

- One JSON text frame per request, under Cloudflare's 1 MiB cap: request bodies
  are capped at 256 KB and responses at 640 KB. Nothing the control room asks
  for is near that, except a screenshot.
- Program and preview thumbnails are forced to **480px JPEG** on the way out and
  the hosted room polls them every 8 s instead of 4. A 640px PNG of a busy game
  scene is most of a megabyte, twice every four seconds, which no venue uplink
  carries.
- 12 seats and 24 live invites per room.
- `/api/stats/ocr` with an image was already refused; a remote seat cannot send
  one at all.
