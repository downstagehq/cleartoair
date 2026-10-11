# Changelog

Newest first. One section per release; the notes for `gh release create` come from here
(see [RELEASE.md](RELEASE.md), step 1).

## 0.3.2 - rehearse with recorded data, read the scoreboard off the screen

**Upgrading:** nothing to do. After the update the graphics in OBS reload themselves once.

- **Replay a recording.** A file made with **Record raw game data** can be played back
  through the agent with no game running: drag it onto **Replay a recording.cmd** in the
  Clear to Air folder (from source: `npm run replay -- <file> --live`). CS2 and Dota 2
  arrive on their GSI port, Rocket League on the Stats API port, Apex on its LiveAPI port.
  The overlays and OBS move as they did on the day, so a show can be rehearsed on real data.
  Without `--live` it prints what the adapter made of the file: phases, scores, events and
  anything that looks wrong (a player who changed team mid-map). League is not supported live.
- **Recordings are tests.** Captures in `agent/src/adapters/fixtures/` are replayed by
  `npm test` and checked against an expectation file. Six synthetic ones ship (built from
  each game's documented format and marked as such); a real capture from a rig joins them.
- **Read the scoreboard off the screen (VALORANT, Windows).** Data tab → Scoreboard import →
  **Read game feed** reads the end-of-map scoreboard from OBS's game capture (not program,
  so our own graphics are never read), or **Read image** reads a PNG. It uses Windows' own
  OCR engine; nothing is installed. The result lands in the text box as a preview: check it,
  fix anything, then Apply. A cell it is unsure of is left empty with a warning, never
  guessed. Tested on rendered boards, not yet on the real game's screen.
- **The post-match scoreboard card keeps the final numbers.** When the feed dropped after
  the final whistle (a Rocket League lobby closing, a CS2 server changing map), the card
  read NO ROWS. The last finished game of the current title is now kept and shown, with its
  score, until the next one ends.
- **Graphics reload after an update.** OBS kept running the old graphics code after Clear to
  Air updated, until someone refreshed the sources. The pages now reload once when the agent
  comes back on a new version. A restart on the same version never reloads them.
- **OBS collection on another port.** An agent started with `--port` built a collection
  pointing at port 7700, so OBS showed another agent's graphics or none. The collection now
  uses the real port, **Sync OBS** repoints an existing one, and preflight says which
  address OBS is showing instead of only "refresh".
- **CTA Studio talent (the built-in alternative to VDO.Ninja) recovers.** Bench-tested with
  two browsers on one PC: when OBS refreshed or restarted its source, or the agent
  restarted, the talent's picture went black until they pressed CONNECT again. Each now
  recovers by itself; a second receiver on a slot replaces the first; a talent can change
  camera or mic mid-call; a page that cannot autoplay shows "Click to start audio". Still
  same-PC only: the join page is not reachable from another device yet, and there is no
  TURN server (see `docs/TALENT-BENCH.md`). VDO.Ninja remains the default.
- **No scorebug over STARTING SOON.** Scenes 01, 06 and 08 carry the in-game layer for its
  ticker and corner tag, and with the bug switched on (the default) it sat on top of the
  standby title. The bug now hides while one of those scenes is on program.
- CS2: the round number comes from the two scores. It showed ROUND 23 after a 22-round map.
- Apex: the match clock runs on the game's timestamps, not this PC's clock.
- Rocket League: the winner is always the side (BLUE/ORANGE), and an empty `Winner` in a
  later update no longer wipes it.
- Switching title logged and reported the new title as the old one.

## 0.3.1 - show-day fixes

**Upgrading:** a game adapter you start from now on comes back by itself after a restart. One
already running when you update is not on that list yet: after updating, press Start on it once.

- **The lamp no longer stays green with no game data.** Adapters started from the Data tab now
  come back after the agent restarts (a crash, an update, a relaunch). Preflight now warns when
  the current game has a live feed (CS2, Dota 2, League, Rocket League, Apex) but no adapter is
  running, and says which button to press. Scoring a show by hand on purpose? Start the Manual
  adapter and the warning clears. Simulators are never restarted on their own.
- **CS2 and Dota 2 Install saves the config file itself.** It finds the game through Steam's
  libraries and writes `gamestate_integration_cleartoair.cfg` into its cfg folder, UTF-8
  without a BOM. If it cannot find the game it shows the file to copy, and every folder it
  looked in. It never overwrites a file Clear to Air did not write without asking first, and
  then keeps the old one as `.old`. Restart the game afterwards.
- **Tray → Open log opens the real log.** It opened `app\agent\data\agent.log`, which nothing
  writes. It now opens `launcher.log` next to `Clear to Air.exe`, which has the launcher's lines
  and the agent's output. Times in it are this PC's local time (the agent's lines were UTC).
- **Record raw game data.** A switch on each game adapter's card in the Data tab saves what the
  game sends to `agent\data\captures\<game>-<date>.jsonl`, with the GSI token and passwords
  taken out. The card shows where the file is and how big it is; it stops at 50 MB. Attach it
  to a "Real payload" issue after anonymising player names and IDs.
- Record and Install work on the broadcast PC only: a remote seat is refused both.
