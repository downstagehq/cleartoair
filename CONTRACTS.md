# CLEAR TO AIR — build contracts (v0 prototype)

Product: **Clear to Air** — a broadcast companion for esports tournament streams.
A small **local agent** (Node) pairs with **OBS** over obs-websocket, ingests **live
game data**, renders **overlay pages** as OBS browser sources, and exposes a
**control room** web app. This file is the contract every builder codes to.
If you need something the contract does not define, add it here in a
`## Additions` section at the bottom and keep it consistent with the rest.

Working folder: the repo root. Node 24, npm 11. Windows 11. OBS 32 installed.
No build step at runtime for the agent (plain ESM JS). The web app is Vite and is
built to `web/dist`, which the agent serves. Everything must work **offline**
(no CDN fonts/scripts at runtime; bundle fonts via `@fontsource/*`).

```
cleartoair/
  package.json           root scripts: dev, build, start
  Clear to Air.cmd              double-click: starts agent, opens control room
  agent/                 Node ESM. deps: ws, obs-websocket-js (only these)
    src/index.js         boot everything below
    src/config.js        ports, paths, obs password lookup (see §7)
    src/state.js         entity-shaped state store, patch, undo history, persist
    src/hub.js           WebSocket hub: overlays + control room clients
    src/http.js          REST + static serving (web/dist, packs/*/overlay, overlays/_shared)
    src/obs/bridge.js    obs-websocket-js wrapper (§5)
    src/obs/collection.js OBS scene-collection generator (§6)
    src/obs/drift.js     desired-vs-live diff (§6)
    src/preflight.js     continuous rules engine (§8)
    src/watchdog.js      paired-signal watchdogs (§8)
    src/adapters/*.js    game adapters (§4)
    src/sim/*.js         simulators that emit the same normalized events (§4)
    data/state.json      persisted state (git-ignored)
  packs/<game>/pack.json game definition (§3)
  packs/<game>/overlay/*.html  overlay pages for that game (§9)
  overlays/_shared/      core.js (WS client + helpers), tokens.css, fonts/
  web/                   Vite + React + TS + Tailwind v4 control room (§10)
  site/                  static landing page (§11)
  docs/                  ARCHITECTURE.md, DESIGN.md, REMOTE.md, RELEASE.md
```

## 1. Ports

| What | Port | Notes |
|---|---|---|
| Agent HTTP + WS | **7700** | `http://127.0.0.1:7700` control room at `/`, overlays at `/packs/<game>/overlay/<page>.html`, shared at `/overlays/_shared/...`, WS at `ws://127.0.0.1:7700/ws` |
| CS2 GSI receiver | 7701 | game POSTs JSON here |
| Dota 2 GSI receiver | 7702 | |
| Apex LiveAPI WS server | 7777 | game connects to us |
| Rocket League native Stats API | 49123 | we connect (TCP, JSON lines) |
| Rocket League SOS (BakkesMod) | 49122 | we connect (WebSocket) |
| LoL Live Client Data | 2999 | we poll `https://127.0.0.1:2999/liveclientdata/allgamedata` (self-signed) |
| obs-websocket | 4455 | we connect |

## 2. State (entity-shaped; team ids everywhere, never A/B slots in entities)

```jsonc
{
  "version": 1,
  "event": {
    "name": "COMMUNITY CUP", "subtitle": "OPEN QUALIFIER", "hashtag": "#COMMUNITYCUP",
    "platform": "LIVE ON TWITCH", "prize": "$1,000",
    "brand": { "primary": "#D9B25A", "secondary": "#0A0A0A", "accent": "#FFFFFF",
               "logo": "", "font": "barlow" } // font: barlow|bebas|saira|custom
  },
  "game": "valorant",                      // pack id
  "teams": {
    "alpha": { "id": "alpha", "name": "Alpha", "short": "ALPHA", "tag": "ALPH",
      "logo": "", "color": "#7C3AED", "seed": 1,
      "record": "10W - 1L", "note": "Undefeated qualifier run",
      "roster": [ { "id": "zephyr", "ign": "Zephyr", "name": "", "role": "SENTINEL",
                    "portrait": "", "note": "" } ] }
  },
  "series": {
    "id": "sf1", "label": "SEMI-FINAL 1", "format": "BO3",
    "teamA": "alpha", "teamB": "bravo",   // the ONLY place slots map to ids
    "scoreA": 1, "scoreB": 0, "mapIndex": 1,  // 0-based index into maps
    "maps": [ { "name": "Ascent", "pickedBy": "alpha", "winner": "alpha", "scoreA": 13, "scoreB": 7, "status": "done" },
              { "name": "Haven",  "pickedBy": "bravo", "winner": null, "scoreA": 0, "scoreB": 0, "status": "live" } ],
    "status": "live"                         // upcoming|live|done
  },
  "veto": {                                  // always refers to state.series teams
    "pool": ["Ascent","Bind","Haven","Icebox","Lotus","Split","Sunset"],
    "steps": [ { "action": "ban", "team": "alpha", "map": "Bind" },
               { "action": "pick", "team": "bravo", "map": "Haven", "side": "ATK" },
               { "action": "decider", "team": null, "map": "Sunset" } ]
  },
  "draft": {                                 // LoL / Dota champion picks and bans, in board order
    "steps": [ { "action": "ban", "team": "alpha", "champion": "K'Sante" },
               { "action": "pick", "team": "alpha", "champion": "Aatrox", "ign": "Zephyr", "role": "TOP" } ]
  },
  "standings": {                             // Apex lobby leaderboard; team may be a bare squad name
    "rows": [ { "team": "Alpha", "games": 6, "placement": 1, "kills": 19, "points": 58 } ],
    "matchPoint": 50                         // null -> fall back to pack.scoring.matchPoint
  },
  "set": {                                   // FGC set: one entry per game, characters counter-picked
    "title": "Street Fighter 6",
    "games": [ { "a": "Ken", "b": "Chun-Li", "winner": "alpha", "roundsA": 3, "roundsB": 1 } ]
  },
  "matchStats": {                            // EA FC half-time comparison, team-level
    "rows": [ { "label": "Possession", "a": 58, "b": 42, "unit": "%" },
              { "label": "Fouls", "a": 8, "b": 13, "lowerIsBetter": true } ],
    "scorers": [ { "team": "alpha", "ign": "Zephyr", "minute": 21 } ]
  },
  "bracket": { "format": "single", "champion": null,
    "rounds": [ { "name": "SEMI-FINALS", "matches": [ { "id": "sf1", "a": "alpha", "b": "bravo", "sa": 2, "sb": 0, "winner": "alpha" } ] },
                { "name": "GRAND FINAL", "matches": [ { "id": "gf", "a": null, "b": null, "sa": 0, "sb": 0, "winner": null } ] } ] },
  "talent": [ { "id": "t1", "name": "Riley Chen", "role": "CASTER", "handle": "@rileycasts", "slot": 3 } ],
  "show": {
    "bug": true, "ticker": false, "corner": true, "timeout": null,   // timeout: {reason, seconds, startedAt}|null
    "lowerThird": { "on": false, "name": "", "role": "", "handle": "" },
    "card": "none",                          // none|vs|veto|draft|standings|set|games|matchstats|roster|bracket|scoreboard|mvp|h2h|schedule
                                             // a card is only offered when pack.caps.cards allows it (§3)
    "cardTeam": null,                        // team id for roster card
    "tickerText": "", "standby": { "mode": "countdown", "targetAt": null, "title": "STARTING SOON", "sub": "" }
  },
  "stats": {                                 // post-match, human-confirmed (OCR or manual)
    "scoreboard": { "mapIndex": 0, "rows": [ { "team": "alpha", "ign": "Zephyr", "acs": 262, "k": 16, "d": 9, "a": 5 } ] },
    "mvp": { "team": "alpha", "ign": "Kestrel", "line": "262 ACS · 16/9/5" }
  },
  "rundown": [ { "id": "r1", "time": "10:00", "title": "Starting soon", "scene": "01", "card": "none", "notes": "", "done": false } ],
  "live": {                                  // written ONLY by adapters/sims (§4). Not persisted.
    "source": "cs2gsi", "connected": true, "updatedAt": 0,
    "phase": "live",                         // warmup|freezetime|live|over|halftime|paused|replay|podium|unknown
    "round": 12, "clock": "1:12", "clockSeconds": 72, "overtime": false,
    "scoreA": 7, "scoreB": 5,                // A/B follow state.series.teamA/teamB after mapping (§4)
    "sideA": "CT", "sideB": "T",             // CS: CT/T, Val: ATK/DEF, RL: BLUE/ORANGE, LoL: BLUE/RED
    "mapName": "Mirage",
    "players": [ { "team": "A", "name": "Zephyr", "hp": 100, "armor": 100, "money": 4750, "kills": 12, "deaths": 8, "assists": 2,
                   "weapon": "AK-47", "alive": true, "boost": 33, "score": 420, "champion": "", "agent": "", "extra": {} } ],
    "bomb": { "state": "planted", "countdown": 30 },
    "ball": { "speed": 0, "team": null },
    "events": [ { "t": 0, "type": "goal|kill|round_end|bomb_planted|...", "text": "" } ]  // last 20
  },
  "settings": { "obsCollectionName": "ClearToAir", "canvas": [1920,1080], "replayDir": "", "gsiToken": "cta" }
}
```

Rules:
- `state.series.teamA/teamB` are the only A/B slots. Overlays resolve a team with
  `team(id)` helper. Veto, scoreboard rows, bracket use ids.
- A patch is a deep merge (objects merge, arrays REPLACE, `null` deletes the key).
- Every applied patch is pushed to a 200-deep undo history.
- `live` is never persisted and never patched by the control room except `live.source`.

## 3. Packs (`packs/<id>/pack.json`)

Pack ids: `cs2`, `valorant`, `rocketleague`, `lol`, `dota2`, `apex`, `fgc`, `eafc`.

```jsonc
{
  "id": "cs2", "name": "Counter-Strike 2", "short": "CS2",
  "sides": ["CT", "T"], "roundsToWin": 13, "defaultFormat": "BO3",
  "formats": ["BO1", "BO3", "BO5"],                 // what this title offers; not an enum -
                                                    // FT2/FT3 (FGC), 2LEG (EA FC), "6 GAMES" (Apex), BO7 (RL)
  "caps": {                                         // what the title actually HAS (§3a)
    "veto": true, "draft": false, "standings": false, "set": false,
    "games": false, "matchStats": false,
    "maps": true, "sides": true, "rounds": true, "halves": true,
    "series": true, "headToHead": true,
    "cards": ["none","vs","veto","roster","bracket","scoreboard","mvp","h2h","schedule"]
  },
  "maps": [ { "id": "de_mirage", "name": "Mirage", "art": "assets/maps/mirage.jpg" } ],   // art relative to pack; may be missing -> stylised fallback
  "roles": ["IGL","AWP","ENTRY","SUPPORT","LURK"],
  "adapters": ["cs2gsi", "manual"],                 // adapter ids this pack supports; first is default
  "stats": { "scoreboardColumns": ["k","d","a","adr","hs"], "mvpStat": "adr" },
  "overlay": { "pages": ["ingame.html","cards.html","standby.html","desk.html"], "bugStyle": "rounds" }, // rounds|goals|kills
  "scenes": "recipe.default",                        // scene recipe id in collection.js (§6)
  "theme": { "primary": "#F5A623", "secondary": "#111318" }
}
```

### 3a. Capabilities

`caps` is what stops a control room offering a map veto for Rocket League. An
absent key defaults to **true**, so an un-migrated pack keeps working.

| key | meaning | true for |
|---|---|---|
| `veto` | maps are picked and banned on air | cs2, valorant |
| `draft` | champions/heroes picked and banned on air | lol, dota2 |
| `standings` | a lobby leaderboard, not a scoreline | apex |
| `set` | games with per-game character counter-picks | fgc |
| `games` | a series of games rather than named maps | rocketleague |
| `matchStats` | team-level match comparison | eafc |
| `maps` | the series runs across named maps/arenas | cs2, valorant, apex |
| `sides` | named sides worth showing (CT/T, ATK/DEF) | cs2, valorant, rl, lol, dota2 |
| `rounds` / `halves` / `series` / `headToHead` | round scoring / halves / best-of / A-vs-B is meaningful | — |
| `cards` | the full-frame cards this title may show | every pack |

Each title carries exactly one **headline card**: cs2/valorant `veto`,
lol/dota2 `draft`, apex `standings`, fgc `set`, rocketleague `games`,
eafc `matchstats`. The control room reads this through `cardsFor()` and `can()`
(`web/src/types.ts`); `render.js` refuses to paint a card whose capability is
false, so a stale rundown row cannot put a fabricated veto or draft on air.

Per-title extras: `champions` (lol, dota2 — datalist suggestions, not a
whitelist), `characterSets` (fgc — a roster per fighting game), `scoring`
(apex — ALGS placement table, `perKill`, `matchPoint`), `statLines` (eafc —
prefill for the match-stats rows, `lowerIsBetter` where the smaller number wins).

**Liquipedia lookup.** `GET /api/liquipedia/team?name=&wiki=` resolves one team;
`POST /api/liquipedia/team {name, wiki?, slot?, confirm?}` also caches its logo into
`packs/<game>/assets/teams/<slug>.png` and, with `slot: "A"|"B"`, applies the name
and logo to that team. The wiki comes from `pack.liquipedia`, falling back to
`WIKI_FOR_PACK`. A result reached by **search** rather than an exact title sets
`needsConfirm` and changes nothing until the caller passes `confirm: true` — the
wiki's search is loose enough that a typo matches a real but wrong team.

Their API terms are enforced server-side, not merely documented: gzip is mandatory
(a plain request gets 406), the User-Agent must carry contact details, and
`action=query` is limited to one call every two seconds — `agent/src/liquipedia.js`
serialises every call through one queue to honour that, and never calls
`action=parse` (30 s limit). Liquipedia text is CC-BY-SA 3.0 and every record
carries `source` and `license`. Team logos are the teams' trademarks: identifying a
team that is playing is ordinary use, mirroring a logo library is not, so the
module fetches one team at a time and `packs/*/assets/teams/` is gitignored.

The word for a unit of play follows `caps.maps`: titles with a map pool that
matters say **MAP** (cs2, valorant, apex), the rest say **GAME** (lol, dota2,
rocketleague, fgc, eafc). `mapUnit()` in `render.js` is the single source, used by
the scoreboard / MVP / head-to-head headers and the MVP kicker.

The **scoreboard** card prefers `stats.scoreboard.rows` — an operator who pasted a
correction meant it — and otherwise falls back to `live.players[]` through
`CTA.render.liveScoreboardRows(state, cols)`, so a connected feed fills the card
instead of showing NO ROWS. `CTA.render.playerStat(player, col)` resolves one
pack column against one normalized player: kills/deaths/assists/score sit at the
top level, everything else in `extra`, and a short alias table covers the
shorthand packs use (`k`→kills, `nw`→netWorth, `lh`→lastHits, …). A column the
feed does not carry returns null and the cell shows a dash rather than a
misleading zero — CS2 GSI has no ADR. Both are pure and tested.
`stats.scoreboard.mapIndex` is only honoured alongside pasted rows; it belongs to
them, and following it under a live fallback put game 1's score beside a GAME 2
header.

`scoreboardColumns` must be **per-player** figures. A squad or team number
repeated down every row says nothing: Apex placement and points belong on the
`standings` card, EA FC possession on `matchstats`, and both were moved there.

Two headline cards derive their headline rather than trusting `series`, because
the number sits beside the detail it must agree with:

- `matchstats` — the score is the count of `matchStats.scorers` whenever there
  are any, then `live.scoreA/B`, then `series`. A board reading 1–0 above a list
  of three goals is worse than no board.
- `games` — reads `series.maps` (for Rocket League that list *is* the games).
  A game with no result yet prints – rather than 0–0, which would read as a
  goalless game instead of one still to come.

`packs/<id>/assets/` holds map art, team logos, portraits, brand. Valorant map
art may be fetched at runtime from `https://media.valorant-api.com/maps/<uuid>/splash.png`
(public, free) — cache it to `packs/valorant/assets/maps/` on first use.

## 4. Adapters (agent/src/adapters/<id>.js)

Each adapter is an ESM module exporting:

```js
export const id = 'cs2gsi';
export const games = ['cs2'];
export const label = 'CS2 Game State Integration';
export const describe = 'Listens on :7701 for POSTs from gamestate_integration_cleartoair.cfg';
export function create({ config, emit, log }) {
  // emit(partialLive) -> merged into state.live and broadcast as {type:"live"}.
  // partialLive uses the §2 live shape. Include "source" and "connected".
  return { start: async () => {}, stop: async () => {}, status: () => ({ connected, detail }) };
}
export function install({ config }) {
  // optional: returns { files: [{ path, content }], instructions: "..." } e.g. the GSI cfg to write
}
// optional (0.3.1):
export const steam = { appId: 730, name, installDir, cfgDir: ['game', 'csgo', 'cfg'], createLast?, restart };
//   Install writes files[0] (only gamestate_integration_cleartoair.cfg) into that Steam game's cfg folder.
export const capturable = true;
//   create() also receives capture(payload); call it with every raw message ("Record raw game data").
```

Team mapping: adapters report teams as the game sees them (CT/T, blue/orange,
team 0/1). The agent maps them to A/B using `state.settings.teamMap` =
`{ "A": "CT"|"T"|"blue"|"orange"|"0"|"1"|<team name substring> , "B": ... }`, with a
default of first-seen = A, and a control-room "SWAP" toggle. Adapters must NOT
decide A/B themselves; they emit `sides: { left: {...}, right: {...} }` raw and the
agent's `normalize()` assigns A/B. Put `normalize()` in `agent/src/adapters/_normalize.js`.

Adapter ids and what they must do:

| id | transport | notes |
|---|---|---|
| `cs2gsi` | HTTP server :7701 | verify `auth.token`; parse `map`, `round`, `phase_countdowns`, `allplayers_*`, `bomb`; observer payloads have allplayers |
| `dota2gsi` | HTTP server :7702 | `map`, `player`/`hero`/`items` per-team dicts in spectator mode, `draft` |
| `rlstats` | TCP client 127.0.0.1:49123 (native Psyonix Stats API, newline-delimited JSON) with **automatic fallback** to WS `ws://127.0.0.1:49122` (SOS) | SOS events `game:update_state`, `game:goal_scored`, `game:match_ended`, `game:replay_start/end`, `game:podium_start`, `game:clock_updated_seconds`. Support both payload shapes. |
| `lolclient` | HTTPS poll 127.0.0.1:2999 every 1 s (ignore TLS) | `allgamedata`: `allPlayers` (riotIdGameName, championName, scores{kills,deaths,assists,creepScore}, level, items), `gameData.gameTime`, `events.Events` (DragonKill, BaronKill, ChampionKill, TurretKilled) |
| `apexlive` | WS server :7777 (game is the client), JSON mode | `matchStateEnd`, `squadEliminated`, `playerKilled`, `ringStartClosing`, `observerSwitched` |
| `manual` | none | emits nothing; live is driven by control-room score buttons which patch `series` directly |
| `startgg` | GraphQL client (token from settings) | one-shot import: event slug -> teams + bracket into state |

Simulators (`agent/src/sim/<game>.js`) export `{ id, label, start({emit}), stop() }` and play a
realistic 2–4 minute loop of events through the SAME `emit` path so overlays and control
room can be exercised with no game installed: `cs2`, `rocketleague`, `lol`, `valorant`
(valorant sim stands in for the Overwolf/OCR path).

## 5. OBS bridge (agent/src/obs/bridge.js)

Uses `obs-websocket-js`. Exposes an object with:
`connect()`, `status()` -> `{connected, version, program, preview, studioMode, scenes:[{name, uuid}], items:[{id,name,enabled,group}], streaming, recording, replayBuffer, error, lastReplay, meters:{[inputName]: dB}}`,
`setScene(name)`, `setPreview(name)`, `take()` (TriggerStudioModeTransition or SetCurrentProgramScene from preview),
`setItem(scene, nameOrId, enabled)`, `replay('start'|'stop'|'save')`, `stream('start'|'stop')`, `record('start'|'stop')`,
`mute(inputNamePattern, on)`, `screenshot(sceneName, width)` -> PNG buffer (switch program first if browser-only scene, wait 2.5 s, then shoot, then restore),
`refreshBrowserSources()` (PressInputPropertiesButton refreshnocache on every browser_source),
`raw(type, data)`, `on(event, fn)`.
Subscribe to `InputVolumeMeters` (EventSubscription bit 65536) and keep the latest peak dB per input in `meters` — this is what proves audio-view faults (the dead-caster-audio incident at a live event in Sep 2026).
Reconnect with backoff. Handle "websocket accepts before scenes load": poll GetSceneList until non-empty (`readyRefresh`).
Broadcast `{type:"obs", data: status()}` on every change through the hub (throttle meters to 4 Hz).

Password: read `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` (`server_password`, `server_port`, `auth_required`); if the file is missing, try `%APPDATA%\obs-studio\global.ini` / `user.ini` `[OBSWebSocket]` section; fall back to `settings.obsPassword`.

## 6. Collection generator + drift (agent/src/obs/collection.js, drift.js)

Port the Python collection generator used at a live event in Sep 2026 to JS, game-agnostic. Keep every
trap it encodes (bounds_rel = px / (canvasH/2), pos_rel, z-order reversed, groups
in top-level `groups` with children re-based to the group's bounding-box corner,
`mixer_hidden`, audio bed per scene, no OBS hotkeys (they are global in OBS, so bare F-keys cut program from any app), browser sources by URL only).
Scene recipe `recipe.default` (scene name → items, front-to-back):

```
01 · STARTING SOON   standby.html + ingame.html + BG loop (if media) + audio bed(all)
02 · DESK            desk.html + cams (2-box group) + bg           + audio bed(all)
03 · CARDS           cards.html + bg                               + audio bed(casters)
04 · IN-GAME         ingame.html + caster PiP group (hidden) + GAME capture + audio bed(casters)
05 · REPLAY          ingame.html + REPLAY media + bg                + audio bed(casters)
06 · BRB             standby.html + bg                             + audio bed(none)
07 · POST-MATCH      cards.html + desk.html + cams + bg            + audio bed(all)
08 · OUTRO           standby.html + bg                             + audio bed(all)
```
Game capture source per pack: `pack.capture` = `{ kind: "game_capture"|"window_capture"|"monitor_capture", window: "..." }`
(cs2: `Counter-Strike 2:SDL_app:cs2.exe`; valorant: `VALORANT:UnrealWindow:VALORANT-Win64-Shipping.exe`; rocketleague: `Rocket League (64-bit, DX11, Cooked):UnrealWindow:RocketLeague.exe`; lol: `League of Legends (TM) Client:RiotWindowClass:League of Legends.exe`; others: monitor capture).
Talent cams: N VDO.Ninja browser sources from `state.talent[].slot` using `settings.vdo = {room, password}` (password never logged), audio-only twins carrying the audio (`&novideo`), cams `&noaudio`.

API: `build({state, pack, root})` -> collection JSON; `install(json, name)` writes to
`%APPDATA%\obs-studio\basic\scenes\<name>.json` with a timestamped backup and REFUSES if OBS is running
(check process `obs64.exe` via `tasklist` spawned with `cmd /c` — never through Git Bash).
`drift.diff(desiredJson, liveStatusFromBridge)` -> `[{ kind: "scene-missing"|"item-missing"|"item-extra"|"url-changed"|"audio-routing", scene, item, expected, actual }]`
comparing scene names, item names/enabled, browser URLs (via GetInputSettings) and audio-bed presence. This is what warns before a rebuild clobbers live edits.

## 7. Agent HTTP + WS API (agent/src/http.js, hub.js)

REST (JSON):
```
GET  /healthz                         {ok, uptime, obs:{connected,program}, adapters:[...], preflight:{clear, fails, warns}}
GET  /api/state                       full state
POST /api/state                       patch (deep merge) -> {ok, version}
POST /api/state/replace               whole state
POST /api/state/undo                  pop history
GET  /api/packs                       [{id,name,short,maps,...}]  (pack.json contents)
POST /api/game                        {game} switch pack (resets veto pool from pack.maps)
GET  /api/adapters                    [{id,label,games,status,running}]
POST /api/adapters/:id/start | stop
    start is remembered in agent/data/adapters.json (non-secret config only) and restarted on boot; stop forgets it
GET  /api/adapters/:id/install        install() output (files + instructions)
POST /api/adapters/:id/install {replace?}  write the cfg into the game (steam adapters) -> {ok, found, written,
                                      unchanged, foreign, backup, path, tried[], files, instructions}
GET|POST /api/adapters/:id/capture {on}   "Record raw game data" -> {on, file, bytes, payloads, maxBytes, reason}
    install and capture are local-only: no remote-policy rule, so a remote seat gets 403
POST /api/sim/:game/start | stop
GET  /api/obs                         bridge.status()
POST /api/obs/scene   {name}
POST /api/obs/preview {name}
POST /api/obs/take
POST /api/obs/item    {scene?, name|id, enabled}
POST /api/obs/replay  {action}         start|stop|save (save then patch show + cut to 05 if body.cut)
POST /api/obs/stream  {action}
POST /api/obs/record  {action}
POST /api/obs/mute    {pattern, on}
POST /api/obs/refresh
POST /api/obs/raw     {type, data}
GET  /api/obs/shot?scene=&w=           image/png
GET  /api/obs/collection/preview       generated collection JSON for current state (not installed)
POST /api/obs/collection/install       {name} -> installs (refuses if OBS running)
GET  /api/obs/collection/drift         drift list
GET  /api/preflight                    {clear, checks:[{id, level:"ok"|"warn"|"fail", title, detail, fix}], ranAt}
POST /api/preflight/run
GET  /api/log?n=200                    recent log lines
POST /api/stats/ocr                    {image: base64 png} -> {rows:[...]} (stub allowed: return 501 with message)
```

WebSocket `ws://127.0.0.1:7700/ws` (hand-rolled or `ws`): on connect send
`{type:"hello", state, obs, adapters, preflight}`. Server → client messages:
`{type:"state", data}` (full, after every patch), `{type:"live", data}` (state.live), `{type:"obs", data}`,
`{type:"preflight", data}`, `{type:"adapters", data}`, `{type:"log", line}`.
Client → server: `{type:"patch", data}`, `{type:"obs", action, ...body}` (same actions as REST), `{type:"ping"}`.
Overlays connect with `?role=overlay&page=ingame`; the hub counts them for preflight
(`overlays connected: N`). **Never use SSE; never more than one HTTP/1.1 connection per overlay page**
(Chromium's 6-per-host pool).

## 8. Preflight + watchdogs

Preflight runs every 10 s (and on demand) and returns checks. Minimum rule set:
`agent-up`, `state-loads`, `pack-loaded`, `obs-connected`, `obs-scenes-present` (≥ recipe scenes), `obs-not-rehearsal` (no source named `*TEST ONLY*` visible),
`browser-sources-online` (every recipe overlay page has ≥1 WS overlay client), `audio-bed` (every scene in program list carries the desktop audio input; desk mics rule per recipe),
`replay-buffer` (running while series.status==="live" → warn), `disk-space` (record path ≥ 10 GB free → warn, ≥ 2 GB → fail), `recording-tracks` (profile RecTracks includes 4 tracks → warn if not; read the ACTIVE profile from `global.ini`/`user.ini` `[Basic] Profile`, not a hard-coded name),
`adapter-live` (if a game adapter is running, `live.updatedAt` within 15 s), `teams-resolve` (series.teamA/B exist in teams), `veto-consistent` (every veto step team is A or B), `talent-slots` (unique slots).
Each check: `{id, level, title, detail, fix}`. `clear = no fails`.

Watchdogs (every 5 s): `video-without-audio` (a CAM · browser source visible and its AUDIO · twin at −inf for 2 samples → refresh that audio input, once per minute max), `adapter-stale`, `replay-buffer-stopped-during-live`, `disk-filling`. Each fires a `{type:"log"}` line and a preflight warn.

## 9. Overlay pages (packs/<game>/overlay/*.html + overlays/_shared/)

Every page: 1920x1080, transparent body, loads `/overlays/_shared/tokens.css` and `/overlays/_shared/core.js`.
`core.js` exposes `CTA.connect({page})` → calls `CTA.onState(fn)`, `CTA.onLive(fn)`; helpers `CTA.team(state,id)`, `CTA.esc`, `CTA.txt(el, s)`, `CTA.show(el, bool)` (uses `.fx/.in` transitions),
`CTA.mapArt(state, mapName)`, `CTA.applyBrand(state)` (sets `--brand-primary`, `--brand-secondary`, `--brand-accent`, `--brand-font` on `:root`). Single WebSocket per page. Polling `/api/state` every 5 s ONLY if the socket is down.
Pages per pack: `ingame.html` (series bug driven by `live` when adapter connected else `series`, lower third, ticker, timeout, corner tag), `cards.html` (vs, veto, draft, standings, set, games, matchstats, roster, bracket, scoreboard, mvp, h2h, schedule — `show.card` selects, gated by `pack.caps.cards`), `standby.html` (countdown / BRB / outro), `desk.html?who=casters|hosts` (nameplates).
Team colours: `team.color` tints plates; fallback pack theme. Safe area 96/54 px. Never position with `translate(-50%)` on an animated element (`.fx` animates transform) — use `calc()`.
Scorebug style by pack `overlay.bugStyle`: `rounds` (CS2/Val: round score + per-player alive/hp dots + bomb), `goals` (RL: score + clock + boost bars), `kills` (LoL/Dota: kills, gold, objectives), `fgc` (games won pips), `eafc` (score + clock).

## 10. Control room (web/)

Vite + React 18 + TypeScript + Tailwind v4 + `motion` (framer) + `lucide-react` + `cmdk` + `sonner` + `zustand`. Fonts via `@fontsource-variable/inter`, `@fontsource/barlow-condensed`, `@fontsource-variable/jetbrains-mono`. Build output `web/dist`; `vite.config.ts` `base: '/'`, dev proxy `/api`, `/ws`, `/packs`, `/overlays` → `http://127.0.0.1:7700`.
State: one zustand store fed by the WS (`hello`, `state`, `live`, `obs`, `preflight`, `adapters`, `log`). Patches go `POST /api/state` (optimistic apply). Actions go `POST /api/obs/*`.
Design: follow `docs/DESIGN.md` exactly. Layout per DESIGN.md §Layout.

## 11. Landing (site/index.html)

Single static page, same tokens, hero = a faithful CSS/HTML mock of the control room with a pulsing PROGRAM tile, then features (Preflight, Drift, Watchdogs, Templates per game, Veto), "Runs on your OBS", "Free and open source" with a "Support the project" block, FAQ. No external requests except Google Fonts allowed here (it is a website, not an overlay).

## Additions
(builders append here)

## Additions — agent core

Files: `agent/src/{index,config,state,hub,http,registry,preflight,watchdog,log}.js`, `agent/src/obs/{bridge,collection,drift}.js`, `agent/README.md`.

- **`agent/src/registry.js`** (new, not in the §tree): adapter + simulator registry. Imports every `adapters/*.js` and `sim/*.js` at boot, skips `_*.js`, one log line per broken module. Adapters are `create()`d at load with `{config, emit, log, state}`; `emit()` runs through `adapters/_normalize.js` `normalize(partialLive, state)` when that file exists, then `state.setLive()`. Sims are started with `start({emit, state, log})`. `live.source` is set to the adapter id / `sim:<id>` on start and reset to `manual` when nothing is running.
- **State API** (`state.js`): `get()`, `patch()`, `replace()`, `undo()`, `setLive()`, `resetLive()`, `onChange(fn)`, `onLive(fn)`, `load()`, `watch()`, `revision()`. `POST /api/state` answers `{ok, version, rev}` — `version` is the schema version (1), `rev` a monotonic change counter. A patch that carries `live` is stripped to `live.source` before merging. `state.json` on disk fills missing top-level keys from defaults; `live` is never written.
- **Default sample state** adds `settings.teamMap {A,B}`, `settings.vdo {room,password}`, `settings.obsPassword`, `settings.obsPort`, `settings.startggToken`. Talent roles `HOST` / `CASTER` decide the audio bed (casters = role matches `/CAST|ANALYST/`).
- **`show.replay`** `{path, savedAt}` is patched by `POST /api/obs/replay {action:"save"}`; `cut:true` (or a scene name) cuts after the save.
- **Extra REST routes**: `GET /api/sims`, `POST /api/obs/reload` (re-read scene list/status), `GET /api/obs/collection/summary`, `POST /api/log {tag,msg}`. `POST /api/stats/ocr` returns 501. OBS actions while disconnected return **503** `{ok:false,error:"OBS is not connected"}`; bad input 400; unknown route 404.
- **WS**: client `{type:"obs", action, ...body, id?}` is answered with `{type:"obs-result", action, id, ...result}` or `{type:"error", action, id, error}`; `{type:"ping"}` gets `{type:"pong", t}`. `hello.adapters` is `{adapters:[...], sims:[...]}` (same shape as the `adapters` broadcast).
- **Bridge status** adds `ready` (scene list has loaded), `port`, and `preview` works without studio mode: `setPreview` stores a local ARM slot and `take()` cuts to it. Meters are dBFS peaks (max channel), floored at −100; an input with no levels in the mix reports −100. `bridge.getSceneItems(scene, {fresh})` (5 s cache), `getInputSettings(name)`, `listInputs(kind)`, `refreshBrowserSource(name)`, `call()` are exposed for preflight/drift/watchdog. `resolveScene` accepts a two-character prefix ("05").
- **Collection recipe** (`recipe.default`, exported as `RECIPE_SCENES`, `RECIPE_BED`, `RECIPE_PAGES`): source names `GFX · In-Game|Cards|Standby|Desk (casters)|Desk (hosts)`, `CAM · <talent name> (VDO.Ninja)` / `AUDIO · <talent name> (VDO.Ninja)`, `AUDIO · Desktop / Game`, `GAME · <PACK SHORT>`, `REPLAY · Last Clip` (→ `settings.replayDir` or `agent/data/replay/replay.mp4`), `BG · Colour` (pack `theme.secondary`) plus `BG · Loop|Starting Soon|Outro` only when `packs/<game>/assets/media/{bg_loop,starting_soon,outro}.mp4` exist; `Stinger` transition only when `stinger.mp4` exists; `GUIDE · Title-safe` only when `packs/<game>/assets/guide.png` exists. Groups: `DESK · 2-BOX` / `DESK · 3-BOX` (hidden, ≥3 talent) per desk scene, `CASTER PiP (bottom corners)` (hidden) in 04. VDO.Ninja view ids are `<room><slot>`. No scene hotkeys are written.
- **Drift** adds kind `item-enabled` (item present but visibility differs from the build) alongside the five contract kinds; VDO.Ninja passwords are masked in `url-changed` entries; when OBS is disconnected the list is a single `scene-missing` row saying so.
- **Preflight** reads the active profile via `user.ini` then `global.ini` `[Basic] ProfileDir|Profile`; `disk-space` uses `fs.promises.statfs` (PowerShell fallback). A running simulator counts as a live source for `adapter-live` / `adapter-stale`. `pack-loaded` is a **fail** when `packs/<game>/pack.json` is missing.
- **Log line shape**: `{t, level, tag, msg}`; ring of 500; `GET /api/log?n=`.
- **CLI**: `--sim <game>`, `--port <n>` (or `CTA_PORT`). Port in use exits 1 with a clear line.

## Additions — control room

Files: `web/{package.json,vite.config.ts,tsconfig.json,index.html}`, `web/src/{main,App,store,ws,api,types,hotkeys,styles.css}`, `web/src/components/*`, `web/src/layout/{Rail,Air,StatusBar}.tsx`, `web/src/views/{Show,Match,Graphics,Data,Rundown,Preflight,Setup}.tsx`, `web/mock/server.mjs` (a fake agent on :7720 for visual checks — `node web/mock/server.mjs`; it is not the agent).

What the control room sends / expects beyond §7 (the agent should accept these; where it already does, this just records it):

- **`POST /api/obs/mute {pattern:"talent", on}`** — the literal pattern `talent` means "every talent audio input" (`AUDIO · <talent name> (VDO.Ninja)` twins). The UI has no way to know the input names. Other patterns are passed through as substrings/regex per §5.
- **`POST /api/obs/replay {action:"save", cut:true}`** is what the Air column's SAVE & CUT and the `R` hotkey send (cut to `05`).
- **`POST /api/obs/scene|preview {name}`** — the UI sends the full scene name resolved from the live scene list; a rundown row's `scene` may be a two-character prefix (`"04"`) and is resolved client-side against `obs.scenes`, falling back to the recipe names. The agent's own prefix resolution is a welcome backstop.
- **`POST /api/obs/collection/install`** must answer non-2xx with `{error}` when it refuses (OBS running); the UI shows that text verbatim under the button.
- **`POST /api/preflight/run`** may return the preflight object; if it does the UI applies it immediately instead of waiting for the next WS broadcast.
- **`GET /api/adapters`, `hello.adapters`, `{type:"adapters"}`** are accepted as either a plain array or `{adapters, sims}`; **`GET /api/sims`** is consumed for the simulator cards (`[{id, label, running}]`) with a built-in fallback list (cs2, valorant, rocketleague, lol).
- **`GET /api/log?n=`** and `{type:"log"}` accept strings or `{t, level, tag, msg}`; the UI formats objects as `HH:MM:SS [tag] msg`.
- **`POST /api/adapters/startgg/run {slug, token}`** — the start.gg import form posts here; a 404/501 is surfaced as an error toast. The UI also patches `settings.startgg.slug` after a successful run (the token is never written to state).
- **`show.standby.mode`** values used by the composer: `off | countdown | brb | schedule | outro`. `+5/+10/+15` set `targetAt` (epoch ms) and force `mode:"countdown"`.
- **`show.timeout`** is `{reason, seconds, startedAt}` (epoch ms); the `5` hotkey toggles a 60 s `TACTICAL TIMEOUT`.
- **`settings.teamMap`** is swapped as `{A: prev.B, B: prev.A}` (default `{A:"left", B:"right"}` when unset).
- **Overlay count in the status bar** is parsed from the `browser-sources-online` preflight check's `detail` (first integer). A dedicated `overlays: N` on `hello` / `{type:"obs"}` would be cleaner — please add if convenient.
- **Optimistic patches**: every edit is applied locally with §2 merge rules, then `POST /api/state`; on a non-2xx the local state is rolled back and a toast shows `{error}`.
- **Hotkeys** (ignored while typing in a field or with ⌘K open): `F1–F8` arm the scene with that recipe number (`01`–`08`) to preview, or cut it when `settings.fastCut` is on; `Ctrl/⌘+Z` undo; `1–5` bug/ticker/corner/lower third/timeout, `0` clear card, `R` save replay & cut, `T` arm TAKE (press again within 3 s to take), `M` mute talent, `Esc` disarm/close, `Alt+G/A/X/D/U/P/S` tabs, `Ctrl/⌘+K` palette.

## Additions — overlays

Owner: overlay packs builder. Files: `overlays/_shared/{tokens.css, skeleton.css, core.js, render.js, preview.html, devserver.mjs, sample-state.json, fonts/}` and `packs/<game>/overlay/{ingame,cards,standby,desk}.html + skin.css`.

**Runtime (core.js).** `CTA.connect({page})` opens ONE WebSocket to `/ws?role=overlay&page=<page>`, reconnects with backoff 1 s → 10 s (×1.7) and polls `GET /api/state` every 5 s only while the socket is down (`<html data-ws="up|down">` shows which). Handles `hello` (`m.state`), `state` (`m.data`), `live` (`m.data` → `state.live`, fires `CTA.onLive` only). `/api/packs` is fetched once; if it fails the page tries `/packs/<id>/pack.json`, then `CTA.fallbackPacks[<id>]` (hard-coded defaults for all 8 ids, Valorant with valorant-api.com splash URLs). `CTA.onReady(fn)` fires once the pack is resolved; `CTA.onState` / `CTA.onLive` are held until then so renderers never see a null pack. **The pack an overlay page renders is the `<id>` in its own URL** (`/packs/<id>/overlay/…`), not `state.game` — a cs2 page stays cs2 if the show is on another game.

**Helpers (§9).** `team(state,id)` also matches `short`/`tag`/`name` case-insensitively and returns a blank record (never undefined). `mapArt(state,name)` matches `pack.maps[].name|id` (ignoring `de_` and punctuation); returns the `art` URL as-is when absolute, else `/packs/<id>/<art>`, else `null`. `sideLabel(pack, side)` accepts an index, a pack label, or adapter strings (`CT/T/ATK/DEF/BLUE/ORANGE/RED/RADIANT/DIRE/left/right/0/1/A/B`) and maps them onto `pack.sides`. `fmtClock(seconds)` → `m:ss` (`h:mm:ss` over an hour). `countdown(targetIso|epochMs|seconds)` → `{text, done, total}`. `applyBrand(state)` sets `--brand-primary/-secondary/-accent/-font/-font-weight/-logo/-primary-rgb` on `:root`; precedence is tokens.css defaults < `pack.theme` < `event.brand` < `team.color` (as `--team` inline on team plates). `event.brand.font`: `barlow|bebas|saira|custom` (`custom` reads `event.brand.fontFamily`; `saira` is not bundled and falls back to Barlow offline; `bebas` flips the display weight to 400 because Bebas Neue only ships one weight). Also exported: `CTA.patch(p)`, `CTA.post(url, body)`, `CTA.tick(fn, ms)`, `CTA.query(k)`, `CTA.pack`, `CTA.packs`, `CTA.state`, `CTA.connected`.

**Renderers (render.js).** Pack pages are thin: `CTA.connect({page}); CTA.render.ingame({bugStyle})` / `.cards()` / `.standby()` / `.desk({who})`. `bugStyle` resolution: `pack.mode === "br"` → `br`; else `pack.overlay.bugStyle`; else the page's own default. Styles: `rounds` (cs2/valorant: round score, round/clock/phase, 5 hp dots per team from `live.players[].hp/alive`, side chips, bomb bar for `live.bomb.state === "planted"|"defusing"`, the round-history bar from `extra.roundWins` when the feed reports it, and timeouts remaining beside each side chip from `extra.sideExtra.<A|B>.timeouts` — one dot per timeout left, since formats differ on how many a side starts with), `goals` (rocketleague: clock with `+` and OVERTIME label when `live.overtime`, 3 boost bars per side from `live.players[].boost`, 2.6 s goal flash on a new `live.events[]` entry with `type:"goal"` — `event.team: "A"|"B"` picks the colour, and `extra.lastGoal {scorer, speed, assist}` names the scorer and shot speed on it, falling back to the team's short name), `kills` (lol/dota2: `live.scoreA/B` or summed `players[].kills`; strip from `live.extra`), `br` (apex: `live.extra.squadsAlive|playersAlive|ring|leader{name,kills}`, falling back to `players[]`), `fgc` (games won from `live.scoreA/B` or `extra.gamesA/B` when connected, else `series.scoreA/B`; games-won pips plus current-game round pips from `extra.roundsA/B` when a feed reports them (`extra.roundsToWin`, default 2); wins needed from `series.format` `FTn` → n, `BOn` → ceil(n/2), and the format wins over `extra.firstTo` so the plate never reads "BO3" beside "FIRST TO 3"; character from `extra.charA/charB`, falling back to `team.roster[0].role`), `eafc` (score + clock; half from `live.round` 1|2 / `live.phase` `halftime|over`; a penalty shootout shows `extra.pensA/B` instead of the series line, since a shootout leaves the score level). When `live.connected` is false every style falls back to `series.scoreA/B` + current map/label. The bug's top is `--bug-top` (default `--safe-y`) so a skin can move it clear of a game HUD.

**State additions read by overlays (all optional):**
- `live.extra` (kills/br styles): `{ goldA, goldB, towersA, towersB, dragonsA, dragonsB, baronsA, baronsB, inhibsA, inhibsB, roshanA, roshanB, heraldsA, heraldsB, barracksA, barracksB, objectives:[{k, a, b}], squadsAlive, playersAlive, ring, leader:{name, kills} }`.
  `extra.roundWins` is the CS2 GSI `round_wins` map — `{ "1": "ct_win_elimination", "2": "t_win_bomb", … }`, keyed by round number, valued `<side>_win_<method>` with method one of `elimination|bomb|defuse|time`. It is read by `CTA.render.roundHistory(extra)` (pure, tested), sorted **numerically** because JSON string keys sort round 10 before round 2, and drawn coloured by the winning **side**, not by team colour: the feed only knows sides and they swap at half time. Side colours are the `--side-ct` / `--side-t` tokens. Markers carry `data-side` / `data-how` rather than class names — a `bomb` class collided with the planted-bomb plate's own `.bomb` rule and inherited its auto margins.

  The objective strip also accepts the side-keyed shape the Riot live endpoints give — `gold {BLUE|RED|A|B|RADIANT|DIRE}` and `objectives {<side>: {turrets, dragons, barons, heralds, inhibs}}` — because an adapter should not have to flatten it first. `turrets` and `towers` are the same row and never double up. Rows are ordered GOLD, TOWERS, DRAGONS, BARONS, ROSHAN, BARRACKS, INHIBS, HERALDS and capped at four, so the strip stays glanceable. `CTA.render.objectiveRows(extra)` is the pure function behind it and is covered by `agent/src/_selftest.js`.
- `stats.h2h`: `{ a:{ team, ign, stats:{<col>:v} }, b:{…} }` — if absent the h2h card takes the best row per team from `stats.scoreboard` by `pack.stats.mvpStat`; stat rows come from `pack.stats.scoreboardColumns` and rows where both sides are empty are skipped.
- `show.standby.brbTitle`, `show.standby.outroTitle` — per-mode headline overrides (`title`/`sub` belong to the countdown; outro credits list `state.talent`).
- `show.deskTopic` (string) shows the "ON THE DESK" topic bar on desk.html; `show.desk: false` hides the nameplate.
- `show.tickerText` is split on `|`, `•` or newline into ticker items; empty → event name/subtitle/platform/hashtag.
- `desk.html?who=casters|hosts` filters `state.talent[].role` with `/cast|analy|observ|comment/i` and `/host|desk|present|anchor/i`, sorted by `slot`, max 4; no match → everyone.

**Map art.** `pack.maps[].art` is used when present (Valorant: valorant-api.com splash URLs straight from pack.json); a missing entry or a broken image (`onerror`) shows the stylised tile (diagonal hatch in team/brand colour, map name in Barlow Condensed at 8 % opacity). Nothing in the overlays fetches or caches art — caching to `packs/valorant/assets/maps/` (§3) is the agent's job; until it exists the veto card needs the network for Valorant art.

**Dev harness.** `node overlays/_shared/devserver.mjs` (port 7710, no deps) serves the repo and fakes `/api/state` (GET + POST deep-merge), `/api/packs`, `/api/game` and `/ws` (hand-rolled; `hello`, then `live` every 2 s cycling scores/hp/boost/bomb). `overlays/_shared/preview.html?page=<pack>/<page>` iframes any page at 50 % over a checkerboard with toggle buttons that POST patches — it works against the real agent on :7700 too (same paths). `bash docs/shots/shoot.sh [filter]` captures every graphic with headless Chrome into `docs/shots/*.png`.

**Rules kept from the first live event (Sep 2026).** One WebSocket per page, never SSE; `CTA.show()` cancels the pending hide timer and forces a reflow before adding `.in` (rAF does not fire in an unpainted browser source); no `.fx` element is positioned with `translate(-50%)`; the veto/roster edge bars are `::after` elements because an inset box-shadow is painted under the art.

## Additions — adapters

Files: `agent/src/adapters/{_normalize,_gsi,cs2gsi,dota2gsi,rlstats,lolclient,apexlive,manual,startgg,_selftest}.js`, `agent/src/adapters/README.md`, `agent/src/sim/{_common,cs2,valorant,rocketleague,lol}.js`, `packs/{cs2,valorant,rocketleague,lol,dota2,apex,fgc,eafc}/pack.json`.

- **Adapters emit already-normalized `live`.** Every adapter and sim builds a raw report (`sides.left/right` + players keyed by the game's side) and emits `normalize(raw, state)`. `normalize()` is **idempotent** (an object without `sides` passes through with defaults + fresh `updatedAt`), so the core's `emitFor()` calling it again is harmless.
- **`create()` options**: `{ config, emit, log, state | getState, patch?, capture? }`. `capture(payload)` is passed to `capturable` adapters; it is a no-op until the Data tab switch is on, and strips tokens itself (agent/src/capture.js). `state` may be the store (has `.get()`) or a snapshot; `getState` (fn) is accepted for tests. Ports resolve `config.PORTS.<name>` → `config.ports.<name>` → default. Bind host is `127.0.0.1`. The adapters read `config.gsiBind` / `config.apexBind`, but nothing in `config.js` sets them yet, so an observer on another PC cannot feed the agent - that needs a real setting plus a non-default token first. `log` may be the core's `{info(tag,msg)}` object or a plain function. `install()` accepts `{ config, state }` where `state` is a snapshot (reads `settings.gsiToken`).
- **A/B mapping order** (`_normalize.js`): 1) `settings.teamMap {A,B}` — token = side key (`CT`,`T`,`BLUE`,`ORANGE`,`RADIANT`,`DIRE`,`ATK`,`DEF`), team index (`0`/`1`, `team2`/`team3`, `order`/`chaos`) or a team-name substring; 2) game team names matched against `state.teams[series.teamA/B]` `.name/.short/.tag`; 3) sticky **first-seen left = A** per `live.source` (survives a halftime side swap); `settings.swapSides: true` flips the default. `resetFirstSeen(source?)` is exported — call it on `POST /api/game`.
- **Extra `live` fields** (all merge-safe, no top-level nulls because `merge()` deletes null keys — `sideA/sideB` are `''` and `bomb` is `{state:'none', countdown:0}` when absent):
  - `live.names {A, B}` — team names as the game reports them (GSI cfg team names, RL team names, Dota team_name).
  - `live.mode` — `'versus'` (default) | `'br'` (Apex). In BR mode `live.squads[] {id, name, kills, damage, alive, players[], placement}` (sorted alive-first, then placement, then kills); `sides` are placeholders `SQUADS`(alive count) / `ELIMINATED`.
  - `live.extra` — game-specific bag (`sideExtra {A,B}` = extra side fields such as `timeouts`, `seriesWins`, `color`; CS2 `mapPhase`, `roundPhase`, `roundWins`, `spectating`; Dota `draft`, `radiantWinChance`, `roshan`, `netWorth`, `gameState`; RL `feed` (`stats-api`|`sos`), `lastGoal {scorer, team, speed, assist}`, `isReplay`; LoL `objectives {BLUE,RED: {turrets,dragons,barons,heralds,inhibs}}`; Apex `ring {stage, closing, closesAt, currentRadius, endRadius}`, `observer`, `squadsAlive`, `squadsTotal`, `winner`). Sims set `extra.sim: true`.
  - Player `extra` per game: CS2 `{steamid, slot, helmet, flashed, burning, roundKills, equipValue, mvps, defusekit, hasBomb}`; Val sim `{ult, ultCost, ultReady, acs}`; RL `{goals, saves, shots, demos, speed, isSonic}` (`kills` = demos); LoL `{level, cs, wardScore, respawnTimer, position, items}` (`score` = CS); Dota `{level, lastHits, denies, gpm, xpm, netWorth, items, respawnSeconds}` (`money` = gold, `score` = net worth); Apex `{damage, downs, teamId}` (`score` = damage, `champion` = legend).
- **Extra phases**: `gameover` (match over — distinct from `over`, which is CS/Val round over) and `draft` (Dota hero selection). Full set: `warmup|freezetime|live|over|halftime|paused|replay|podium|gameover|draft|unknown`.
- **Event types** (`live.events[].type`, `t` = ms epoch, or game-time ms for LoL): `match_start`, `match_end`, `round_end`, `halftime`, `kill`, `bomb_planted|bomb_defused|bomb_exploded`, `spike_planted|spike_defused|spike_exploded`, `goal`, `save`, `shot`, `demo`, `overtime`, `dragon`, `baron`, `herald`, `grub`, `atakhan`, `turret`, `inhib`, `first_blood`, `multikill`, `ace`, `roshan`, `draft`, `down`, `squad_eliminated`, `ring`, `info`.
- **`startgg`** is not live: `create()` returns `{ start, stop, status, run(args) }`; `run({ slug, token?, apply? })` imports and, unless `apply:false`, calls `patch({teams, bracket})` (the core's `state.patch` is used when no `patch` option is passed). Token: `args.token` → `settings.startggToken`. Suggested route: `POST /api/adapters/startgg/run` (not yet in http.js). Imported teams carry `startggId`; matches carry `startggId`; `bracket.format` is `double` when losers rounds exist.
- **pack.json extras**: `sims: [...]` (simulator ids for the pack), `capture {kind, window}` (§6), `theme.accent` (RL orange), `maps[].active` (in the current competitive rotation), `maps[].uuid` + absolute `art` URL for Valorant (valorant-api.com splash; cache per §3), `mode: "br"` on apex, `notes`. `sides: []` on apex (no A/B).
- **Simulators** accept `start({ emit, state | getState, log })`, stamp `source: "sim:<id>"` and emit every 500 ms. Pacing constants are exported (`PACE` in cs2/valorant, `CLOCK_RATE` in rocketleague, `SPEED` in lol): CS2/Val start mid-first-half (round 10) so halftime and match point fit in ~3–4 min; RL clock runs at 1.5×; LoL game clock at 8×.
- **Self-test**: `node agent/src/adapters/_selftest.js` — binds/releases every port, verifies parsers with sample payloads, runs each sim 5 s, exits 0; exits 1 on a leaked handle.

## Additions — title switch, live OBS sync, releases (15 Sep 2026)

**The collection is title-agnostic.** The generator (`obs/collection.js`) now writes
browser sources at `/overlay/<page>.html` (served from `overlays/live/`, one page
per recipe role) and one capture input named **`GAME · Capture`**. A page under
`/overlay/` resolves its pack from `state.game` on every state message and swaps
`<link id="skin">` to `/packs/<game>/overlay/skin.css`; a page under
`/packs/<id>/overlay/` stays pinned to that pack (previews, `shoot.sh`). One
collection therefore serves every title. `CAPTURE` and `captureSettings(cap)` are
exported so the generator and the live sync cannot disagree; Apex and Dota now have
real game-capture windows.

**`POST /api/game {game, syncObs?}`** is a real switch (`game.js`):
`gameSwitchPatch()` resets `series` (maps, format, scores, mapIndex, status),
`veto`, `draft`, `standings`, `set`, `matchStats`, `stats`, clears `show.card`
when the new title cannot show it, strips cards the title lacks from rundown rows,
and blanks roster roles that are not in `pack.roles`. It keeps event, brand,
teams, series slots and label, bracket, talent, rundown shape and settings. It stops
another title's simulator or adapter and calls `resetFirstSeen()`. When OBS is
connected and ready it then runs **`obs/sync.js`**: every browser source whose URL is
`/packs/<x>/overlay/<page>.html` is repointed to `/overlay/<page>.html` (query
kept), the capture source is renamed to `GAME · Capture` and given the title's
window, or removed and recreated in `04 · IN-GAME` when the input kind has to
change (obs-websocket cannot change a kind in place). Reply:
`{ok, game, from, reset[], kept[], stopped[], obs: {changes[]} | null}`. The
whole thing is one undo.

**`POST /api/obs/sync`** runs that sync on demand. **`GET /api/obs/collections`**
lists every `*.json` in OBS's scenes folder with `{file, name, ours, scenes, game,
active}` — `ours` means a GFX browser source pointing at this agent's pages; `game`
is `any` for a title-agnostic build or the pinned pack id — plus `active` (from
`GetSceneCollectionList` when connected) and `obsRunning`.
**`POST /api/obs/collection/activate {name}`** = `SetCurrentSceneCollection`.
**`POST /api/obs/collection/remove {file}`** moves one of ours out of the folder
(`.removed-<stamp>`), only while OBS is closed, never a foreign collection.

**`POST /api/event/new {game, name?, subtitle?, hashtag?}`** replaces the state with
`newEventState()`: neutral event, brand from the pack theme, two placeholder teams
sized by **`pack.rosterSize`** (new field: 5 cs2/valorant/lol/dota2, 3
rocketleague/apex, 1 fgc/eafc), the title's default format and pool, a single-match
bracket, and `defaultRundown(pack)` — which only asks for cards the title has
(**no map-veto block on Rocket League**; a standings block on Apex; "Game 1" where
the title plays games). `settings` and `talent` are kept. **`GET /api/game/rundown`**
returns that default for the current title; the Rundown tab's "Load default" uses it.

**Liquipedia rosters.** `liquipedia.js` adds `fetchWikitext`, `parseSquad`
(`{{Squad|status=active |{{Person…}}}}` and `{{ActiveSquad {{SquadPlayer…}}}}`,
staff excluded, former squads skipped), `parseInfobox` (`image`/`imagedark` name
the logo file exactly), `fileUrl` and `lookupRoster`. `POST /api/liquipedia/team`
now returns `roster[]` (players in this app's shape, roles mapped onto
`pack.roles`, IGL from the CS wiki's flag, flag in `note`) and, with `slot`,
applies name + logo + roster to that team (`applyRoster:false` to skip). Still one
team per call, still confirmed on a search hit. Control room: `LiquipediaLookup`
(per team) and `LiquipediaMatch` (both slots, sequential) on the Match tab.

**Version + updates.** `GET /api/version` → `{version, install: "portable"|"source",
node}`; `/healthz` carries `version`. `GET /api/update[?force=1]` reads the
`latest.json` asset of the newest public release,
`https://github.com/<package.json releases.repo>/releases/latest/download/latest.json`
(a constant, never a setting; `--update-url` / `CTA_UPDATE_URL` for staging; cached six hours) and answers `{version, latest, available, url, sha256, size, file, keyId, sig, notes}`;
a failed check says so rather than claiming "up to date". The manifest is signed:
`keyId` names the release key, `sig` is ECDSA P-256 / SHA-256 (IEEE P1363, base64) over
`cleartoair-manifest-v1\n<version>\n<url>\n<sha256>\n<size>\n<file>\n` (notes and date
unsigned). A manifest without a valid signature from a key built into this copy
(`agent/src/release-key.js`) answers `{ok: false, available: false, error: "manifest
signature invalid", detail}`, never `available: true`; the launcher re-verifies the same
fields against its own copy of the key before downloading. The status bar shows the
version, or an `update · vX` link. Packaging and the tray launcher: `docs/RELEASE.md`,
`tools/package.mjs`, `tools/launcher/`.

**Player photos and roles (15 Sep, later).** `POST /api/liquipedia/team` also
resolves every roster member's page in one batched `action=query` (up to 50 titles)
plus one `imageinfo` call: `parsePlayerInfobox` gives the photo file, real name,
country and per-game roles (`roles=igl` / `awp,rifle` / `carry` / `top`), mapped onto
`pack.roles` through an alias table; photos are cached under `packs/_players/<slug>`
(gitignored, shared across titles because a person is not per-game). A team applied
to a slot sheds the slot's old `seed`/`record`/`note`. Wikis whose roster is
`{{ActiveSquadAuto}}` (Rocket League) carry no roster in wikitext: `lookupRoster`
falls back to `fetchRendered` (`action=parse`, its own 30 s throttle) and
`parseRosterHtml` reads the rendered "Active" table. The versus card draws one tile
per player under each badge, sized by `pack.rosterSize`. `gameSwitchPatch` blanks a
portrait under another pack's sample art but keeps cached photos.

## Additions — remote seats / the hosted control room (7 Oct 2026)

Full guide: `docs/REMOTE.md`. The relay itself: `relay/README.md`.

**Shape.** The agent dials OUT to a Cloudflare Worker (`relay/`) and holds one
WebSocket. A browser anywhere loads the same built control room from that Worker;
every `/api/**`, `/packs/**` and `/ws` request is tunnelled down the socket,
stamped with the seat it came from, and run through the agent's **own**
`createRequestHandler` — one API, not two. No port is opened on the broadcast PC.

**OFF by default** and off on every fresh install. The relay URL, the room id and
its key live in `agent/data/remote.json`, written only by `POST /api/remote/enable`
from a local caller — never from state, because a state patch can be sent by
anyone at the desk and whoever names the relay names where the control traffic
goes (the same reasoning as `UPDATE_URL`).

**Seats.** `producer` (the air and the desk), `scorer` (score, maps, veto, draft,
standings, set, stats, teams, rundown), `viewer` (read-only). A producer is held at
the door until the operator admits them, unless `requireAdmit` is off. Starting or
stopping the stream needs the `streamControl` cap, off by default. Codes are
`XXXX-XXXX` from a 31-char alphabet (no I/L/O/0/1); the link is
`https://<relay>/j/<room>/<code>`, one use, one hour. A seat lasts 14 hours.

**`agent/src/remote-policy.js` decides everything** — the relay is never trusted,
it only reports which seat called. Deny by default: a route absent from its rule
list is unreachable from the internet, so every `/api/remote*` admin route is
unreachable by construction. `/api/remote/me` is answered by `remote.js` itself
(the agent is the only end that knows who is asking) and is the one thing a seat
held at the door may call.

**Redaction is one function, in one place.** `redactState()` blanks
`settings.obsPassword`, `settings.gsiToken`, `settings.startggToken` and
`settings.vdo.password` out of the REST answer, the `hello` frame and every `state`
push, and reports what it held back in `state.__remote = {role, redacted[]}`. It
deep-clones first, so it can never reach the agent's live object. No seat may patch
`settings` or `live`.

**`hub.attach(sink, {transform, guard, label})`** makes a remote seat a client in
the hub's own map, so every existing broadcast reaches it unchanged; `transform`
is what it may see (redaction) and `guard` is what it may send up. `hub.send` now
applies a per-client transform, and `onMessage` runs a per-client guard.

**New routes** (local callers only): `GET /api/remote`, `POST /api/remote/enable`,
`/disable`, `/caps`, `/invite`, `/revoke`, `/admit`, `/kick`. `GET /api/obs/shot`
takes `fmt=jpg&q=<1-100>` (PNG stays the local default); the policy forces a
tunnelled thumbnail to 480px JPEG q55 and strips `cut`, and the hosted room polls
every 8 s instead of 4.

**Frame budget.** One JSON text frame per request, under Cloudflare's 1 MiB cap:
request bodies 256 KB, responses 640 KB. A bigger answer is refused with a plain
message rather than a truncated body.

**The control room is one bundle for both places.** `web/src/remote.ts` asks
`/api/remote/me` on boot; `null` means "this is the rig". The Remote panel renders
on the rig only, and `can(seat, 'air')` gates the air controls.
`tools/relay-assets.mjs` copies `web/dist` to `relay/public`; `tools/package.mjs`
also ships `relay/src/protocol.js` into a rig build, which is the one relay file
the agent imports.

**Tests.** `relay/test/e2e.mjs` (60 checks: a real agent process, the real worker
and room on Node stand-ins for Cloudflare, a cookie-holding fake browser) and 59
policy checks in `agent/src/_selftest.js`. `relay/test/serve.mjs` runs the relay
locally; `relay/test/shot.mjs` screenshots the hosted desk. **Never deployed to
Cloudflare** — see "Not verified" in `docs/REMOTE.md`.
