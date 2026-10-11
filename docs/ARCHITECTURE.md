# Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │  CONTROL ROOM (web/ → web/dist)              │
                 │  Show · Match · Graphics · Data · Rundown ·  │
                 │  Preflight · Setup       ⌘K   F1–F8  R T M   │
                 └───────────────▲───────────────▲──────────────┘
                                 │ WS /ws        │ REST /api
┌────────────┐    obs-websocket  │               │           ┌─────────────────┐
│    OBS     │◄──────────────────┤  LOCAL AGENT  ├──────────►│ OVERLAY PAGES   │
│  scenes,   │   :4455           │  :7700        │  WS /ws   │ (OBS browser    │
│  sources,  │                   │               │           │  sources)       │
│  replay,   │  screenshots      │  state.json   │           │ packs/<game>/   │
│  meters    │◄──────────────────┤  packs/       │           │ overlay/*.html  │
└────────────┘                   │  preflight    │           └─────────────────┘
                                 │  watchdogs    │
                                 │  drift        │
                                 │  collection   │
                                 └───────▲───────┘
            CS2 GSI :7701 ─────────────┐ │ ┌──────── RL native :49123 / SOS :49122
            Dota 2 GSI :7702 ──────────┤ │ ├──────── LoL Live Client :2999
            Apex LiveAPI :7777 ────────┘ │ └──────── start.gg GraphQL (import)
                                         │
                                   simulators (cs2, rocketleague, lol, valorant)
```

## Why this split
- **obs-websocket is localhost-only and game capture is local**, so the agent must live on
  the stream PC. It is the one piece that can never be "just a website".
- **Overlays are URLs.** OBS browser sources point at `http://127.0.0.1:7700/packs/<game>/overlay/<page>.html`;
  the same pages could be served from a CDN later with no change to OBS.
- **The control room is a web app** talking to the agent over one WebSocket. Today it is
  served by the agent. Remote seats (`docs/REMOTE.md`) serve the same app through a
  relay the rig dials out to, while state stays on the rig, so venue Wi-Fi dying
  never blanks a graphic.

## State
One entity-shaped document (`CONTRACTS.md §2`). Teams are entities with ids; the series
is the only place A/B slots map to ids; veto, scoreboard, bracket reference ids. Patches
are deep merges with a 200-step undo history; persisted to `agent/data/state.json`
debounced; `live` (adapter output) is never persisted.

## Traps encoded (the moat)
- Chromium's six-HTTP/1.1-connections-per-host pool is shared by every OBS browser
  source → one WebSocket per page, never SSE, never polling loops.
- `.fx` animates `transform` → never position with `translate(-50%)`; use `calc()`.
- OBS re-bases group children to the group's bounding-box corner on load.
- obs-websocket accepts connections ~80 s before the collection loads → `readyRefresh`.
- `GetSourceScreenshot` only paints browser sources in the program scene.
- OBS rewrites the collection on exit → refuse to install while `obs64.exe` runs.
- `bounds_rel = px / (canvasH/2)`; z-order is stored bottom-first.
- Preflight must read the ACTIVE profile (`global.ini` / `user.ini` `[Basic] Profile`),
  not a profile by name.
- VDO.Ninja gives a mismatched-password viewer no media and no error → meters, not the mixer.
- Vanguard blocks synthetic input while VALORANT runs; use APIs, never GUI automation.
- `tasklist /FI` from Git Bash silently matches nothing (MSYS path mangling) → spawn via `cmd /c`.

## Remote seats (the hosted control room)
| Layer | Where | Notes |
|---|---|---|
| State | the local agent (`agent/data/state.json`) | the rig is always the source of truth; the relay keeps only a room-key hash, invite codes and the seat list |
| Relay | Cloudflare Worker + Durable Object (`relay/`) | the rig dials out, so no port is forwarded; self-hostable |
| Seats | browser, through the relay | producer / scorer / viewer, enforced on the rig by `agent/src/remote-policy.js` |
| Secrets | never leave the rig | OBS password, GSI and start.gg tokens are redacted from every remote answer |

Full guide: `docs/REMOTE.md`; the relay itself: `relay/README.md`.
