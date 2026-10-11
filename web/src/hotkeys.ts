import { useEffect } from 'react';
import { TABS, useStore } from './store';

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable || !!t.closest('[cmdk-root]');
}

/** Control-room hotkeys per DESIGN.md: F1–F8 scenes, 1–5 toggles, R replay, T take (arms), M mute,
 *  Ctrl/⌘+Z undo. These only work while the control room has focus (unlike OBS hotkeys, which are
 *  global - which is why the collection no longer writes any). */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const S = useStore.getState();
      if (S.paletteOpen || S.aboutOpen) return;

      // Alt+letter → tab
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const t = TABS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (t) {
          e.preventDefault();
          S.setTab(t.id);
          return;
        }
      }
      // Ctrl/⌘+Z: undo the last state change (never while typing - the field owns it).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void S.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // F1–F8 follow the recipe NUMBER ("01 ·" … "08 ·"), not the position in OBS's
      // scene list, and ARM the scene into preview. Only with Setup → "Fast cut"
      // on do they cut straight to program. No scene with that number: nothing.
      const fk = /^F(\d{1,2})$/.exec(e.key);
      if (fk) {
        const n = Number(fk[1]);
        if (n >= 1 && n <= 8 && S.obs.connected) {
          e.preventDefault();
          void S.sceneKey(n).catch(() => {});
        }
        return;
      }
      switch (e.key) {
        case '1':
          void S.toggleShow('bug');
          break;
        case '2':
          void S.toggleShow('ticker');
          break;
        case '3':
          void S.toggleShow('corner');
          break;
        case '4':
          void S.toggleShow('lowerThird');
          break;
        case '5':
          void S.toggleShow('timeout');
          break;
        case '0':
          void S.setCard('none');
          break;
        case 'r':
        case 'R':
          if (S.obs.connected) void S.replay('save', true);
          break;
        case 't':
        case 'T':
          if (S.obs.connected) {
            if (S.takeArmedAt) void S.take();
            else S.armTake();
          }
          break;
        case 'm':
        case 'M':
          if (S.obs.connected) void S.muteTalent();
          break;
        case 'Escape':
          // One layer per press: the drawer, then a half-pressed TAKE, then the armed scene.
          if (S.drawer) S.setDrawer(null);
          else if (S.takeArmedAt) S.disarmTake();
          else if (S.obs.preview) void S.clearPreview();
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
