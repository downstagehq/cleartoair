import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Field, Select, TextCommit } from './Field';
import { Pill } from './Pill';
import { qrPath } from './qr';
import { errText, post } from '../api';
import { expiresIn, type Invite, type RemoteStatus } from '../remote';
import { toastErr, toastOk, useStore } from '../store';

/** A talent link as /api/remote reports it: an invite with a slot. */
type TalentInvite = Invite & { slot?: string; name?: string };
type Turn = { url?: string; secret?: string; username?: string; credential?: string };

const SLOTS = ['caster1', 'caster2', 'caster3', 'caster4', 'caster5', 'caster6', 'caster7', 'caster8'];

/** The link as a QR code, for the caster to scan off the rig's screen. */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const qr = useMemo(() => {
    try { return qrPath(text); } catch { return null; }
  }, [text]);
  if (!qr) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code of the talent link"
      style={{ background: '#fff', borderRadius: 6, flex: 'none' }}
    >
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

/**
 * Camera links for casters on another network: each is bound to ONE slot on
 * this PC, single use, and good for 15 minutes. The caster opens it on a phone
 * or laptop, allows camera and mic, and presses CONNECT; the picture and voice
 * arrive in OBS on that slot's CTA Studio source (view.html?slot=casterN).
 * Only signaling goes through the relay - the media is peer to peer.
 */
export function TalentLinks({ desk, onChange }: { desk: RemoteStatus; onChange: () => void }) {
  const state = useStore((s) => s.state);
  const patch = useStore((s) => s.patch);
  const [slot, setSlot] = useState('caster1');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState('');
  const [copied, setCopied] = useState('');

  const talent = state?.talent ?? [];
  const nameFor = (s: string) => talent.find((t) => `caster${t.slot}` === s)?.name || '';
  const used = new Set(talent.map((t) => `caster${t.slot}`));
  const slots = SLOTS.filter((s, i) => i < 4 || used.has(s));
  const links = (desk.invites as TalentInvite[]).filter((i) => (i.role as string) === 'talent');
  // The newest link's code is up on screen without a click: the usual move is
  // to hold the rig's screen up to the caster's phone.
  const newest = links.length ? links[links.length - 1].code : '';
  const autoShown = useRef('');
  useEffect(() => {
    if (newest && autoShown.current !== newest) { autoShown.current = newest; setShown(newest); }
  }, [newest]);
  const turn: Turn = ((state?.settings as unknown as { talent?: { turn?: Turn } })?.talent?.turn) ?? {};
  const setTurn = (p: Turn) => void patch({ settings: { talent: { turn: p } } });

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      toastErr('Could not copy', 'Select the link and copy it by hand.');
    }
  };

  const make = async () => {
    setBusy(true);
    try {
      const inv = await post<TalentInvite & { ok: true }>('/api/remote/talent-invite', { slot, name: nameFor(slot) });
      setShown(inv.code);
      await copy(inv.link, inv.code);
      toastOk(`Talent link for ${slot}`, 'Copied - or let them scan the code.');
    } catch (e) {
      toastErr('No talent link', errText(e));
    } finally {
      setBusy(false);
      onChange();
    }
  };

  return (
    <div className="mb-4">
      <div className="label mb-2">Talent camera links</div>
      <p className="text-[12px] text-ink-3 mb-2 max-w-[62ch]">
        For a caster on another network: one link per slot, single use, good for 15 minutes. Their camera and mic arrive
        on that slot&apos;s CTA Studio source in OBS. The link opens only the camera page — nothing of the desk.
      </p>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Select value={slot} onChange={(e) => setSlot(e.currentTarget.value)} className="h-8 w-[220px]">
          {slots.map((s) => (
            <option key={s} value={s}>
              {s}{nameFor(s) ? ` · ${nameFor(s)}` : ''}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="primary" disabled={busy || !desk.connected} onClick={() => void make()}>
          Make talent link
        </Button>
      </div>

      {links.length ? (
        <div className="flex flex-col gap-2 mb-2">
          {links.map((inv) => (
            <div key={inv.code} className="rounded-[10px] p-2" style={{ background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
              <div className="flex items-center gap-2 text-[12px] flex-wrap">
                <Pill tone="idle">{inv.slot ?? 'talent'}</Pill>
                {inv.name ? <span className="text-ink-2">{inv.name}</span> : null}
                <span className="mono text-brass">{inv.code}</span>
                <span className="text-ink-3">expires in {expiresIn(inv.exp)}</span>
                <Button size="sm" variant="ghost" onClick={() => void copy(inv.link, inv.code)}>
                  {copied === inv.code ? 'Copied' : 'Copy link'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShown(shown === inv.code ? '' : inv.code)}>
                  {shown === inv.code ? 'Hide code' : 'Show code'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void post('/api/remote/revoke', { code: inv.code })
                      .then(() => toastOk('Talent link revoked'))
                      .catch((e) => toastErr('Could not revoke', errText(e)))
                      .finally(onChange)
                  }
                >
                  Revoke
                </Button>
              </div>
              {shown === inv.code ? (
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <QrCode text={inv.link} />
                  <div className="text-[12px] text-ink-3 max-w-[38ch]">
                    Scan with the phone&apos;s camera. On the page: allow camera and microphone, put headphones on, press
                    CONNECT. <span className="mono ellipsis block mt-1">{inv.link}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <details className="mt-2">
        <summary className="text-[12px] text-ink-3 cursor-pointer">TURN server (optional - for networks that block a direct call)</summary>
        <div className="grid gap-2 mt-2 max-w-[560px]">
          <p className="text-[12px] text-ink-3">
            Without TURN, a call between two strict networks (some mobile carriers, venue wifi that blocks UDP) cannot
            connect. With a shared secret the rig mints a short-lived login per talent, so the secret never leaves this
            PC; remote seats never see any of these fields.
          </p>
          <Field label="TURN url(s)" hint="e.g. turns:turn.example.com:443?transport=tcp, turn:turn.example.com:3478">
            <TextCommit mono value={turn.url ?? ''} onCommit={(v) => setTurn({ url: v })} placeholder="turns:turn.example.com:443?transport=tcp" />
          </Field>
          <Field label="Shared secret (coturn use-auth-secret)" hint="Preferred. Leave the two fields below empty.">
            <TextCommit mono type="password" autoComplete="off" value={turn.secret ?? ''} onCommit={(v) => setTurn({ secret: v })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Or: static username">
              <TextCommit mono autoComplete="off" value={turn.username ?? ''} onCommit={(v) => setTurn({ username: v })} />
            </Field>
            <Field label="Static credential">
              <TextCommit mono type="password" autoComplete="off" value={turn.credential ?? ''} onCommit={(v) => setTurn({ credential: v })} />
            </Field>
          </div>
        </div>
      </details>
    </div>
  );
}
