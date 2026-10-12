# Replay fixtures

Captures in the format the **Record raw game data** switch writes (`agent/data/captures/*.jsonl`),
each with an `.expect.json`. `node agent/src/adapters/_selftest.js` (part of `npm test`) replays every
one through the adapter's own parser and checks it, so an adapter can be tested without the game.

Files named `*.synthetic.jsonl` are **not** game captures. `tools/fixtures/make-synthetic.mjs` builds
them from each game's documented payload shape, and their header says `"synthetic": true`. They
prove the harness and the parsers agree with the docs. Only a real capture proves they agree with
the game.

## Adding a real capture

1. On the rig: Data tab, the adapter's card, switch on **Record raw game data**. Play or spectate.
   Switch it off. The card shows the file.
2. Anonymise it: replace player names, Steam/Epic IDs and match ids. Keep the shape.
3. Copy it here as `<game>-<what it shows>.jsonl`, e.g. `cs2-local-bots-halftime.jsonl`.
4. `node tools/replay.mjs agent/src/adapters/fixtures/<file>.jsonl` prints what the adapter made of it.
5. `node tools/replay.mjs agent/src/adapters/fixtures/<file>.jsonl --expect` writes the snapshot.
   **Read it.** Where the adapter got something wrong (a score, who is team A, a phase), edit the
   expectation to what the game really showed. The test now fails: that is the bug, written down.
6. Add `"why"`: one line on what this capture proves. Commit both files.

## Playing a capture into a running agent

`node tools/replay.mjs <file> --live --speed 4` feeds the agent through the adapter's real port at
the recorded pace (CS2/Dota POST, Rocket League serves the Stats API port, Apex connects to the
adapter). The overlays and OBS move as they did on the day. Use it to rehearse a show with real data.

League polls the game client, so for League the tool plays the client: it serves the recorded polls on
`http://127.0.0.1:2998` (`--port`), answering 503 through any hole in the recording, and the agent must
be started with `CTA_LOL_REPLAY_URL=http://127.0.0.1:2998`. The adapter takes nothing but plain http on
127.0.0.1 / localhost there; without the variable it polls the game's https://127.0.0.1:2999 as always.
The adapter polls once a second, so above `--speed 1` it sees only some of the recorded polls.

## Still unconfirmed on a real game

- CS2: whether a spectator on a **local bot server** gets `allplayers`; the round number on the
  game-over payload; team names when `mp_teamname_1/2` is not set.
- Rocket League: what **Free Play** sends at all (one car, no opponents, no clock?); whether
  `Game.Winner` is the team name.
- Apex: whether `timestamp` is epoch seconds (the match clock assumes it is a steady clock).
- Dota 2: `radiant_win_chance` in live payloads; the `events` block.
- League: everything not in Riot's two samples (allgamedata, eventdata): GameEnd's `Result` on a
  spectator client (the adapter names a winner only from a player's client), the fields of
  `InhibRespawningSoon` / `InhibRespawned` / `HordeKill` / `AtakhanKill`, whether eventdata names players
  by `summonerName` ("Name#TAG") or Riot ID, what a spectator client restarting mid-game answers, and
  whether EventIDs survive that restart (the adapter de-duplicates by content, so it does not rely on them).
