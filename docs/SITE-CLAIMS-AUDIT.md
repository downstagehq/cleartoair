# Site claims audit (site/index.html, site/site.js)

Version 0.3.1, 11 October 2026. Checked against the code on `open-source`. Verdicts:
TRUE (evidence given), OVERCLAIM (fixed), STALE (was true once, fixed), UNVERIFIABLE.
Only `site/` was changed.

| # | Claim (where) | Verdict | Evidence | Change |
|---|---|---|---|---|
| 1 | Free, open source; app AGPL-3.0+, packs and renderer MIT (meta, tile, OSS, footer) | TRUE | `package.json`, `agent/` and `web/package.json` `"license": "AGPL-3.0-or-later"`; `packs/LICENSE`, `overlays/_shared/LICENSE` | none |
| 2 | Hero status: "testing with real games is in progress" | OVERCLAIM | No adapter has had a real game feed; real-game tests are planned. "One real OBS setup" is true (`docs/KICKOFF.md:22`, OBS 32.2.2) | "Tested with the built-in simulators, sample game data and one real OBS setup. It has not yet run with a live game or on a real show." |
| 3 | 8 game packs, each with overlays, match model and simulator | TRUE | `packs/*/pack.json` (8), `agent/src/sim/*.js` (8) | none |
| 4 | "5 games with a live data feed from the publisher driving the graphics" (tile) | OVERCLAIM | 5 adapters exist (`agent/src/adapters/{cs2gsi,dota2gsi,rlstats,lolclient,apexlive}.js`); none has driven graphics from a real game | "games with an adapter for the publisher's live data feed" |
| 5 | 8 OBS scenes, built and installed into OBS | TRUE | `agent/src/obs/collection.js:76` `RECIPE_SCENES`; installs to `%APPDATA%\obs-studio\basic\scenes` (`config.js:32`) | none |
| 6 | Preflight checks OBS, 8 scenes, overlays, audio, graphics over capture, rehearsal source, sample event, simulator, replay buffer, tracks, disk; every 10 s and on demand | TRUE | `agent/src/preflight.js` (`INTERVAL_MS = 10000`, checks at 110-276) | none |
| 7 | Mock "19 checks" | TRUE | 19 base checks when OBS is connected: agent-up + 9 state + 5 OBS + 1 overlay + 3 disk (`preflight.js:279-287`), plus any tripped watchdogs | none |
| 8 | Lamp green / amber / red | TRUE | `web/src/components/Lamp.tsx` `lampFor` | none |
| 9 | Every problem comes with a fix for the operator | TRUE (minor) | Every fail and warn has fix text, except the follow-on "OBS check skipped" warns, which ride on the OBS-connected fail's fix | none |
| 10 | Drift compares scenes, sources, visibility, browser URLs, audio | TRUE | `agent/src/obs/drift.js:1-4` | none |
| 11 | Four watchdogs every 5 s; silent caster caught in about 10 s; reload at most once a minute | TRUE | `agent/src/watchdog.js` (`INTERVAL_MS 5000`, `SILENT_SAMPLES 2`, `REFRESH_COOLDOWN_MS 60000`) | none |
| 12 | "Series bug ... for every game"; cards "head-to-head, rosters, bracket, scoreboard, MVP and schedule" in every pack | OVERCLAIM (small) | Apex has `bugStyle: "br"` and no `h2h` or `mvp` card (`packs/apex/pack.json:25`) | "Scorebug, lower thirds, ticker ..."; "Every pack has roster, bracket, scoreboard and schedule cards, all but Apex add head-to-head and MVP, plus ..." |
| 13 | Format cards: veto CS2/VALORANT, draft Dota 2/LoL, standings Apex, set FGC, match stats EA FC, games RL | TRUE | `caps.cards` in each `pack.json` | none |
| 14 | Four pages per pack; ticker and lower third on every in-game page | TRUE | `overlay.pages` in each `pack.json`; `packs/*/overlay/ingame.html` | none |
| 15 | Event colours, logo, font set once, flow into every page | TRUE | `overlays/_shared/core.js:163` `applyBrand` | none |
| 16 | "Five games feed the graphics directly" | OVERCLAIM | As 4 | Heading "Five games can feed ..."; added: built from publisher docs, tested with simulators and sample data, none has run against a live game yet |
| 17 | Record raw game data switch | TRUE, was missing | `capturable = true` on all 5 adapters; `web/src/views/Data.tsx:109`; `docs/CHANGELOG.md` 0.3.1 | One line added in Live data |
| 18 | VALORANT: paste scoreboard TEXT, shown by team, applied on confirm | TRUE | `web/src/components/ScoreboardImport.tsx` (dry run, then apply; posts text to `/api/stats/ocr`). The page never says OCR or image | none |
| 19 | VALORANT manual round desk | TRUE | Per-map round steppers, `web/src/views/Match.tsx:213-221` | none |
| 20 | Every game imports teams and brackets from start.gg | TRUE | `agent/src/adapters/startgg.js:9` lists all 8 | none |
| 21 | A simulator for every game | TRUE | `agent/src/sim/` | none |
| 22 | Remote seats "built and in beta", producer or scorer | UNDERSTATED / unqualified | Viewer seat exists too (`docs/REMOTE.md:33`); tested over the internet 11 Oct 2026, never on a real show (`README.md:110-113`) | "in beta: a producer, scorer or viewer ... tested over the internet, not yet on a real show" |
| 23 | Hosted control room card tagged "Coming" | STALE | Relay live at room.cleartoair.com since 0.3.0 | Tag "Beta"; added "Tested over the internet, not yet on a real show." |
| 24 | Local first; only VALORANT map art needs the internet | TRUE | Overlays bundle their fonts (`overlays/_shared/fonts`); the only external host in `packs/` and `overlays/` is media.valorant-api.com; `web/src` loads nothing external | none |
| 25 | Nothing installed in OBS; uses obs-websocket; never between OBS and the encoder | TRUE | `agent/src/obs/bridge.js` | none |
| 26 | Windows zip, no installer; port 7700; obs-websocket 4455 | TRUE | `README.md:71-77`, `docs/RELEASE.md` | none |
| 27 | FGC titles SF6, Tekken 8, GGST, MK1 | TRUE | `packs/fgc/pack.json:17` | none |
| 28 | No licence key, no watermark, no account | TRUE | No licensing code; remote seats use invite links, no accounts | none |
| 29 | "Give monthly or once" | UNVERIFIABLE | No donation page yet; the button opens an email to hello@ | "Write to us to give monthly or once." |
| 30 | Sponsor logo on site, README and About screen | TRUE (as an offer) | `web/src/components/About.tsx` has a sponsors section | none |
| 31 | Paid setup and custom packs | UNVERIFIABLE | A service offer, not a product claim | none |
| 32 | Nothing reads game memory or injects into a game client | OVERCLAIM (small) | Clear to Air does neither, but the Rocket League SOS fallback needs BakkesMod, a mod (`agent/src/adapters/rlstats.js:14-15`) | "Clear to Air does not read game memory ... Its optional Rocket League fallback, SOS, needs the BakkesMod mod, which only loads with anti-cheat off." |
| 33 | Riot's policy allows broadcast overlays | UNVERIFIABLE | External policy, not in code | none |
| 34 | FAQ "How finished": "testing with real games is in progress" | OVERCLAIM | As 2 | Rewritten: simulators, sample data, one real OBS; no live game, no real show yet; remote seats tested over the internet only |
| 35 | FAQ live data games "each through the publisher's own feed" | OVERCLAIM (unqualified) | As 4 | "... through an adapter for the publisher's own feed, so far tested with simulators and sample data only." |
| 36 | Games legend "a live feed from the publisher drives the graphics" | OVERCLAIM | As 4 | "an adapter reads the publisher's live feed." |
| 37 | "The public release is not out yet" / "email you once, at launch" (notify, site.js) | STALE | v0.3.0 and v0.3.1 are public on GitHub Releases; the repo is public | "Releases are on GitHub now. Leave an address and we will email you once, when version 1.0 is out."; eyebrow "Version 1.0"; success message and footnote updated to match. **Owner to confirm the 1.0 promise.** |
| 38 | Built in South Africa by a working broadcaster | UNVERIFIABLE | Names no events, organisers or players | none |
| 39 | Sample names (Alpha, Bravo, Riley Chen and so on) | TRUE (fictional) | Matches the scrubbed sample data | none |

Not on the page and not claimed, so nothing to fix: image OCR, talent video and return
feeds, code signing (the zip is unsigned and SmartScreen warns), macOS or Linux builds,
paid tiers. Signed manifests and self-update are real but not mentioned.

Rendered with `python -m http.server` and headless Chrome at 1440 px. At 375 px (browser
emulation) `scrollWidth` is 375, so nothing overflows.
