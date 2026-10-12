# Game adapters (`agent/src/adapters/`)

Every adapter is a plain ESM module with the CONTRACTS §4 interface:

```js
export const id, games, label, describe;
export function create({ config, emit, log, getState, patch }) -> { start(), stop(), status() }
export function install({ config, getState }) -> { files: [{ path, content }], instructions }
```

`emit(live)` receives an **already-normalized** §2 `live` object: every adapter builds a raw report
(`sides.left/right` + players keyed by the game's own side, e.g. `CT`/`T`) and passes it through
`normalize(raw, getState())` from `_normalize.js`, which assigns A/B. `normalize()` is idempotent,
so the core may call it again on the emitted object without harm. Adapters never decide A/B.

`getState` (optional) lets an adapter read `settings.gsiToken`, `settings.teamMap`, team names.
`patch` (optional) is only used by `startgg` to write the import into state.

Run the smoke test any time: `node agent/src/adapters/_selftest.js` (binds and releases every
port, pushes sample payloads through each parser, runs each simulator for 5 s, exits 0).

## Team mapping (`_normalize.js`)

`state.settings.teamMap = { A: <token>, B: <token> }` where a token is a side key (`CT`, `T`,
`BLUE`, `ORANGE`, `RADIANT`, `ATK`…), a team index (`0`/`1`, `team2`/`team3`), or a substring of the
team name the game reports (`"alph"` matches "Alpha"). Name-substring mapping survives a CS2/VAL
halftime side swap; side-key mapping deliberately follows the side.

With no `teamMap`, the default is **sticky first-seen = A**: the team name first seen on the left is
A for the rest of that source's session (so a halftime swap keeps A = A). If a game gives no team
names (LoL, RL casual) left = A. `settings.swapSides: true` flips the default. `resetFirstSeen()`
clears the memory (call it on `/api/game` switch).

Also exported: `prettyWeapon('weapon_ak47') -> 'AK-47'`, `fmtClock(seconds)`, `pushEvent(buf, type, text)`.

## Adapter table

| id | game | transport | port | install | connected when |
|---|---|---|---|---|---|
| `cs2gsi` | cs2 | HTTP server (game POSTs) | 7701 | `gamestate_integration_cleartoair.cfg` → `<Steam>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\` | a payload with the right `auth.token` arrived < 15 s ago |
| `dota2gsi` | dota2 | HTTP server (game POSTs) | 7702 | same cfg → `<Steam>\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration\` **plus** launch option `-gamestateintegration` | same |
| `rlstats` | rocketleague | raw TCP client → fallback WebSocket client | 49123 → 49122 | `<RL>\TAGame\Config\DefaultStatsAPI.ini` (some guides: `TAStatsAPI.ini`), `[TAGame.MatchStatsExporter_TA]` `PacketSendRate=30` `Port=49123` | a socket is open and messages are fresh |
| `lolclient` | lol | HTTPS poll every 1 s | 2999 | nothing — the game client serves it | last poll succeeded < 5 s ago |
| `apexlive` | apex | WebSocket **server** (game connects) | 7777 | launch options `+cl_liveapi_enabled 1 +cl_liveapi_ws_servers "ws://127.0.0.1:7777" +cl_liveapi_use_protobuf 0` | the game socket is open |
| `manual` | all | none | – | nothing | never (scores come from the Match tab) |
| `startgg` | all | GraphQL client (one-shot) | – | token in `settings.startggToken` | never (not live) |

All servers bind `127.0.0.1` by default. Since 0.3.3 the two GSI receivers (CS2 and Dota 2) can also listen
on the LAN for an observer PC: Data tab → Observer PC (`settings.gsiLan`, `_lan.js`). Only the exact
addresses listed there are admitted (no ranges), the GSI token is still checked, and refused senders show
in preflight. Every other receiver - Apex's LiveAPI, Rocket League's Stats API, League's poller - stays on
this PC only, so those games must run on the same PC as the agent.

GSI token (`_gsi.js resolveToken`): the first non-empty of `settings.gsiToken` → `config.settings.gsiToken` →
`config.gsiToken`, else the legacy `'cta'`. An empty setting never disables auth. `install()` prints the
current token into the cfg, so re-install the cfg whenever the token changes.

**Install writes the cfg (cs2gsi, dota2gsi; `_steam.js`).** An adapter that exports `steam = { appId, name,
installDir, cfgDir, createLast?, restart }` gets `POST /api/adapters/<id>/install`: Steam's registry value
(`HKCU\Software\Valve\Steam` `SteamPath`, then the HKLM `InstallPath`) → `steamapps\libraryfolders.vdf` → the
library listing the app (or holding its `appmanifest_<id>.acf`, whose `installdir` wins) →
`steamapps\common\<installdir>\<cfgDir>`. It writes only `gamestate_integration_cleartoair.cfg`, UTF-8 without a
BOM, via a temp file and a rename. The game's own cfg folder must exist (Dota's `gamestate_integration\` is the one
folder it creates). An existing file that does not start with `"Clear to Air"` is reported (`foreign`) and only
replaced on a second request with `replace: true`, which keeps it as `.old`. If the game is not found, the answer
carries the text to save by hand and every path it tried (`tried`). Local operator only: no remote-policy rule.

**Record raw game data (`capturable`; `agent/src/capture.js`).** A module exporting `capturable = true` receives
`capture(payload)` in `create()` and calls it with every raw message (GSI: each accepted POST; rlstats: each
framed message; apexlive: each LiveAPI message; lolclient: each `allgamedata` poll). It is a no-op until the
Data tab switch is on; then each payload goes to `agent/data/captures/<game>-<YYYY-MM-DD>.jsonl` (one header line,
then `{type:"payload", t, adapter, payload}` per line), tokens and every secret the agent holds removed, stopping
itself at 50 MB. Player names and IDs are kept: anonymise before sharing (the "Real payload" issue template).

### cs2gsi — what it yields

`map.name → mapName` (prettified: `de_dust2 → Dust II`), `map.round → round` (1-based while live),
`map.phase`/`round.phase` → `phase` (`warmup|freezetime|live|over|halftime|gameover|paused`),
`phase_countdowns.phase_ends_in → clock/clockSeconds` (or `bomb.countdown` when the bomb is down),
`map.team_ct/team_t {score,name}` → `sides.left (CT) / right (T)`, `allplayers` → `players[]`
(`hp, armor, money, kills, deaths, assists, weapon` = active weapon prettified, `alive`, `extra:
{steamid, slot, helmet, flashed, roundKills, equipValue, mvps, defusekit, hasBomb}`), `bomb
{state, countdown}`, events: `round_end`, `bomb_planted/defused/exploded`, `kill`, `match_start/end`.
Payloads whose `auth.token` ≠ `settings.gsiToken` get 401 and one log line.

The cfg requests Valve's observer set: `provider, map, map_round_wins, round, phase_countdowns, bomb,
allplayers_id/state/match_stats/weapons, allplayers_position ("0", optional), player_id/state/match_stats/weapons`.
Without `map_round_wins` the game never sends `map.round_wins` (`extra.roundWins`). Install saves it **without a
UTF-8 BOM**; anyone saving it by hand must do the same. A **playing** client only sends `player_*`; spectate (Watch tab, GOTV or `playdemo`) for `allplayers_*`.

### dota2gsi — what it yields

`map.clock_time → clock` (negative before the horn), `game_state → phase` (`draft` during hero
selection/strategy time, `freezetime` pre-game, `live`, `paused`, `gameover`), `radiant_score/dire_score`
→ sides `RADIANT`/`DIRE`, players with `champion` = hero (prettified), `hp`, `money` = gold, `score` = net
worth, `extra: {level, lastHits, denies, gpm, xpm, netWorth, items, respawnSeconds, scepter, shard, aegis}`,
`extra.draft {activeTeam, pick, radiant/dire {picks, bans}}`, `extra.radiantWinChance`, `extra.roshan
{state, endsIn}`, `extra.netWorth {RADIANT, DIRE}`, `extra.league {id, name, seriesType}`.

- Spectator payloads key players `player.team2.player0..4` (Radiant) and `player.team3.player5..9` (Dire);
  `hero` and `items` use the same keys.
- `player.teamN.playerN.team_name` is the **side** (`radiant`/`dire`), not the organisation. Org names come
  from `league.radiant.name` / `league.dire.name` (plus `tag`, `series_wins` → `sideExtra`), which the game only
  fills when spectating a league match; the cfg requests `"league" "1"` and `"events" "1"`.
- `scepter` = `hero.aghanims_scepter`; `aegis` = an `item_aegis` in any item slot. `aegis_picked_up` /
  `aegis_denied` from the `events` block become `info` events.
- `map.radiant_win_chance` is unconfirmed in live payloads: `extra.radiantWinChance` is omitted when absent.

### rlstats — what it yields

**Native Stats API** (sources: Psyonix Stats API doc, mirror
https://kevindjf.github.io/rl-stats-overlay/reference/stats-api/; github.com/zomlit/rocket-league-stats-api
`src/client.ts` + `src/envelope.ts`; github.com/DevJMD/rocket-league-stats-api README). A **raw local TCP
socket** on `Port` (default 49123) — not a websocket — carrying `{ "Event": "UpdateState", "Data": "<JSON
string>" }` envelopes; `Data` is usually a string and is parsed a second time (an object is accepted too).
Enabled in `DefaultStatsAPI.ini` (DevJMD calls it `TAStatsAPI.ini` — edit whichever exists), section
`[TAGame.MatchStatsExporter_TA]`: `PacketSendRate` (0 = off; it **is** the on switch; max 120) and `Port`.
There is no `bEnabled` key. v2.72 also has `WebPort` (websocket) — not used here.

UpdateState `Data`: `MatchGuid`, `Players[] {Name, PrimaryId, Shortcut, TeamNum, Score, Goals, Shots, Assists,
Saves, Touches, CarTouches, Demos, bHasCar, Speed, Boost, bBoosting, bOnGround, bOnWall, bPowersliding,
bDemolished, bSupersonic, Attacker?}`, `Game {Teams[] {Name, TeamNum, Score, ColorPrimary, ColorSecondary},
TimeSeconds, bOvertime, Frame, Elapsed, Ball {Speed, TeamNum (255 = untouched)}, bReplay, bHasWinner, Winner,
Arena, bHasTarget, Target? {Name, Shortcut, TeamNum}}`. Teams are placed by `TeamNum`, not array order.
`Boost`/`Speed` are absent for opponents unless spectating: the player gets `boost: 0` with
`extra.boostKnown: false` (render.js draws `n0(p.boost)`), and `extra.speed` is omitted.

Events handled: `UpdateState`, `GoalScored {GoalSpeed, GoalTime, ImpactLocation, Scorer, BallLastTouch,
Assister?}`, `GoalReplayStart/WillEnd/End`, `MatchCreated`, `MatchInitialized`, `CountdownBegin` → `freezetime`,
`RoundStarted` → `live`, `MatchPaused` → `paused` / `MatchUnpaused`, `ClockUpdatedSeconds {TimeSeconds,
bOvertime}`, `MatchEnded {WinnerTeamNum}`, `PodiumStart`, `MatchDestroyed`, `StatfeedEvent {EventName, Type,
MainTarget, SecondaryTarget?}`, `CrossbarHit` (info event); `BallHit`, `BoostPickup`, `PlayerJoined/Left`,
`ReplayCreated` are ignored. A new `MatchGuid` resets the match.

`GoalSpeed`: the doc gives Unreal units/s on the native feed (1 uu = 1 cm, km/h = uu/s × 0.036) while SOS
sends km/h, so a value above 400 is converted (`toKmh`); `extra.lastGoal.speed` is always km/h.

**SOS** (`game:update_state`, `game:goal_scored`, `game:match_ended`, `game:replay_start/will_end/end`,
`game:podium_start`, `game:clock_updated_seconds`, `game:match_created`, `game:initialized`,
`game:pre_countdown_begin`, `game:round_started_go`, `game:statfeed_event`) goes through the same switch, keyed
on a lower-cased, prefix-stripped event name.

Framing is brace-balanced JSON scanning (newline-delimited, length-prefixed and concatenated objects all work).
A truncated frame no longer swallows the stream: an unclosed object followed by a new `{"Event":` envelope, or
a balanced object that fails to parse, resyncs to that envelope, and the buffer is capped at 1 MB. Counts show
in `status().detail`.

Yields `sides BLUE/ORANGE` (`name`, `score`, `color`, `colorSecondary`), `clock` (counts up in OT), `overtime`,
`phase` (`warmup|freezetime|live|paused|replay|gameover|podium`), `players[] {boost, score, alive, kills=demos,
assists, extra:{goals,saves,shots,demos,touches,carTouches,speed,boostKnown,isSonic,demolished,boosting,onGround,
onWall,powersliding,hasCar,shortcut,id}}`, `ball {speed, team}`, `extra.lastGoal {scorer, team, speed (km/h),
assist, lastTouch, time}`, `extra.winner`, `extra.target`, `extra.matchGuid`, `extra.isReplay`, events `goal`,
`save`, `shot`, `demo`, `info`, `match_start/end`.

Connection order: TCP 49123 → (refused) → WS 49122 → backoff (1.6×, max 10 s) → TCP… forever until
`stop()`. When a feed drops it reconnects from TCP again.

### lolclient — what it yields

`gameData.gameTime → clock`, `allPlayers[]` → players (`name` = `riotIdGameName` ▸ `riotId` ▸
`summonerName`, `champion`, `team` BLUE (ORDER) / RED (CHAOS), `kills/deaths/assists`, `score` = CS,
`alive = !isDead`, `extra: {level, cs, wardScore, respawnTimer, position, items}`), team kill totals →
`scoreA/scoreB`, `events.Events` → `live.events` (last 20, deduped by `EventID`: DragonKill, BaronKill,
HeraldKill, HordeKill, AtakhanKill, ChampionKill, TurretKilled, InhibKilled, FirstBlood, Multikill, Ace,
GameStart, GameEnd), `extra.objectives {BLUE,RED: {turrets,dragons,barons,heralds,inhibs}}`.
`phase` = `warmup` before 0:00, `live`, `gameover` after a `GameEnd` event. A missing or empty `allPlayers`
(spectator / replay edge cases) yields no players instead of throwing. Event names (`KillerName`,
`VictimName`, `Recipient`, `Assisters`) may be a legacy `summonerName` or a `Name#TAG` Riot ID; they are
resolved to the player's `riotIdGameName` for event text and objective credit.

TLS: the API is served on loopback with Riot's self-signed certificate. Verification is disabled on a
dedicated `https.Agent` for that one request only. `NODE_TLS_REJECT_UNAUTHORIZED` is never touched.

### apexlive — what it yields

Battle-royale shape: `mode: 'br'`, `squads[] {id, name, kills, damage, alive, players[], placement}`
(sorted alive-first then kills), `players[] {team = squad name, champion = legend, kills, hp, alive,
score = damage}`, `phase` (`warmup|freezetime|live|gameover|podium` from `gameStateChanged` /
`matchStateEnd`), `extra.ring {stage, closing, closesAt, currentRadius, endRadius}`, `extra.observer`,
`extra.squadsAlive/squadsTotal`, `extra.winner`. Events: `kill`, `down`, `squad_eliminated`, `ring`,
`match_start/end`. The two `sides` are placeholders (`SQUADS` alive count vs `ELIMINATED`) so overlays
that expect A/B still get numbers.

Handled categories: `init`, `matchSetup`, `gameStateChanged`, `characterSelected`, `playerConnected`,
`observerSwitched`, `playerDamaged`, `playerDowned`, `playerKilled`, `playerRespawnTeam`,
`playerRevive`, `squadEliminated`, `ringStartClosing`, `ringFinishedClosing`, `matchStateEnd`.

The event name is taken from `category` or the protobuf `@type` suffix
(`type.googleapis.com/rtech.liveapi.PlayerKilled`) and normalised by `eventKey()` (letters only, lower-case),
so `player_killed` (snake_case, as the unofficial LiveAPI 2.0 docs show it —
github.com/zeejayym/apex-liveapi-documentation), `playerKilled` and `PlayerKilled` all match.

The match model survives a websocket reconnect (and the `init` the game sends on it); it is reset only by a
`matchSetup` for a different match (`serverId`, or map + playlist when no id is sent) or any `matchSetup`
after the match ended.

**Unconfirmed**: the casing of `gameStateChanged.state` values (matched case-insensitively against
WaitingForPlayers / PickLoadout / Prematch / Playing / Resolution / Postmatch), and whether a non-admin client in
a private match receives the full feed. Verify both against a live lobby before a show.

### startgg — import

`importEvent({ slug, token })` → `{ teams, bracket, event }` in the §2 shape. Entrants → `teams`
(id = slugified name, roster from participants' gamer tags, seed), sets → `bracket.rounds` grouped by
`fullRoundText` (winners rounds first, then losers by depth; `format: 'double'` when negative rounds
exist), `champion` from a decided final. Pages of 40 entrants / 30 sets keep each query well under
start.gg's 1000-object limit. `create().run({ slug, token, apply })` performs the import and calls
`patch({ teams, bracket })` when the core supplied `patch`.

Rate limit: start.gg allows 80 requests per 60 s (https://developer.start.gg/docs/rate-limits) and one
import can need up to 65 pages. Every request goes through one process-wide sliding-window limiter
(`limiter`, 60 requests / 60 s), and HTTP 429 or a "Rate limit exceeded" body is retried with exponential
backoff (honouring `Retry-After`) before failing with a clear message.

## Simulators (`agent/src/sim/`)

`{ id, label, start({ emit, getState }), stop() }`. Each builds the same raw report an adapter would
and emits `normalize(raw, getState())` every 500 ms. Team names and rosters come from
`state.teams[state.series.teamA/B]` when `getState` is supplied; otherwise Alpha vs Bravo.

Sims stamp `live.source = 'sim:<id>'` (the core's convention) so the control room can tell a rehearsal from a real feed; the data shape is identical to the adapter in the second column.

| sim | shape of | loop (≈ 3–4 min) |
|---|---|---|
| `cs2` | `cs2gsi` | starts at round 10 (6-3), 4 s warmup, 5 s freezetime, 14–26 s live rounds with kills/economy/bomb plants (40 s countdown), halftime side swap after round 12, first to 13 (OT to 16), 12 s gameover, new map. `PACE` export tunes it. |
| `valorant` | (no adapter) | same skeleton from round 10 (5-4) with agents, ult points, spike (45 s), ATK/DEF swap |
| `rocketleague` | `rlstats` | 3v3, 5:00 counting down at `CLOCK_RATE` 1.5×, boost oscillation, goals every 40–90 s → 6 s replay, OT if tied, podium 10 s |
| `lol` | `lolclient` | `SPEED` 8× game clock; kills/CS/gold/levels, dragon 5:00 (+5 min), herald 8:00, baron 20:00, turrets, inhib, nexus ≈ 25–30 min |

The registry starts a sim with `start({ emit, state, log })` where `state` is a snapshot; tests may pass `getState`.

## Anti-cheat / ToS notes

| game | status |
|---|---|
| CS2, Dota 2 | **Game State Integration is a Valve feature.** Sanctioned, VAC-safe, works on official servers. |
| League of Legends | Riot's **Live Client Data API** is official. Riot's policy forbids in-game overlays that give a real-time advantage; an OBS browser-source overlay on a broadcast is fine. Do not draw on the game window. |
| VALORANT | **No live API** and Vanguard blocks memory reads. Use the simulator for rehearsal, scoreboard OCR (`POST /api/stats/ocr`) or the Match tab for real matches. |
| Rocket League | Since **April 2026** Easy Anti-Cheat ships with the game. The **native Stats API** (this adapter's primary feed) is Psyonix's own and works online. **BakkesMod / SOS** only loads with EAC disabled → LAN / offline / private matches launched without anti-cheat. Never run BakkesMod in online matchmaking. |
| Apex Legends | **LiveAPI is an official Respawn feature** enabled by launch options. Sanctioned; needs a custom lobby with an observer for the full feed. |
| FGC, EA FC | No live data. Manual scoring; start.gg for brackets. |
