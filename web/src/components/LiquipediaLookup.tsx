// Fill a team from Liquipedia instead of typing it twenty minutes before a show.
//
// Deliberately one team at a time and never silent: the agent does the fetching
// (see agent/src/liquipedia.js for the API terms and why this is not a bulk
// importer), and anything it reached by fuzzy search has to be confirmed here
// before it touches a team — search is loose enough that a typo will happily match
// a real but wrong team.
//
// A lookup now brings the active roster and the infobox logo as well as the
// name. With a slot ("A" or "B") the agent applies all three itself; otherwise
// the caller gets them through onApply.

import { useState } from 'react';
import { Check, Search, Users } from 'lucide-react';
import { Button } from './Button';
import { errText, post } from '../api';
import { toastErr, toastOk, useStore } from '../store';
import { deriveShort, deriveTag } from '../types';
import type { Player } from '../types';

export interface FoundTeam {
  name: string;
  wiki: string;
  matched?: 'title' | 'search';
  logo?: { url: string; variant: string } | null;
  source: string;
  license: string;
}

export interface LpReply {
  ok?: boolean;
  found?: boolean;
  needsConfirm?: boolean;
  team?: FoundTeam;
  logo?: { path: string; bytes: number } | null;
  roster?: Player[];
  infobox?: { name?: string; location?: string; twitter?: string };
  applied?: { team: string; slot: string; roster: number } | null;
  message?: string;
}

/** One round trip; the caller decides what to do with needsConfirm. */
export async function lookupTeam(name: string, opts: { slot?: 'A' | 'B' | null; confirm?: boolean; roster?: boolean } = {}): Promise<LpReply> {
  const r = await post<LpReply>('/api/liquipedia/team', { name, slot: opts.slot ?? undefined, confirm: !!opts.confirm, roster: opts.roster !== false });
  if (r.applied?.team && r.team?.name) await fixIdentity(r.applied.team, r.team.name, r.infobox?.name);
  return r;
}

/**
 * The agent's slot apply sets the name (and short only when the infobox has a
 * name) but leaves the old tag - so "Alpha" became "Team Liquid" with tag
 * "ALPH" still on the bug. Replace short and tag from the applied name.
 */
async function fixIdentity(teamId: string, name: string, infoboxName?: string) {
  try {
    await useStore.getState().patch({ teams: { [teamId]: { short: deriveShort(infoboxName || name), shortAuto: true, tag: deriveTag(name) } } }, { silent: true });
  } catch (e) {
    toastErr('Team name applied, but the short name and tag were not updated', errText(e));
  }
}

export function LiquipediaLookup({
  teamName,
  slot,
  onApply,
}: {
  teamName: string;
  /** A or B when the team being edited is in the series; the agent then applies the result itself. */
  slot?: 'A' | 'B' | null;
  onApply: (p: { name: string; logo?: string; roster?: Player[] }) => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundTeam | null>(null);
  const [rosterN, setRosterN] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (confirm: boolean) => {
    const name = (q.trim() || teamName).trim();
    if (!name) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await lookupTeam(name, { slot, confirm });
      if (!r.found) {
        setFound(null);
        setRosterN(null);
        setMsg(r.message ?? 'No team page found.');
        return;
      }
      if (r.needsConfirm) {
        setFound(r.team ?? null);
        setRosterN(null);
        setMsg(r.message ?? 'Confirm this is the right team.');
        return;
      }
      setFound(r.team ?? null);
      setRosterN(r.roster?.length ?? 0);
      setMsg(null);
      // Without a slot the agent changed nothing; hand everything to the caller.
      if (!r.applied) onApply({ name: r.team?.name ?? name, logo: r.logo?.path, roster: r.roster?.length ? r.roster : undefined });
      const bits = [r.logo ? 'logo' : 'no logo on the page', r.roster?.length ? `${r.roster.length} players` : 'no roster found'];
      toastOk(`Liquipedia · ${r.team?.name}`, `Name applied · ${bits.join(' · ')}`);
    } catch (e) {
      setMsg(errText(e));
      toastErr('Liquipedia lookup failed', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col-span-3 rounded-[8px] border border-line bg-bg-2 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] tracking-[.1em] uppercase text-ink-3">Liquipedia</span>
        <span className="text-[10px] text-ink-3">name · logo · active roster · rate limited</span>
      </div>

      <div className="flex items-end gap-2">
        <input
          className="inp h-8 flex-1 min-w-0"
          placeholder={teamName ? `${teamName} — or type another name` : 'Team name'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run(false);
            }
          }}
        />
        <Button size="sm" icon={<Search size={13} />} disabled={busy} onClick={() => void run(false)}>
          {busy ? 'Looking…' : 'Fill from Liquipedia'}
        </Button>
      </div>

      {found ? (
        <div className="flex items-center gap-3">
          {found.logo ? (
            <img
              src={found.logo.url}
              alt=""
              className="w-10 h-10 object-contain flex-none"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : (
            <span className="w-10 h-10 rounded-[6px] bg-bg-3 flex-none" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink ellipsis">{found.name}</div>
            <a href={found.source} target="_blank" rel="noreferrer noopener" className="text-[11px] text-ink-3 hover:text-ink-2 ellipsis block">
              {found.wiki} wiki{found.logo ? ` · ${found.logo.variant} logo` : ' · no logo on the page'}
              {rosterN !== null ? ` · ${rosterN} on the active roster` : ''}
            </a>
          </div>
          {msg ? (
            <Button size="sm" variant="primary" icon={<Check size={13} />} disabled={busy} onClick={() => void run(true)}>
              Use this
            </Button>
          ) : (
            <Users size={14} className="text-ok flex-none" />
          )}
        </div>
      ) : null}

      {msg ? <div className="text-[12px] text-warn">{msg}</div> : null}

      <div className="text-[10px] text-ink-3 leading-snug">
        Text from Liquipedia is CC-BY-SA 3.0. Team logos belong to the teams — fine for identifying a team that is playing on
        your broadcast, not for building a logo library.
      </div>
    </div>
  );
}

/**
 * Both teams of the series in one go: type two names, get names, logos and
 * rosters on slots A and B. Sequential on purpose (the agent queues the calls two
 * seconds apart anyway); a fuzzy match on either side stops and asks.
 */
export function LiquipediaMatch({ nameA, nameB }: { nameA: string; nameB: string }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState<'A' | 'B' | null>(null);
  const [ask, setAsk] = useState<{ slot: 'A' | 'B'; name: string; team: FoundTeam } | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const fill = async (slot: 'A' | 'B', name: string, confirm = false): Promise<boolean> => {
    setBusy(slot);
    try {
      const r = await lookupTeam(name, { slot, confirm });
      if (!r.found) {
        toastErr(`Slot ${slot}: not found`, r.message ?? name);
        return false;
      }
      if (r.needsConfirm && r.team) {
        setAsk({ slot, name, team: r.team });
        return false;
      }
      setDone((d) => [...d, `${slot} · ${r.team?.name}${r.roster?.length ? ` · ${r.roster.length} players` : ''}${r.logo ? ' · logo' : ''}`]);
      return true;
    } catch (e) {
      toastErr(`Slot ${slot} failed`, errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setDone([]);
    setAsk(null);
    const na = a.trim() || nameA;
    const nb = b.trim() || nameB;
    if (na && !(await fill('A', na))) return;
    if (nb) await fill('B', nb);
  };

  const confirmAsk = async () => {
    if (!ask) return;
    const okA = await fill(ask.slot, ask.name, true);
    setAsk(null);
    if (okA && ask.slot === 'A') {
      const nb = b.trim() || nameB;
      if (nb) await fill('B', nb);
    }
  };

  return (
    <div className="rounded-[8px] border border-line bg-bg-2 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] tracking-[.1em] uppercase text-ink-3">Fill the series from Liquipedia</span>
        <span className="text-[10px] text-ink-3">names · logos · rosters onto A and B</span>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <input className="inp h-8 min-w-0" placeholder={nameA || 'Team A'} value={a} onChange={(e) => setA(e.target.value)} />
        <input className="inp h-8 min-w-0" placeholder={nameB || 'Team B'} value={b} onChange={(e) => setB(e.target.value)} />
        <Button size="sm" variant="primary" icon={<Search size={13} />} disabled={!!busy} onClick={() => void run()}>
          {busy ? `Slot ${busy}…` : 'Fill both'}
        </Button>
      </div>
      {ask ? (
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-warn">
            Slot {ask.slot}: closest match is <b className="text-ink">{ask.team.name}</b>. Use it?
          </span>
          <Button size="sm" variant="primary" icon={<Check size={12} />} onClick={() => void confirmAsk()}>
            Yes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>
            No
          </Button>
        </div>
      ) : null}
      {done.length ? (
        <ul className="text-[12px] text-ink-2">
          {done.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
