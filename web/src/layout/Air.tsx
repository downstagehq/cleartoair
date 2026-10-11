import { useEffect, useMemo, useState } from 'react';
import { Camera, CircleDot, Film, Mic, MicOff, Radio, Square } from 'lucide-react';
import { Button, ConfirmHold, Keycap, Pill, SceneTile } from '../components';
import { TAKE_ARM_MS, talentMuteState, useStore } from '../store';
import { can } from '../remote';
import { RECIPE_SCENES, resolveScene, sceneNumber, sceneTitle } from '../types';

function useTick(ms: number, enabled: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setT((x) => x + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return t;
}

function Thumb({ kind, name, src, empty }: { kind: 'pgm' | 'pvw'; name?: string | null; src?: string | null; empty: string }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return (
    <div className={`slate ${kind === 'pgm' ? 'ring-pgm' : 'ring-pvw'}`}>
      {src && !err ? <img src={src} alt="" onError={() => setErr(true)} /> : <div className="text-[12px] text-ink-3 px-4 text-center">{empty}</div>}
      <span className={`chip ${kind === 'pgm' ? 'chip-pgm' : 'chip-pvw'}`}>
        {kind === 'pgm' ? <span className="w-[6px] h-[6px] rounded-full bg-white/90" /> : null}
        {kind.toUpperCase()}
      </span>
      {name ? (
        <span className="absolute left-0 right-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
          <span className="display text-[13px] text-white/95">
            <span className="mono text-[10px] text-white/60 mr-1.5">{sceneNumber(name)}</span>
            {sceneTitle(name)}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function TakeButton() {
  const armedAt = useStore((s) => s.takeArmedAt);
  const obsUp = useStore((s) => s.obs.connected);
  const hasArmed = useStore((s) => !!s.obs.preview);
  const mayAir = can(useStore((s) => s.seat), 'air');
  const connected = obsUp && hasArmed && mayAir;
  const armTake = useStore((s) => s.armTake);
  const take = useStore((s) => s.take);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!armedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(id);
  }, [armedAt]);
  const remaining = armedAt ? Math.max(0, TAKE_ARM_MS - (now - armedAt)) : 0;
  const frac = armedAt ? remaining / TAKE_ARM_MS : 0;
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`take ${armedAt ? 'armed' : ''}`}
      disabled={!connected}
      onClick={() => (armedAt ? void take() : armTake())}
      title={!mayAir ? 'This seat watches - it does not cut' : !obsUp ? 'OBS not connected' : !hasArmed ? 'Nothing armed - click a scene first' : 'Two-step: first click arms for 3 s, second click takes the armed scene to air'}
    >
      <span className="flex flex-col items-center justify-center h-full gap-0.5">
        <span className="flex items-center justify-center gap-3">
          {armedAt ? (
            <svg width="30" height="30" viewBox="0 0 34 34" className="-rotate-90 flex-none">
              <circle cx="17" cy="17" r={r} fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="3" />
              <circle cx="17" cy="17" r={r} fill="none" stroke="#fff" strokeWidth="3" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" />
            </svg>
          ) : null}
          <span className={armedAt ? 'text-[22px]' : ''}>TAKE</span>
          {armedAt ? <span className="mono text-[14px] font-normal tracking-normal opacity-80 w-8 text-left">{(remaining / 1000).toFixed(1)}</span> : <Keycap className="opacity-80">T</Keycap>}
        </span>
        {armedAt ? <span className="text-[10px] font-[var(--font-ui)] font-medium tracking-[.1em] opacity-80 leading-none">ARMED · CLICK AGAIN TO TAKE</span> : null}
      </span>
    </button>
  );
}

export function Air() {
  const obs = useStore((s) => s.obs);
  const state = useStore((s) => s.state);
  const previewScene = useStore((s) => s.previewScene);
  const replay = useStore((s) => s.replay);
  const muteTalent = useStore((s) => s.muteTalent);
  const seat = useStore((s) => s.seat);
  const seatCaps = useStore((s) => s.seatCaps);
  const mayAir = can(seat, 'air');
  // The agent caps a tunnelled thumbnail at 480px JPEG anyway; ask for what we
  // will actually get, and ask less often.
  const shotWidth = seat ? 480 : 640;
  const talentMute = talentMuteState(obs);
  const talentMuted = talentMute === true;
  // Going live from a remote seat needs the rig's own blessing on top of the role.
  const mayBroadcast = mayAir && (!seat || !!seatCaps.streamControl);
  const obsAction = useStore((s) => s.obsAction);
  const fastCut = !!state?.settings?.fastCut;

  const tick = useTick(seat ? 8000 : 4000, obs.connected);
  const pgmSrc = obs.connected ? `/api/obs/shot?w=${shotWidth}&t=${tick}` : null;
  const hasPvw = !!obs.preview && obs.connected;
  const pvwSrc = hasPvw ? `/api/obs/shot?scene=${encodeURIComponent(obs.preview ?? '')}&w=${shotWidth}&t=${tick}` : null;

  const scenes = obs.scenes.length ? obs.scenes.map((s) => s.name) : RECIPE_SCENES;

  // Nothing armed: SUGGEST the next rundown block's scene (else the one after
  // program). It is only a suggestion - clicking it arms it, it never cuts.
  const suggested = useMemo(() => {
    if (obs.preview) return null;
    const next = state?.rundown.find((r) => !r.done);
    if (next?.scene) return resolveScene(next.scene, obs.scenes);
    const i = scenes.indexOf(obs.program ?? '');
    return scenes[(i + 1) % scenes.length] ?? null;
  }, [obs.preview, obs.program, obs.scenes, scenes, state?.rundown]);

  return (
    <aside className="air flex flex-col gap-3 p-3 bg-bg-1 hairline-l min-w-0">
      <div className="flex items-center justify-between px-1">
        <span className="label">Program</span>
        <span className="mono text-[11px] text-ink-3">{obs.connected ? `OBS ${obs.version ?? ''}` : 'OBS offline'}</span>
      </div>
      <Thumb kind="pgm" name={obs.program} src={pgmSrc} empty={obs.connected ? 'Waiting for the first frame…' : 'OBS not connected'} />

      <div className="flex items-center justify-between px-1 mt-1">
        <span className="label">Preview</span>
        <span className="mono text-[11px] text-ink-3">{obs.studioMode ? 'studio mode' : hasPvw ? 'armed' : 'nothing armed'}</span>
      </div>
      {/* The preview slot shows the ARMED scene - the one TAKE will cut to. It is
          never itself a cut button. */}
      {hasPvw ? (
        <Thumb kind="pvw" name={obs.preview} src={pvwSrc} empty="No preview scene" />
      ) : suggested ? (
        <div className="flex flex-col gap-1">
          <SceneTile name={suggested} tally="armed" onClick={obs.connected && mayAir ? () => void previewScene(suggested) : undefined} title="Suggested next - click to arm it" />
          <span className="text-[11px] text-ink-3 px-1">Suggested next. Click to arm, then TAKE.</span>
        </div>
      ) : null}

      <TakeButton />

      <div className="flex items-center justify-between px-1 mt-1">
        <span className="label">Scenes</span>
        <span className="text-[11px] text-ink-3">{!mayAir ? 'watching only' : fastCut ? 'click arms · F-keys cut (fast cut on)' : 'click arms · TAKE cuts'}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {scenes.map((name) => {
          const n = Number(sceneNumber(name));
          return (
            <SceneTile
              key={name}
              name={name}
              compact
              keycap={n >= 1 && n <= 8 ? `F${n}` : undefined}
              tally={obs.program === name ? 'pgm' : obs.preview === name ? 'pvw' : 'idle'}
              onClick={obs.connected && mayAir ? () => void previewScene(name) : undefined}
              title={obs.program === name ? 'On air' : mayAir ? 'Click to arm into preview, then TAKE' : 'This seat watches - it does not arm scenes'}
            />
          );
        })}
        {!obs.connected ? <div className="text-[11px] text-ink-3 px-1">Recipe scenes shown. Connect OBS to arm and take.</div> : null}
      </div>

      <div className="hairline-t pt-3 mt-1 flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="label">Replay</span>
          <Pill tone={obs.replayBuffer ? 'ok' : 'idle'}>{obs.replayBuffer ? 'buffer on' : 'buffer off'}</Pill>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button icon={<Camera size={14} />} disabled={!obs.connected || !mayAir} onClick={() => void replay(obs.replayBuffer ? 'stop' : 'start')}>
            {obs.replayBuffer ? 'Stop buffer' : 'Start buffer'}
          </Button>
          <Button icon={<Film size={14} />} keycap="R" disabled={!obs.connected || !obs.replayBuffer || !mayAir} onClick={() => void replay('save', true)}>
            Save & cut
          </Button>
        </div>
        <Button
          block
          icon={talentMuted ? <MicOff size={14} /> : <Mic size={14} />}
          keycap="M"
          disabled={!obs.connected || talentMute === null || !mayAir}
          onClick={() => void muteTalent()}
          className={talentMute === true || talentMute === 'mixed' ? 'text-fail border-fail/40' : ''}
          title={talentMute === null ? 'No talent audio found in OBS - build the collection in Setup' : (obs.talentMute?.inputs ?? []).map((i) => `${i.name}: ${i.muted ? 'muted' : 'live'}`).join('\n')}
        >
          {talentMute === true ? 'Talent muted · unmute' : talentMute === 'mixed' ? 'Some talent muted · mute all' : talentMute === null ? 'No talent audio in OBS' : 'Mute talent'}
        </Button>
      </div>

      <div className="hairline-t pt-3 mt-1 flex flex-col gap-2">
        <div className="flex items-center justify-between h-8 px-1">
          <div className="flex items-center gap-2">
            <Radio size={14} className={obs.streaming ? 'text-pgm' : 'text-ink-3'} />
            <span className="text-[13px]">Stream</span>
            <Pill tone={obs.streaming ? 'pgm' : 'idle'} pulse={!!obs.streaming}>
              {obs.streaming ? 'live' : 'off'}
            </Pill>
          </div>
          <ConfirmHold
            disabled={!obs.connected || !mayBroadcast}
            variant={obs.streaming ? 'danger' : 'default'}
            className="btn-sm"
            title={mayBroadcast ? 'Hold 0.8 s' : 'Going live from a remote seat is switched off on the broadcast PC'}
            onConfirm={() => void obsAction('stream', { action: obs.streaming ? 'stop' : 'start' })}
          >
            {obs.streaming ? <Square size={12} /> : <Radio size={12} />}
            {obs.streaming ? 'Hold to end' : 'Hold to go live'}
          </ConfirmHold>
        </div>
        <div className="flex items-center justify-between h-8 px-1">
          <div className="flex items-center gap-2">
            <CircleDot size={14} className={obs.recording ? 'text-pgm' : 'text-ink-3'} />
            <span className="text-[13px]">Record</span>
            <Pill tone={obs.recording ? 'pgm' : 'idle'}>{obs.recording ? 'rec' : 'off'}</Pill>
          </div>
          <ConfirmHold
            disabled={!obs.connected || !mayBroadcast}
            variant={obs.recording ? 'danger' : 'default'}
            className="btn-sm"
            title={mayBroadcast ? 'Hold 0.8 s' : 'Recording from a remote seat is switched off on the broadcast PC'}
            onConfirm={() => void obsAction('record', { action: obs.recording ? 'stop' : 'start' })}
          >
            {obs.recording ? <Square size={12} /> : <CircleDot size={12} />}
            {obs.recording ? 'Hold to stop' : 'Hold to record'}
          </ConfirmHold>
        </div>
      </div>
    </aside>
  );
}
