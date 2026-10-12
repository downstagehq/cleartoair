# Changelog

Newest first. One section per release; the notes for `gh release create` come from here
(see [RELEASE.md](RELEASE.md), step 1).

## 0.3.5 - League hardened, talent links reach OBS

**Upgrading:** nothing to do. To use talent links, see the first point.

- **Talent links into OBS, end to end.** Setup → Remote seats → Talent camera links now has
  a **Talent sources in OBS** switch: VDO.Ninja (the default) or CTA Studio. Until now the
  CTA Studio sources the links feed could only be chosen by editing the settings file. Switch
  it, then rebuild the OBS collection (OBS closed, **Hold to install**). Tested with a real
  OBS 32.2.2 and room.cleartoair.com: a link opened in a phone-sized browser on the relay
  put its camera on 02 · DESK. The camera was a browser test camera on this PC; a real
  phone on mobile data is still to do.
- **League of Legends, checked against Riot's own samples.** Three new recordings: a full
  game from a player's client, a spectator client with Riot IDs, and joining mid-game with
  a client restart and a second game. They turned up eight fixes:
  - Turrets and minions are named in the feed ("Blue turret killed Ember", not
    "Turret_T1_L_03_A killed Ember").
  - An inhibitor taken by minions now counts.
  - The end of the game says which side won ("Game over — Blue side wins") on a player's
    client; a spectator's client says "Game over", because only a player's client knows.
  - Two players with the same name are told apart by their tag.
  - Starting Clear to Air mid-game no longer floods the feed with every earlier event.
  - A second game in the same session keeps its events.
  - Riot's sample gives every event the same ID; repeats are now recognised by content.
  - A client restart no longer resets what was already announced.
  - From source, `npm run replay -- <file> --live` now plays League recordings too, into an
    agent started with `CTA_LOL_REPLAY_URL=http://127.0.0.1:2998` (the tool prints the line).
    The agent accepts only a plain http address on this PC there; without it nothing changes.
- **Program and preview thumbnails were squashed.** On a window about 900 px tall the Air
  column shrank them to a strip and the graphics were cropped away. They keep 16:9 now (the
  column scrolls), and an empty game capture shows as black, not as "no picture".
- **No corner tag over the desk.** On 02 · DESK the event's corner tag covered the right-hand
  nameplate; it hides on that scene.
- Wording: preflight's fixes name the buttons as they read on screen (**Hold for new event**,
  **Run now**); the talent page no longer promises "zero audio drop"; Apex's setup says the
  observer client runs on this PC (its receiver is local only).

## 0.3.4 - the replay cuts back by itself

**Upgrading:** nothing to do. It is on by default; switch it off under Replay in the Air column.

- **Back to the game when the replay ends.** When 05 · REPLAY goes on program (Save & cut,
  or a cut by hand), Clear to Air remembers the scene that was on before and cuts back to it
  when the clip finishes. It knows the clip has finished because OBS says so, and it also
  checks the clip's length in case that signal never comes. The cut uses the scene's normal
  transition. The Air column shows "Back to 04 · IN-GAME in 6 s" with a **Hold** button to
  stay on the replay this time. If you cut somewhere else first, nothing happens. Tested in
  OBS 32.2.2: Save & cut on a 7-second clip went back to 04 by itself 8.3 s later.
- **Talent links work on room.cleartoair.com.** The hosted relay now carries them (it was
  redeployed with 0.3.3's relay, plus a fix: Cloudflare was answering the talent page with
  the control room's own page). Tested over the internet: the link opens over HTTPS, media
  flows, and an agent restart, an OBS refresh and closing the seat all behave.

## 0.3.3 - an observer PC, talent links, a sharper scoreboard reader

**Upgrading:** nothing to do. LAN listening is off until you switch it on.

- **Observer PC (CS2, Dota 2).** The game can now run on a separate observer PC and send its
  data to the rig over the venue network. Data tab → Observer PC → switch LAN on, add the
  observer PC's address, copy the cfg it shows onto that PC, restart the game there. Only the
  addresses you list are accepted, one by one (no ranges), and the GSI token is still checked.
  Everyone else on the network gets refused, and preflight names them, so a player's PC on the
  same LAN cannot put a score on air. The control room and the API stay on this PC only. Windows
  may ask once whether Node.js may use the network: allow Private networks. Tested over this
  PC's own LAN address; a second PC on a real venue network is still to do.
- **Talent links (CTA Studio, beta).** Setup → Talent: make a single-use link (15 minutes,
  one slot) with a QR code. The caster opens it on a phone or laptop anywhere. The page
  comes from the hosted relay over HTTPS, so the camera works, and their call reaches OBS as
  that slot's source. The link opens that one page and that one slot's call setup, nothing
  else. Media goes straight between the two ends. Dropped connections recover by themselves.
  An optional TURN server (Settings, never shown to remote seats) helps strict networks.
  A one-page quick-start card for the caster is in `docs/talent-quickstart.pdf`.
  **Needs the hosted relay update before it works on room.cleartoair.com.** Everything else
  in this release works with the relay as it is. Tested with two browsers on one PC through a
  local copy of the relay; phones and real networks are still to do. VDO.Ninja stays the
  default.
- **Reading the scoreboard off the screen, take two.** Tested on boards closer to the game's:
  its fonts, team-tinted rows, agent icons, JPEG compression, 1440p/720p/4:3 stretched, and a
  HUD over the edge. 638 of 640 cells read, none wrong (was 474). JPEG screenshots are
  accepted. The work runs off the main thread, so the desk never stutters while it reads.
  Still not tried on the real game's screen.
- **Remote seats: team logos and player photos arrived empty.** Any file the rig streamed
  through the relay reached the seat as zero bytes. Fixed.

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
