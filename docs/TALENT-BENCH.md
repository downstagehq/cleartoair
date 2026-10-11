# CTA Studio talent path: one-machine bench (11 Oct 2026)

The signaling in `agent/src/talent.js` had been tested before. Until this run, nobody
had checked that real audio and video make it from `overlays/talent/join.html`
(the talent) to `overlays/talent/view.html` (the OBS browser source). This bench
tests that media path on one Windows 11 box, fixes what it found, and lists what
still needs two real devices.

## What was run

`node tools/bench/talent-bench.mjs --port 7740` (no new dependencies; `ws` is loaded from `agent/node_modules`):

- Starts its own agent with a scratch `--data-dir`, so the real `agent/data` is never touched.
- Gives that agent a scratch `APPDATA` whose obs-websocket config names a dead port (4499), so its OBS bridge never reaches a real OBS on the PC.
- Starts headless Chrome 154 (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`). One instance runs the talent pages and one runs the receivers, all driven over CDP. A third Chrome uses OBS's autoplay switch (test I).
- Injects a logger before the pages load. It wraps `RTCPeerConnection` and `WebSocket` and watches the `<video>`. The pages themselves are not changed by the bench, and the request guard (Host, Origin, Sec-Fetch-Site) is used as normal: everything is same-origin on `127.0.0.1`.
- "Flowing" means `connectionState === 'connected'` and the inbound-rtp **video and audio** `bytesReceived` both rise between two `getStats()` samples.

Raw output is in `results.json` in the scratch dir (`%TEMP%\claude\talent-bench\`).

## Results: before and after the fixes

"Before" is the code as of commit 304852a. "After" is the fixed code below.

| # | Case | Before | After |
|---|---|---|---|
| A | OBS side waiting, talent presses CONNECT | PASS. Opus and VP8 arrive, 0 packets lost, RTT 1 ms, pair host/udp ↔ host/udp. | PASS (unchanged) |
| A | Time to first frame | First connection in a fresh Chrome process 4-6 s; later ones ~0.35-0.5 s | Same. See "Still open". |
| A2 | Normal desktop Chrome, no click | **Silent and paused**, with no hint why (`play()` gives `NotAllowedError`). | PASS. A "Click to start audio" overlay appears only because `play()` was refused. One click plays it and received audio energy rises. |
| B | Receiver reloads mid-call (OBS refresh or restart) | **FAIL.** Black until the talent reconnects. The talent throws `InvalidStateError ... Called in wrong state: stable`. | PASS. The hub asks the caster for a fresh offer. Connected 155 ms after the reload, first frame 389 ms, no errors. |
| C | Talent DISCONNECT, then CONNECT | PASS, but leaks a receiver peer connection each cycle (2 created, 2 open) | PASS. "Waiting" shows in 117 ms, first frame 360 ms after CONNECT, only 1 peer connection open. |
| C2 | Talent reloads join.html, then CONNECT | PASS | PASS. The receiver clears in 186 ms (the talent sends `bye` on `pagehide`), first frame 384 ms. |
| D | Talent live first, OBS source opened 3 s later | PASS | PASS. First frame 547 ms after the receiver opens. |
| E | Two receivers on one slot (OBS plus a preview tab) | **FAIL.** The second never connects. | PASS (newest wins). The new receiver plays. The old one is closed with `replaced`, shows "This slot was opened in another receiver - refresh to take it back", and does not dial back in. |
| F | Second talent on another slot (caster2) | PASS | PASS. Both slots flow at once. |
| G | Second talent opens an occupied slot | Newcomer wins | PASS. Newcomer wins; the first talent shows "OPENED ELSEWHERE" and doesn't retry. |
| H | Agent restarts mid-call | **FAIL.** Media stops at once and the talent stays OFFLINE. | PASS. **Media never stops**: 665 kbps during the outage, 626 kbps after. The talent shows "RECONNECTING…", then "CONNECTED · LIVE". The same call carries on with no renegotiation. |
| H2 | Recovery after H | Needed the talent to press CONNECT | PASS. A receiver reload after the restart (the hub has no stored offer) still recovers; first frame 410 ms. |
| J | Talent re-picks camera or mic mid-call (new case) | not tested; the old code stopped the live tracks | PASS. The senders carry the new live tracks (`replaceTrack`), and 21 fps keep decoding. |
| I | `--autoplay-policy=no-user-gesture-required` (as OBS) | PASS. Plays with sound. | PASS. Plays, the click overlay stays hidden, received audio energy rises. |

`node agent/src/_selftest.js`: **does not finish as-is.** Its talent block (lines 455-463) asserts the old behavior: after a receiver has answered, a late receiver must be replayed that stale offer. That is exactly bug B, so it now waits forever at line 460 for an offer that the hub (correctly) no longer replays. A scratch copy with the replacement below passes **ALL CHECKS PASSED (586 PASS)**. `_selftest.js` wasn't in the files I may edit; the replacement is under "Selftest change needed".

## What this proves, and what it doesn't

**It proves:** the pages and the hub carry a working A/V `MediaStream` between separate Chrome processes. Opus and VP8 get negotiated and trickle ICE works. The stream survives OBS refreshing its source, the agent restarting, the talent rejoining, and the talent switching devices. Slots stay independent. OBS's CEF autoplay switch is enough for sound with no click.

**It doesn't prove:**

- **NAT traversal.** On one box, host↔host always wins. srflx candidates were gathered but not needed.
- **TURN.** There is none.
- **Venue Wi-Fi.** Client isolation and blocked UDP were not tested.
- **Real microphones and cameras.** Fake devices: 1280x720 requested, 640x360 to 960x540 reached in 15 s as bandwidth estimation ramped on loopback.
- **OBS's own capture.** The source was not loaded in a real OBS CEF (mixer meter, recorded track, A/V sync).
- **Echo and latency.** Glass-to-glass delay and lip sync weren't measured. Loopback jitter buffers were audio about 57 ms and video about 15 ms.
- **Mobile browsers.** iOS Safari and Android Chrome were not tested as the talent, nor was screen lock.
- **Recovery from a real ICE failure.** The new "on `failed`, ask the talent for a fresh offer" path (see below) can't be triggered on one machine.

## STUN and TURN, plainly

The agent configures **no** ICE servers. It never touches media. Both pages hard-code
`stun:stun.l.google.com:19302` (`ICE_SERVERS` near the top of each page's script).
**There is no TURN anywhere.** Across networks this means:

- It works only if UDP hole punching succeeds (usually when at least one side has a friendly NAT).
- It **fails with no fallback** in three cases: a mobile carrier with symmetric NAT or CGNAT against a strict NAT on the other side; a venue that blocks outbound UDP (there's no TURN over TCP/TLS 443); and Google's STUN being unreachable.
- ICE then goes `checking` → `failed` after about 30 s. view.html now asks the talent for a fresh offer on `failed` and shows "Waiting...", but without TURN a retry over the same networks will usually fail again.

A production setup needs TURN (coturn or a hosted service, short-lived credentials, TCP/TLS 443). The ICE config should also come from the agent rather than being hard-coded in two pages.

## Blocker before any two-device test: the talent cannot reach the page

As shipped, CTA Studio only works when the talent is **on the same PC as OBS**:

1. The agent listens on `127.0.0.1` only (`config.js` `HOST`).
2. `guardRequest` (`http.js`) refuses any Host header that isn't loopback, for both the join page and the `/talent/signaling` upgrade.
3. On anything other than `localhost`, `getUserMedia` needs HTTPS.
4. The hosted relay doesn't tunnel `/talent/signaling` or `/overlays/talent/` (deny-by-default; `docs/REMOTE.md` says "a seat has no voice").
5. `/talent/signaling` has no auth. Since the newest caster and the newest receiver win their slot, anyone who reaches the endpoint can take over a slot. That's fine on loopback. It must get a per-slot secret token before it is exposed anywhere.

The proper fix is a product decision (HTTPS join page and signaling through the relay, with a token in the join link). Nothing in the UI makes a join link today, or switches `settings.talent.mode` to `'studio'`.

## What changed

**Protocol** (documented at the top of `talent.js`):

- Caster offers and candidates carry a `seq` that numbers the caster's peer connections. The receiver echoes it on its answer and candidates. Anything for a superseded connection is ignored rather than misapplied.
- New messages:
  - caster → hub `{type:'bye'}`: leaving on purpose.
  - hub → caster `{type:'RENEGOTIATE'}`: make a fresh offer.
  - receiver → caster `{type:'RENEGOTIATE'}`: relayed; sent after an ICE `failed`.
  - `TALENT_OFFLINE` now has `graceful`.
  - The receiver URL may carry `&live=1`.
- Older pages without `seq` still interoperate (a missing `seq` matches anything).

**`agent/src/talent.js`**

- Each slot tracks `answered`. A receiver that joins while a caster is present gets one of three things:
  - the standing offer and its candidates, if nobody has answered it yet (as before);
  - nothing, if it says `live=1` (its media is still playing after a socket drop);
  - otherwise, `RENEGOTIATE` is sent to the caster.
- One receiver per slot: the newest closes older ones with `1000 'replaced'`.
- Messages from a replaced caster or receiver are ignored.
- Candidates for the same `seq` that race ahead of the offer are kept.
- `TALENT_OFFLINE.graceful` is set when the caster said `bye`.

**`overlays/talent/join.html`**

- `startPeer()` closes the old peer connection, builds a new one, and sends the offer before any of its candidates (candidates are held until the offer is out). It runs on CONNECT and on `RENEGOTIATE`.
- An answer is applied only for the current `seq` and only in `have-local-offer`. Candidates are only for the current `seq`.
- A dropped socket no longer tears down the call. While live, the page shows RECONNECTING… and retries every 2 s. On reopen it keeps a call that is still `connected`, and only renegotiates a dead one.
- `replaced` → "OPENED ELSEWHERE", no retry.
- DISCONNECT and `pagehide` send `bye`.
- Re-picking a camera or mic hands the new tracks to the live call (`replaceTrack`).
- The slot is passed through `encodeURIComponent`.

**`overlays/talent/view.html`**

- A fresh peer connection per offer. The old one is always closed (`closePeer()`), which fixes the leak. `TALENT_ONLINE` no longer resets anything.
- On `TALENT_OFFLINE`, the receiver clears at once if the leave was graceful or there's no media. Otherwise it keeps playing; a `disconnected` state that lasts 5 s clears it, and `failed` clears it and sends `RENEGOTIATE`.
- The socket retries every 2 s with `&live=1` while media plays. `replaced` → a visible message, no retry.
- `play()` after each new stream. Only a `NotAllowedError` shows the "Click to start audio" overlay, so it never appears in OBS, where autoplay is allowed.
- The slot is passed through `encodeURIComponent`.

**`tools/bench/talent-bench.mjs`**: cases A-J and I as above. The agent is kept away from any real OBS. `--watch <slot>` is for the two-device test.

## Selftest change needed (`agent/src/_selftest.js`, not applied)

Replace lines 455-468 (from `// the case the clients cannot handle themselves: OBS restarts mid-show, so a` through `ok((await offline).type === 'TALENT_OFFLINE', 'the receiver is told when the caster drops');`) with:

```js
  // OBS refreshes or restarts mid-show, after the call was set up: the standing
  // offer has already been answered, and replaying it would get an answer the
  // caster can no longer apply (black source - docs/TALENT-BENCH.md case B).
  // The hub asks the caster for a fresh offer instead.
  rx.close();
  await settle();
  const renegotiate = next(tx, (m) => m.type === 'RENEGOTIATE');
  const rx2 = await open(url('obs_receiver', 'caster1'));
  eq((await renegotiate).type, 'RENEGOTIATE', 'a receiver joining after the offer was answered gets the caster asked for a fresh offer');
  const freshOffer = next(rx2, (m) => m.type === 'offer');
  tx.send(JSON.stringify({ type: 'offer', offer: { sdp: 'OFFER-2' }, seq: 2 }));
  eq((await freshOffer).offer.sdp, 'OFFER-2', 'the fresh offer reaches the new receiver');
  tx.send(JSON.stringify({ type: 'candidate', candidate: { c: 'from-caster-2' }, seq: 2 }));
  await settle();

  // the case the clients cannot handle themselves: a receiver joins after the
  // caster sent its offer but before anyone answered it
  rx2.close();
  await settle();
  const rx3 = await open(url('obs_receiver', 'caster1'));
  eq((await next(rx3, (m) => m.type === 'offer')).offer.sdp, 'OFFER-2', 'a receiver joining before anyone answered is replayed the standing offer');
  eq((await next(rx3, (m) => m.type === 'candidate')).candidate.c, 'from-caster-2', 'buffered candidates are replayed to a late receiver');

  // one receiver per slot: the newest replaces the older one
  const rx3closed = new Promise((res) => rx3.once('close', (_code, reason) => res(String(reason))));
  const rx4 = await open(url('obs_receiver', 'caster1'));
  eq(await rx3closed, 'replaced', 'a newer receiver on the slot replaces the older one');

  // caster drops
  const offline = next(rx4, (m) => m.type === 'TALENT_OFFLINE');
  tx.close();
  ok((await offline).type === 'TALENT_OFFLINE', 'the receiver is told when the caster drops');
```

Also change line 491, `rx2.close(); a.close(); b.close();`, to `rx4.close(); a.close(); b.close();`.

## Still open

- **First connection in a fresh browser process takes 2-6 s.** That time is a synchronous `new RTCPeerConnection()` (the receiver got the offer at +2177 ms but finished building its peer connection at +4255 ms). It's possibly specific to this machine. A cheap mitigation (not done): `new RTCPeerConnection().close()` at page load in both pages, so OBS pays it when the source loads and the talent pays it before pressing CONNECT.
- **Newest receiver wins, and the trade-off is real.** If an operator opens `view.html` in a browser tab to preview a slot, that tab takes the slot from OBS, and the OBS source shows "opened in another receiver" until it is refreshed. The agent logs `a newer receiver replaced an older one`. The full fix is one caster peer connection per receiver, with receiver ids on every message.
- **No TURN, no auth on `/talent/signaling`, and no way for a second device to reach the page** (above).
- **Talent-side behavior on phones is untested:** screen lock, background tabs, and iOS device-dropdown labels before permission is granted.

## Two-device checklist

**Setup:** the **laptop** is the rig (agent + OBS) on home or venue Wi-Fi. The **phone** is the talent on **mobile data, with Wi-Fi off**. Because of the blocker above, the phone needs an HTTPS route to the agent. This is a test-only tunnel. While it's up, anyone with the URL can call the agent's API, so use a scratch data dir, keep it up only for the test, and turn off OBS's WebSocket server (Tools → WebSocket Server Settings) so the tunnel can't drive OBS.

1. Stop the normal Clear to Air agent.
2. Start the tunnel: `cloudflared tunnel --url http://127.0.0.1:7700 --http-host-header 127.0.0.1:7700`. Note the `https://<name>.trycloudflare.com` URL. The host-header rewrite gets past the loopback Host check. (This flag wasn't exercised here; confirm it on the first try.)
3. Start the agent with that origin allowed (PowerShell, repo root):
   `$env:CTA_ALLOW_ORIGINS='https://<name>.trycloudflare.com'; node agent/src/index.js --data-dir $env:TEMP\cta-talent-test`
4. On the laptop, start a receiver and a stats view. Use **either**:
   - Desktop Chrome: open `chrome://webrtc-internals` first, then `http://127.0.0.1:7700/overlays/talent/view.html?slot=caster1` in another tab, and click **"Click to start audio"** when it appears; **or**
   - `node tools/bench/talent-bench.mjs --watch caster1`. This opens headless Chrome with OBS's autoplay switch and prints the connection state, candidate pair, RTT, video kbps/size/fps/lost and audio kbps/level/jitter every 2 s.
5. On the phone (mobile data), open `https://<name>.trycloudflare.com/overlays/talent/join.html?slot=caster1` and allow camera and mic. Check the preview and the VU meter, then tap **CONNECT TO OBS**. If the device dropdowns are empty, reload once after granting permission. Keep the screen on and the browser in the foreground.
6. What to look for (webrtc-internals → the peer connection → Stats):
   - **`connectionState: connected`** within a few seconds. Write down the time from tapping to picture.
   - **The selected `candidate-pair`** (state `succeeded`, nominated): local and remote `candidateType`. Expect `srflx` on at least one side. **`checking` → `failed` after about 30 s means NAT traversal failed and this path needs TURN.** Write down both candidate types and the phone's carrier.
   - `inbound-rtp` video: `bytesReceived` rising, `frameWidth`/`framesPerSecond` (does it reach 1280x720 after 30 s?), `packetsLost`, `jitter`.
   - `inbound-rtp` audio: `audioLevel` moves when the talent speaks; `jitterBufferDelay / jitterBufferEmittedCount` (ms of buffer).
   - `candidate-pair.currentRoundTripTime`.
7. Latency and sync: put a millisecond clock on the laptop screen, point the phone camera at it, and compare the clock with its image in the received video. That's glass-to-glass delay. Then clap on camera to check lip sync.
8. Echo: the talent page sends nothing back (there is no return or IFB feed). Listen for room echo only if the talent also monitors the stream on a speaker.
9. In OBS: add a Browser source with `http://127.0.0.1:7700/overlays/talent/view.html?slot=caster1`, 1280x720, and tick **Control audio via OBS**. It takes the slot from the Chrome tab (newest wins); the tab says so. Expect picture plus a moving mixer meter with **no** click overlay. Record 30 s and check A/V sync in the file.
10. Recovery (each should now recover without the talent touching anything):
    - Right-click the source → Refresh. Picture should be back in about 0.5 s.
    - Restart the agent mid-call. The picture should keep going; the phone shows RECONNECTING…, then LIVE.
    - Change the camera on the phone mid-call. The picture should switch without dropping.
    - Lock the phone for 10 s, and toggle airplane mode. Note what happens; this is untested.
11. If you can, repeat with the phone on the venue Wi-Fi and on a second carrier.
12. Teardown: Ctrl+C cloudflared (the URL dies), stop the agent, and turn OBS's WebSocket server back on.

Record for each run: carrier and network, the candidate pair types, RTT, time to first picture, the resolution reached, packet loss, glass-to-glass delay, and whether OBS played audio with no click.
