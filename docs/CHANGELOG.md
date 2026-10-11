# Changelog

Newest first. One section per release; the notes for `gh release create` come from here
(see [RELEASE.md](RELEASE.md), step 1).

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
