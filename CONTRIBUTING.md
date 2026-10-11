# Contributing to Clear to Air

Thanks for looking. Clear to Air is a small project and the most useful
contributions are often small too: a real payload from a game we have only seen
in documentation, a pack for a title nobody has covered, a bug report with a log
attached.

This page covers how to run the code, the rules that keep a live show safe, and
step-by-step guides for the two things most people come to write: **a game
adapter** and **an overlay pack**.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security
problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Licensing of contributions

- There is no CLA and no sign-off line to add.
- Inbound = outbound. What you contribute is licensed under the licence of the
  files you change: the **GNU AGPL v3 or later** for the application (agent,
  control room, relay, tools), and **MIT** for anything under `packs/` and
  `overlays/_shared/` (see `packs/LICENSE` and `overlays/_shared/LICENSE`).
- Only submit work you have the right to submit. Do not paste code from projects
  with incompatible licences, and do not commit artwork you did not make or
  license (see [Assets](#assets-the-rules) below).
- Contributing does not give you rights to the Clear to Air name or logo. See
  [TRADEMARKS.md](TRADEMARKS.md).

## Run it from source

You need **Node.js 22 or newer** (the portable build ships Node 24) and Git.
Clear to Air is developed and tested on Windows, which is where OBS and the games
run for most crews.

**Windows, the quick way:** double-click `Clear to Air.cmd` in the repository
root. On the first run it installs dependencies and builds the control room, then
starts the agent on `http://127.0.0.1:7700` and opens it in your browser. Leave the
agent window open.

**Any shell:**

```
npm run setup        # installs agent/ and web/ dependencies
npm run build        # builds the control room into web/dist
npm start            # starts the agent on http://127.0.0.1:7700
```

Useful variations:

```
npm run sim -- cs2            # start the agent with the CS2 simulator feeding it
npm run dev:agent             # agent with node --watch, restarts on save
npm run dev:web               # Vite dev server for the control room on :5173
```

`dev:web` proxies `/api`, `/ws`, `/packs` and `/overlays` to the agent on 7700.
The agent refuses browser origins it does not know, so start it with the dev
origin allowed:

```
CTA_ALLOW_ORIGINS=http://localhost:5173 npm run dev:agent      # bash
$env:CTA_ALLOW_ORIGINS="http://localhost:5173"; npm run dev:agent   # PowerShell
```

Simulators exist for every pack (`cs2`, `valorant`, `rocketleague`, `lol`,
`dota2`, `apex`, `eafc`, `fgc`), so you can work on almost everything without the
game or OBS installed. The agent starts fine with OBS closed.

### Tests

```
npm test
```

runs three suites:

| Suite | What it checks |
|---|---|
| `agent/src/_selftest.js` | the agent core, packs, renderer helpers and the remote-seat policy |
| `agent/src/adapters/_selftest.js` | every adapter binds and releases its port, parses sample payloads, and every simulator emits the normalized shape |
| `relay/test/e2e.mjs` | a real agent process, the real relay code on a Node harness, and a pretend browser in each seat role |

Run `npm run build` once first: the relay test serves `web/dist`. Stop any
running agent before testing, because the adapter suite needs ports 7701, 7702
and 7777 free.

### Overlays without the agent

```
node overlays/_shared/devserver.mjs
```

serves the repository on port 7710 with a fake `/api/state` and a fake live feed.
Open `http://127.0.0.1:7710/overlays/_shared/preview.html?page=cs2/cards` to see
any pack page at half size with toggle buttons. The same preview page works
against the real agent on 7700. `bash docs/shots/shoot.sh [filter]` captures every
graphic with headless Chrome into `docs/shots/`.

## Repository map

| Path | What lives there | Licence |
|---|---|---|
| `agent/src/` | the Node agent: HTTP + WebSocket API (`http.js`, `hub.js`), state, preflight, watchdogs, updater check | AGPL |
| `agent/src/adapters/` | game adapters and their shared helpers (`_normalize.js`, `_gsi.js`), plus `_selftest.js` | AGPL |
| `agent/src/sim/` | simulators, one per pack | AGPL |
| `agent/src/obs/` | the OBS bridge, scene-collection generator and drift check | AGPL |
| `agent/src/remote.js`, `remote-policy.js` | remote seats: the rig's side of the hosted control room, and what each seat may do | AGPL |
| `web/` | the control room (React + Vite + Tailwind) | AGPL |
| `overlays/_shared/` | the shared overlay runtime and renderer (`core.js`, `render.js`), tokens, skeleton CSS, fonts, dev server | MIT (fonts: OFL) |
| `overlays/live/`, `overlays/talent/` | non-pack overlay pages and the talent green room | AGPL |
| `packs/<id>/` | one folder per game: `pack.json`, `overlay/*.html`, `overlay/skin.css` | MIT |
| `relay/` | the hosted control room relay (Cloudflare Worker + Durable Object) and its tests | AGPL |
| `tools/` | packaging, the Windows launcher, brand and icon scripts | AGPL |
| `brand/` | the logo files | trademarks, see TRADEMARKS.md |
| `docs/` | architecture, design, release and remote-seat notes; `docs/shots/` screenshots | AGPL |
| `CONTRACTS.md` | the data shapes everything agrees on: state, packs, adapters, API | AGPL |

When the code and a doc disagree, the code wins. Fix the doc in the same pull
request.

## The rules that matter

These are not style preferences. Each one exists because breaking it can put
something wrong on air or leak something private.

1. **Remote access is deny-by-default.** A seat in the hosted control room can
   only reach routes listed in `agent/src/remote-policy.js`. A route you add to
   `agent/src/http.js` is unreachable remotely until you add a rule for it on
   purpose, naming the roles that may call it. Do not widen a rule to make a test
   pass. If your change touches `remote-policy.js`, `remote.js`, `relay/` or the
   request guard in `http.js`, say so in the pull request and add a policy check
   to `agent/src/_selftest.js`.
2. **Secrets never leave the PC.** The OBS password, the GSI token, the start.gg
   token and the VDO.Ninja password are listed in `SECRET_PATHS` in
   `remote-policy.js` and blanked from everything a remote seat receives. If you
   add a new secret to `settings`, add its path there in the same change. Never
   log a secret, and never put one in a URL.
3. **Red and green are tally colours only.** Red means PROGRAM and green means
   PREVIEW, everywhere in the control room. Do not use them for success, errors
   or decoration. Use the state tokens in `docs/DESIGN.md`.
4. **Hot actions take two steps.** Anything that changes what is on air is
   ARM then TAKE, the dedicated TAKE button, or a hold-to-confirm. Never a plain
   button in a grid.
5. **No personal or client data anywhere.** Fixtures, tests, screenshots, sample
   state and docs use the fictional teams **Alpha, Bravo, Charlie and Delta** and
   made-up player names (the tests use names like Zephyr, Kestrel, Rift). No real
   teams, players, events, organisations, email addresses or Steam IDs. When you
   capture a real payload, replace every name and ID before you commit it.
6. **Never a fabricated number.** If a feed does not provide a figure, the overlay
   shows a dash. It does not show 0 or a guess. This applies to adapters
   (below), to the scoreboard parser and to the renderer.
7. **Nothing on the broadcast PC listens beyond loopback.** Adapters bind
   `127.0.0.1`. The hosted control room works because the rig dials out, not
   because something listens.

## Guide: writing a game adapter

An adapter turns one game's data feed into the shared `live` object that the
overlays and the control room read. Read `agent/src/adapters/README.md` and
section 4 of `CONTRACTS.md` alongside this guide. `cs2gsi.js` (HTTP receiver),
`rlstats.js` (TCP/WebSocket client) and `lolclient.js` (polling) are good models.

### 1. Find out what the game actually sends

Before writing code, get a real payload if you possibly can. Several adapters were
written from documentation and community notes alone, and the README lists what
is still unconfirmed. A captured payload beats any document.

Ways to capture one (stop the matching adapter first if it uses the same port):

- **Valve GSI (CS2, Dota 2):** add a second `gamestate_integration_*.cfg` that
  points at a spare port, and run a tiny listener that appends each POST body to
  a file:

  ```
  node -e "require('http').createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{require('fs').appendFileSync('capture.ndjson',b.replace(/\n/g,'')+'\n');r.end()})}).listen(3001,'127.0.0.1')"
  ```

  Spectate the match (Watch tab, GOTV or `playdemo`): a playing client only sends
  its own player.
- **LoL Live Client Data:** while a game or spectated game is running, save
  `https://127.0.0.1:2999/liveclientdata/allgamedata` (self-signed certificate,
  so `curl -k`).
- **Rocket League Stats API, Apex LiveAPI:** stop the adapter and listen on its
  port with a few lines of Node that append each message to a file.

Then **anonymise it**: player names, team names, Steam/Epic/Riot IDs, the GSI
`auth.token`, match and server IDs. Use Alpha/Bravo and invented player names.

### 2. Create the module

Create `agent/src/adapters/<id>.js`. The registry (`agent/src/registry.js`)
imports every `.js` file in that folder whose name does not start with `_`. A
module that fails to import is skipped with one log line; it never stops the
agent.

```js
// agent/src/adapters/mygame.js
import { normalize } from './_normalize.js';
import { makeLogger, resolveOpts } from './_gsi.js';

export const id = 'mygame';                 // unique, lower case
export const games = ['mygame'];            // pack ids this adapter serves
export const label = 'My Game Live API';    // shown in the Data tab
export const describe = 'Polls http://127.0.0.1:1234/state every second';

// Pure function: game payload in, RAW report out. Export it so tests can call it.
export function parsePayload(p, ctx = { events: [] }) {
  return {
    source: id,
    connected: true,
    phase: 'live',                      // see the phase list in CONTRACTS.md
    clockSeconds: p.time,
    sides: {
      left:  { key: 'BLUE', name: p.teams[0].name, score: p.teams[0].score },
      right: { key: 'RED',  name: p.teams[1].name, score: p.teams[1].score },
    },
    players: p.players.map((x) => ({
      team: x.side === 0 ? 'BLUE' : 'RED', // the GAME's side key, never 'A'/'B'
      name: x.name,
      kills: x.kills,
      // omit what the game does not send; do not write 0
    })),
    events: ctx.events,
    extra: {},
  };
}

export function create({ config, emit, log, state, getState } = {}) {
  const o = resolveOpts({ config, state, getState });
  const say = makeLogger(log, id);
  const ctx = { events: [] };
  let timer = null, lastOk = 0, last = null;

  async function poll() {
    try {
      const p = await (await fetch('http://127.0.0.1:1234/state')).json();
      last = parsePayload(p, ctx);
      lastOk = Date.now();
      emit?.(normalize(last, o.getState()));
    } catch (e) { /* game not running: status() reports it */ }
  }

  return {
    start: async () => { say('starting'); timer = setInterval(poll, 1000); },
    stop: async () => { clearInterval(timer); timer = null; emit?.({ source: id, connected: false }); },
    status: () => ({ connected: Date.now() - lastOk < 5000, detail: last ? `${last.sides.left.score}-${last.sides.right.score}` : 'waiting for the game' }),
  };
}

// Optional. What the operator must install or switch on in the game.
export function install({ config, state, getState } = {}) {
  return { files: [], instructions: 'Enable the live API in the game settings.' };
}
```

The interface, exactly:

| Export | Shape |
|---|---|
| `id`, `games`, `label`, `describe` | strings, `games` an array of pack ids (`'*'` is accepted for any) |
| `create(opts)` | `opts = { config, emit, log, state \| getState, patch? }`; returns `{ start(), stop(), status() }`. `start`/`stop` may be async. `status()` returns `{ connected, detail }`. `stop()` must release every socket, server and timer. |
| `install(opts)` | optional; returns `{ files: [{ path, content }], instructions }` |

`log` may be the core's `{ info(tag, msg), warn(tag, msg) }` object or a plain
function: use `makeLogger(log, id)`. `state` may be the store or a snapshot: use
`resolveOpts()` and read it through `getState()`. If you receive HTTP POSTs like
Valve GSI, use `createGsiServer()` and `resolveToken()` from `_gsi.js` rather than
writing your own server, so the token check stays in one place.

### 3. Emit RAW reports and let `_normalize.js` decide A/B

Adapters **never decide which team is A and which is B.** Report sides the way
the game does (`sides.left` / `sides.right`, each with the game's own `key` such
as `CT`, `BLUE`, `RADIANT`) and key every player by that side key. Then pass the
report through `normalize(raw, getState())`, which maps it onto A/B using, in
order: the operator's `settings.teamMap`, the team names in `state.teams`, and
finally "first seen on the left is A", which is sticky so a half-time side swap
does not flip the teams. `normalize()` is idempotent, so the core running it again
is harmless.

The raw shape is documented at the top of `_normalize.js`:

```
{ source, connected, phase, round, clock, clockSeconds, overtime, mapName,
  sides: { left: { key, name, score, ... }, right: { ... } },
  players: [ { team: <side key>, name, hp, kills, deaths, assists, ... } ],
  bomb, ball, events, extra, mode }
```

Game-specific fields go in `extra` (match level) or `player.extra`. Use
`pushEvent(buf, type, text)` for events, with a type from the list in
`CONTRACTS.md` (`kill`, `goal`, `round_end`, `match_end`, `info`, ...).
`prettyWeapon()` and `fmtClock()` are there too.

### 4. Missing is not zero

If the game does not send a value, **leave it out**. Do not write `0` and do not
invent a default. A zero goes to air looking exactly like a real zero. The
renderer turns a missing column into a dash.

Two details:

- Do not put `null` on a **top-level** `live` key. The core's merge treats null as
  "delete this key". Omit the key instead. `normalize()` already fills safe
  defaults where the overlays need them (`sideA: ''`, `bomb.state: 'none'`).
- When a field must stay numeric for the renderer but the value is unknown, add
  an explicit flag beside it. `rlstats` sends `boost: 0` with
  `extra.boostKnown: false` for opponents whose boost the game does not report.

### 5. Add self-test checks

Every adapter is exercised by `agent/src/adapters/_selftest.js`:

1. Add your id to the `ADAPTERS` array. The generic loop then checks the exports,
   `create()`, `install()`, `start()` and `stop()`.
2. If your adapter listens on a port, add it to the port map near the end of the
   loop so the test proves `stop()` released it.
3. Add a sample payload constant **shaped exactly like the real one** (PascalCase
   stays PascalCase, strings that are JSON stay strings, teams out of order if the
   game sends them out of order), using Alpha/Bravo and the test's player names.
4. Add an `if (name === '<id>') { ... }` block that pushes the payload through the
   real parser or socket and checks the normalized result with `ok(cond, msg)`.
   Check the awkward cases, not only the happy path: a missing field, an empty
   player list, a reconnect, a side swap.

Run `node agent/src/adapters/_selftest.js` until it exits 0, then `npm test`.

### 6. Wire it up and document it

- Add the id to the `adapters` list in the pack's `pack.json` (the first entry is
  the default).
- If the adapter listens on or connects to a port, add it to the port table in
  `agent/README.md`.
- Add a row to the adapter table in `agent/src/adapters/README.md` and a "what it
  yields" section: which payload fields map to which `live` fields, and anything
  you could not confirm. Mark unconfirmed behaviour as unconfirmed.
- Add a line to the anti-cheat / ToS table in that README. Only use data the
  publisher provides for this purpose: official APIs, game state integration,
  local files the game writes. **No memory reading, no injection, nothing that
  draws on the game window.** We will not merge an adapter that could get a
  player banned.
- A simulator in `agent/src/sim/<game>.js` (`{ id, label, start({ emit, getState }), stop() }`)
  is welcome, so others can rehearse without the game.

## Guide: making an overlay pack

A pack is everything title-specific about the graphics: which cards exist, what
the map pool is, what the scorebug shows, the default colours. The drawing itself
is shared. Every pack page loads the same runtime and renderer from
`overlays/_shared/`, so a pack is mostly data plus a few lines of CSS.

### 1. Copy the closest pack

```
packs/<id>/
  pack.json
  overlay/
    ingame.html     scorebug, lower third, ticker, corner tag, timeout
    cards.html      full-frame cards (vs, veto, roster, scoreboard, ...)
    standby.html    countdown, BRB, outro
    desk.html       caster and host nameplates (?who=casters|hosts)
    skin.css
```

Pick the pack closest to your title (`cs2` for round-based shooters, `lol` for
drafted MOBAs, `rocketleague` for goal-based games, `fgc` for one-on-one sets,
`apex` for battle royale, `eafc` for sports games without a feed) and copy the
folder. The agent loads every `packs/*/pack.json` at start.

The four HTML pages are thin and should stay that way. Each one loads
`/overlays/_shared/tokens.css`, `skeleton.css`, your `skin.css`, then
`stateBuffer.js`, `core.js` and `render.js`, and calls:

```js
CTA.connect({ page: 'ingame' });
CTA.render.ingame({ bugStyle: 'rounds' });   // or .cards(), .standby(), .desk({ who })
```

The pack an overlay page draws is the `<id>` in its own URL
(`/packs/<id>/overlay/...`), not the game the control room is set to.

### 2. Fill in `pack.json`

Section 3 of `CONTRACTS.md` is the full reference. The fields:

| Field | What it does |
|---|---|
| `id`, `name`, `short` | folder name, display name, short label for chips |
| `sides` | the game's side names, e.g. `["CT","T"]`, `["BLUE","RED"]`; `[]` for battle royale |
| `mode` | `"br"` for battle royale; omit otherwise |
| `roundsToWin` | rounds to win a map, `0` when the game does not have rounds |
| `defaultFormat`, `formats` | what a series can be: `BO1/BO3/BO5`, `FT2`, `2LEG`, `"6 GAMES"`, ... |
| `maps` | `[{ id, name, art, active }]`. `id` is what the feed reports, `active` marks the current pool, `art` is optional (see Assets) |
| `roles` | the roster role options |
| `rosterSize` | players per team |
| `liquipedia` | the Liquipedia wiki slug used for team lookup (`counterstrike`, `rocketleague`, ...) |
| `adapters` | adapter ids; the first is the default; include `manual` |
| `sims` | simulator ids for rehearsal |
| `stats` | `scoreboardColumns` (per-player figures only) and `mvpStat` |
| `caps` | what the title actually has; see below |
| `overlay` | `pages` and `bugStyle`: `rounds`, `goals`, `kills`, `br`, `fgc` or `eafc` |
| `scenes` | the OBS scene recipe; `"recipe.default"` |
| `theme` | `primary`, `secondary`, optional `accent`: the default colours until the event brand overrides them |
| `capture` | how the generated OBS collection captures the game: `{ "kind": "game_capture", "window": "Title:Class:exe" }` or `{ "kind": "monitor_capture", "window": "" }` |
| `notes` | anything an operator should know |

Optional per-title extras: `champions` (suggestion list, not a whitelist),
`characterSets` (per fighting game), `scoring` (battle-royale placement points),
`statLines` (team match-stat rows).

**`caps` deserves care.** It is what stops the control room offering a map veto
for a game that has no veto, and the renderer refuses to paint a card whose
capability is false. A missing key defaults to `true`, so **set every key
explicitly**: `veto`, `draft`, `standings`, `set`, `games`, `matchStats`, `maps`,
`sides`, `rounds`, `halves`, `series`, `headToHead`, and the `cards` list. Each
title has exactly one headline card (veto, draft, standings, set, games or
matchstats).

### 3. Keep `skin.css` thin

The shipped skins are 5 to 8 lines each. Colours come from `pack.json` `theme`
through `CTA.applyBrand()`, and the event's own brand overrides them, so **do not
hard-code brand colours** in the skin. Use it for title-specific tweaks: a CSS
variable such as `--chamfer` or `--bug-top` (to move the bug clear of the game's
HUD), and small rules scoped with `[data-game="<id>"]`.

Layout rules from the shared skeleton: pages are 1920x1080 with a transparent
background, the safe area is 96 px by 54 px, and never position an animated
`.fx` element with `translate(-50%)` (the animation owns `transform`; use
`calc()`).

If your title needs a new scorebug style or a new card type, that is a change to
`overlays/_shared/render.js` (MIT, like the packs; tests in `agent/src/_selftest.js`). Send
it as its own pull request.

### 4. Assets: the rules

- **Never commit team logos or player photos.** `packs/*/assets/teams/` and
  `packs/_players/` are gitignored on purpose. They belong to the teams and the
  photographers. The agent can fetch one team's logo from Liquipedia on the
  operator's PC when they need it.
- **Map art only if you have the right to share it**: your own work, or art
  under a licence that allows redistribution, with the licence noted. Otherwise
  leave `art` out. The cards draw a stylised tile with the map name instead, and
  that is fine.
- **No game logos, character renders or key art from publishers.** Name the game
  in text.
- **Fonts must be under the SIL Open Font License or a similarly permissive
  licence**, and the licence file must sit next to the font. Bundled fonts live in
  `overlays/_shared/fonts/`. Do not add fonts to a pack folder.

### 5. Test it

- `node overlays/_shared/devserver.mjs`, then
  `http://127.0.0.1:7710/overlays/_shared/preview.html?page=<id>/cards`.
- With the agent: `npm run sim -- <sim>` and add
  `http://127.0.0.1:7700/packs/<id>/overlay/ingame.html` as an OBS browser source
  at 1920x1080, or generate the OBS collection from the control room's Setup tab.
- `npm test`. Some pack checks in `agent/src/_selftest.js` list pack ids
  explicitly; add yours where the check applies to it.
- Attach screenshots of each page to the pull request. `docs/shots/shoot.sh` can
  make them.

If the title is new to Clear to Air, the Liquipedia wiki for it is read from
`pack.liquipedia`, and `overlays/_shared/core.js` keeps fallback copies of the
shipped packs (`CTA.fallbackPacks`) for when `/api/packs` is unreachable. Adding
yours there is optional.

## Good first issues

- **A real payload for each adapter.** Capture, anonymise and add a check for one
  real payload per adapter (`cs2gsi`, `dota2gsi`, `rlstats`, `lolclient`,
  `apexlive`). Known open questions:
  - Apex: the casing of `gameStateChanged.state` values, and whether a non-admin
    client in a private match receives the full feed.
  - Dota 2: whether `map.radiant_win_chance` appears in live payloads.
  - Rocket League: the native Stats API shape was taken from secondary sources.
- **A new pack** for a title that is not covered yet, even manual-scoring only.
- **Valorant map art caching.** `CONTRACTS.md` section 3 says the agent should
  cache the valorant-api.com splash art into `packs/valorant/assets/maps/` on first
  use. Today the overlays load it from the network every time.
- **A simulator** for a pack that does not have a realistic one yet.
- **Docs from a real show.** If you ran Clear to Air on a stream, write down
  what confused you. That is a bug report too.

## Pull requests

- One change per pull request. A new adapter and a renderer change are two pull
  requests.
- Run `npm test` and say that you did.
- Screenshots for anything visual: control room, overlays, cards.
- Say if you touched `remote-policy.js`, `remote.js`, `relay/` or the request
  guard in `http.js`. Those get a second look.
- Fill in the pull request template. It is short.

Questions that are not bugs: [GitHub Discussions](https://github.com/downstagehq/cleartoair/discussions).
