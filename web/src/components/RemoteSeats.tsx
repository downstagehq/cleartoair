import { useEffect, useState } from 'react';
import { Button } from './Button';
import { ConfirmHold } from './ConfirmHold';
import { Field, Input } from './Field';
import { Empty, Panel } from './Panel';
import { Pill } from './Pill';
import { Toggle } from './Toggle';
import { errText } from '../api';
import { toastErr, toastOk, useStore } from '../store';
import {
  ROLE_BLURB, ROLE_LABEL, admitSeat, expiresIn, kickSeat, mintInvite, revokeInvite, setRemote, setRemoteCaps,
  type SeatRole,
} from '../remote';

const ROLES: SeatRole[] = ['producer', 'scorer', 'viewer'];

/**
 * Hand the desk to someone who is not in the room. Lives on the broadcast PC
 * only: the routes behind it are not reachable through the tunnel on purpose,
 * so a producer in the hosted room cannot invite anyone or close a seat.
 */
export function RemoteSeats() {
  const remote = useStore((s) => s.remote);
  const seat = useStore((s) => s.seat);
  const refresh = useStore((s) => s.loadRemote);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const known = remote === 'unavailable' ? null : remote;
  // Only the rig asks. A seat is refused here by design, and a refusal logged
  // on the broadcast PC every time a guest opens Setup is noise during a show.
  useEffect(() => { if (!seat) void refresh(); }, [refresh, seat]);
  useEffect(() => { if (known?.relay) setUrl(known.relay); }, [known?.relay]);

  // 'unavailable' is a 501 (a process with no remote wiring, like the overlay
  // preview server) or a 403 (we are IN the hosted room - a seat cannot manage
  // the other seats). Either way there is nothing to show here.
  if (seat || remote === 'unavailable') return null;
  const desk = remote;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toastOk(label); }
    catch (e) { toastErr(label, errText(e)); }
    finally { setBusy(false); void refresh(); }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      toastErr('Could not copy', 'Select the link and copy it by hand.');
    }
  };

  const lamp = !desk?.enabled ? 'idle' : desk.connected ? 'ok' : 'warn';
  const lampColor = lamp === 'ok' ? 'var(--ok)' : lamp === 'warn' ? 'var(--warn)' : 'var(--ink-4)';

  return (
    <Panel
      title="Remote seats"
      actions={
        <span className="mono text-[11px] text-ink-3 flex items-center gap-1.5">
          <span className="inline-block w-[7px] h-[7px] rounded-full" style={{ background: lampColor }} />
          {!desk?.enabled ? 'off' : desk.connected ? 'paired' : 'connecting'}
        </span>
      }
    >
      <p className="text-[13px] text-ink-2 mb-3 max-w-[64ch]">
        Give the desk to someone on another laptop — across the venue or across the country. The rig dials out to the
        room relay, so nothing is opened on this PC and no port is forwarded. Your OBS password and tokens never leave
        here, whatever seat anyone holds.
      </p>

      {!desk?.configured ? (
        <div className="rounded-[10px] p-3 mb-3" style={{ background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
          <Field
            label="Room relay address"
            hint="The Cloudflare Worker from relay/ — deploy it once and paste its address. See relay/README.md."
          >
            <Input
              mono
              value={url}
              placeholder="https://cleartoair-room.<your-account>.workers.dev"
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
          </Field>
          <Button
            className="mt-3"
            variant="primary"
            disabled={busy || !url.trim()}
            onClick={() => run('Remote seats on', () => setRemote(true, url.trim()))}
          >
            Switch remote seats on
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-4 flex-wrap mb-3">
          <Toggle
            on={!!desk.enabled}
            disabled={busy}
            label={desk.enabled ? 'Remote seats are on' : 'Remote seats are off'}
            onChange={(on) => run(on ? 'Remote seats on' : 'Remote seats off', () => setRemote(on))}
          />
          <span className="mono text-[11px] text-ink-3 ellipsis">{desk.relay}</span>
        </div>
      )}

      {desk?.error ? (
        <div className="text-[12px] mb-3" style={{ color: 'var(--warn)' }}>{desk.error}</div>
      ) : null}

      {desk?.enabled ? (
        <>
          <div className="flex flex-col gap-2 mb-4">
            <Toggle
              on={!!desk.requireAdmit}
              disabled={busy}
              label="Hold producers at the door until I admit them"
              onChange={(v) => run('Saved', () => setRemoteCaps({ requireAdmit: v }))}
            />
            <Toggle
              on={!!desk.caps?.streamControl}
              disabled={busy}
              label="Let a remote producer start and stop the stream"
              onChange={(v) => run('Saved', () => setRemoteCaps({ streamControl: v }))}
            />
            <span className="text-[12px] text-ink-3 max-w-[60ch]">
              Cutting scenes and driving the graphics is always a producer&apos;s to do. Starting and stopping the
              broadcast itself is off until you switch it on here.
            </span>
          </div>

          <div className="label mb-2">Invite someone</div>
          <div className="flex gap-2 flex-wrap mb-2">
            {ROLES.map((role) => (
              <Button
                key={role}
                size="sm"
                variant={role === 'producer' ? 'primary' : 'default'}
                disabled={busy || !desk.connected}
                title={ROLE_BLURB[role]}
                onClick={() =>
                  run(`${ROLE_LABEL[role]} invite ready`, async () => {
                    const inv = await mintInvite(role);
                    await copy(inv.link, inv.code);
                  })
                }
              >
                {ROLE_LABEL[role]}
              </Button>
            ))}
          </div>
          <div className="text-[12px] text-ink-3 mb-4 max-w-[60ch]">
            {desk.connected
              ? 'The link is copied to your clipboard. One seat per link, good for an hour.'
              : 'Waiting to pair with the relay — invites open up once the lamp goes green.'}
          </div>

          {desk.invites?.length ? (
            <div className="mb-4 flex flex-col gap-1.5">
              {desk.invites.map((inv) => (
                <div key={inv.code} className="flex items-center gap-2 text-[12px]">
                  <Pill tone={inv.role === 'producer' ? 'pgm' : 'idle'}>{ROLE_LABEL[inv.role]}</Pill>
                  <span className="mono text-brass">{inv.code}</span>
                  <span className="text-ink-3">expires in {expiresIn(inv.exp)}</span>
                  <Button size="sm" variant="ghost" onClick={() => void copy(inv.link, inv.code)}>
                    {copied === inv.code ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => run('Invite revoked', () => revokeInvite(inv.code))}>
                    Revoke
                  </Button>
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" onClick={() => run('All invites revoked', () => revokeInvite())}>
                  Revoke every invite
                </Button>
              </div>
            </div>
          ) : null}

          <div className="label mb-2">At the desk</div>
          {desk.seats?.length ? (
            <div className="flex flex-col gap-1.5">
              {desk.seats.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-[13px]">
                  <span
                    className="inline-block w-[7px] h-[7px] rounded-full flex-none"
                    style={{ background: s.pending ? 'var(--warn)' : s.online ? 'var(--ok)' : 'var(--ink-4)' }}
                    title={s.pending ? 'waiting to be admitted' : s.online ? 'connected' : 'has a seat, not connected'}
                  />
                  <span className="ellipsis flex-1 min-w-0">{s.name}</span>
                  <Pill tone={s.role === 'producer' ? 'pgm' : 'idle'}>{ROLE_LABEL[s.role]}</Pill>
                  {s.pending ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => run(`${s.name} admitted`, () => admitSeat(s.id, true))}>
                        Admit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => run(`${s.name} turned away`, () => admitSeat(s.id, false))}>
                        Turn away
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => run(`${s.name}'s seat closed`, () => kickSeat(s.id))}>
                      Close seat
                    </Button>
                  )}
                </div>
              ))}
              <div className="mt-2">
                <ConfirmHold onConfirm={() => run('Every seat cleared', () => kickSeat('*'))}>Clear every seat</ConfirmHold>
              </div>
            </div>
          ) : (
            <Empty title="Nobody is on a remote seat." hint="Invite a producer, scorer or viewer above and send them the link." />
          )}
        </>
      ) : null}
    </Panel>
  );
}
