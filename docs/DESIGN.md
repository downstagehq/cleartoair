# CLEAR TO AIR — design system

## Thesis
A broadcast gallery, not a dashboard. The only saturated colour on a control-room
screen is **state**: red is PROGRAM, green is PREVIEW, amber is a warning. Everything
else is cool graphite and light. The brand's signature is a **lamp**: the wordmark
carries an indicator that is dark when idle and lit when the show is clear to air.
Nothing decorative. Density is high, hierarchy is carried by type weight and
hairlines, not boxes.

## Tokens (CSS custom properties; also the Tailwind theme)

```css
:root {
  /* surfaces — cool graphite ladder */
  --bg-0: #0B0D10;   /* canvas */
  --bg-1: #12151A;   /* panel */
  --bg-2: #181C22;   /* card / raised */
  --bg-3: #1F242C;   /* hover / active */
  --line: rgba(255,255,255,.07);      /* structural hairline */
  --line-strong: rgba(255,255,255,.14);
  /* ink */
  --ink: #E8ECF1; --ink-2: #A9B3C1; --ink-3: #6E7A8A; --ink-4: #45505E;
  /* state (reserved — never used as decoration) */
  --pgm: #FF3B3B; --pgm-glow: rgba(255,59,59,.35);
  --pvw: #3DDC84; --pvw-glow: rgba(61,220,132,.30);
  --warn: #FFB020; --fail: #FF5A5A; --ok: #3DDC84;
  /* brand accent: brass. Used for ONE thing per screen (primary action or the lamp text) */
  --brass: #D9B25A; --brass-2: #B8933E; --brass-glow: rgba(217,178,90,.25);
  /* type */
  --font-ui: "Inter Variable", Inter, system-ui, sans-serif;
  --font-display: "Barlow Condensed", "Bebas Neue", Impact, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace;
  /* radii */
  --r-1: 6px; --r-2: 10px; --r-pill: 999px;
  /* motion */
  --ease: cubic-bezier(.23, 1, .32, 1); --t-fast: 120ms; --t-base: 180ms; --t-slow: 260ms;
}
```

Spacing scale: 4/8/12/16/24/32/48. Panel padding 16. Row height in dense lists 32.

## Type
- UI: Inter Variable 14px/1.45, weight 450–500. Labels 11px uppercase, tracking .08em, `--ink-3`.
- Display: Barlow Condensed 600/700 for scene names, team names, scores in the control room; 700 for overlay numerals.
- Mono: JetBrains Mono for clocks, scores, round numbers, hotkeys, ids. `font-variant-numeric: tabular-nums` everywhere numbers change.
- Never letter-space Inter. Do letter-space Barlow Condensed uppercase (.04–.08em).

## Tally grammar (non-negotiable)
- PROGRAM: 2px red ring + red label chip "PGM"; a 6px red dot pulses (1.6s) on the program scene in every list.
- PREVIEW: 2px green ring + "PVW".
- Armed / pending: dashed `--line-strong` ring, no colour.
- Idle: hairline.
- Red and green appear NOWHERE else. Success toasts use `--ok` text only, no green fills.

## Components
- **Button**: 32px, `--bg-2` fill, hairline, radius 6, hover `--bg-3`, active scale(.97). Primary = brass fill with `#111` text. Danger = hairline red text, red fill only while confirming.
- **Hot action** (cuts to air): must be a two-step ARM → TAKE, or a dedicated red TAKE button in the Air column. Never a plain button in a grid.
- **Keycap**: 20px, mono 11px, gradient `#1a1e25→#12151A`, inset highlight, hairline.
- **Status pill**: 22px, mono 11px uppercase, dot + text; colours only from state tokens.
- **Panel**: `--bg-1`, hairline, radius 10, header 40px with 11px uppercase title on the left and actions on the right.
- **Field**: 32px, `--bg-0` fill, hairline, focus ring brass 1px + glow.
- **Toggle**: 36x20 track; ON = brass; OFF = `--bg-3`.
- **Lamp** (brand signature): a 12x12 rounded square. Idle `--bg-3` with hairline; CLEAR → `--ok` fill + glow; FAULTS → `--fail`. Sits inside the wordmark and in the status bar.

## Layout of the control room (1440+ wide; collapses gracefully to 1100)
```
┌──────────────┬────────────────────────────────────────────┬───────────────────┐
│ RAIL 56px    │ WORKSPACE (tabs: Show · Match · Graphics · │ AIR 320px         │
│ logo lamp    │           Data · Rundown · Preflight ·     │ PROGRAM thumb     │
│ nav icons    │           Setup)                           │  (red ring)       │
│              │                                            │ PREVIEW thumb     │
│              │  Panels in a 12-col grid, 16px gutters     │  (green ring)     │
│              │                                            │ [   TAKE   ]      │
│              │                                            │ scene strip F1–F8 │
│              │                                            │ replay · mute     │
│              │                                            │ stream · record   │
├──────────────┴────────────────────────────────────────────┴───────────────────┤
│ STATUS BAR 28px: ● agent  ● OBS 32.1  ● cs2gsi 0.4s  ● 4 overlays   ⌘K   12:04:31 │
└─────────────────────────────────────────────────────────────────────────────┘
```
- Show tab: rundown blocks as one-click "GO" rows (sets graphics + cuts scene), current block highlighted, next block outlined.
- Match tab: series card (team A | score | team B, with SWAP), map list with per-map score, veto builder (pool chips → ban/pick/decider steps, team colour), rosters editor.
- Graphics tab: on-air toggles (bug, ticker, lower third, corner, timeout), full-frame card selector with live thumbnail, lower-third composer, standby composer.
- Data tab: adapter cards (status, latency, start/stop, install instructions), simulators, live feed table (players), start.gg import.
- Preflight tab: the lamp large, check list grouped ok/warn/fail with FIX text, drift list, watchdog log.
- Setup tab: event + brand (colours, logo, font), pack switch, talent slots, OBS collection build/install, settings.
- ⌘K command palette: every action; hotkeys F1–F8 scenes, 1–5 toggles, R replay, T take, M mute.

## Overlay style (shared skeleton, per-pack skin)
- Plates: chamfered ends (clip-path polygon, 14px chamfer), `--brand-secondary` body, `--brand-primary` 4px edge, team colour 6px edge on team plates.
- Numerals: Barlow Condensed 700; scores 96px in the bug, 160px on cards.
- Cards: full-frame dark ground with a ghosted display-face wordmark at 4% white, brand primary hairlines, map art with a 60% dark scrim and 8px brand edge.
- Motion: `.fx` 320ms opacity + 420ms transform; enter from 24px; never transform-origin surprises (position with calc()).

## The logo (final, Oct 2026)

The designers' delivery is in `brand/source/` as received. `python tools/brand/clean.py`
turns it into `brand/*.svg` (Illustrator's white artboard rectangle and the white a-counters
removed; the counters become a mask) and `web/src/brand.ts`; `python tools/brand/icons.py`
draws the launcher icon and tray PNGs into `tools/launcher/brand/`.

- **Wordmark** "clear to a✓r", lower case. The ✓ with its dot stands in for the i of *air*,
  and it is the same shape as the **mark**. Never retype the name in a font in its place.
- **The mark is the lamp.** It is the product's one status signal, in the designers' four states:

  | State | Colour | Means |
  |---|---|---|
  | Clear | `#3DDC84` | preflight passes, no warnings |
  | Warnings | `#FFB020` (= `--warn`) | passes, with warnings |
  | Faults | `#FF5A5A` (= `--fail`) | a check fails, or the agent is down |
  | Idle | `#1E242C` (designers); `--lamp-idle #4A5464` on graphite, `#8792A2` in the tray | not checked yet |

  Same rule everywhere: rail, preflight header, browser tab icon, Windows tray, site.
- **Clear is the PVW green.** That was put to the designers in the logo brief and they kept it.
  The lamp only ever lights the mark, never a tile, row or chip, so green still means PREVIEW
  everywhere else in the control room (`--ok` stays teal for passing rows).
- The "CTA" abbreviation is retired from the UI (it reads as *call to action*); the rail shows the mark.
- On customer overlays the logo does not appear. Their broadcast is their brand.

## Landing page
Hero: the control room itself in a browser chrome mock, PGM tile pulsing, one line: **"Clear to air."** Sub: "The control room for esports broadcasts. Pairs with your OBS. Ships with the graphics." One CTA (brass). Below: four proof tiles pulled from the real event (11 scenes, 65 replay clips, 0 crashes, 2-person crew). Feature strips alternate UI crop / copy. Pricing: Free · Event Pass · Pro · Studio with a USD/ZAR toggle.
