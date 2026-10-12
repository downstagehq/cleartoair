# Scoreboard OCR: plan and status

VALORANT has no live stats API, so the end-of-game numbers come off the
scoreboard screen. `POST /api/stats/ocr` (0.3.2) takes pasted text, an uploaded
image or an OBS shot of `GAME · Capture`. Image reads are always a **preview**
that the operator confirms. No dependency is added.

## How it works

- **Engine:** the OCR built into Windows 10/11 (`Windows.Media.Ocr`), driven
  from Windows PowerShell 5.1 by `agent/src/stats/ocr-windows.ps1`. There is
  nothing to install and no native module. On the dev box the OCR languages are
  en-GB, en-US and zh-Hans-CN.
- **Input:** PNG or JPEG (`png.js`, `jpeg.js`, both pure JS). The JPEG decoder
  handles baseline files, which are what OBS, browsers and the Windows snipping
  tool write. Progressive and CMYK JPEGs get a 415 ("save as PNG").
- **Off the event loop:** the whole read runs in a worker thread
  (`ocr-worker.js`): decoding, finding the cells, building the layouts,
  starting PowerShell, and the vote. Starting PowerShell is a synchronous
  CreateProcess that takes 5-30 ms on Windows. The agent's event loop only
  waits for one message. Measured worst stall: 8-22 ms, with three reads at
  once.
- **Pipeline** (`agent/src/stats/ocr.js`):
  1. **Find the text cells from glyph strokes.** A stroke is a strong luma step
     followed, within a stroke width, by a step back. One-sided edges (row
     backgrounds, icon tiles) don't count, and any ink run taller than about 9%
     of the image (grid lines, a minimap frame, background texture) is erased.
  2. **Rebuild the cells as tight dark-on-white text lines,** one per
     scoreboard row, in 3 layouts. Also read: the raw image, a copy with each
     cell's last glyph cut off (used only for percent columns), and 2 "probe"
     layouts. A probe draws each one- or two-glyph cell between two copies of a
     multi-digit neighbour ("298 4 298"); a probe read counts only if both
     copies read the same.
  3. **Read all 7 images in ONE PowerShell start-up.**
  4. **Vote per cell.**
     - Disagreeing reads leave the cell blank, and the warning names both
       reads.
     - A single-glyph cell needs 2 agreeing reads. Read only once, it stays
       blank and the warning offers that read.
     - A word straddling two cells (`14 4` read as `144`) is discarded.
     - Percent cells must be between 0 and 100.
  5. **Rebuild rows and columns from the header row** (`readScoreboard`):
     - Two-word labels (FIRST BLOODS, ECON RATING) are joined.
     - Every layout's reading of a label is tried, not just the vote winner.
     - IGNs lose the icon junk the engine reads around them (`I Ember A`).
       Snapping to the roster is exact, ignoring case, or exactly one roster
       name one character off for names of 5+ letters.
     - A column whose label did not read at all is **named** (never filled)
       from a known board layout. This only happens when exactly one known
       layout fits the labels that did read, at least 4 labels read, and a
       column of numbers sits where that layout puts it. It is flagged in the
       warnings.
  6. **Emit the paste text,** and `scoreboard.js` parses it. The paste parser
     stays the only thing that writes `stats.scoreboard`. A hole ends the row's
     text, so later values can never slide into the wrong column.

## Synthetic boards (fictional players, `fixtures/make-board.mjs`)

Each board is rendered by headless Chrome at the game resolution, then scaled
the way the OBS shot does (1920 px wide), lightly blurred (0.25-0.5 px) and
JPEG-compressed at q 0.6-0.7 in a canvas. The 8 committed JPEGs are 50-86 KB
each.

- **"real" boards:** our understanding of the in-game end-of-match scoreboard
  (assumptions below). Bahnschrift (Windows' DIN) for names and numbers, Bebas
  Neue (bundled, OFL) for the title and headers. Agent and rank are icons, rows
  have team-tinted translucent backgrounds, and the local player's row is pale
  yellow with dark text.
- **"stats" boards:** a tracker-style layout with KAST / HS% in Barlow
  Condensed (bundled, OFL).
- **The busy board** adds a bright 3D-ish background with line texture behind a
  translucent board, a minimap overlapping the left edge, a kill feed and an
  ability bar.

| Board | Source → OCR input | 0.3.2 pipeline (right / blank / WRONG) | Now (right / blank / WRONG) | Time now |
|---|---|---|---|---|
| real-1080 | 1920x1080, q70 | 67 / 13 / 0 | **80 / 0 / 0** | 2.0 s |
| real-1440 | 2560x1440 → 1920x1080 | 68 / 12 / 0 | **80 / 0 / 0** | 2.0 s |
| real-720-up | 1280x720 → 1920x1080 | 54 / 26 / 0 | **80 / 0 / 0** | 1.9 s |
| real-4x3-stretched | 1440x1080 → 1920x1080 | 72 / 8 / 0 | **80 / 0 / 0** | 1.9 s |
| real-busy-hud | busy background, HUD, q60 | 0 / 80 / 0 | **80 / 0 / 0** | 2.0 s |
| stats-1080 | 1920x1080, q65 | 71 / 9 / 0 | **80 / 0 / 0** | 1.7 s |
| stats-1440 | 2560x1440 → 1920x1080, q60 | 79 / 1 / 0 | **79 / 1 / 0** | 1.8 s |
| stats-720 | 1280x720, q70 | 63 / 17 / 0 | **79 / 1 / 0** | 1.6 s |
| **Total** | | **474/640 (74.1%)** | **638/640 (99.7%), 0 wrong** | |

How these were measured:
- 10 players × 8 stat columns per board. Cells only count as right when the IGN
  was matched too.
- The 0.3.2 pipeline could not take JPEGs, so it was fed the same pixels as
  PNG.
- Times are on this PC (Core Ultra 9 185H) when idle. Under load from other
  work they rose to 3-4 s.

Notes:
- **Both blanks** are Zephyr's ECON `71` in Barlow Condensed. The 7's diagonal
  touches the 1, and every layout reads it as "n". That is a genuine glyph
  ambiguity, so it is left blank and flagged, which is the intended behaviour.
- **The round-1 boards** (PNG, flat fills) went from 299/320 to 317/320 on the
  same code.
- **Tests:** `node agent/src/stats/_ocrtest.js` takes about 11 s on Windows:
  105 checks, 9 reads, three at a time. Off Windows the OCR part prints SKIP,
  and the decoding, cell-finding and row-rebuild checks still run.

### Assumptions about the real end-of-match scoreboard (no capture yet)

- One list of all ten players, sorted by ACS, rows tinted by team. Teams are
  therefore assigned by roster, not by position.
- Columns: player (agent icon, name, rank icon), then ACS, K, D, A, ECON
  RATING, FIRST BLOODS, PLANTS, DEFUSES. There is no KAST or HS%, so with the
  VALORANT pack's `[acs,k,d,a,kast,hs]` those two come back empty with a
  warning.
- The local player's row is highlighted, and the title shows VICTORY/DEFEAT
  with the score.

All of this needs checking against a real capture. If the real headers differ,
add their spellings to `HEADER_KEYS` and the column order to `KNOWN_LAYOUTS`
in `ocr.js`.

## Limits

- **Synthetic only.** No real VALORANT capture has been tested. The fonts are
  stand-ins for the game's own.
- **HUD over the cells themselves.** HUD over the edges is handled. A cell
  covered by HUD comes back blank, not misread, because the strokes are gone.
- **Very busy, high-contrast scenes behind a mostly transparent board** can
  still merge or split rows. The result is blank rows, not wrong numbers.
- **Languages.** English OCR is used when it is installed (it is on every
  English Windows). Non-Latin IGNs are untested and won't snap to a roster
  name unless the roster spells them the same way.
- **Windows only.** Off Windows the route answers 501, and pasting still works.

## Operator flow (never straight to air)

1. In Stats, the operator either clicks **Read game feed** (an OBS shot of
   `GAME · Capture`, 1920 px wide) or uses **Read image**.
2. The agent answers a **preview**: rows, empty cells, warnings ("Onyx: d read
   as 13 or 18 - check it", "Kestrel: defuses read only once, as 1 - check
   it"), and the paste text. Nothing is applied.
3. The operator fixes any blanks and clicks **Apply**. That is the text path
   (`{ text, apply: true }`), so what airs is exactly what the operator
   confirmed.

## Remaining steps

1. Collect 5-10 real end-of-game captures (1080p, 1440p, 4:3 stretched), add
   them as fixtures, confirm the column assumptions above and retune.
2. **UI:** let **Read image** accept JPEG (`accept="image/png,image/jpeg"`).
   Highlight blank cells and inferred columns in the preview.
3. **Optional:** a VALORANT pack column set that matches the real board
   (`econ`, `fb`, `plants`, `defuses`) if the overlays want those instead of
   KAST / HS%.
