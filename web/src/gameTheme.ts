// Per-game skin for the control room.
//
// Every pack already carries a theme (Valorant red, Rocket League blue, Apex
// crimson…) and the app ignored it completely, so switching titles changed almost
// nothing you could see. This publishes the active pack's colour as CSS variables
// and stamps `data-game` on <html>, which is all the stylesheet needs to re-skin
// the chrome.
//
// One rule this must not break: `--pgm` red and `--pvw` green mean PROGRAM and
// PREVIEW and nothing else. Several packs are red (Valorant #FF4655, Apex
// #DA292A), so the game colour is only ever used for identity — edges, washes,
// the game badge — never as a filled status indicator that could be misread as
// tally.

import { useEffect } from 'react';
import type { Pack } from './types';

/** Clear to Air's own brass, used when no pack is resolved yet. */
const NEUTRAL = { primary: '#d9b25a', secondary: '#12151a', accent: '#b8933e' };

/** #rgb / #rrggbb -> "r, g, b", so the stylesheet can build its own alphas. */
export function rgbChannels(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * Relative luminance (WCAG). A few packs ship a colour dark enough that text on
 * it would be unreadable, so the badge flips its own foreground rather than
 * trusting the pack to have picked a legible one.
 */
export function luminance(hex: string): number {
  const ch = rgbChannels(hex);
  if (!ch) return 0;
  const [r, g, b] = ch.split(',').map((v) => {
    const c = Number(v.trim()) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyGameTheme(pack: Pack | null): void {
  const root = document.documentElement;
  const theme = pack?.theme ?? NEUTRAL;
  const primary = theme.primary || NEUTRAL.primary;
  const accent = theme.accent || primary;
  const channels = rgbChannels(primary) ?? rgbChannels(NEUTRAL.primary) ?? '217, 178, 90';

  root.style.setProperty('--game', primary);
  root.style.setProperty('--game-accent', accent);
  root.style.setProperty('--game-rgb', channels);
  root.style.setProperty('--game-ink', luminance(primary) > 0.45 ? '#0b0d10' : '#ffffff');

  if (pack?.id) root.dataset.game = pack.id;
  else delete root.dataset.game;
}

/** Keeps the skin in step with the active pack. */
export function useGameTheme(pack: Pack | null): void {
  useEffect(() => {
    applyGameTheme(pack);
  }, [pack]);
}
