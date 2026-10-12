# CTA Studio talent path: one-machine bench (11-12 Oct 2026)

The signaling in `agent/src/talent.js` had been tested before. Until this work,
nobody had checked that real audio and video make it from
`overlays/talent/join.html` (the talent) to `overlays/talent/view.html` (the OBS
browser source).

- **Round 1 (11 Oct)** benched that media path on one Windows 11 box and fixed what it found.
- **Round 2 (12 Oct)** took the talent off the rig: a caster on another network now comes in over the hosted room relay as a **talent seat**, bound to one slot. That path is benched too, through the real relay code running locally.

Both list what still needs two real devices.

## How it was run

`node tools/bench/talent-bench.mjs --port 7740` (local path) and
`node tools/bench/talent-bench.mjs --relay --port 7740` (over the relay). No new
dependencies; `ws` is loaded from `agent/node_modules`.

- Starts its own agent with a scratch `--data-dir`, so the real `agent/data` is never touched.
- Gives that agent a scratch `APPDATA` whose obs-websocket config names a dead port (4499), so its OBS bridge never reaches a real OBS on the PC.
- Starts headless Chrome 154 (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`), driven over CDP. One instance runs the talent pages, one runs the receivers. In `--relay` the receiver uses OBS's `--autoplay-policy=no-user-gesture-required`.
- `--relay` runs the real `relay/src/worker.js` and `room.js` on the Node harness (`relay/test/harness.mjs`, port 8790). It pairs the agent with it, mints a talent link for `caster1`, and opens that link in the talent Chrome on the relay origin. `http://127.0.0.1` is a secure context, so `getUserMedia` works as it would on HTTPS. OBS's side stays local on the rig.
- Injects a logger before the pages load. It wraps `RTCPeerConnection` and `WebSocket` and watches the `<video>`. The pages themselves are not changed, and the request guard is used as normal.
- "Flowing" means `connectionState === 'connected'` and the inbound-rtp **video and audio** `bytesReceived` both rise between two `getStats()` samples.

Raw output goes to `results.json` and `results-relay.json` in the scratch dir (`%TEMP%\claude\talent-bench\`).

## Round 2: a talent over the room relay (12 Oct, all PASS)

| # | Case | Result |
|---|---|---|
| R-A | Talent opens its link on the relay origin, presses CONNECT; OBS `view.html` is local | PASS. The page lands on `/overlays/talent/join.html` via the relay (secure context), shows `CONNECTED · LIVE CASTER1`, and signaling runs over the tunnelled `/talent/signaling`. Opus and VP8 arrive, connected, pair host/udp ↔ host/udp. First connection 5.6-7 s (the fresh-Chrome cost below). |
| R-B | The relay drops the talent's socket mid-call | PASS. **Media never stops** (about 340 kbps while the socket is down). The page shows RECONNECTING…, redials, gets CONFIG, and is back on caster1. The same call carries on; no renegotiation. |
| R-C | The relay drops the RIG's socket (rig reconnect) | PASS. Every hosted socket closes with 4004. The agent redials in about 1 s and the talent redials after it. Media kept flowing throughout, no renegotiation. |
| R-D | The agent process restarts mid-call | PASS. The talent seat's slot binding is in `remote.json`, so after the restart the agent repairs with the relay and the talent comes back to caster1. Media kept flowing throughout, no renegotiation. |
| R-E | OBS refreshes its source while the talent is on the relay | PASS. `RENEGOTIATE` goes up the tunnel to the phone and the fresh offer comes back. First frame 476 ms after the reload. |
| R-F | The desk closes the talent's seat | PASS. The page shows LINK CLOSED and never retries. OBS clears in **20 ms** (graceful offline; it was 11 s before the rig said so). The cookie is dead (401). |

And the local path re-run on the round-2 code (CONFIG-driven ICE, rebuilt messages): **all 13 cases A-J and I still PASS**.

Other checks:

- **`relay/test/e2e.mjs`** (real agent, real worker and room, a scripted browser): **111/111.** It covers:
  - a talent link refused for a bad slot, and through the generic invite;
  - a remote seat cannot mint a talent link;
  - the door lands a talent seat on the join page, and the link is single use;
  - the page can be reopened from a bookmark, but not fetched cross-site;
  - denials: `/api/state`, `/api/remote/me`, `/api/talent`, `/healthz`, packs, `view.html`, a POST to the desk, and the hub socket (`/ws`, closed 4003 with no hello);
  - a forged `?role=obs_receiver&slot=caster3` ends up as caster2's caster;
  - the offer reaches caster2 only, and the answer comes back;
  - the talent gets a minted TURN credential, never the secret; a producer sees the TURN url but a blank secret, and no desk socket ever carried it;
  - a producer cannot open talent signaling;
  - relay and rig socket drops, a second link replacing the first caster (`replaced`), expiry, revoke, kick (4003, cookie dead);
  - a streamed pack file arriving whole through the tunnel (bug below).
- **`agent/src/_selftest.js`**: ALL CHECKS PASSED. New since round 2:
  - talent policy: every denial above, with `allowChannel` for each seat kind;
  - CONFIG first on every socket;
  - fields a caster invents are dropped, and malformed offers are not relayed;
  - a tunnelled caster is bound to its slot, `attach` refuses a non-slot, and a 450-message flood is closed with 4008;
  - TURN: static credentials pass through; ephemeral ones are `expiry:seat` + HMAC-SHA1; the secret is never in the list; only `turn:`/`turns:` urls are accepted;
  - redaction of `settings.talent.turn.*`.
- **QR codes** (`node tools/bench/qr-check.mjs`): 8/8 decode byte-for-byte with OpenCV's `QRCodeDetector`. That covers versions 1-10, an invite-length link and UTF-8. The QR on the rig's own panel, decoded from a screenshot, gives exactly the minted link.

### Bug found and fixed on the way: tunnelled files came down empty

`agent/src/remote.js handleRequest` called `res.end()` as soon as the handler
returned. A file the agent serves (`serveFile`: an async `fs.stat`, then a
stream pipe) finishes after that. So every static file through the tunnel
arrived as zero bytes: the talent page, and also the team logos and player
photos the hosted control room draws. It now waits for the response to finish,
and cuts off only a handler that never answers (15 s). There is an e2e check for
it.

## Round 1: before and after the fixes (11 Oct)

"Before" is the code as of commit 304852a. "After" is 0.3.2.

| # | Case | Before | After |
|---|---|---|---|
| A | OBS side waiting, talent presses CONNECT | PASS. Opus and VP8, 0 packets lost, RTT 1 ms, pair host/udp ↔ host/udp. | PASS (unchanged) |
| A | Time to first frame | First connection in a fresh Chrome process 4-6 s; later ones ~0.35-0.5 s | Same. See "Still open". |
| A2 | Normal desktop Chrome, no click | **Silent and paused**, with no hint why (`play()` gives `NotAllowedError`). | PASS. A "Click to start audio" overlay appears only because `play()` was refused; one click plays it. |
| B | Receiver reloads mid-call (OBS refresh or restart) | **FAIL.** Black until the talent reconnects (`InvalidStateError ... Called in wrong state: stable`). | PASS. The hub asks the caster for a fresh offer. First frame 389 ms after the reload. |
| C | Talent DISCONNECT, then CONNECT | PASS, but leaked a receiver peer connection per cycle | PASS. Only 1 peer connection open. |
| C2 | Talent reloads join.html, then CONNECT | PASS | PASS. The receiver clears in under 200 ms (`bye` on `pagehide`). |
| D | Talent live first, OBS source opened 3 s later | PASS | PASS |
| E | Two receivers on one slot | **FAIL.** The second never connects. | PASS (newest wins; the old one says so and stays down). |
| F | Second talent on another slot | PASS | PASS |
| G | Second talent opens an occupied slot | Newcomer wins | PASS. The first talent shows OPENED ELSEWHERE and doesn't retry. |
| H | Agent restarts mid-call | **FAIL.** Media stops; the talent stays OFFLINE. | PASS. **Media never stops**; RECONNECTING… then LIVE, no renegotiation. |
| H2 | Receiver reload after H | Needed the talent to press CONNECT | PASS |
| J | Talent re-picks camera/mic mid-call | the old code stopped the live tracks | PASS (`replaceTrack`) |
| I | `--autoplay-policy=no-user-gesture-required` (as OBS) | PASS | PASS. The click overlay stays hidden. |

## What this proves, and what it doesn't

**It proves:** a caster on the relay origin gets a working A/V `MediaStream` into
a local OBS-style receiver. The relay carries only signaling. The call survives
the relay dropping either end, the agent restarting, OBS refreshing, the talent
rejoining and switching devices. A talent seat cannot reach anything but its
page and its own slot. TURN credentials reach the talent and never a desk seat.

**It doesn't prove:**

- **Cloudflare.** The relay code with talent seats has **not been deployed** (by instruction). Durable Object hibernation, storage across an eviction, and the real WebSocket close codes are harness stand-ins.
- **NAT traversal.** On one box host↔host always wins. srflx candidates were gathered but not needed.
- **TURN.** None is deployed. Only the credential minting and its plumbing are tested, never a relayed call.
- **Venue Wi-Fi.** Client isolation and blocked UDP were not tested.
- **Real devices.** Fake camera and mic; no iOS Safari or Android Chrome as the talent; no screen lock or backgrounding; no wake lock (`navigator.wakeLock` is best effort and untested here).
- **OBS's own capture.** No real OBS CEF: mixer meter, recorded track, A/V sync.
- **Echo and latency.** Glass-to-glass delay and lip sync weren't measured.

## STUN and TURN, plainly

**ICE now comes from one place, the agent.** The talent hub's first message on
every signaling socket is `{type:'CONFIG', slot, role, iceServers}`, for the
caster's page and OBS's `view.html` alike. The pages only keep Google STUN as a
fallback until it arrives. The default is `stun:stun.l.google.com:19302`, and
**no TURN is deployed.** Across networks, without TURN:

- A call works only if UDP hole punching succeeds (usually when at least one side has a friendly NAT).
- It fails with no fallback in three cases:
  - a mobile carrier with symmetric NAT or CGNAT against a strict NAT on the other side;
  - a venue that blocks outbound UDP;
  - Google's STUN being unreachable.
- ICE then goes `checking` → `failed` after about 30 s. `view.html` asks the talent for a fresh offer, but without TURN a retry over the same networks will usually fail again.

**What a TURN server needs:** a TURN server with a public address and TLS on 443.

- Run **coturn** on a small VPS with `use-auth-secret`, a `static-auth-secret`, a `realm`, a certificate, and `listening-port=3478` + `tls-listening-port=443`.
- Then in Setup → Remote seats → TURN, set the url (`turns:turn.example.com:443?transport=tcp, turn:turn.example.com:3478`) and the **shared secret**. The rig then mints a 12-hour credential per signaling socket (`expiry:seat`, HMAC-SHA1). The secret never leaves the PC and is redacted from every remote seat.
- A hosted TURN service with its own credential API (Cloudflare Calls TURN, Twilio, Metered) works through the static username/credential fields. Those credentials would have to be refreshed by hand: nothing mints them for that provider.
- Budget: TURN relays the whole stream, about 1.5-3 Mbit/s per caster at 720p, but only when the direct path fails.

## The round-1 blocker, and where it stands

Round 1 found that a talent on another device could not reach the join page:

- the agent is loopback-only, with a Host guard;
- `getUserMedia` needs HTTPS;
- the relay did not carry the talent path;
- signaling had no auth.

Round 2 closes this **over the relay**, keeping its security model:

- deny-by-default policy on the PC, and the room decides nothing;
- slot-bound, single-use, 15-minute links with a per-seat cookie, which is the token;
- HTTPS from the relay origin.

The agent stays loopback-only. The hosted relay (room.cleartoair.com) carries it since the 12 October redeploy.

## Still open

- **Relay deploy.** `room.cleartoair.com` runs the old relay code: no `/overlays/talent/` tunnel, no `/talent/signaling`, no `talent` role. The agent and UI work against the new relay only.
- **First connection in a fresh browser process takes 2-7 s.** That time is a synchronous `new RTCPeerConnection()`, possibly specific to this machine. A cheap mitigation (not done): `new RTCPeerConnection().close()` at page load in both pages.
- **Newest receiver wins, and the trade-off is real.** An operator previewing `view.html` in a browser tab takes the slot from OBS until OBS refreshes. The full fix is one caster peer connection per receiver.
- **A talent link opened in two browsers.** The cookie is per browser: the second open of a single-use link is refused at the door. But a caster who forwards their *seat* (shares the cookie) could open a second caster socket, and the newest wins. Closing the seat ends both.
- **No return feed (IFB)** to the caster, and no talkback.
- **Phones:** screen lock, backgrounding, iOS device labels, wake lock - untested.

## Files (round 2)

- `relay/src/protocol.js`: `talent` role, `CHANNEL_PATHS`, `TALENT_PAGE`, 15-minute talent invite TTL, `isTalentSlot`.
- `relay/src/room.js`: `join` frames carry the invite code back to the rig; `open` frames carry which socket was asked for; the rig's close code/reason passes through (the page needs `replaced`).
- `relay/src/worker.js`: tunnels `/overlays/talent/` and `/talent/signaling`; a talent seat lands on its page after the door; the bookmark exception for that page only; role-neutral door wording.
- `relay/test/harness.mjs`: the talent socket path; close codes and reasons carried through; `dropAgent`/`dropClients` test hooks.
- `relay/test/e2e.mjs`: the talent cases (111 checks).
- `agent/src/remote-policy.js`: `allowTalent`, `allowChannel`; TURN fields added to `SECRET_PATHS`.
- `agent/src/remote.js`:
  - `talentInvite`; the persisted `code → slot` and `seat → slot` bindings; unbound talent seats are kicked;
  - talent channels go to `talent.attach`;
  - frames are checked against their channel's seat;
  - talent page headers;
  - graceful offline on a kick;
  - the empty-file fix.
- `agent/src/talent.js`:
  - transport split from slot logic, and `attach()` for tunnelled casters;
  - CONFIG with `iceServers()`: STUN, plus TURN static or ephemeral;
  - messages rebuilt from known fields, with size and rate caps.
- `agent/src/http.js`: `POST /api/remote/talent-invite` (local only).
- `agent/src/_selftest.js`: the talent and remote sections.
- `overlays/talent/join.html`:
  - waits for CONFIG before offering, and shows the bound slot;
  - stops on 4003/4008 (LINK CLOSED) and on `replaced`;
  - amber RECONNECTING / red LINK CLOSED;
  - phone layout, headphones hint, screen wake lock;
  - device names re-listed after permission.
- `overlays/talent/view.html`: ICE from CONFIG.
- `web/src/components/TalentLinks.tsx` (in the Remote seats panel):
  - slot picker labelled with talent names;
  - link, copy, revoke, and the QR code (shown for the newest link);
  - optional TURN settings.
- `web/src/components/qr.ts`: a dependency-free QR encoder written for this (byte mode, level M, versions 1-10). It is not vendored, so there is nothing under licences/.
- `web/src/components/RemoteSeats.tsx`: talent links get their own section; talent seats are listed with their slot.
- `tools/bench/talent-bench.mjs`: `--relay` cases R-A to R-F.
- `tools/bench/qr-check.mjs`: decodes the encoder's output with OpenCV.
- `tools/bench/quickstart-pdf.mjs`: renders the card.
- `docs/talent-quickstart.html` and `.pdf`: the one-page picture card for the caster. Open the link, allow camera + mic, headphones, CONNECT, what each light means, battery and screen tips.
- `docs/REMOTE.md`: the talent seats section.

## Two-device checklist

**Setup:** the **laptop** is the rig (agent + OBS) on home or venue Wi-Fi. The
**phone** is the talent on **mobile data, Wi-Fi off**.

**To test a relay change before deploying it**, use the relay harness locally with a
throwaway HTTPS tunnel in front of it. The tunnel exposes only the **relay**: a
dumb pipe that needs a seat cookie for everything. The agent stays
loopback-only and dials out to it, exactly as it does to `room.cleartoair.com`.

1. Stop the normal Clear to Air agent. `npm run build` once, because the harness serves `web/dist`.
2. `npm run relay:dev` (the real worker and room on `http://127.0.0.1:8788`).
3. `cloudflared tunnel --url http://127.0.0.1:8788`. Note the `https://<name>.trycloudflare.com` address.
4. Start a test agent with its own data dir: `node agent/src/index.js --data-dir $env:TEMP\cta-talent-test`. Then in Setup → Remote seats, paste the `https://<name>.trycloudflare.com` address and switch it on. Wait for the green lamp.
5. Setup → Remote seats → Talent camera links → `caster1` → **Make talent link**. Its QR code is on screen.
6. On the laptop, start a receiver and a stats view. Use **either**:
   - desktop Chrome: `chrome://webrtc-internals` first, then `http://127.0.0.1:7700/overlays/talent/view.html?slot=caster1` (click "Click to start audio"); **or**
   - `node tools/bench/talent-bench.mjs --no-agent --watch caster1`, which prints the pair, RTT, kbps, size/fps, loss and audio level every 2 s.
7. On the phone, scan the QR code. Type a name, then on the page allow camera and mic, put headphones on, and press **CONNECT TO OBS**. The badge should say `CONNECTED · LIVE CASTER1`. Keep the screen on; `docs/talent-quickstart.pdf` is the card to hand a caster.
8. What to look for (webrtc-internals → Stats):
   - `connectionState: connected`, and the time from tap to picture.
   - The selected `candidate-pair`'s local and remote `candidateType`. Expect `srflx` on at least one side. **`checking` → `failed` after about 30 s = needs TURN.** Write down both types and the carrier.
   - `inbound-rtp` video: bytes rising, `frameWidth`/`framesPerSecond` (720p after about 30 s?), `packetsLost`, `jitter`.
   - `inbound-rtp` audio: `audioLevel` moving; jitter buffer ms.
   - `currentRoundTripTime`.
9. Latency and sync: point the phone at a millisecond clock on the laptop screen, compare it with its image in the received video, then clap on camera.
10. In OBS: Browser source `http://127.0.0.1:7700/overlays/talent/view.html?slot=caster1`, 1280x720, **Control audio via OBS**. It takes the slot from the Chrome tab. Expect picture plus a moving meter with no click overlay. Record 30 s and check A/V sync.
11. Recovery, expected to need nothing from the caster:
    - OBS → Refresh (back in about 0.5 s);
    - restart the test agent (the phone shows RECONNECTING… then LIVE, and the picture keeps going);
    - Ctrl+C and restart `relay:dev` + cloudflared. The harness keeps seats in memory, so this one **does** need a fresh link; the real relay keeps them.
    - Then: lock the phone for 10 s, toggle airplane mode, switch the phone's camera. Note what happens.
12. Close the seat in Setup: the phone shows LINK CLOSED and OBS clears.
13. Teardown: Ctrl+C cloudflared and `relay:dev`, stop the test agent, start the normal one.

**On the hosted relay**, skip steps 2-4: the normal agent's Remote seats on `room.cleartoair.com` makes the same link.

Record for each run: carrier and network, candidate pair types, RTT, time to first picture, the resolution reached, packet loss, glass-to-glass delay, and whether OBS played audio with no click.
