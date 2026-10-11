# Scoreboard OCR: plan and status

VALORANT has no live stats API, so the end-of-game numbers come off the
scoreboard screen. Today `POST /api/stats/ocr` parses pasted text
(`agent/src/stats/scoreboard.js`) and refuses an image with a 415. This adds
reading the image, without adding a dependency.

## What works

- **Engine:** the OCR built into Windows 10/11 (`Windows.Media.Ocr`), driven
  from Windows PowerShell 5.1 by `agent/src/stats/ocr-windows.ps1`. There is
  nothing to install and no native module, so the portable zip stays as it is.
  Node starts it with an async `spawn` and a timeout (default 15 s), never
  `spawnSync`. On the dev box the OCR languages are en-GB, en-US and zh-Hans-CN.
- **Pipeline** (`agent/src/stats/ocr.js`, `png.js`):
  1. Decode the PNG in pure JS.
  2. Find the text cells from the horizontal pixel gradient.
  3. Rebuild the image as tight dark-on-white text lines, one per scoreboard
     row.
  4. OCR that composite in 3 layouts, plus the raw image and a "last glyph
     trimmed" copy. All five go through ONE PowerShell start-up.
  5. Vote per cell, and map the words back to cells.
  6. Rebuild the rows and columns from the header row (`readScoreboard`).
  7. Emit the paste text, and `scoreboard.js` parses it. The paste parser stays
     the only thing that writes `stats.scoreboard`.
- **Why the extra steps:** the raw engine almost never misreads a digit, but it
  drops cells. Isolated short tokens go missing (a lone `4` in the A column, a
  `0` first blood, the single-letter `K`/`D`/`A` headers), and so do whole `%`
  words. Bahnschrift `74%` reads as `740/0`, and Arial `74%` is dropped
  entirely. Packing each row into one line fixes the drops. When layouts
  disagree, the cell is left blank and the warning names both reads. A word that
  straddles two cells (`14 4` read as `144`) is discarded. A percent cell is
  only accepted if it is between 0 and 100.

## Measured on synthetic boards (fictional players, `fixtures/make-board.mjs`)

| Board (10 players x 8 stat columns) | Cells read | Wrong values | Time |
|---|---|---|---|
| 1920x1080, flat background | 80/80 | 0 | ~1.9 s |
| 1920x1080, gradient, stripes, HUD text | 80/80 | 0 | ~2.1 s |
| 1280x720 (downscaled) | 70/80 | 0 | ~1.8 s |
| 1280x720, noisy | 69/80 | 0 | ~1.9 s |

- **By column:** ACS, K, D, A, ECON and FB were 240/240 across all four boards.
  The IGNs were 40/40. Agent labels were all read at 1080.
- **At 720p:** the 11 cells lost are the `HS%` column (its header label is not
  read, so the column cannot be named and is left empty) and one KAST cell.
- **Baseline, raw engine on the 1080 board:** about 54% of cells by position
  (75% at best with upscaling and inversion). Through the row rebuild it is
  about 5%, because the K/D/A headers are lost. So the composite step is the
  whole result.
- **Synchronous JS:** about 300 ms per 1080p image, yielding between layouts.
- **Tests:** `node agent/src/stats/_ocrtest.js` covers all of this. Off Windows
  it prints SKIP.

## Limits (not yet verified on a real capture)

- **Real game font and layout.** Untested against the actual VALORANT
  end-of-game screen. Its column set probably differs from the pack's
  `[acs,k,d,a,kast,hs]` (ACS / K / D / A / econ / first bloods / plants /
  defuses are typical; KAST and HS% may not be shown). Columns the board does
  not have are left empty with a warning.
- **Agent icons.** The game shows agent icons, not names, so `agent` will
  usually be empty.
- **4:3 stretched resolutions.** These squash the glyphs horizontally. Expect
  more drops; the fix would be a horizontal pre-scale.
- **HUD or overlays on top of the board.** Our own graphics in the program
  feed will be read as text. Shoot the game capture source, not program. A
  `crop` option exists to restrict the area.
- **Busy backgrounds.** A busy 3D scene behind a translucent board can merge
  rows into one text band. The rows are skipped (blank), not misread.
- **Languages.** English OCR is used when it is installed (it is on every
  English Windows). Non-Latin IGNs need that OCR language installed, and even
  then they are untested.
- **Windows only.** Off Windows, the route answers 501 and pasting still works.

## Operator flow (never straight to air)

1. In Stats, click **Read from screen**. This takes an OBS shot of the game
   capture at full width (or the operator uploads a PNG).
2. The agent OCRs it and answers a **preview**: rows, empty cells, warnings
   ("Onyx: d read as 13 or 18 - check it"), and the paste text. Nothing is
   applied.
3. The control room shows the preview in the existing scoreboard import box.
   The operator fixes any blanks and clicks **Apply**. That is the existing
   text path (`{ text, apply: true }`), so what airs is exactly what the
   operator confirmed.

## Remaining steps

1. Wire the route (image or `source:"obs"` → preview, never auto-apply) and add
   the test to `npm test`.
2. Add `bridge.sourceScreenshot(GAME_SOURCE, 1920)`. Today
   `bridge.screenshot()` only shoots scenes, and the program scene includes our
   graphics.
3. UI: a "Read from screen" button and a preview with empty cells highlighted,
   in `web/src/components/ScoreboardImport.tsx`.
4. Collect 5-10 real end-of-game captures (1080p, 1440p, 4:3 stretched), add
   them as fixtures, and retune. If needed, add a per-title header map (for
   example ECON RATING, FIRST BLOODS, PLANTS) and a pack column mapping.
5. Optional: move the pixel work to a `worker_thread` if the 300 ms block ever
   shows up in overlay timing.
