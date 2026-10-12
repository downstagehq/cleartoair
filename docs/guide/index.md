# Clear to Air user guide

This guide shows you how to install Clear to Air and run a tournament stream with it.

Clear to Air is a free, open-source control room for esports tournament streams. A small agent runs on the broadcast PC next to OBS Studio and drives OBS over its WebSocket server. You run the show from a browser tab: the run of show, scene cuts, graphics, replays and preflight checks. Where a game offers live data through the publisher's own interface, an adapter reads it and the graphics follow the match. Where it does not, you keep score by hand. An optional relay lets crew and casters join from another network.

Clear to Air is at version 0.3.5 and is still early. Every pack and adapter has been tested against built-in simulators and sample payloads shaped from each game's documentation. Testing against real games and real shows is in progress. Each page says what is not yet confirmed.

## Pages

- [Getting started](getting-started.md): install the Windows build, connect OBS, build the scene collection and read the lamp. Also covers updates and running from source.
- [Your first show in 30 minutes](first-show.md): a timed walkthrough from an empty desk to going live, using the demo event and a simulator.
- [Game data adapters](adapters.md): what each live feed provides, how to connect it, and what is still unconfirmed. Also covers recording raw game data and playing it back.
- [Observer PC](observer-pc.md): take CS2 or Dota 2 game data from a separate observer PC on the venue network.
- [Talent links and remote seats](talent-links.md): bring a caster's camera in from another network (beta), and hand the desk to a producer, scorer or viewer elsewhere.
- [Replays](replays.md): the replay buffer, Save & cut, the automatic cut back after a replay, and rehearsing with recorded game data.
- [Troubleshooting](troubleshooting.md): symptoms, causes and fixes, including every preflight check.
- [FAQ](faq.md): cost, licences, platforms, game policies, privacy and how to report bugs.

## Getting help

Questions and show reports go to [GitHub Discussions](https://github.com/downstagehq/cleartoair/discussions). Bugs go to [GitHub Issues](https://github.com/downstagehq/cleartoair/issues). Security problems go through `SECURITY.md` in the repository, never a public issue.
