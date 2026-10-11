# Remote seats — the hosted control room

*Built 7 October 2026.*

Someone who is not in the room can sit at the desk. A producer across the venue
can cut scenes and drive the graphics; a scorer at the other end of the hall can
keep the score; a client can watch. The broadcast PC stays shut.

## For the operator

**Once, ever:** deploy the relay — see `relay/README.md`. It is one
`npx wrangler deploy` on the Cloudflare free plan. Paste the address it prints
into **Setup → Remote seats**.

**Every show:**

1. Setup → Remote seats → switch it on. The lamp goes green when the rig has
   paired with the room.
2. Press **Producer**, **Scorer** or **Viewer**. The link is on your clipboard.
   Send it however you like.
3. A producer knocks; you see them in the seat list and press **Admit**. A
   scorer or viewer is already in.
4. The status bar shows how many are on, and says **N at the door** when someone
   is waiting.
5. **Close seat** removes one. **Clear every seat** (hold) removes all of them.
   Switching remote seats off drops the lot and the outbound connection with it.

A guest's browser shows **remote · producer** in the status bar, so nobody
confuses the hosted desk for the rig.

## The three seats

| | Producer | Scorer | Viewer |
|---|---|---|---|
| Watch the desk, thumbnails, log | yes | yes | yes |
| Score, maps, veto, draft, standings, set, stats | yes | yes | — |
| Cards, bug, ticker, lower third | yes | — | — |
| Arm a scene, TAKE, replay, mute talent | yes | — | — |
| Start/stop the stream or recording | only if you switch it on | — | — |
| Everything else | — | — | — |

"Everything else" is a long list on purpose: OBS scene collections, the
simulators, adapter installs, the updater, shutdown, switching the whole show to
another title, a raw obs-websocket call, and managing the other seats. None of
it is reachable through the tunnel, by anyone, ever. The rule is deny-by-default
(`agent/src/remote-policy.js`), so a route added to the agent later stays
unreachable until someone lists it on purpose.

## What never leaves the PC

`/api/state` carries `settings.obsPassword`, `settings.gsiToken`,
`settings.startggToken` and `settings.vdo.password`. That is why the local API
refuses cross-site callers at all (`agent/src/http.js`). Every one of them is
blanked before the state goes down the tunnel — in the REST answer, in the
`hello` frame and in every `state` push. The seat is told *which* fields were
held back (`__remote.redacted`), so the hosted UI can say "set on the rig"
rather than showing an empty box that looks editable.

No remote seat, of any role, can write `settings` or `live`.

## How it works

```
  browser ──https──► cleartoair-room (Cloudflare Worker + Durable Object)
                            │
                            │  ONE WebSocket, dialled OUT by the rig
                            ▼
                    agent/src/remote.js
                            │  policy check, then the agent's own handler
                            ▼
                    agent/src/http.js ──► OBS
```

Three things are worth knowing about the shape:

**The hosted control room is the same bundle.** Not a port, not a cut-down
build. The relay is a transparent proxy on the same origin, so `fetch('/api/state')`
and `new WebSocket('/ws')` work unchanged; the page finds out which of the two
places it is in by asking `/api/remote/me`, and narrows its own UI accordingly
(`web/src/remote.ts`). The only visual differences are the seat badge, the
controls a seat may not use, and slower, smaller thumbnails.

**There is one API, not two.** A tunnelled request is turned back into a Node
request/response pair and run through `createRequestHandler` — the same route
table the local control room hits. So a route can never behave one way locally
and another way remotely, and there is no second implementation to drift.

**A remote seat is a hub client like any other.** `hub.attach()` adds it to the
same client map as a local page, so every existing broadcast reaches it with no
new code. What differs is two functions it carries: `transform` (what it may
see — that is where redaction lives, in one place) and `guard` (what it may
send up).

## Running and testing it

```
node relay/test/serve.mjs      # the relay, locally, to try it by hand
node relay/test/e2e.mjs        # a real agent + the real relay + a fake browser
node agent/src/_selftest.js    # the policy rules on their own
node relay/test/shot.mjs       # screenshots into docs/shots/remote/
```

`relay/test/e2e.mjs` is the one that matters. It starts a real agent process on
a spare port with its own data dir, points it at the Node relay harness, joins
as each of the three roles, and checks the things that would actually hurt:
that the OBS password never leaves, that a scorer cannot cut program, that a
producer waits at the door, that a forged cookie is refused, that a cross-site
page cannot drive the desk with a borrowed one, and that a kick takes the socket
away, and that two seats on the desk at once each follow their own role. 60 checks.

The harness (`relay/test/harness.mjs`) runs the **real** `worker.js` and
`room.js` on Node stand-ins for `WebSocketPair`, Durable Object storage and the
asset binding. What it cannot test is Cloudflare's own behaviour: hibernation,
storage durability across a restart, and the real 1 MiB frame cap.

## Verified on 7 October 2026

- The 60 end-to-end checks above, against a real agent process, including two
  seats on the desk at the same time.
- 59 policy checks in `agent/src/_selftest.js`; the two suites are 615 checks.
- The hosted control room **rendered and screenshotted** as a producer and as a
  scorer, with a CS2 simulator feeding the desk — `docs/shots/remote/`. The
  state, the scene list, the series card and the live readouts all draw; the
  status bar reads `remote · producer`.
- The rig's own Remote panel, paired, with both seats listed.

## Not verified

- **Nothing has run on Cloudflare.** The relay has never been deployed. The
  Durable Object's hibernation and its storage surviving an eviction are
  Cloudflare behaviours the Node harness cannot stand in for.
- No real internet hop: every byte of every test crossed loopback, so nothing is
  known about latency or a flaky venue uplink.
- Thumbnails were never fetched through the tunnel with OBS running, so the
  480px JPEG budget is arithmetic, not a measurement.

## Still open

- The relay URL is blank in a shipped build until someone deploys a relay and
  pastes its address in. A default could be baked into `agent/src/remote.js` once there is a
  real address.
- A seat has no voice. Talent audio is still VDO.Ninja / CTA Studio
  (`agent/src/talent.js`); a remote producer is driving the desk silently.
- The seat list is not in the hosted room, by design — but a producer cannot
  currently see who else is on the desk with them.
- Hosted thumbnails are a poll, not a stream. If the uplink is tight this is the
  first thing to improve.
