# Clear to Air — local agent

The Node process that pairs with OBS, holds the show state, feeds the overlays and
serves the control room. Plain ESM, Node 24, two dependencies (`ws`, `obs-websocket-js`).
It starts with OBS closed, packs missing and `web/dist` missing.

## Run

```
node agent/src/index.js                 # http://127.0.0.1:7700
node agent/src/index.js --sim valorant  # also start the VALORANT simulator
node agent/src/index.js --port 7710     # or CTA_PORT=7710
npm start                               # from the repo root
```

`Clear to Air.cmd` at the repo root does the same and opens the control room.
Stop with Ctrl+C (adapters and simulators are stopped, OBS disconnected).

## Ports

| Port | What |
|---|---|
| 7700 | Agent HTTP + WebSocket (`/ws`) |
| 7701 | CS2 GSI receiver (adapter `cs2gsi`) |
| 7702 | Dota 2 GSI receiver (`dota2gsi`) |
| 7777 | Apex LiveAPI WS server (`apexlive`) |
| 49123 / 49122 | Rocket League Stats API / SOS — we connect (`rlstats`) |
| 2999 | LoL Live Client Data — we poll (`lolclient`) |
| 4455 | obs-websocket — we connect |

## Where things live

- `agent/data/state.json` — persisted state (written 300 ms after a change, hot-reloaded
  if you edit it by hand; `live` is never written).
- `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` — where the OBS
  password and port are read from (fallback: `user.ini`/`global.ini` `[OBSWebSocket]`,
  then `settings.obsPassword`). The password is never logged.
- `%APPDATA%\obs-studio\basic\scenes\<name>.json` — where `POST /api/obs/collection/install`
  writes the generated collection (timestamped backup, refuses while `obs64.exe` runs).
- The active OBS profile (`user.ini` `[Basic] Profile`) is read for the recording path
  and track mask that preflight checks.

### Game State Integration cfg (CS2 / Dota 2)

`POST /api/adapters/cs2gsi/install` (the Data tab's Install) finds the game through Steam's
libraries and writes, UTF-8 without a BOM,
`<library>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_cleartoair.cfg`
(Dota 2: `...\dota 2 beta\game\dota\cfg\gamestate_integration\`). It never replaces a file of that
name it did not write unless asked again with `replace: true` (the old one is kept as `.old`).
`GET` returns the file and the manual steps. The token is `state.settings.gsiToken` (a random
one is generated on first boot). Both are local-only; see `agent/src/adapters/_steam.js`.

### Other files under agent/data

- `adapters.json` — adapters the operator started; restarted on boot, forgotten on Stop.
- `captures/<game>-<date>.jsonl` — "Record raw game data" (Data tab), tokens removed, 50 MB cap.

## API

REST (JSON). Errors are `{ok:false, error}` with 400 (bad input), 503 (OBS not connected) or 404.

```
GET  /healthz                         {ok, uptime, port, obs:{connected,program,ready,error}, adapters, sims, overlays, preflight:{clear,fails,warns}}
GET  /api/state                       full state
POST /api/state                       deep-merge patch (arrays replace, null deletes) -> {ok, version, rev}
POST /api/state/replace               whole state
POST /api/state/undo                  pop the 200-deep history
GET  /api/packs                       every packs/*/pack.json
POST /api/game        {game}          switch pack; veto pool reset from pack.maps, steps cleared
GET  /api/adapters                    [{id,label,games,describe,status,running,installable,autoInstall,capturable}]
POST /api/adapters/:id/start|stop     start is remembered in agent/data/adapters.json and restarted on boot
GET  /api/adapters/:id/install        {files:[{path,content}], instructions}
POST /api/adapters/:id/install        {replace?} -> {ok, found, written, unchanged, foreign, backup, path, tried, files, instructions}
GET|POST /api/adapters/:id/capture    {on} -> {on, file, bytes, payloads, maxBytes, reason}
GET  /api/sims                        [{id,label,running}]
POST /api/sim/:game/start|stop
GET  /api/obs                         bridge status (scenes, program, preview, items, meters in dBFS, ...)
POST /api/obs/scene    {name}         program cut ("04" or the full scene name)
POST /api/obs/preview  {name}         studio-mode preview, or a local ARM slot when studio mode is off
POST /api/obs/take                    TriggerStudioModeTransition, or cut to the armed slot
POST /api/obs/item     {scene?, name|id, enabled}
POST /api/obs/replay   {action, cut?} start|stop|save; save repoints "REPLAY · Last Clip", writes show.replay, cuts to 05 when cut=true
POST /api/obs/stream   {action}       start|stop
POST /api/obs/record   {action}       start|stop
POST /api/obs/mute     {pattern, on}  regex (or substring) over input names
POST /api/obs/refresh                 refreshnocache on every browser source
POST /api/obs/reload                  re-read scene list + status from OBS
POST /api/obs/raw      {type, data}   any obs-websocket request
GET  /api/obs/shot?scene=&w=          PNG (browser-only scenes are cut to for 2.5 s, then restored)
GET  /api/obs/collection/preview      generated collection JSON for the current state
GET  /api/obs/collection/summary      scene/item counts of the same
POST /api/obs/collection/install {name}
GET  /api/obs/collection/drift        [{kind, scene, item, expected, actual}]
GET  /api/preflight                   last result; POST /api/preflight/run runs now
GET  /api/log?n=200                   ring buffer; POST /api/log {tag,msg} appends a client line
POST /api/stats/ocr                   501 in this build
```

Static: `/` → `web/dist` (SPA fallback; a placeholder page when not built),
`/packs/*` → `packs/`, `/overlays/*` → `overlays/`. HTML/JS/CSS/JSON are `no-store`;
images, fonts and media cache for a day.

WebSocket `ws://127.0.0.1:7700/ws` — on connect: `{type:"hello", state, obs, adapters, preflight}`.
Server → client: `state`, `live`, `obs`, `preflight`, `adapters`, `log` (`{type:"log", line}`).
Client → server: `{type:"patch", data}`, `{type:"obs", action, ...body, id?}` (answered with
`{type:"obs-result", action, id, ...}` or `{type:"error", action, id, error}`), `{type:"ping"}` → `pong`.
Overlays connect with `?role=overlay&page=ingame`; the hub counts them for preflight.

## Preflight and watchdogs

Preflight runs every 10 s (`agent-up`, `state-loads`, `pack-loaded`, `obs-connected`,
`obs-scenes-present`, `obs-not-rehearsal`, `browser-sources-online`, `audio-bed`,
`replay-buffer`, `disk-space`, `recording-tracks`, `adapter-live`, `teams-resolve`,
`veto-consistent`, `talent-slots`). Watchdogs run every 5 s (`video-without-audio`,
`adapter-stale`, `replay-buffer-stopped-during-live`, `disk-filling`) and surface as
preflight warns while tripped. `video-without-audio` refreshes the silent `AUDIO ·` twin
of a visible `CAM ·` source, at most once a minute per input.
