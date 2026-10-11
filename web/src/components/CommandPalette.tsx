import { Command } from 'cmdk';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Camera,
  CircleDot,
  Clapperboard,
  Film,
  Info,
  LayoutGrid,
  ListOrdered,
  MicOff,
  Play,
  Radio,
  Settings2,
  Square,
  Swords,
  ToggleLeft,
  Undo2,
  Zap,
} from 'lucide-react';
import { CARD_LABELS, TABS, currentPack, talentMuteState, useStore, type Tab } from '../store';
import { cardsFor, sceneNumber, sceneTitle } from '../types';
import { Keycap } from './Keycap';
import { ConfirmHold } from './ConfirmHold';

type HoldAction = { label: string; hint: string; action: 'stream' | 'record'; verb: 'start' | 'stop' };

const TAB_ICON: Record<Tab, typeof Play> = {
  show: Play,
  match: Swords,
  graphics: LayoutGrid,
  data: Activity,
  rundown: ListOrdered,
  preflight: CircleDot,
  setup: Settings2,
};

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setPalette = useStore((s) => s.setPalette);
  const obs = useStore((s) => s.obs);
  const state = useStore((s) => s.state);
  const packs = useStore((s) => s.packs);
  const pack = currentPack(packs, state);
  const st = useStore;
  // Stream / record actions do not fire from the list. Selecting one opens the
  // same press-and-hold the Air column uses - a stray Enter in the palette must
  // never end the stream.
  const [hold, setHold] = useState<HoldAction | null>(null);
  useEffect(() => {
    if (!open) setHold(null);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(!st.getState().paletteOpen);
      }
      if (e.key === 'Escape' && st.getState().paletteOpen) setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette, st]);

  const run = (fn: () => void | Promise<unknown>) => () => {
    setPalette(false);
    void fn();
  };

  const scenes = useMemo(() => obs.scenes.map((s) => s.name), [obs.scenes]);

  if (!open) return null;
  const S = st.getState();
  const tm = talentMuteState(obs);

  if (hold) {
    return (
      <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-black/50 fade-in" onClick={() => setPalette(false)}>
        <div onClick={(e) => e.stopPropagation()} className="cmdk p-4 flex flex-col gap-3 w-[420px]">
          <div className="display text-[20px] text-ink">{hold.label}</div>
          <div className="text-[13px] text-ink-2">{hold.hint}</div>
          <div className="flex items-center gap-2">
            <ConfirmHold
              variant={hold.verb === 'stop' ? 'danger' : 'primary'}
              disabled={!obs.connected}
              title="Press and hold 0.8 s"
              onConfirm={() => {
                setPalette(false);
                void S.obsAction(hold.action, { action: hold.verb });
              }}
            >
              {hold.verb === 'stop' ? <Square size={12} /> : <Play size={12} />} Hold to {hold.label.toLowerCase()}
            </ConfirmHold>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHold(null)} autoFocus>
              Back
            </button>
          </div>
          {!obs.connected ? <div className="text-[12px] text-warn">OBS is not connected.</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-black/50 fade-in" onClick={() => setPalette(false)}>
      <div onClick={(e) => e.stopPropagation()}>
        <Command className="cmdk" label="Command palette" loop>
          <Command.Input autoFocus placeholder="Type a command…" />
          <Command.List>
            <Command.Empty>No matching command. Try a scene number, a card name, or a tab.</Command.Empty>

            <Command.Group heading="Air">
              <Command.Item onSelect={run(() => S.armTake())} value="take arm program">
                <Zap size={14} /> Arm TAKE <Keycap className="kc">T</Keycap>
              </Command.Item>
              <Command.Item onSelect={run(() => S.replay('save', true))} value="save replay cut">
                <Film size={14} /> Save replay and cut to 05 <Keycap className="kc">R</Keycap>
              </Command.Item>
              <Command.Item onSelect={run(() => S.replay(obs.replayBuffer ? 'stop' : 'start'))} value="replay buffer start stop">
                <Camera size={14} /> {obs.replayBuffer ? 'Stop replay buffer' : 'Start replay buffer'}
              </Command.Item>
              <Command.Item onSelect={run(() => S.muteTalent())} value="mute talent">
                <MicOff size={14} /> {tm === true ? 'Unmute talent' : 'Mute talent'} <Keycap className="kc">M</Keycap>
              </Command.Item>
              <Command.Item onSelect={run(() => S.obsAction('refresh'))} value="refresh graphics browser sources">
                <Radio size={14} /> Refresh graphics browser sources
              </Command.Item>
              <Command.Item onSelect={run(() => S.undo())} value="undo last change">
                <Undo2 size={14} /> Undo last change <Keycap className="kc">Ctrl Z</Keycap>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Scenes">
              {scenes.length === 0 ? (
                <Command.Item disabled value="no scenes">
                  <Clapperboard size={14} /> OBS not connected — no scenes to arm
                </Command.Item>
              ) : (
                scenes.map((name) => {
                  const n = Number(sceneNumber(name));
                  return (
                    <Command.Item key={name} value={`arm scene preview ${name}`} onSelect={run(() => S.previewScene(name))}>
                      {obs.program === name ? <span className="dot-pgm" /> : <Clapperboard size={14} />}
                      Arm <span className="mono text-ink-3">{sceneNumber(name)}</span> {sceneTitle(name)}
                      {obs.program === name ? <span className="tally-chip tally-chip-pgm">PGM</span> : obs.preview === name ? <span className="tally-chip tally-chip-pvw">PVW</span> : null}
                      {n >= 1 && n <= 8 ? <Keycap className="kc">F{n}</Keycap> : null}
                    </Command.Item>
                  );
                })
              )}
            </Command.Group>

            <Command.Group heading="Cards">
              {cardsFor(pack).map((c) => (
                <Command.Item key={c} value={`card ${CARD_LABELS[c]}`} onSelect={run(() => S.setCard(c))}>
                  <LayoutGrid size={14} /> Card: {CARD_LABELS[c]}
                  {state?.show.card === c ? <span className="ml-auto text-[11px] text-brass">on</span> : null}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="On air">
              {(
                [
                  ['bug', 'Series bug', '1'],
                  ['ticker', 'Ticker', '2'],
                  ['corner', 'Corner tag', '3'],
                  ['lowerThird', 'Lower third', '4'],
                  ['timeout', 'Timeout', '5'],
                ] as const
              ).map(([k, label, key]) => (
                <Command.Item key={k} value={`toggle ${label}`} onSelect={run(() => S.toggleShow(k))}>
                  <ToggleLeft size={14} /> Toggle {label} <Keycap className="kc">{key}</Keycap>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Stream">
              <Command.Item value="start stream go live" onSelect={() => setHold({ label: 'Go live', hint: 'Starts the stream in OBS.', action: 'stream', verb: 'start' })}>
                <Play size={14} /> Start stream… <span className="ml-auto text-[11px] text-ink-3">hold to confirm</span>
              </Command.Item>
              <Command.Item value="stop stream end" onSelect={() => setHold({ label: 'End stream', hint: 'Ends the stream for every viewer. This cannot be undone.', action: 'stream', verb: 'stop' })}>
                <Square size={14} /> Stop stream… <span className="ml-auto text-[11px] text-ink-3">hold to confirm</span>
              </Command.Item>
              <Command.Item value="start recording" onSelect={() => setHold({ label: 'Start recording', hint: 'Starts the local recording in OBS.', action: 'record', verb: 'start' })}>
                <CircleDot size={14} /> Start recording… <span className="ml-auto text-[11px] text-ink-3">hold to confirm</span>
              </Command.Item>
              <Command.Item value="stop recording" onSelect={() => setHold({ label: 'Stop recording', hint: 'Stops and closes the recording file.', action: 'record', verb: 'stop' })}>
                <Square size={14} /> Stop recording… <span className="ml-auto text-[11px] text-ink-3">hold to confirm</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Go to">
              {TABS.map((t) => {
                const Icon = TAB_ICON[t.id];
                return (
                  <Command.Item key={t.id} value={`go to ${t.label}`} onSelect={run(() => S.setTab(t.id))}>
                    <Icon size={14} /> {t.label}
                  </Command.Item>
                );
              })}
            </Command.Group>

            <Command.Group heading="Help">
              <Command.Item value="about clear to air version licence license credits sponsors supporters" onSelect={() => S.setAbout(true)}>
                <Info size={14} /> About Clear to Air
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
