# FAQ

Short answers to common questions about Clear to Air.

## Does it cost anything?

No. Clear to Air is free, including for commercial shows.

- The application (agent, control room, relay, tools) is under the GNU AGPL v3 or later. If you distribute a changed version, or run one as a service for other people, you must publish your changes under the same licence.
- The overlay packs in `packs/` and the shared overlay renderer are under the MIT licence, so you can build, keep private or sell your own packs.
- The name "Clear to Air" and its logo are trademarks and are not covered by either licence. Forks must use their own name and logo.

## Which systems does it run on?

The download is for Windows 10 and 11, 64-bit. It brings its own Node runtime.

## Can I run it on a Mac or Linux from source?

It is not supported or tested. The agent is Node.js, but several parts assume Windows:

- It finds OBS's settings, profiles and scene collections under the Windows `%APPDATA%` folder.
- It checks whether OBS is running with a Windows command before it installs a collection.
- **Install** for CS2 and Dota 2 finds Steam through the Windows registry.
- The scoreboard reader uses the OCR engine built into Windows.
- The tray launcher is a Windows program.

## Does it read game memory or touch the game?

No. Live data comes only from interfaces the publishers provide: Valve's Game State Integration, Riot's Live Client Data API, Psyonix's Stats API and Respawn's LiveAPI. Nothing draws on the game window. The graphics are OBS browser sources on the broadcast output.

## Is it allowed by the game publishers?

These are the project's own notes from the adapter code. Check each publisher's current rules for your event.

- **CS2 and Dota 2:** Game State Integration is a Valve feature and works on official servers.
- **League of Legends:** the Live Client Data API is Riot's official interface. Riot's policy forbids in-game overlays that give a real-time advantage; an OBS overlay on a broadcast is fine. Do not draw on the game window.
- **VALORANT:** there is no live API, and Vanguard blocks memory reads. Score by hand, or read the end-of-map scoreboard off the screen.
- **Rocket League:** the Stats API is Psyonix's own and works online. BakkesMod and the SOS plugin only load with Easy Anti-Cheat off: LAN, offline or private matches launched without it. Never run BakkesMod in online matchmaking.
- **Apex Legends:** the LiveAPI is an official Respawn feature, switched on with launch options.

## Do I need the hosted relay?

No. Everything on the broadcast PC works without it. You only need a relay for remote seats and talent links. You can use the hosted one at `https://room.cleartoair.com` (free while remote seats are in beta) or deploy your own on Cloudflare's free plan.

## What data leaves the PC?

The control room and API only listen on the broadcast PC. Clear to Air has no analytics. Data leaves the PC only for these:

| What | Where to | When |
|---|---|---|
| Update check | GitHub (the release manifest) | When the launcher starts, and when you check from the tray |
| Team lookup | Liquipedia | When you search for a team |
| Bracket import | start.gg | When you press **Import teams and bracket** |
| VALORANT map art | media.valorant-api.com | When a graphic or the control room shows a VALORANT map image |
| VDO.Ninja talent | vdo.ninja | When OBS loads the talent sources |
| Remote seats | Your chosen relay | Only while remote seats are on. Your OBS password, GSI token, start.gg token, VDO.Ninja password and TURN credentials are removed first. |
| Talent link calls | Google's STUN server, and your TURN server if you set one | While a talent link call is set up |

Game data from an [observer PC](observer-pc.md) arrives over your local network; it does not go to the internet.

## Which OBS version do I need?

Clear to Air drives OBS through obs-websocket 5, on port 4455 by default. The automatic cut back after a replay was tested on OBS 32.2.2. OBS 28 or later should work, since obs-websocket 5 is built in from that version; only 32.2.2 has been tested.

## Has it been used on a real show?

Not fully yet. Every pack and adapter has been tested against built-in simulators and sample payloads built from each game's documentation. Testing against real games and real shows is in progress. The hosted relay was tested over the internet, but has not yet carried a real show with OBS attached. Talent links are beta, and untested on phones and real networks.

## Where is my show saved?

In `app\agent\data\` in the Windows build (`agent\data\` from source). It survives updates. Every change can be undone with Ctrl Z, up to 200 steps.

## How do I report a bug?

Open an issue at [github.com/downstagehq/cleartoair/issues](https://github.com/downstagehq/cleartoair/issues). Include the version from the status bar, what you did, and the relevant lines from `launcher.log` (Tray → **Open log**). Remove passwords, tokens and invite links first.

For an adapter that misreads a game, attach a recording from **Record raw game data** to an "Adapter report / real game payload" issue, after anonymising player names and IDs.

Questions that are not bugs go to [GitHub Discussions](https://github.com/downstagehq/cleartoair/discussions). Security problems go through `SECURITY.md`, never a public issue.
