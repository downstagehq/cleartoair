// _selftest.js — core module tests (scoreboard ingest, rehearsal bed checks,
// overlay telemetry delay buffer). Run:  node agent/src/_selftest.js
// The adapter/simulator suite is separate: agent/src/adapters/_selftest.js
// Exits 0 when every check passes.

import {
  parseKda, parseNum, isAgent, cleanIgn, tokenize, teamIndex, rosterOwner, parseRow, parseScoreboard,
} from './stats/scoreboard.js';
import { sceneKey, bedTalent, audioSourceName, expectedBed, checkBed, renderReport } from './rehearse.js';
import { RECIPE_SCENES, RECIPE_BED, DESKTOP_AUDIO } from './obs/collection.js';
import { slug as lpSlug, WIKI_FOR_PACK, parseSquad, parseInfobox, parsePlayerInfobox, parseRosterHtml, plain } from './liquipedia.js';
import { gameSwitchPatch, newEventState, defaultRundown, cardsFor, headlineCard, vetoPool, rosterSize } from './game.js';
import { genericUrl, repointUrl } from './obs/sync.js';
import { build, GAME_SOURCE } from './obs/collection.js';
import { compareVersions } from './update.js';
import { defaultState } from './state.js';
import fs from 'node:fs';
import path from 'node:path';
import { PACKS_DIR } from './config.js';

// stateBuffer.js is a plain browser script; loading it registers the
// constructor on globalThis, which is exactly how the overlay pages get it.
await import('../../overlays/_shared/stateBuffer.js');
const CTADelayBuffer = globalThis.CTADelayBuffer;

// render.js is a browser script too. Give it a window, a stub document it never
// touches at load time, and the four core helpers it destructures, so the tests
// below run against the shipped renderer rather than a copy of its logic.
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, documentElement: { dataset: {} }, body: null };
globalThis.CTA = { esc: (v) => String(v == null ? '' : v), team: () => null, show: () => {}, txt: () => {} };
await import('../../overlays/_shared/render.js');
const { objectiveRows, roundHistory, playerStat, liveScoreboardRows } = globalThis.CTA.render;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
const throws = (fn, msg) => { let t = false; try { fn(); } catch { t = true; } ok(t, msg); };

const TEAMS = {
  alpha: { id: 'alpha', name: 'Alpha', short: 'ALPH', tag: 'ALPH', roster: [{ ign: 'Zephyr' }, { ign: 'Kestrel' }, { ign: 'Onyx' }, { ign: 'Talon' }, { ign: 'Ronin' }] },
  bravo: { id: 'bravo', name: 'Bravo', short: 'BRV', tag: 'BRV', roster: [{ ign: 'Rift' }, { ign: 'Ember' }, { ign: 'Nomad' }, { ign: 'Static' }, { ign: 'Quartz' }] },
};
const VAL_COLS = ['acs', 'k', 'd', 'a', 'kast', 'hs'];

console.log('\n== scoreboard: tokens ==');
eq(parseKda('18/10/4'), [18, 10, 4], 'KDA splits on /');
eq(parseKda('18 / 10 / 4'), [18, 10, 4], 'KDA tolerates spaces');
eq(parseKda('18-10-4'), [18, 10, 4], 'KDA splits on -');
ok(parseKda('298') === null, 'a plain number is not a KDA');
ok(parseKda('18/10') === null, 'a two-part token is not a KDA');
eq(parseNum('74%'), 74, 'trailing percent is stripped');
eq(parseNum('1,894'), 1894, 'thousands separator is stripped');
ok(parseNum('Kestrel') === null, 'an IGN is not a number');
ok(isAgent('JETT') && isAgent('kay/o') && isAgent('KAYO'), 'agent names match case- and slash-insensitively');
ok(!isAgent('Kestrel'), 'an IGN is not an agent');
eq(cleanIgn('JETT Kestrel'), 'Kestrel', 'agent prefix stripped from IGN');
eq(cleanIgn('Kestrel SOVA'), 'Kestrel', 'agent suffix stripped from IGN');
eq(cleanIgn('Kestrel'), 'Kestrel', 'a clean IGN is left alone');
eq(tokenize('Kestrel\tJETT\t298'), ['Kestrel', 'JETT', '298'], 'tabs separate columns');
eq(tokenize('Kestrel  JETT  298'), ['Kestrel', 'JETT', '298'], 'two or more spaces separate columns');

console.log('\n== scoreboard: rows ==');
eq(parseRow('Kestrel  JETT  298  18/10/4  74%  24%', VAL_COLS),
  { ign: 'Kestrel', agent: 'JETT', acs: 298, k: 18, d: 10, a: 4, kast: 74, hs: 24 },
  'valorant row fills every pack column');
ok(parseRow('Kestrel  JETT  298  18/10/4  74%  24%', VAL_COLS).acs === 298,
  'KDA is split before the fill so ACS does not slide (a bug seen on a live broadcast)');
eq(parseRow('Onyx 12 9 5', ['k', 'd', 'a']), { ign: 'Onyx', k: 12, d: 9, a: 5 },
  'bare numbers fill columns left to right');
ok(parseRow('ALPHA', VAL_COLS) === null, 'a lone team name is not a player row');
ok(parseRow('', VAL_COLS) === null, 'an empty line is not a player row');
ok(parseRow('PLAYER ACS K D A', VAL_COLS) === null, 'a header line is not a player row');

console.log('\n== scoreboard: teams ==');
eq(teamIndex(TEAMS).get('ALPH'), 'alpha', 'team index resolves the short name');
eq(teamIndex(TEAMS).get('BRAVO'), 'bravo', 'team index resolves the full name');
eq(rosterOwner(TEAMS, 'Kestrel'), 'alpha', 'roster lookup finds the team');
eq(rosterOwner(TEAMS, 'KESTREL'), 'alpha', 'roster lookup is case-insensitive');
ok(rosterOwner(TEAMS, 'nobody') === null, 'an unknown IGN has no roster owner');

const headed = parseScoreboard({
  text: ['Alpha', 'Kestrel  JETT  298  18/10/4  74%  24%', 'Zephyr  OMEN  215  14/11/9  68%  19%',
    'Bravo', 'Rift  RAZE  230  15/13/5  70%  21%', 'Ember  FADE  195  13/12/7  66%  17%'].join('\n'),
  columns: VAL_COLS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo',
});
eq(headed.rows.length, 4, 'header form parses every player row');
eq(headed.matched, 'headers', 'team headers are used when present');
eq(headed.rows[0].team, 'alpha', 'rows under a header take that team');
eq(headed.rows[2].team, 'bravo', 'the second header switches team');
eq(headed.warnings.length, 0, 'a fully headed scoreboard warns about nothing');

const byRoster = parseScoreboard({
  text: ['Kestrel  JETT  298  18/10/4  74%  24%', 'Rift  RAZE  230  15/13/5  70%  21%'].join('\n'),
  columns: VAL_COLS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo',
});
eq(byRoster.rows[0].team, 'alpha', 'roster match assigns team without a header');
eq(byRoster.rows[1].team, 'bravo', 'roster match assigns the other team');

const split = parseScoreboard({
  text: ['Alpha 10 1 1', 'Bravo 9 2 2', 'Charlie 8 3 3', 'Delta 7 4 4'].join('\n'),
  columns: ['k', 'd', 'a'], teams: TEAMS, teamA: 'alpha', teamB: 'bravo',
});
eq(split.rows.map((r) => r.team), ['alpha', 'alpha', 'bravo', 'bravo'], 'unknown IGNs split evenly down the middle');
ok(split.warnings.length > 0, 'an even split warns the operator to check sides before air');
ok(/check the sides/i.test(split.warnings[0]), 'the split warning says to check the sides');

throws(() => parseScoreboard({ text: '', columns: VAL_COLS, teams: TEAMS }), 'empty text is rejected');
throws(() => parseScoreboard({ text: 'PLAYER ACS K D A', columns: VAL_COLS, teams: TEAMS }), 'a header-only paste is rejected');
ok(parseScoreboard({ text: 'Kestrel 298 18/10/4', columns: VAL_COLS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo' }).warnings.some((w) => /kast|hs/.test(w)),
  'short rows warn about the columns that are missing');

console.log('\n== rehearsal: scene keys and beds ==');
eq(sceneKey('03 · CARDS'), '03', 'scene key is the number prefix');
ok(sceneKey('nonsense') === null, 'a scene without a number prefix has no key');
eq(RECIPE_SCENES.length, 8, 'the recipe has 8 scenes');
ok(RECIPE_SCENES.every((n) => RECIPE_BED[sceneKey(n)]), 'every recipe scene has a declared audio bed');

const TALENT = [
  { id: 'h1', name: 'Juniper', role: 'HOST', slot: 1 },
  { id: 'c1', name: 'Onyx', role: 'CASTER', slot: 2 },
  { id: 'c2', name: 'Quartz', role: 'ANALYST', slot: 3 },
];
eq(bedTalent(TALENT, 'all').length, 3, 'bed "all" is every talent');
eq(bedTalent(TALENT, 'casters').map((t) => t.id), ['c1', 'c2'], 'bed "casters" is casters and analysts only');
eq(bedTalent(TALENT, 'none').length, 0, 'bed "none" is nobody');
eq(audioSourceName(TALENT[0]), 'AUDIO · Juniper (VDO.Ninja)', 'audio source name matches the generated collection');

const game = expectedBed('04 · IN-GAME', TALENT);
eq(game.who, 'casters', 'the in-game scene carries the casters bed');
ok(game.forbidden.has('AUDIO · Juniper (VDO.Ninja)'), 'the host is forbidden on the in-game scene');
ok(game.expected.has('AUDIO · Onyx (VDO.Ninja)'), 'a caster is expected on the in-game scene');
const desk = expectedBed('02 · DESK', TALENT);
eq(desk.who, 'all', 'the desk scene carries everyone');
eq(desk.forbidden.size, 0, 'nobody is forbidden on the desk');

const good = checkBed('04 · IN-GAME', TALENT, [{ name: DESKTOP_AUDIO }, { name: 'AUDIO · Onyx (VDO.Ninja)' }, { name: 'AUDIO · Quartz (VDO.Ninja)' }]);
ok(good.ok, 'a correct in-game bed passes');
const bleed = checkBed('04 · IN-GAME', TALENT, [{ name: DESKTOP_AUDIO }, { name: 'AUDIO · Onyx (VDO.Ninja)' }, { name: 'AUDIO · Quartz (VDO.Ninja)' }, { name: 'AUDIO · Juniper (VDO.Ninja)' }]);
ok(!bleed.ok, 'the host live on the in-game scene fails');
ok(/bleed/i.test(bleed.notes.join(' ')), 'the failure names the bleed it prevents');
const silent = checkBed('02 · DESK', TALENT, [{ name: DESKTOP_AUDIO }, { name: 'AUDIO · Onyx (VDO.Ninja)' }]);
ok(!silent.ok, 'missing talent audio on the desk fails');
ok(/inaudible/i.test(silent.notes.join(' ')), 'the failure says who is inaudible');
const noGame = checkBed('02 · DESK', TALENT, TALENT.map((t) => ({ name: audioSourceName(t) })));
ok(!noGame.ok, 'a scene with no game audio fails');
eq(checkBed('06 · BRB', TALENT, [{ name: DESKTOP_AUDIO }]).ok, true, 'BRB with no mics passes');
ok(!checkBed('06 · BRB', TALENT, [{ name: DESKTOP_AUDIO }, { name: 'AUDIO · Onyx (VDO.Ninja)' }]).ok, 'a live mic in BRB fails');

const html = renderReport({ ok: false, scenes: 2, scenesOk: 1, talent: 3, finishedAt: Date.now(), onAir: false,
  results: [{ scene: '01 · STARTING SOON', key: '01', present: true, bed: { who: 'all', ok: true }, shot: 'scene_01.png', notes: [] },
    { scene: '04 · IN-GAME', key: '04', present: true, bed: { who: 'casters', ok: false }, shot: null, notes: ['<script>bad</script>'] }] });
ok(html.startsWith('<!doctype html>'), 'the rehearsal report is a full HTML document');
ok(html.includes('1/2 SCENES VERIFIED'), 'the report badge counts verified scenes');
ok(html.includes('&lt;script&gt;'), 'report notes are HTML-escaped');
ok(!html.includes('<script>bad'), 'an unescaped note never reaches the report');

console.log('\n== per-game capabilities ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'pack.json')));
  eq(ids.length, 8, 'all 8 packs are present');
  const packs = Object.fromEntries(ids.map((id) => [id, JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'))]));
  ok(ids.every((id) => packs[id].caps), 'every pack declares caps');
  ok(ids.every((id) => Array.isArray(packs[id].caps.cards) && packs[id].caps.cards.length), 'every pack lists its card menu');

  // the bug that started this: Rocket League has no map veto
  eq(packs.rocketleague.caps.veto, false, 'Rocket League has no map veto');
  ok(!packs.rocketleague.caps.cards.includes('veto'), 'the veto card is not offered for Rocket League');
  eq(packs.lol.caps.veto, false, 'LoL has no map veto - one map, a draft instead');
  eq(packs.dota2.caps.veto, false, 'Dota has no map veto');
  eq(packs.eafc.caps.veto, false, 'EA FC has no map veto');
  eq(packs.apex.caps.veto, false, 'Apex has no map veto');
  eq(packs.cs2.caps.veto, true, 'CS2 does pick and ban maps');
  eq(packs.valorant.caps.veto, true, 'Valorant does pick and ban maps');

  // battle royale has no head-to-head series
  eq(packs.apex.caps.series, false, 'Apex is not a head-to-head series');
  ok(!packs.apex.caps.cards.includes('vs'), 'Apex is not offered a Versus card');
  ok(!packs.apex.caps.cards.includes('h2h'), 'Apex is not offered a head-to-head card');
  ok(packs.apex.caps.cards.includes('scoreboard'), 'Apex still gets a scoreboard');

  eq(packs.eafc.caps.halves, true, 'EA FC is played in halves');
  ok(ids.every((id) => packs[id].caps.cards.includes('none')), 'every game can clear the card');
}

console.log('\n== draft card ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const rd = (id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'));
  const lol = rd('lol'), dota = rd('dota2');

  eq(lol.caps.draft, true, 'LoL drafts champions');
  eq(dota.caps.draft, true, 'Dota drafts heroes');
  ok(lol.caps.cards.includes('draft'), 'LoL is offered the draft card');
  ok(dota.caps.cards.includes('draft'), 'Dota is offered the draft card');
  ok(!lol.caps.cards.includes('veto'), 'a draft is not a map veto - LoL still has no veto card');

  for (const id of ['cs2', 'valorant', 'rocketleague', 'apex', 'eafc', 'fgc']) {
    const p = rd(id);
    eq(p.caps.draft, false, id + ' does not draft champions');
    ok(!p.caps.cards.includes('draft'), id + ' is not offered the draft card');
  }

  ok(lol.champions.length > 50, 'LoL ships a champion suggestion list');
  ok(dota.champions.length > 100, 'Dota ships a hero suggestion list');
  ok(dota.champions.includes('Invoker') && lol.champions.includes('Ahri'), 'the lists carry real names');
  ok(new Set(lol.champions).size === lol.champions.length, 'no duplicate champions');
  ok(new Set(dota.champions).size === dota.champions.length, 'no duplicate heroes');
}

console.log('\n== standings card ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const rd = (id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'));
  const apex = rd('apex');

  eq(apex.caps.standings, true, 'Apex has lobby standings');
  ok(apex.caps.cards.includes('standings'), 'Apex is offered the standings card');
  ok(!apex.caps.cards.includes('vs'), 'a lobby table replaces Versus, it does not sit beside it');
  for (const id of ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'eafc', 'fgc']) {
    const p = rd(id);
    eq(p.caps.standings, false, id + ' has no lobby standings');
    ok(!p.caps.cards.includes('standings'), id + ' is not offered the standings card');
  }

  // ALGS scoring table
  const sc = apex.scoring;
  eq(sc.placement.length, 20, 'the placement table covers a 20-squad lobby');
  eq(sc.placement[0], 12, 'a win is 12 placement points');
  eq(sc.placement[1], 9, 'second is 9');
  eq(sc.placement[19], 0, 'last place scores no placement points');
  eq(sc.perKill, 1, 'a kill is one point');
  eq(sc.matchPoint, 50, 'match point is 50');
  ok(sc.placement.every((v, n, a) => n === 0 || a[n - 1] >= v), 'the placement table never rewards a worse finish');

  // the derivation the card and the builder both use
  const pts = (row) => row.points != null ? row.points
    : ((sc.placement.length && row.placement ? sc.placement[row.placement - 1] : row.placement || 0) + (row.kills || 0) * sc.perKill);
  eq(pts({ placement: 1, kills: 8 }), 20, 'a win with 8 kills is 20 points');
  eq(pts({ placement: 20, kills: 0 }), 0, 'last with no kills is 0');
  eq(pts({ placement: 5, kills: 3 }), 7, '5th with 3 kills is 7');
  eq(pts({ placement: 1, kills: 8, points: 99 }), 99, "the organiser's own points override the table");
}

console.log('\n== set history card ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const rd = (id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'));
  const fgc = rd('fgc');

  eq(fgc.caps.set, true, 'the FGC pack has a set history');
  ok(fgc.caps.cards.includes('set'), 'FGC is offered the set card');
  ok(fgc.caps.cards.includes('vs'), 'a set history sits beside Versus, it does not replace it');
  eq(fgc.caps.veto, false, 'a stage pick is not a broadcast veto');
  eq(fgc.caps.draft, false, 'characters are per game, not a draft phase');

  for (const id of ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'eafc', 'apex']) {
    const p = rd(id);
    eq(p.caps.set, false, id + ' has no set history');
    ok(!p.caps.cards.includes('set'), id + ' is not offered the set card');
  }

  // the pack is game-agnostic, so characters come per title
  const titles = Object.keys(fgc.characterSets || {});
  ok(titles.length >= 4, 'the FGC pack carries a roster per fighting game');
  ok(titles.includes('Street Fighter 6') && titles.includes('Tekken 8'), 'SF6 and Tekken 8 are covered');
  for (const t of titles) {
    const r = fgc.characterSets[t];
    ok(Array.isArray(r) && r.length > 20, t + ' has a usable roster');
    ok(new Set(r).size === r.length, t + ' has no duplicate characters');
    ok(r.every((c) => typeof c === 'string' && c.trim()), t + ' has no blank entries');
  }
  ok(/not whitelists/i.test(fgc.notes || ''), 'the pack says the rosters are suggestions, not whitelists');
}

console.log('\n== series + match stats cards ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const rd = (id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'));
  const rl = rd('rocketleague'), ea = rd('eafc');

  eq(rl.caps.games, true, 'Rocket League plays a series of games');
  ok(rl.caps.cards.includes('games'), 'Rocket League is offered the series board');
  eq(rl.caps.veto, false, 'the series board is what Rocket League has instead of a veto');
  eq(rl.caps.maps, false, 'Rocket League arenas are not maps in the series sense');

  eq(ea.caps.matchStats, true, 'EA FC has a match-stats comparison');
  ok(ea.caps.cards.includes('matchstats'), 'EA FC is offered the match-stats card');
  eq(ea.caps.halves, true, 'EA FC is still played in halves');

  for (const id of ['cs2', 'valorant', 'lol', 'dota2', 'apex', 'fgc']) {
    const p = rd(id);
    eq(p.caps.games, false, id + ' has no series board');
    eq(p.caps.matchStats, false, id + ' has no match stats');
    ok(!p.caps.cards.includes('games') && !p.caps.cards.includes('matchstats'), id + ' is offered neither');
  }
  eq(rl.caps.matchStats, false, 'Rocket League has no football match stats');
  eq(ea.caps.games, false, 'EA FC is one match, not a series board');

  // the stat lines, and the one that is won by the smaller number
  const lines2 = ea.statLines || [];
  ok(lines2.length >= 6, 'EA FC ships the usual football stat lines');
  const byLabel = Object.fromEntries(lines2.map((l) => [l.label, l]));
  ok(byLabel.Possession && byLabel.Possession.unit === '%', 'possession is a percentage');
  eq(byLabel.Fouls.lowerIsBetter, true, 'fouls are won by the smaller number');
  ok(!byLabel.Shots.lowerIsBetter, 'shots are won by the bigger number');

  // the highlight rule the card uses
  const better = (a, b, low) => (a === b ? null : (low ? (a < b ? 'a' : 'b') : (a > b ? 'a' : 'b')));
  eq(better(14, 9, false), 'a', 'more shots is better');
  eq(better(8, 13, true), 'a', 'fewer fouls is better');
  eq(better(13, 8, true), 'b', 'fewer fouls is better whichever side it is');
  eq(better(5, 5, false), null, 'a tie highlights neither side');
}

console.log('\n== series formats ==');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'packs');
  const ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'pack.json')));
  const packs = Object.fromEntries(ids.map((id) => [id, JSON.parse(fs.readFileSync(path.join(dir, id, 'pack.json'), 'utf8'))]));

  ok(ids.every((id) => Array.isArray(packs[id].formats) && packs[id].formats.length), 'every pack lists the formats it offers');
  ok(ids.every((id) => packs[id].formats.includes(packs[id].defaultFormat)),
    'every default format is one the pack actually offers');

  // a title decides its own shapes - this is what the hardcoded BO1/BO3/BO5 got wrong
  ok(packs.fgc.formats.every((f) => /^FT\d$/.test(f)), 'a fighting-game set is first-to, not best-of');
  ok(packs.rocketleague.formats.includes('BO7'), 'RLCS runs best-of-seven finals');
  ok(packs.eafc.formats.includes('2LEG'), 'EA FC can run a two-legged tie');
  ok(packs.apex.formats.every((f) => /GAMES/.test(f)), 'a battle-royale series is a game count');
  ok(!packs.apex.formats.some((f) => /^BO/.test(f)), 'a battle royale is never a best-of');

  // needWins() in the overlay runtime has to read all of these
  const needWins = (fmt) => {
    let m = /FT\s*(\d+)/i.exec(fmt || ''); if (m) return +m[1];
    m = /BO\s*(\d+)/i.exec(fmt || ''); if (m) return Math.ceil(+m[1] / 2);
    return 2;
  };
  eq(needWins('BO3'), 2, 'BO3 needs two wins');
  eq(needWins('BO5'), 3, 'BO5 needs three');
  eq(needWins('BO7'), 4, 'BO7 needs four');
  eq(needWins('FT2'), 2, 'FT2 needs two');
  eq(needWins('FT4'), 4, 'FT4 needs four');
  eq(needWins('2LEG'), 2, 'an unparsed format falls back to two rather than breaking the bug');
}

console.log('\n== talent studio: source naming ==');
eq(audioSourceName({ name: 'Onyx' }), 'AUDIO · Onyx (VDO.Ninja)', 'vdo mode keeps the split audio source name');
eq(audioSourceName({ name: 'Onyx' }, 'studio'), 'TALENT · Onyx (CTA Studio)', 'studio mode uses the single A/V source');
{
  const T = [{ id: 'c1', name: 'Onyx', role: 'CASTER', slot: 1 }];
  const bed = checkBed('04 · IN-GAME', T, [{ name: DESKTOP_AUDIO }, { name: 'TALENT · Onyx (CTA Studio)' }], 'studio');
  ok(bed.ok, 'the rehearsal bed check follows the talent mode');
  const wrong = checkBed('04 · IN-GAME', T, [{ name: DESKTOP_AUDIO }, { name: 'AUDIO · Onyx (VDO.Ninja)' }], 'studio');
  ok(!wrong.ok, 'a VDO source in studio mode is still reported as missing audio');
}

console.log('\n== overlay: telemetry delay buffer ==');
const buf = new CTADelayBuffer(0);
eq(buf.getDelay(), 0, 'the buffer starts with no delay');
eq(buf.setDelay(250), 250, 'delay is settable');
eq(buf.setDelay(-5), 0, 'a negative delay clamps to 0');
eq(buf.setDelay(99999), 1000, 'delay clamps to the 1000 ms slider maximum');
eq(CTADelayBuffer.MAX_DELAY_MS, 1000, 'the documented maximum is 1000 ms');
const pass = new CTADelayBuffer(0);
pass.push({ round: 1 }); pass.push({ round: 2 });
eq(pass.get().round, 2, 'with no delay the newest frame passes straight through');
const held = new CTADelayBuffer(1000);
held.push({ round: 1 }); held.push({ round: 2 });
eq(held.get().round, 1, 'with a delay longer than the history the oldest frame is shown');
ok(held.size() === 2, 'frames are retained in the ring');
held.reset();
ok(held.size() === 0 && held.get() === null, 'reset empties the ring');
const snap = new CTADelayBuffer(0);
snap.push({ hp: 100, boost: 10 }); snap.push({ hp: 0, boost: 90 });
const blended = CTADelayBuffer._blend({ hp: 100, boost: 10 }, { hp: 0, boost: 90 }, 0.5);
eq(blended.hp, 100, 'discrete values are never blended — a death is not a fade');
eq(blended.boost, 50, 'continuous values are blended');
const bPlayers = CTADelayBuffer._blend({ players: [{ hp: 100, boost: 0 }] }, { players: [{ hp: 0, boost: 100 }] }, 0.5);
eq(bPlayers.players[0].hp, 100, 'per-player hp is never blended');
eq(bPlayers.players[0].boost, 50, 'per-player boost is blended');
eq(CTADelayBuffer._blend({ ball: { speed: 0 } }, { ball: { speed: 100 } }, 0.5).ball.speed, 50, 'ball speed is blended');

console.log('\n== talent studio: signaling ==');
{
  const http = (await import('node:http')).default;
  const { WebSocket } = await import('ws');
  const { createHub } = await import('./hub.js');

  const server = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
  const hub = createHub(server, { hello: () => ({}), patch: () => {}, obs: async () => ({}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (role, slot) => `ws://127.0.0.1:${port}/talent/signaling?role=${role}&slot=${slot}`;

  // Buffer from construction: the hub greets a receiver the instant it joins,
  // and an EventEmitter drops a 'message' that lands before a listener exists.
  // The real pages assign ws.onmessage synchronously, so only this harness
  // needs the buffer.
  const open = (u) => new Promise((res, rej) => {
    const w = new WebSocket(u);
    w.inbox = []; w.waiters = [];
    w.on('message', (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      const i = w.waiters.findIndex((x) => x.pred(m));
      if (i >= 0) { const [x] = w.waiters.splice(i, 1); x.res(m); } else w.inbox.push(m);
    });
    w.once('open', () => res(w));
    w.once('error', rej);
  });
  const next = (w, pred = () => true) => {
    const i = w.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(w.inbox.splice(i, 1)[0]);
    return new Promise((res) => w.waiters.push({ pred, res }));
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));

  // the ordinary case: OBS is up first, then the caster joins
  const rx = await open(url('obs_receiver', 'caster1'));
  const online = next(rx, (m) => m.type === 'TALENT_ONLINE');
  const tx = await open(url('caster', 'caster1'));
  ok((await online).type === 'TALENT_ONLINE', 'a receiver already waiting is told the caster came online');

  const gotOffer = next(rx, (m) => m.type === 'offer');
  tx.send(JSON.stringify({ type: 'offer', offer: { sdp: 'OFFER-1' } }));
  eq((await gotOffer).offer.sdp, 'OFFER-1', 'the caster offer reaches the OBS receiver');

  const gotAnswer = next(tx, (m) => m.type === 'answer');
  rx.send(JSON.stringify({ type: 'answer', answer: { sdp: 'ANSWER-1' } }));
  eq((await gotAnswer).answer.sdp, 'ANSWER-1', 'the receiver answer reaches the caster');

  const gotCandR = next(rx, (m) => m.type === 'candidate');
  tx.send(JSON.stringify({ type: 'candidate', candidate: { c: 'from-caster' } }));
  eq((await gotCandR).candidate.c, 'from-caster', 'caster ICE candidates reach the receiver');

  const gotCandT = next(tx, (m) => m.type === 'candidate');
  rx.send(JSON.stringify({ type: 'candidate', candidate: { c: 'from-obs' } }));
  eq((await gotCandT).candidate.c, 'from-obs', 'receiver ICE candidates reach the caster');
  await settle();
  eq(hub.talent.status().caster1, { caster: true, receivers: 1, offer: true }, 'the slot reports one caster and one receiver');

  // OBS refreshes or restarts mid-show, after the call was set up: the standing
  // offer has already been answered, and replaying it would get an answer the
  // caster can no longer apply (black source - docs/TALENT-BENCH.md case B).
  // The hub asks the caster for a fresh offer instead.
  rx.close();
  await settle();
  const renegotiate = next(tx, (m) => m.type === 'RENEGOTIATE');
  const rx2 = await open(url('obs_receiver', 'caster1'));
  eq((await renegotiate).type, 'RENEGOTIATE', 'a receiver joining after the offer was answered gets the caster asked for a fresh offer');
  const freshOffer = next(rx2, (m) => m.type === 'offer');
  tx.send(JSON.stringify({ type: 'offer', offer: { sdp: 'OFFER-2' }, seq: 2 }));
  eq((await freshOffer).offer.sdp, 'OFFER-2', 'the fresh offer reaches the new receiver');
  tx.send(JSON.stringify({ type: 'candidate', candidate: { c: 'from-caster-2' }, seq: 2 }));
  await settle();

  // the case the clients cannot handle themselves: a receiver joins after the
  // caster sent its offer but before anyone answered it
  rx2.close();
  await settle();
  const rx3 = await open(url('obs_receiver', 'caster1'));
  eq((await next(rx3, (m) => m.type === 'offer')).offer.sdp, 'OFFER-2', 'a receiver joining before anyone answered is replayed the standing offer');
  eq((await next(rx3, (m) => m.type === 'candidate')).candidate.c, 'from-caster-2', 'buffered candidates are replayed to a late receiver');

  // one receiver per slot: the newest replaces the older one
  const rx3closed = new Promise((res) => rx3.once('close', (_code, reason) => res(String(reason))));
  const rx4 = await open(url('obs_receiver', 'caster1'));
  eq(await rx3closed, 'replaced', 'a newer receiver on the slot replaces the older one');

  // caster drops
  const offline = next(rx4, (m) => m.type === 'TALENT_OFFLINE');
  tx.close();
  ok((await offline).type === 'TALENT_OFFLINE', 'the receiver is told when the caster drops');
  await settle();
  ok(hub.talent.status().caster1 === undefined || !hub.talent.status().caster1.caster, 'the slot clears when the caster leaves');

  // slots do not cross-talk
  const a = await open(url('obs_receiver', 'caster2'));
  const b = await open(url('caster', 'caster9'));
  let leaked = false;
  a.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'offer') leaked = true; });
  b.send(JSON.stringify({ type: 'offer', offer: { sdp: 'WRONG-SLOT' } }));
  await settle();
  ok(!leaked, 'an offer never leaks into another slot');

  // a bad role is refused rather than left half-connected
  const bad = new WebSocket(url('nonsense', 'caster1'));
  const badClosed = await new Promise((res) => { bad.once('close', (code) => res(code)); bad.once('error', () => res(-1)); });
  eq(badClosed, 1008, 'an unknown role is closed with a policy violation');

  // an unknown websocket path must be refused, not handed to either hub
  const stray = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  const strayFailed = await new Promise((res) => { stray.once('error', () => res(true)); stray.once('open', () => res(false)); });
  ok(strayFailed, 'an unknown websocket path is refused');

  rx4.close(); a.close(); b.close();
  await settle();
  hub.close();
  await new Promise((r) => server.close(r));
  ok(true, 'the signaling hub shuts down cleanly');
}

console.log('\n== overlay: objective strip (LoL / Dota bug) ==');
// Dota GSI shape: flat <key>A / <key>B.
const dota = objectiveRows({ goldA: 31250, goldB: 28400, towersA: 4, towersB: 2, roshanA: 1, roshanB: 0, barracksA: 0, barracksB: 0 });
eq(dota.map((r) => r.k), ['GOLD', 'TOWERS', 'ROSHAN', 'BARRACKS'], 'Dota flat keys produce the Dota strip');
eq([dota[0].a, dota[0].b], ['31.3k', '28.4k'], 'gold is abbreviated to thousands');
eq([dota[1].a, dota[1].b], [4, 2], 'tower counts survive as numbers');

// Riot live shape: side-keyed gold and objectives. This was rendering blank.
const lol = objectiveRows({
  gold: { BLUE: 7118, RED: 6203 },
  objectives: { BLUE: { turrets: 3, dragons: 2, barons: 1, heralds: 1, inhibs: 0 }, RED: { turrets: 1, dragons: 1, barons: 0, heralds: 0, inhibs: 0 } },
});
eq(lol.map((r) => r.k), ['GOLD', 'TOWERS', 'DRAGONS', 'BARONS'], 'side-keyed objectives produce the League strip');
eq([lol[0].a, lol[0].b], ['7.1k', '6.2k'], 'side-keyed gold is read and abbreviated');
eq([lol[1].a, lol[1].b], [3, 1], 'turrets are labelled TOWERS and read per side');
ok(!lol.some((r) => r.k === 'HERALDS'), 'lower-priority rows are dropped rather than overflowing the strip');
ok(objectiveRows({ gold: { BLUE: 1, RED: 2 }, objectives: { BLUE: { turrets: 1, dragons: 1, barons: 1, heralds: 1, inhibs: 1 }, RED: {} } }).length <= 4, 'the strip is never taller than four rows');

// Radiant/Dire is the other name for the same two sides.
eq(objectiveRows({ gold: { RADIANT: 2000, DIRE: 1000 } }).map((r) => [r.k, r.a, r.b]), [['GOLD', '2.0k', '1.0k']], 'RADIANT/DIRE is read like A/B');

// An explicit rows array stays authoritative, and a duplicate label never doubles up.
eq(objectiveRows({ objectives: [{ k: 'GOLD', a: '9k', b: '8k' }] }).map((r) => r.k), ['GOLD'], 'an objectives array is passed through');
eq(objectiveRows({ towersA: 5, towersB: 1, objectives: { BLUE: { turrets: 9 }, RED: { turrets: 9 } } }).filter((r) => r.k === 'TOWERS').length, 1, 'towers and turrets do not both produce a row');
eq(objectiveRows({}), [], 'no objective data means no strip at all');
eq(objectiveRows(undefined), [], 'a missing extra bag is not an error');

console.log('\n== overlay: CS2 round history ==');
// The real GSI shape. Keys arrive as JSON strings.
const rw = roundHistory({ roundWins: { '1': 'ct_win_elimination', '2': 't_win_bomb', '3': 'ct_win_defuse', '4': 't_win_time' } });
eq(rw.map((r) => r.side), ['ct', 't', 'ct', 't'], 'the winning side is read off each round');
eq(rw.map((r) => r.how), ['elimination', 'bomb', 'defuse', 'time'], 'how the round ended is read off each round');

// Lexical ordering would put round 10 before round 2 and scramble the whole bar.
const many = {};
for (let i = 1; i <= 12; i++) many[String(i)] = (i % 2 ? 'ct' : 't') + '_win_elimination';
eq(roundHistory({ roundWins: many }).map((r) => r.round), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'rounds are ordered numerically, not lexically');

// Junk must not put a marker on air.
eq(roundHistory({ roundWins: { '1': 'ct_win_elimination', '2': 'nonsense', '0': 'ct_win_bomb', x: 't_win_bomb' } }).map((r) => r.round), [1], 'unparseable and out-of-range entries are dropped');
eq(roundHistory({ roundWins: { '1': 'ct_win_somethingnew' } })[0].how, 'elimination', 'an unknown win method falls back rather than emitting a stray class');
eq(roundHistory({ roundWins: { '1': 'T_WIN_BOMB' } })[0], { round: 1, side: 't', how: 'bomb' }, 'the feed may shout; the strip does not care');
eq(roundHistory({}), [], 'no round data means no bar');
eq(roundHistory(undefined), [], 'a missing extra bag is not an error');
eq(roundHistory({ roundWins: [] }), [], 'an array is tolerated and yields nothing');

console.log('\n== overlay: scoreboard from a live feed ==');
// A normalized player: kills/deaths/assists/score at the top level, the rest in extra.
const dotaPlayer = { team: 'A', name: 'Zephyr', kills: 9, deaths: 2, assists: 11, score: 18400, money: 15200,
  extra: { lastHits: 214, denies: 12, gpm: 612, xpm: 705, netWorth: 18400, level: 21 } };

eq(playerStat(dotaPlayer, 'k'), 9, 'k resolves to kills');
eq(playerStat(dotaPlayer, 'd'), 2, 'd resolves to deaths');
eq(playerStat(dotaPlayer, 'a'), 11, 'a resolves to assists');
eq(playerStat(dotaPlayer, 'lh'), 214, 'lh resolves to lastHits in extra');
eq(playerStat(dotaPlayer, 'nw'), 18400, 'nw resolves to netWorth in extra');
eq(playerStat(dotaPlayer, 'gpm'), 612, 'a column that matches extra directly is read');
eq(playerStat(dotaPlayer, 'gold'), 15200, 'Dota keeps gold in money');
ok(playerStat(dotaPlayer, 'adr') === null, 'a stat the feed does not carry is null, not zero');
eq(playerStat(dotaPlayer, 'kda'), '9/2/11', 'kda is composed rather than looked up');
ok(playerStat(dotaPlayer, 'items') === null, 'an object-valued extra is not put in a table cell');
ok(playerStat(null, 'k') === null && playerStat(dotaPlayer, '') === null, 'missing player or column is not an error');

// Rocket League keeps goals/saves/shots in extra and score/assists at the top level.
const rlPlayer = { team: 'B', name: 'Rift', kills: 1, assists: 2, score: 430, extra: { goals: 3, saves: 4, shots: 7, demos: 1 } };
eq(['score', 'goals', 'assists', 'saves', 'shots'].map((c) => playerStat(rlPlayer, c)), [430, 3, 2, 4, 7], 'the whole Rocket League column set resolves');

const STATE = {
  series: { teamA: 'alpha', teamB: 'bravo' },
  live: { connected: true, players: [dotaPlayer, rlPlayer, { team: 'C', name: 'stray', kills: 1, extra: {} }] },
};
const rows = liveScoreboardRows(STATE, ['k', 'd', 'a', 'nw']);
eq(rows.map((r) => r.team), ['alpha', 'bravo'], 'live players are mapped onto the desk team ids');
eq(rows.map((r) => r.ign), ['Zephyr', 'Rift'], 'a player on no known slot is dropped rather than guessed');
eq(rows[0], { team: 'alpha', ign: 'Zephyr', k: 9, d: 2, a: 11, nw: 18400 }, 'only the pack columns land on the row');
ok(!('nw' in rows[1]), 'a column the player has no value for is left off, so the card shows a dash');
eq(liveScoreboardRows({ series: {}, live: { connected: false, players: [dotaPlayer] } }, ['k']), [], 'a disconnected feed contributes nothing');
eq(liveScoreboardRows({ series: { teamA: 'alpha' }, live: { connected: true, players: [] } }, ['k']), [], 'no players means no rows');
eq(liveScoreboardRows({}, ['k']), [], 'no live block is not an error');
// After the final whistle the feed drops (or a Rocket League lobby closes and empties the players):
// the agent's live.result for THIS title is what the post-match card shows.
const RESULT = { game: 'rocketleague', scoreA: 2, scoreB: 1, players: [{ ...rlPlayer, team: 'A', name: 'Zephyr' }, rlPlayer] };
eq(liveScoreboardRows({ game: 'rocketleague', series: { teamA: 'alpha', teamB: 'bravo' }, live: { connected: false, players: [], result: RESULT } }, ['goals']).map((r) => `${r.team}:${r.ign}:${r.goals}`), ['alpha:Zephyr:3', 'bravo:Rift:3'], 'feed gone after game over: the last finished game fills the card');
eq(liveScoreboardRows({ game: 'cs2', series: { teamA: 'alpha', teamB: 'bravo' }, live: { connected: false, players: [], result: RESULT } }, ['goals']), [], 'a result from another title is never shown');
eq(liveScoreboardRows({ game: 'rocketleague', series: { teamA: 'alpha', teamB: 'bravo' }, live: { connected: true, players: [dotaPlayer], result: RESULT } }, ['k']).map((r) => r.ign), ['Zephyr'], 'a connected feed with players wins over the old result');

console.log('\n== liquipedia: names and wikis ==');
// The slug becomes a filename under packs/<game>/assets/teams, so it has to be
// safe for every team name an operator will paste in.
eq(lpSlug('Karmine Corp'), 'karmine-corp', 'spaces become hyphens');
eq(lpSlug('G2 Esports'), 'g2-esports', 'digits survive');
eq(lpSlug('FURIA Esports'), 'furia-esports', 'case is folded');
eq(lpSlug('Team Vitality!!'), 'team-vitality', 'punctuation is dropped, not encoded');
eq(lpSlug('  paiN  Gaming  '), 'pain-gaming', 'surrounding and repeated spaces collapse');
eq(lpSlug('Natus Vincere'), 'natus-vincere', 'a plain two-word name is untouched beyond case');
eq(lpSlug('???'), 'team', 'a name with nothing usable still yields a filename');
eq(lpSlug(''), 'team', 'an empty name does not produce an empty filename');
ok(!/[^a-z0-9-]/.test(lpSlug('Ninjas in Pyjamas (NIP)')), 'a slug never contains a path or shell character');

// Every pack must resolve to a wiki, or the lookup silently searches the wrong one.
for (const id of ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'apex', 'fgc', 'eafc']) {
  ok(typeof WIKI_FOR_PACK[id] === 'string' && WIKI_FOR_PACK[id].length > 0, `${id} maps to a liquipedia wiki`);
}


// ---------------------------------------------------------------------------
console.log('\n== game switch ==');
const PACKS = Object.fromEntries(['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'apex', 'fgc', 'eafc'].map((id) => [id, JSON.parse(fs.readFileSync(path.join(PACKS_DIR, id, 'pack.json'), 'utf8'))]));
for (const id of Object.keys(PACKS)) ok(Number.isInteger(PACKS[id].rosterSize) && PACKS[id].rosterSize > 0, `${id} declares a roster size (${PACKS[id].rosterSize})`);
eq(rosterSize(PACKS.rocketleague), 3, 'Rocket League is 3v3');
eq(rosterSize(PACKS.fgc), 1, 'the FGC is 1v1');
eq(rosterSize({}), 5, 'an un-migrated pack defaults to 5');

// The complaint that started this: a Dota show still listing Rocket League arenas as games.
const stale = defaultState();
stale.game = 'rocketleague';
stale.series = { ...stale.series, format: 'BO7', scoreA: 2, scoreB: 1, mapIndex: 2, status: 'live', maps: [{ name: 'Mannfield', scoreA: 3, scoreB: 1, winner: 'alpha', status: 'done' }, { name: 'Champions Field', scoreA: 0, scoreB: 0, winner: null, status: 'live' }] };
stale.show.card = 'games';
stale.rundown = [{ id: 'r1', time: '', title: 'Series board', scene: '03', card: 'games', notes: '', done: false }, { id: 'r2', time: '', title: 'Game 1', scene: '04', card: 'none', notes: '', done: false }];
const sw = gameSwitchPatch(stale, PACKS.dota2, 'dota2');
eq(sw.patch.game, 'dota2', 'the game changes');
eq(sw.patch.series.maps, [], 'the other title\'s arenas do not survive the switch');
eq(sw.patch.series.format, 'BO3', 'the format falls back to the new title\'s default');
eq([sw.patch.series.scoreA, sw.patch.series.scoreB, sw.patch.series.mapIndex], [0, 0, 0], 'scores and the current map reset');
eq(sw.patch.veto.pool, [], 'a title without a veto gets an empty pool');
eq(sw.patch.show.card, 'none', 'a card the new title cannot show is cleared');
eq(sw.patch.rundown.map((r) => r.card), ['none', 'none'], 'rundown rows lose cards the new title cannot show');
ok(!('event' in sw.patch) && !('talent' in sw.patch) && !('bracket' in sw.patch) && !('settings' in sw.patch), 'event, talent, bracket and settings are untouched');
ok(sw.patch.teams && Object.values(sw.patch.teams).every((t) => t.roster.every((p) => p.role === '')), 'Valorant roles are blanked on a Dota desk (they are not Dota roles)');
ok(sw.reset.includes('series') && sw.reset.includes('veto') && sw.kept.includes('teams'), 'the reply says what was reset and what was kept');

const sw2 = gameSwitchPatch(defaultState(), PACKS.cs2, 'cs2');
ok(sw2.patch.veto.pool.length > 0 && !sw2.patch.veto.pool.includes('Cache'), 'CS2 gets its active rotation as the pool');
ok(!('rundown' in sw2.patch), 'a rundown whose cards the new title allows is left alone');
const sw3 = gameSwitchPatch(defaultState(), PACKS.valorant, 'valorant');
ok(!('teams' in sw3.patch), 'roles that exist on the new title are kept');

console.log('\n== default rundown per title ==');
for (const id of Object.keys(PACKS)) {
  const rows = defaultRundown(PACKS[id]);
  const cards = new Set(cardsFor(PACKS[id]));
  ok(rows.every((r) => cards.has(r.card)), `${id}: every default block uses a card the title has`);
  const head = headlineCard(PACKS[id]);
  ok(!head || rows.some((r) => r.card === head), `${id}: the headline card (${head}) has a block`);
}
ok(!defaultRundown(PACKS.rocketleague).some((r) => r.card === 'veto'), 'Rocket League\'s rundown has no map veto block');
ok(defaultRundown(PACKS.rocketleague).some((r) => /Game 1/.test(r.title)), 'Rocket League calls it a game, not a map');
ok(defaultRundown(PACKS.valorant).some((r) => /Map 1/.test(r.title)), 'Valorant calls it a map');
ok(defaultRundown(PACKS.apex).some((r) => r.card === 'standings') && !defaultRundown(PACKS.apex).some((r) => r.card === 'vs'), 'Apex gets standings and no versus card');

console.log('\n== new event ==');
const cur = defaultState();
cur.settings.obsPassword = 'keepme';
cur.talent = [{ id: 't9', name: 'Crew', role: 'CASTER', handle: '@crew', slot: 3 }];
const ne = newEventState(cur, PACKS.rocketleague, { game: 'rocketleague', name: 'Test Cup' });
eq(ne.game, 'rocketleague', 'new event is on the requested title');
eq(ne.event.name, 'Test Cup', 'new event takes the name');
eq(Object.keys(ne.teams).length, 2, 'two placeholder teams');
eq(ne.teams['team-a'].roster.length, 3, 'placeholder rosters are sized for the title');
eq(ne.series.format, 'BO5', 'format is the title default');
eq(ne.settings.obsPassword, 'keepme', 'settings survive a new event');
eq(ne.talent.length, 1, 'talent survives a new event');
eq(ne.veto.pool, [], 'no veto pool for a title without a veto');
ok(ne.rundown.length > 5 && ne.rundown.every((r) => r.card !== 'veto'), 'the rundown is the title\'s own');
ok(!ne.series.maps.length && ne.series.scoreA === 0, 'nothing from the sample event leaks in');
eq(vetoPool(PACKS.valorant).includes('Ascent'), true, 'valorant pool has Ascent');

console.log('\n== title-agnostic collection ==');
const built = build({ state: { ...defaultState(), game: 'rocketleague' }, pack: PACKS.rocketleague, root: path.resolve(PACKS_DIR, '..') });
const urls = built.sources.filter((x) => x.id === 'browser_source' && /^GFX/.test(x.name)).map((x) => x.settings.url);
ok(urls.length === 5 && urls.every((u) => /\/overlay\/[a-z]+\.html/.test(u) && !/\/packs\//.test(u)), 'every GFX source points at a title-agnostic /overlay/ page');
ok(built.sources.some((x) => x.name === GAME_SOURCE && x.id === 'game_capture'), 'the capture source has the generic name and RL is a game capture');
const builtApex = build({ state: { ...defaultState(), game: 'apex' }, pack: PACKS.apex, root: path.resolve(PACKS_DIR, '..') });
ok(builtApex.sources.some((x) => x.name === GAME_SOURCE && x.id === 'game_capture'), 'Apex now has a real game-capture window (it was monitor capture)');
eq(genericUrl('http://127.0.0.1:7700/packs/rocketleague/overlay/desk.html?who=hosts'), 'http://127.0.0.1:7700/overlay/desk.html?who=hosts', 'an old per-pack URL maps to the generic page, query kept');
eq(genericUrl('http://127.0.0.1:7700/overlay/ingame.html'), null, 'an already-generic URL is left alone');
eq(genericUrl('https://vdo.ninja/?room=x'), null, 'a VDO.Ninja source is never touched');
eq(repointUrl('http://127.0.0.1:7700/overlay/ingame.html', 'http://127.0.0.1:7720'), 'http://127.0.0.1:7720/overlay/ingame.html', 'a graphics page pointing at another agent port is repointed to this agent');
eq(repointUrl('http://localhost:7700/packs/cs2/overlay/desk.html?who=hosts', 'http://127.0.0.1:7720'), 'http://127.0.0.1:7720/overlay/desk.html?who=hosts', 'old per-pack URL on localhost: generic page, this origin, query kept');
eq(repointUrl('http://127.0.0.1:7720/overlay/cards.html', 'http://127.0.0.1:7720'), null, 'already right: left alone');
eq(repointUrl('https://vdo.ninja/?room=x&view=a', 'http://127.0.0.1:7720'), null, 'VDO.Ninja is never repointed');
eq(repointUrl('http://192.168.1.20:7700/overlay/ingame.html', 'http://127.0.0.1:7720'), null, 'a page on another machine is not ours to move');
eq(build({ state: { game: 'cs2', settings: {}, talent: [] }, port: 7720 }).sources.filter((x) => x.id === 'browser_source' && /^GFX · /.test(x.name)).every((x) => x.settings.url.startsWith('http://127.0.0.1:7720/overlay/')), true, 'the collection points its graphics at the port this agent listens on (--port), not 7700');
for (const p of ['ingame', 'cards', 'standby', 'desk']) ok(fs.existsSync(path.resolve(PACKS_DIR, '..', 'overlays', 'live', `${p}.html`)), `overlays/live/${p}.html exists`);

console.log('\n== liquipedia: rosters ==');
const CS_WT = `{{Infobox team
|name=Team Vitality
|image=Team Vitality 2026 full lightmode.png
|imagedark=Team Vitality 2026 full darkmode.png
|location=France
|twitter=TeamVitalityCS
}}
'''Team Vitality''' is a [[:Category:France|French]] organisation.
==Player Roster==
===Active===
{{Squad|status=active
|{{Person|flag=fr|id=apEX|igl=y|name=Dan Madesclaire|joindate={{abbr|2018-10-08|Player was inactive}} <ref name="VIT 2018"/>}}
|{{Person|flag=fr|id=ZywOo|name=Mathieu Herbaut|joindate=2018-10-08 <ref name="VIT 2018"/>}}
|{{Person|flag=il|id=flameZ|name=Shahar Shushan|joindate=2023-06-22}}
|{{Person|flag=uk|id=mezii|name=William Merriman|joindate=2023-11-08}}
|{{Person|flag=ee|id=ropz|name=Robin Kool|joindate=2025-01-10}}
|{{Person|flag=fr|id=XTQZZZ|name=Rémy Quoniam|role=Coach|joindate=2023-10-13}}
}}
===Former===
{{Squad|status=former|title=Former Players
|{{Person|flag=il|id=Spinx|name=Lotan Giladi|joindate=2022-08-15|leavedate=2025-01-23|newteam=mouz}}
}}`;
const sq = parseSquad(CS_WT);
eq(sq.map((p) => p.ign), ['apEX', 'ZywOo', 'flameZ', 'mezii', 'ropz'], 'the five active players, in page order, coach excluded');
eq(sq[0], { ign: 'apEX', name: 'Dan Madesclaire', role: '', flag: 'fr', igl: true }, 'the IGL flag and the real name come through, refs and abbr stripped');
ok(!sq.some((p) => p.ign === 'Spinx'), 'former players are not on the roster');
const ib = parseInfobox(CS_WT);
eq(ib.imagedark, 'Team Vitality 2026 full darkmode.png', 'the dark-mode logo file is read from the infobox');
eq(ib.name, 'Team Vitality', 'infobox name');
const VAL_WT = `{{ActiveSquad|
{{SquadPlayer|id=Boaster|name=Jake Howlett|flag=uk|role=Captain}}
{{SquadPlayer|id=Derke|name=Nikita Sirmitev|flag=fi|role=Duelist}}
{{SquadPlayer|id=Coach1|name=Some Coach|flag=us|role=Head Coach}}
}}`;
const sq2 = parseSquad(VAL_WT);
eq(sq2.map((p) => p.ign), ['Boaster', 'Derke'], 'the ActiveSquad/SquadPlayer form also parses; the coach is excluded');
eq(sq2[1].role, 'DUELIST', 'roles are upper-cased for the pack role list');
eq(parseSquad(''), [], 'no wikitext, no roster');
const RL_HTML = '<h3 id="Active">Active</h3><table class="table2&#95;&#95;table"><tbody><tr class="table2&#95;&#95;row--head"><th>ID</th><th>Name</th><th></th><th>Join Date</th></tr>'
  + '<tr class="table2&#95;&#95;row--body"><td><b><span class="inline-player"><span class="flag"><a href="/rocketleague/Category:France" title="France"><img src="x"></a></span>&#160;<a href="/rocketleague/Zen" title="Zen">zen</a></span></b></td><td>Alexis Bernier</td><td></td><td>2022-10-02 <sup class="reference">[26]</sup></td></tr>'
  + '<tr class="table2&#95;&#95;row--body"><td><b><a href="/rocketleague/ExoTiiK" title="ExoTiiK">ExoTiiK</a></b></td><td>Brice Bigeard</td><td></td><td>2024-10-14</td></tr>'
  + '<tr class="table2&#95;&#95;row--body"><td><b><a href="/rocketleague/Eversax" title="Eversax">Eversax</a></b></td><td>Benjamin Wagner</td><td>Coach</td><td>2025-10-14</td></tr>'
  + '</tbody></table><h3 id="Former">Former</h3><tr class="table2&#95;&#95;row--body"><td><a href="/rocketleague/Old" title="Old">Old</a></td><td>Gone</td><td></td></tr>';
const rlRoster = parseRosterHtml(RL_HTML);
eq(rlRoster.map((p) => p.ign), ['zen', 'ExoTiiK'], 'the rendered Active table gives the players, coach and former rows excluded');
eq(rlRoster[0], { ign: 'zen', name: 'Alexis Bernier', role: '', flag: 'france', igl: false, link: 'Zen' }, 'IGN, real name, flag and the page link come out of the row');
eq(parseRosterHtml('<p>nothing</p>'), [], 'no Active section, no roster');
const PLAYER_WT = '{{Infobox player\n|id=ZywOo\n|ids=Herbus Doubledoor\n|image=ZywOo at BLAST Bounty Winter 2026.jpg\n|name=Mathieu Herbaut\n|country=France\n|team=Team Vitality\n|roles=awp,rifle\n|team_history=\n}}\n\'\'\'ZywOo\'\'\' is a player.';
eq(parsePlayerInfobox(PLAYER_WT), { id: 'ZywOo', name: 'Mathieu Herbaut', image: 'ZywOo at BLAST Bounty Winter 2026.jpg', roles: ['awp', 'rifle'], country: 'France', team: 'Team Vitality' }, 'a player infobox gives the photo file, real name and per-game roles');
ok(parsePlayerInfobox('no infobox here') === null, 'a page without a player infobox is null, not a guess');
const sw4 = gameSwitchPatch({ ...defaultState(), game: 'valorant' }, PACKS.cs2, 'cs2');
ok(Object.values(sw4.patch.teams).every((t) => t.roster.every((p) => p.portrait === '')), 'Valorant sample portraits do not follow the desk onto CS2');
const kept = gameSwitchPatch({ ...defaultState(), teams: { x: { id: 'x', name: 'X', roster: [{ ign: 'a', role: '', portrait: '/packs/_players/a.jpg' }] } } }, PACKS.cs2, 'cs2');
ok(!('teams' in kept.patch), 'a cached Liquipedia photo survives a switch (a person is not per-game)');
const STAFF_WT = `{{Squad|type=staff|status=active\n|{{Person|flag=us|id=Bossman|name=Some Boss|role=Head of Esports}}\n}}\n{{Squad|status=active\n|{{Person|flag=us|id=Reps|name=Jordan Wolfe}}\n}}`;
eq(parseSquad(STAFF_WT).map((p) => p.ign), ['Reps'], 'a staff squad is skipped even when the role is not a known staff word');
eq(parseSquad('{{Squad|type=staff|status=active\n|{{Person|id=X|name=Y|role=Boss}}\n}}'), [], 'a page with only a staff squad has no roster (TSM on the Apex wiki)');
eq(plain('[[apEX]] <ref name="x"/>{{flag|fr}} \'\'\'bold\'\'\''), 'apEX  bold', 'plain() strips links, refs, flags and bold');

console.log('\n== update ==');
eq(compareVersions('0.2.0', '0.1.0'), 1, 'minor bump is newer');
eq(compareVersions('0.1.0', '0.1.0'), 0, 'same is same');
eq(compareVersions('0.1.10', '0.1.9'), 1, 'numeric, not lexical');
eq(compareVersions('1.0.0-beta.1', '0.9.9'), 1, 'pre-release tag is ignored for ordering');

// ---------------------------------------------------------------------------
// Security + state hardening (1 Oct 2026). Nothing here patches the in-process
// store: patch() would schedule a save to the real agent/data/state.json. The
// persistence checks run in a child process pointed at a temp dir instead.
console.log('\n== state: merge refuses prototype keys ==');
{
  const { merge, clean } = await import('./state.js');
  const target = { a: { b: 1 } };
  merge(target, JSON.parse('{"__proto__":{"polluted":1},"a":{"__proto__":{"polluted":2},"c":3},"constructor":{"prototype":{"polluted":3}}}'));
  ok(({}).polluted === undefined && Object.prototype.polluted === undefined, 'a JSON __proto__ patch does not reach Object.prototype');
  eq(target, { a: { b: 1, c: 3 } }, 'the safe keys of the same patch still merge');
  const dirty = clean(JSON.parse('{"x":{"__proto__":{"p":1},"y":[{"constructor":1,"z":2}]}}'));
  ok(!Object.prototype.hasOwnProperty.call(dirty.x, '__proto__') && dirty.x.y[0].z === 2 && !Object.prototype.hasOwnProperty.call(dirty.x.y[0], 'constructor'), 'clean() strips prototype keys at any depth, arrays included');
}

console.log('\n== state: live updates replace per-map data ==');
{
  const st = await import('./state.js');
  st.resetLive('cs2gsi');
  const wins = {}; for (let r = 1; r <= 24; r++) wins[r] = r % 2 ? 'ct_win_elimination' : 't_win_bomb';
  st.setLive({ source: 'cs2gsi', connected: true, names: { A: 'Map1 A', B: 'Map1 B' }, extra: { roundWins: wins, sideExtra: { A: { timeouts: 1 }, B: { timeouts: 3 } }, objectives: { BLUE: { turrets: 4 } } }, bomb: { state: 'planted', countdown: 30 } });
  st.setLive({ source: 'cs2gsi', connected: true, names: { A: 'Map2 A' }, extra: { roundWins: { 1: 'ct_win_time' } }, bomb: { state: 'none' } });
  const l = st.get().live;
  eq(Object.keys(l.extra.roundWins), ['1'], 'map 2 round history replaces map 1 (24 markers -> 1)');
  ok(!('sideExtra' in l.extra) && !('objectives' in l.extra), 'extra keys the new update lacks are gone, not carried over');
  eq(l.names, { A: 'Map2 A' }, 'names is replaced wholesale');
  eq(l.bomb, { state: 'none', countdown: 30 }, 'other live objects still deep-merge');
  st.setLive({ scoreA: 2 });
  eq(Object.keys(l.extra.roundWins), ['1'], 'an update without extra leaves the current extra alone');

  st.setLive({ source: 'cs2gsi', connected: true, phase: 'live', scoreA: 12, scoreB: 9, players: [{ team: 'A', name: 'Zephyr', kills: 20 }] });
  ok(!st.get().live.result, 'no result while the game is still being played');
  st.setLive({ source: 'cs2gsi', connected: true, phase: 'gameover', scoreA: 13, scoreB: 9, players: [{ team: 'A', name: 'Zephyr', kills: 21 }] });
  st.setLive({ source: 'cs2gsi', connected: false, phase: 'unknown', players: [] });
  const res = st.get().live.result;
  ok(res && res.scoreA === 13 && res.players[0].kills === 21 && res.game === st.get().game && st.get().live.players.length === 0, 'game over keeps a result that outlives the feed dropping and the players emptying');

  console.log('\n== state: stale feed watchdog ==');
  const now = Date.now();
  st.setLive({ source: 'cs2gsi', connected: true, updatedAt: now - 25000 });
  ok(st.checkStale(now) === true && st.get().live.connected === false, 'a real adapter silent for 25 s is marked disconnected');
  ok(st.checkStale(now + 5000) === false, 'it is marked once, not on every tick');
  st.setLive({ source: 'cs2gsi', connected: true });
  ok(st.get().live.connected === true && st.checkStale() === false, 'the next update clears it');
  st.resetLive('sim:cs2');
  st.setLive({ source: 'sim:cs2', connected: true, updatedAt: now - 60000 });
  ok(st.checkStale(now) === false && st.get().live.connected === true, 'a simulator is never marked stale');
  st.resetLive('manual');
  st.setLive({ source: 'manual', connected: true, updatedAt: now - 60000 });
  ok(st.checkStale(now) === false, 'manual is never marked stale');
  st.resetLive('manual');
}

console.log('\n== state: atomic save, .bak recovery ==');
{
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-state-'));
  const stateUrl = pathToFileURL(path.resolve(PACKS_DIR, '..', 'agent', 'src', 'state.js')).href;
  // One child per boot: STATE_FILE is fixed when config.js is imported.
  const boot = (body) => {
    const code = `const st = await import(${JSON.stringify(stateUrl)}); const fs = await import('node:fs');\n${body}`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CTA_DATA_DIR: dir }, encoding: 'utf8' });
    const line = String(r.stdout || '').split(/\r?\n/).reverse().find((x) => x.startsWith('RESULT '));
    if (!line) console.log(r.stdout, r.stderr);
    return line ? JSON.parse(line.slice(7)) : {};
  };
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ ...defaultState(), event: { name: 'GOOD' }, settings: { ...defaultState().settings, gsiToken: 'cta' } }));

  const a = boot(`st.load(); const info = st.loadInfo(); st.patch({ event: { name: 'NEWER' } }); const wrote = st.flush();
    console.log('RESULT ' + JSON.stringify({ info, wrote, token: st.get().settings.gsiToken, files: fs.readdirSync(${JSON.stringify(dir)}) }));`);
  eq(a.info && a.info.from, 'file', 'a good state.json loads from file');
  ok(a.wrote === true, 'flush() writes a pending save synchronously');
  eq(a.token, 'cta', 'an existing saved GSI token is kept as it is');
  eq(JSON.parse(fs.readFileSync(file, 'utf8')).event.name, 'NEWER', 'the save reached state.json');
  eq(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).event.name, 'GOOD', 'the first save of a session backed up the last good file');
  ok(!(a.files || []).includes('state.json.tmp'), 'no temp file is left behind');

  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 3)));   // a crash mid-write, the old way
  const b = boot(`st.load(); const info = st.loadInfo(); const name = st.get().event.name; st.patch({ event: { subtitle: 'AFTER' } }); st.flush();
    console.log('RESULT ' + JSON.stringify({ info, name, files: fs.readdirSync(${JSON.stringify(dir)}) }));`);
  eq(b.info && b.info.from, 'backup', 'a truncated state.json falls back to state.json.bak');
  ok(b.info && b.info.hadFile === true && /unreadable/.test(b.info.reason), 'loadInfo() says a file existed and why it was not used');
  eq(b.name, 'GOOD', 'the backup content is what boots');
  ok((b.files || []).some((f) => /^state\.corrupt-.*\.json$/.test(f)) && b.info.corrupt, 'the corrupt file is kept aside as state.corrupt-<stamp>.json');
  eq(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).event.name, 'GOOD', 'saving after a recovery does not overwrite the good .bak');

  fs.writeFileSync(file, '{"trunc');
  fs.writeFileSync(file + '.bak', '');
  const c = boot(`st.load(); console.log('RESULT ' + JSON.stringify({ info: st.loadInfo(), name: st.get().event.name, token: st.get().settings.gsiToken }));`);
  eq(c.info && c.info.from, 'defaults', 'both files unreadable -> defaults');
  ok(c.info && c.info.hadFile === true, 'defaults after a failure is distinguishable from a first run (hadFile)');

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-fresh-'));
  const d = (() => {
    const code = `const st = await import(${JSON.stringify(stateUrl)}); st.load(); st.flush(); console.log('RESULT ' + JSON.stringify({ info: st.loadInfo(), token: st.get().settings.gsiToken }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CTA_DATA_DIR: fresh }, encoding: 'utf8' });
    const line = String(r.stdout || '').split(/\r?\n/).reverse().find((x) => x.startsWith('RESULT '));
    return line ? JSON.parse(line.slice(7)) : {};
  })();
  ok(d.info && d.info.from === 'defaults' && d.info.hadFile === false, 'a first run reports defaults with hadFile false');
  ok(/^[0-9a-f]{16}$/.test(d.token || '') && d.token !== 'cta', 'a first run mints a random 16-char GSI token');
  eq(JSON.parse(fs.readFileSync(path.join(fresh, 'state.json'), 'utf8')).settings.gsiToken, d.token, 'the minted token is saved at once, so the next boot keeps it');
  for (const x of [dir, fresh]) fs.rmSync(x, { recursive: true, force: true });
}

console.log('\n== http: request guard ==');
{
  const { guardRequest } = await import('./http.js');
  const P = 7700;
  const req = (method, url, headers) => ({ method, url, headers });
  const g = (r, o = {}) => guardRequest(r, { port: P, extraOrigins: [], ...o });
  const own = { host: '127.0.0.1:7700', origin: 'http://127.0.0.1:7700', 'sec-fetch-site': 'same-origin' };
  ok(g(req('GET', '/api/state', own)).ok, 'same-origin GET /api/state is allowed');
  ok(g(req('POST', '/api/state', { ...own, 'content-type': 'application/json; charset=utf-8' })).ok, 'same-origin JSON POST is allowed');
  ok(g(req('GET', '/api/state', { host: '127.0.0.1:7700' })).ok, 'a tool with no Origin (launcher, curl) is allowed');
  ok(g(req('GET', '/api/state', { host: 'localhost:7700', origin: 'http://localhost:7700' })).ok && g(req('GET', '/api/state', { host: '[::1]:7700' })).ok, 'localhost and [::1] are the same agent');
  eq(g(req('GET', '/api/state', { ...own, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403, 'a cross Origin is refused');
  eq(g(req('POST', '/api/obs/raw', { host: '127.0.0.1:7700', origin: 'null', 'content-type': 'application/json' })).status, 403, "an opaque 'null' Origin is refused");
  eq(g(req('GET', '/api/state', { host: 'evil.example:7700' })).status, 403, 'a foreign Host (DNS rebinding) is refused');
  eq(g(req('GET', '/api/state', {})).status, 403, 'a missing Host is refused');
  eq(g(req('GET', '/api/obs/shot?cut=1', { host: '127.0.0.1:7700', 'sec-fetch-site': 'cross-site' })).status, 403, 'a cross-site <img> on /api/obs/shot?cut=1 is refused (no Origin on an image GET)');
  eq(g(req('GET', '/api/state', { host: '127.0.0.1:7700', 'sec-fetch-site': 'same-site' })).status, 403, 'Sec-Fetch-Site same-site is refused on the API');
  eq(g(req('POST', '/api/state', { ...own, 'content-type': 'text/plain' })).status, 415, 'a non-JSON POST is refused with 415');
  eq(g(req('POST', '/api/obs/stream', { ...own, 'content-type': 'application/x-www-form-urlencoded' })).status, 415, 'a form POST is refused with 415');
  eq(g(req('POST', '/api/obs/take', own)).status, 415, 'a POST with no content type is refused');
  ok(g(req('GET', '/overlay/ingame.html', { host: '127.0.0.1:7700', 'sec-fetch-site': 'cross-site' })).ok, 'static overlay files stay open to GET');
  ok(g(req('GET', '/healthz', { host: '127.0.0.1:7700', origin: 'https://evil.example' })).ok, '/healthz stays open (the launcher polls it)');
  eq(g(req('GET', '/ws', { host: '127.0.0.1:7700', origin: 'https://evil.example' }), { upgrade: true }).status, 403, 'a cross-origin WebSocket upgrade is refused');
  eq(g(req('GET', '/ws?role=control', { host: '127.0.0.1:7700', 'sec-fetch-site': 'cross-site' }), { upgrade: true }).status, 403, 'a cross-site WebSocket upgrade is refused');
  ok(g(req('GET', '/ws?role=overlay&page=ingame', { host: '127.0.0.1:7700', origin: 'http://127.0.0.1:7700' }), { upgrade: true }).ok, 'an overlay page on this agent may open /ws');
  ok(g(req('POST', '/api/state', { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' }), { extraOrigins: ['http://localhost:5173'] }).ok, 'CTA_ALLOW_ORIGINS admits the Vite dev server');

  // The same guard on a real upgrade, on an ephemeral port.
  const http = (await import('node:http')).default;
  const { WebSocket } = await import('ws');
  const { createHub } = await import('./hub.js');
  const server = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
  const hub = createHub(server, { hello: () => ({}), patch: () => {}, obs: async () => ({}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tryWs = (origin) => new Promise((res) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws?role=control`, origin ? { origin } : {});
    w.on('open', () => { w.close(); res('open'); });
    w.on('unexpected-response', (_q, r) => res(r.statusCode));
    w.on('error', () => res('error'));
  });
  eq(await tryWs('https://evil.example'), 403, 'hub: a WebSocket from a foreign page gets 403');
  eq(await tryWs(`http://127.0.0.1:${port}`), 'open', 'hub: a WebSocket from this agent opens');
  hub.close();
  await new Promise((r) => server.close(r));
}

// ---------------------------------------------------------------------------
// Remote seats: what the hosted control room may do, and what it may see.
// The end-to-end version (a real agent process, the real relay Worker and
// room) is relay/test/e2e.mjs. These are the rules themselves, in isolation.
// ---------------------------------------------------------------------------
{
  console.log('\nremote seats - policy');
  const {
    allow, allowPatch, allowHubMessage, redactState, patchPaths, shotQuery, matchRule, SECRET_PATHS,
  } = await import('./remote-policy.js');

  const seat = (role, extra = {}) => ({ id: 's1', name: 'Guest', role, ...extra });
  const PRODUCER = seat('producer');
  const SCORER = seat('scorer');
  const VIEWER = seat('viewer');
  const CAPS = { caps: { streamControl: false } };

  // Deny by default is the whole point of the list: a route added to http.js
  // later is unreachable from the internet until someone lists it on purpose.
  ok(!matchRule('POST', '/api/obs/raw'), 'no rule covers an arbitrary obs-websocket call');
  for (const p of ['/api/shutdown', '/api/game', '/api/event/new', '/api/obs/collection/install', '/api/obs/collection/remove', '/api/adapters/cs2gsi/run', '/api/sim/cs2/start', '/api/rehearse']) {
    ok(!allow(PRODUCER, 'POST', p, CAPS).ok, `a producer cannot POST ${p}`);
  }
  ok(!allow(PRODUCER, 'GET', '/api/update', CAPS).ok, 'a producer cannot reach the updater');
  ok(!allow(PRODUCER, 'GET', '/api/remote', CAPS).ok, 'a seat cannot read the seat list');
  ok(!allow(PRODUCER, 'POST', '/api/remote/invite', CAPS).ok, 'a seat cannot mint another invite');

  ok(allow(PRODUCER, 'POST', '/api/obs/take', CAPS).ok, 'a producer can take');
  ok(allow(PRODUCER, 'POST', '/api/obs/scene', CAPS).ok, 'a producer can cut a scene');
  ok(!allow(SCORER, 'POST', '/api/obs/scene', CAPS).ok, 'a scorer cannot cut a scene');
  ok(!allow(VIEWER, 'POST', '/api/state', CAPS).ok, 'a viewer cannot write state');
  ok(allow(VIEWER, 'GET', '/api/state', CAPS).ok, 'a viewer can read state');
  ok(allow(VIEWER, 'GET', '/packs/cs2/assets/teams/vitality.png', CAPS).ok, 'team logos come down the tunnel');
  ok(!allow(VIEWER, 'GET', '/packs/../agent/data/state.json', CAPS).ok, 'a path walking out of packs/ is not a pack asset');

  // The stream switch is off until the broadcast PC says otherwise.
  ok(!allow(PRODUCER, 'POST', '/api/obs/stream', CAPS).ok, 'remote stream control is off by default');
  ok(allow(PRODUCER, 'POST', '/api/obs/stream', { caps: { streamControl: true } }).ok, 'and on when the operator switches it on');
  ok(!allow(SCORER, 'POST', '/api/obs/stream', { caps: { streamControl: true } }).ok, 'even then, only a producer');

  // A seat held at the door can do exactly one thing: ask if it has been let in.
  const PENDING = seat('producer', { pending: true });
  ok(!allow(PENDING, 'GET', '/api/state', CAPS).ok, 'a seat at the door cannot read state');
  ok(!allow(PENDING, 'POST', '/api/obs/take', CAPS).ok, 'nor touch the air');
  ok(allow(PENDING, 'GET', '/api/remote/me', CAPS).ok, 'but it can ask who it is');
  eq(allow(null, 'GET', '/api/state', CAPS).status, 401, 'no seat at all is a 401');

  // Patches.
  ok(allowPatch(PRODUCER, { series: { scoreA: 1 } }).ok, 'a producer can change the score');
  ok(allowPatch(PRODUCER, { show: { bug: true } }).ok, 'a producer can change what is on screen');
  ok(!allowPatch(PRODUCER, { settings: { obsPassword: 'x' } }).ok, 'nobody writes settings from a remote seat');
  ok(!allowPatch(PRODUCER, { live: { score: 9 } }).ok, 'nor live telemetry');
  ok(allowPatch(SCORER, { teams: { t1: { score: 2 } } }).ok, 'a scorer can change a team');
  ok(!allowPatch(SCORER, { show: { bug: false } }).ok, 'a scorer cannot change what is on screen');
  ok(!allowPatch(SCORER, { brand: { logo: '' } }).ok, 'nor the brand');
  ok(!allowPatch(VIEWER, { series: { scoreA: 1 } }).ok, 'a viewer cannot patch at all');
  // A deep patch is judged by what it really writes, not by its outermost key.
  ok(!allowPatch(PRODUCER, { settings: { vdo: { password: 'x' } } }).ok, 'a nested settings write is caught too');
  eq(patchPaths({ series: { scoreA: 1, maps: [{ a: 1 }] }, show: { bug: true } }).sort(),
    ['series.maps', 'series.scoreA', 'show.bug'], 'patchPaths walks to the leaves, arrays included');

  // The socket is the same door as the REST API, so it needs the same lock.
  ok(allowHubMessage(PRODUCER, { type: 'ping' }).ok, 'ping is always fine');
  ok(allowHubMessage(PRODUCER, { type: 'obs', action: 'take' }, CAPS).ok, 'a producer can take over the socket');
  ok(!allowHubMessage(PRODUCER, { type: 'obs', action: 'raw' }, CAPS).ok, 'but not raw');
  ok(!allowHubMessage(SCORER, { type: 'obs', action: 'scene' }, CAPS).ok, 'a scorer cannot cut over the socket either');
  ok(!allowHubMessage(PRODUCER, { type: 'patch', data: { settings: { obsPassword: 'x' } } }, CAPS).ok, 'a settings patch over the socket is refused');
  ok(!allowHubMessage(PRODUCER, { type: 'whatever' }, CAPS).ok, 'an unknown frame type is refused');

  // Redaction. The agent's own object must never be touched, and every secret goes.
  const liveState = defaultState();
  liveState.settings.obsPassword = 'hunter2';
  liveState.settings.startggToken = 'sgg';
  liveState.settings.vdo = { room: 'cta-room', password: 'vdo-pass' };
  const out = redactState(liveState, { role: 'producer' });
  for (const p of SECRET_PATHS) {
    const got = p.split('.').reduce((o, k) => (o == null ? o : o[k]), out);
    eq(got, '', `${p} is blanked for a remote seat`);
  }
  eq(liveState.settings.obsPassword, 'hunter2', 'redaction copies - the agent keeps its own password');
  eq(out.settings.vdo.room, 'cta-room', 'the VDO room survives (only the password is a secret)');
  eq(out.settings.obsCollectionName, liveState.settings.obsCollectionName, 'everything else comes through untouched');
  eq(out.__remote.role, 'producer', 'the seat is told its own role');
  ok(out.__remote.redacted.includes('settings.obsPassword'), 'and what was held back');
  ok(!redactState(defaultState()).__remote.redacted.includes('settings.obsPassword'), 'an unset password is not reported as held back');
  ok(redactState(null).__remote != null, 'redacting nothing does not throw');

  // Thumbnails: JPEG, capped, and never allowed to cut program for a picture.
  const shot = new URLSearchParams(shotQuery('w=1920&cut=1&scene=04'));
  eq(shot.get('w'), '480', 'a remote thumbnail is capped at 480px');
  eq(shot.get('fmt'), 'jpg', 'and comes back as JPEG');
  eq(shot.get('cut'), null, 'and cannot ask the rig to cut program for the shot');
  eq(shot.get('scene'), '04', 'while the scene it asked for is kept');
  eq(new URLSearchParams(shotQuery('w=240')).get('w'), '240', 'a smaller width is left alone');
}


// ---------------------------------------------------------------------------
// Signed release manifests (9 Oct 2026). An installed copy must refuse any update
// the project's release key did not sign, even one served from the real repo. An
// ephemeral key in a temp dir stands in for the real one (never touched here), and
// the signing is the real code tools/package.mjs runs. Ephemeral ports only.
console.log('\n== update: signed release manifests ==');
{
  const os = await import('node:os');
  const crypto = await import('node:crypto');
  const http = await import('node:http');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { verifyManifest, manifestPayload, checkForUpdate } = await import('./update.js');
  const { createKeyFile, loadPrivateKey, signManifest, publicKeyInfo } = await import('../../tools/release-key.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-sig-'));
  try {
    const keyFile = path.join(tmp, 'keys', 'release-signing-key.pem');
    const pub = createKeyFile(keyFile);
    throws(() => createKeyFile(keyFile), 'an existing key file is never replaced without --force');
    const priv = loadPrivateKey(keyFile);
    eq(publicKeyInfo(priv).keyId, pub.keyId, 'the key file on disk is the key that was announced');
    const KEYS = [pub];
    const base = {
      version: '9.9.9', date: '2026-10-09', url: 'https://github.com/downstagehq/cleartoair/releases/download/v9.9.9/ClearToAir-win64-9.9.9.zip',
      sha256: 'ab'.repeat(32), size: 12345678, notes: 'test build', file: 'ClearToAir-win64-9.9.9.zip',
    };
    const signed = signManifest(base, priv);
    ok(verifyManifest(signed, KEYS).ok, 'a manifest signed by the release key is accepted');
    ok(signed.keyId === pub.keyId && /^[0-9a-f]{16}$/.test(signed.keyId) && Buffer.from(signed.sig, 'base64').length === 64, 'it carries the 16-hex keyId and a 64-byte r||s signature');
    ok(verifyManifest({ ...signed, notes: 'other words', date: '2030-01-01' }, KEYS).ok, 'notes and date are display text, not signed');
    ok(verifyManifest({ ...signed, sha256: signed.sha256.toUpperCase() }, KEYS).ok, 'the sha256 is signed lowercase, so its case does not matter');
    const TAMPER = [['url', 'https://evil.example/ClearToAir-win64-9.9.9.zip'], ['sha256', 'cd'.repeat(32)], ['version', '9.9.10'], ['size', 12345679], ['file', 'ClearToAir-win64-6.6.6.zip']];
    for (const [field, value] of TAMPER) {
      const r = verifyManifest({ ...signed, [field]: value }, KEYS);
      ok(!r.ok && r.error === 'signature does not match', `a tampered ${field} is refused`);
    }
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forged = signManifest(base, other.privateKey);
    ok(!verifyManifest(forged, KEYS).ok, 'a manifest signed by another key is refused');
    ok(!verifyManifest({ ...forged, keyId: signed.keyId }, KEYS).ok, 'and claiming the real keyId does not help');
    const { sig: _sig, ...noSig } = signed;
    ok(!verifyManifest(noSig, KEYS).ok, 'a manifest without a sig is refused');
    ok(!verifyManifest(base, KEYS).ok, 'an old-style unsigned manifest is refused');
    ok(!verifyManifest({ ...signed, sig: signed.sig.slice(0, -4) + 'AAA=' }, KEYS).ok, 'a malformed signature is refused');
    ok(!verifyManifest(signed, []).ok, 'a build without a release key accepts nothing');
    throws(() => manifestPayload({ ...base, url: 'https://x.example/a\nb' }), 'a newline in a signed field cannot be signed (no two manifests share a payload)');
    throws(() => manifestPayload({ ...base, url: 'http://x.example/a.zip' }), 'a plain-http url cannot be signed');
    throws(() => manifestPayload({ ...base, size: '12345678' }), 'size must be a JSON number');

    // The agent's /api/update path end to end: a manifest the built-in key did not
    // sign is never offered, however new it claims to be.
    const serve = (body) => new Promise((resolve) => {
      const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    for (const [label, body] of [['signed by a key this build does not carry', forged], ['unsigned', base]]) {
      const srv = await serve(body);
      const r = await checkForUpdate({ url: `http://127.0.0.1:${srv.address().port}/latest.json`, force: true });
      srv.close();
      ok(r.ok === false && r.available === false && r.latest === null && r.error === 'manifest signature invalid', `checkForUpdate refuses a manifest ${label} - ${r.detail || r.error}`);
    }

    // Cross-language: the launcher (C#, CNG) must accept exactly what Node signed. It
    // has the real key compiled in, so the test key goes in through --pubkey-x/-y.
    const LAUNCHER = fileURLToPath(new URL('../../tools/launcher/', import.meta.url));
    const exe = path.join(LAUNCHER, 'out', 'Clear to Air.exe');
    const stale = fs.existsSync(exe) && ['ClearToAir.cs', 'ReleaseKey.cs'].some((f) => fs.statSync(path.join(LAUNCHER, f)).mtimeMs > fs.statSync(exe).mtimeMs);
    if (process.platform !== 'win32' || !fs.existsSync(exe)) console.log('  SKIP launcher cross-check: needs Windows and tools/launcher/out/Clear to Air.exe (tools\\launcher\\build.cmd)');
    // An older exe without --verify-manifest would start the real tray app instead.
    else if (stale) console.log('  SKIP launcher cross-check: the exe is older than its source - rebuild with tools\\launcher\\build.cmd');
    else {
      let n = 0;
      const launcher = (m, keyArgs = ['--pubkey-x', pub.x, '--pubkey-y', pub.y], compact = false) => {
        const f = path.join(tmp, `manifest-${++n}.json`);
        fs.writeFileSync(f, compact ? JSON.stringify(m) : JSON.stringify(m, null, 2) + '\n');
        const r = spawnSync(exe, ['--verify-manifest', f, ...keyArgs], { encoding: 'utf8', timeout: 20000 });
        return { code: r.status, out: String(r.stdout || '').trim() };
      };
      eq(launcher(signed), { code: 0, out: 'OK' }, 'the compiled launcher accepts the Node-signed manifest');
      eq(launcher(signed, undefined, true), { code: 0, out: 'OK' }, 'compact JSON too');
      for (const [field, value] of TAMPER) {
        const r = launcher({ ...signed, [field]: value });
        ok(r.code === 1 && r.out.startsWith('FAIL'), `the launcher refuses a tampered ${field} - ${r.out}`);
      }
      const wrong = launcher(forged);
      ok(wrong.code === 1 && /unknown key/.test(wrong.out), `the launcher refuses another key - ${wrong.out}`);
      const claim = launcher({ ...forged, keyId: signed.keyId });
      ok(claim.code === 1 && /does not match/.test(claim.out), `even under the real keyId - ${claim.out}`);
      const bare = launcher(noSig);
      ok(bare.code === 1 && /not signed/.test(bare.out), `the launcher refuses a manifest without a sig - ${bare.out}`);
      const builtIn = launcher(signed, []);
      ok(builtIn.code === 1 && /unknown key/.test(builtIn.out), `without the test-key override the built-in key does not accept a test signature - ${builtIn.out}`);
      const half = launcher(signed, ['--pubkey-x', pub.x]);
      ok(half.code === 1, 'a lone --pubkey-x is refused');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Show-day fixes (0.3.1): adapters come back after a restart, preflight warns when
// a game feed exists but nothing is running, Install writes the GSI cfg itself, and
// "Record raw game data". Temp dirs only: nothing here touches agent/data.
{
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const pathToFileURLHref = (p) => pathToFileURL(p).href;
  const { createRegistry, loadRunning, publicConfig } = await import('./registry.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-showday-'));
  const liveLog = [];
  const fakeState = (st = defaultState()) => ({ get: () => st, setLive: (p) => liveLog.push(p), resetLive: () => {}, patch: () => {}, revision: () => 1 });
  const hub = { broadcast: () => {} };
  try {
    console.log('\n== registry: adapters come back after a restart ==');
    // A fake adapter folder: two live adapters that count their starts, one that cannot start.
    const dir = path.join(tmp, 'adapters');
    fs.mkdirSync(dir);
    const fake = (id, extra = '') => `export const id = '${id}'; export const games = ['cs2']; export const label = '${id} label';
      export const starts = []; ${extra}
      export function create() { let on = false; return { start: async (cfg) => { starts.push(cfg); on = true; }, stop: async () => { on = false; }, status: () => ({ connected: on, detail: '' }) }; }`;
    fs.writeFileSync(path.join(dir, 'feeda.js'), fake('feeda'));
    fs.writeFileSync(path.join(dir, 'feedb.js'), fake('feedb'));
    fs.writeFileSync(path.join(dir, 'broken.js'), `export const id = 'broken'; export const games = ['cs2'];
      export function create() { return { start: async () => { throw Object.assign(new Error('listen EADDRINUSE 127.0.0.1:7701'), { code: 'EADDRINUSE' }); }, stop: async () => {}, status: () => ({ connected: false }) }; }`);
    const runningFile = path.join(tmp, 'data', 'adapters.json');
    const opts = { state: fakeState(), hub, adaptersDir: dir, simDir: path.join(tmp, 'no-sims'), runningFile, captureDir: path.join(tmp, 'captures') };

    const r1 = createRegistry(opts);
    await r1.load();
    await r1.startAdapter('feeda', { config: { mode: 'observer', gsiToken: 'secret-1', apiKey: 'k', nested: { x: 1 } } });
    await r1.startAdapter('feedb');
    let threw = false; try { await r1.startAdapter('broken'); } catch { threw = true; }
    ok(threw && !('broken' in loadRunning(runningFile)), 'a Start that fails (port taken) is not remembered');
    eq(Object.keys(loadRunning(runningFile)).sort(), ['feeda', 'feedb'], 'an operator Start is written to adapters.json');
    eq(loadRunning(runningFile).feeda.config, { mode: 'observer' }, 'only the non-secret, plain start config is kept (no token, no key, no objects)');
    ok(!fs.readFileSync(runningFile, 'utf8').includes('secret-1'), 'the token never reaches the file');
    await r1.stopAdapter('feedb');
    eq(Object.keys(loadRunning(runningFile)), ['feeda'], 'an operator Stop takes it off the list');
    await r1.stopAll();
    eq(Object.keys(loadRunning(runningFile)), ['feeda'], 'shutting down leaves the list alone, so it comes back');

    // "The agent restarted": a new registry over the same file.
    const r2 = createRegistry(opts);
    await r2.load();
    eq(r2.runningAdapters(), [], 'nothing runs before restore()');
    const back = await r2.restore();
    eq(back.restored, ['feeda'], 'restore() starts what the operator had running');
    eq(r2.runningAdapters(), ['feeda'], 'and only that: feedb was stopped by the operator, broken never ran');
    const mod = await import(pathToFileURLHref(path.join(dir, 'feeda.js')));
    eq(mod.starts.at(-1), { mode: 'observer' }, 'with its non-secret config');
    await r2.stopAll();

    fs.writeFileSync(runningFile, JSON.stringify({ running: { broken: { startedAt: 1 }, gone: { startedAt: 1 }, '../x': { startedAt: 1 } } }));
    const r3 = createRegistry(opts);
    await r3.load();
    const bad = await r3.restore();
    ok(bad.restored.length === 0 && bad.failed.map((f) => f.id).sort().join() === 'broken,gone', `a restore that fails is a log line, not a crash (${bad.failed.map((f) => `${f.id}: ${f.error}`).join('; ')})`);
    ok('broken' in loadRunning(runningFile) && !('../x' in loadRunning(runningFile)), 'it stays on the list for the next boot; a junk id is ignored');
    eq(publicConfig({ port: 7701, password: 'x', obsPassword: 'y', ok: true, list: [1] }), { port: 7701, ok: true }, 'publicConfig drops secret-named keys and non-plain values');
    fs.writeFileSync(runningFile, '{not json');
    eq(loadRunning(runningFile), {}, 'an unreadable adapters.json restores nothing (and never throws)');

    console.log('\n== preflight: a game feed exists but nothing is running ==');
    const { createPreflight } = await import('./preflight.js');
    const real = createRegistry({ state: fakeState(), hub, runningFile: path.join(tmp, 'real.json'), captureDir: path.join(tmp, 'captures') });
    await real.load();   // the shipped adapters; create() binds nothing
    eq(real.feedsFor('cs2').map((f) => f.id), ['cs2gsi'], 'CS2 has one live feed (not Manual, not the start.gg importer)');
    eq(real.feedsFor('valorant'), [], 'Valorant has none');
    const pf = async (game, running) => {
      const st = { ...defaultState(), game, event: { ...defaultState().event, name: 'Test Cup' } };
      st.live = { ...st.live, source: 'manual', updatedAt: 0 };
      const reg = { runningAdapters: () => running, runningSims: () => [], feedsFor: (g) => real.feedsFor(g) };
      const p = createPreflight({ state: fakeState(st), hub: { broadcast: () => {}, overlayPages: () => ({}), overlayCount: () => 0 }, bridge: { status: () => ({ connected: false }) },
        packs: { get: (id) => PACKS[id] || null }, registry: reg, watchdog: null, port: 7700 });
      const out = await p.run();
      return { check: out.checks.find((c) => c.id === 'adapter-live'), out };
    };
    const cold = await pf('cs2', []);
    eq(cold.check.level, 'warn', 'CS2 with no adapter running is a WARNING now, not a pass (the green lamp with no data)');
    ok(/CS2 Game State Integration/.test(cold.check.title) && /^Data tab → CS2 Game State Integration → Start/.test(cold.check.fix), `the fix names the tab, the card and the button: "${cold.check.fix}"`);
    ok(cold.out.warns >= 1, 'it counts as a warning, so the lamp is amber (fail > warn > ok)');
    eq((await pf('cs2', ['manual'])).check.level, 'ok', 'the operator chose Manual on purpose -> ok');
    eq((await pf('valorant', [])).check.level, 'ok', 'a title with no live feed -> ok, scores follow the Match tab');
    eq((await pf('cs2', ['cs2gsi'])).check.level, 'warn', 'running but silent is still the old warning');

    console.log('\n== install: write the GSI cfg, or say where it looked ==');
    const where = { dir: path.join(tmp, 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg') };
    const inst = createRegistry({ state: fakeState(), hub, runningFile: path.join(tmp, 'i.json'), captureDir: path.join(tmp, 'captures'),
      findCfgDir: (g) => (where.found ? { ok: true, dir: where.dir, tried: [where.dir] } : { ok: false, tried: ['C:\\Steam\\steamapps\\libraryfolders.vdf', where.dir], reason: `${g.name} was not found in any Steam library` }) });
    await inst.load();
    ok(inst.adapters().find((a) => a.id === 'cs2gsi').autoInstall === true && inst.adapters().find((a) => a.id === 'dota2gsi').autoInstall === true, 'CS2 and Dota 2 Install write the file (autoInstall)');
    ok(!inst.adapters().find((a) => a.id === 'lolclient').autoInstall, 'LoL has nothing to write');
    const miss = inst.writeInstall('cs2gsi');
    ok(!miss.ok && !miss.found && miss.tried.length === 2 && miss.files[0].path === 'gamestate_integration_cleartoair.cfg' && /BOM/.test(miss.instructions), 'CS2 not found -> the text, Copy-able, plus every path it tried');
    where.found = true;
    fs.mkdirSync(where.dir, { recursive: true });
    const hit = inst.writeInstall('cs2gsi');
    const onDisk = fs.readFileSync(path.join(where.dir, 'gamestate_integration_cleartoair.cfg'));
    ok(hit.ok && hit.written && onDisk[0] !== 0xef && onDisk.toString('utf8').startsWith('"Clear to Air"') && /Restart CS2/.test(hit.restart), `found -> written without a BOM (${hit.path})`);
    ok(inst.writeInstall('cs2gsi').unchanged === true, 'pressing Install again changes nothing');
    let refused = false; try { inst.writeInstall('lolclient'); } catch (e) { refused = e.status === 400; }
    ok(refused, 'an adapter with no file to write is refused (400), not guessed at');

    console.log('\n== record raw game data ==');
    const { createCaptures, stripSecrets, secretsFrom, localDate, REMOVED } = await import('./capture.js');
    const st = defaultState();
    st.settings.gsiToken = 'gsi-tok-123';
    st.settings.obsPassword = 'obs-pass-456';
    const stripped = stripSecrets({ auth: { token: 'gsi-tok-123' }, provider: { name: 'x' }, deep: [{ password: 'p', note: 'leak obs-pass-456 here' }], Token: 5, apiKey: 'k' }, secretsFrom(st));
    eq(stripped.auth.token, REMOVED, 'the GSI auth.token is removed');
    eq(stripped.deep[0], { password: REMOVED, note: `leak ${REMOVED} here` }, 'secret-named keys at any depth, and any secret the agent holds, wherever it appears');
    eq([stripped.Token, stripped.apiKey, stripped.provider.name], [REMOVED, REMOVED, 'x'], 'case-insensitive key names; everything else untouched');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(localDate()), 'files are named by the local date');

    const capDir = path.join(tmp, 'cap');
    const caps = createCaptures({ dir: capDir, version: '0.3.1', getState: () => st, maxBytes: 4096 });
    eq(caps.status('cs2gsi').on, false, 'off by default');
    caps.start('cs2gsi', 'cs2');
    for (let i = 0; i < 3; i++) caps.write('cs2gsi', { auth: { token: 'gsi-tok-123' }, map: { name: 'de_mirage', round: i }, provider: { appid: 730 } });
    ok(caps.write('dota2gsi', { x: 1 }) === false, 'an adapter that is not recording writes nothing');
    const s1 = caps.status('cs2gsi');
    ok(s1.on && s1.payloads === 3 && path.basename(s1.file) === `cs2-${localDate()}.jsonl`, `status says where and how much (${path.basename(s1.file)}, ${s1.bytes} B, ${s1.payloads} payloads)`);
    caps.stop('cs2gsi', 'switched off');
    await caps.flushed();
    const lines = fs.readFileSync(s1.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(lines[0].type === 'capture' && lines[0].adapter === 'cs2gsi' && lines[0].cleartoair === '0.3.1' && /anonymise/.test(lines[0].note), 'first line: adapter, Clear to Air version and what to anonymise (the "Real payload" template)');
    ok(lines.slice(1).every((l, i) => l.type === 'payload' && !Number.isNaN(Date.parse(l.t)) && l.payload.map.round === i), 'then one timestamped line per payload, as received, in order');
    ok(!fs.readFileSync(s1.file, 'utf8').includes('gsi-tok-123'), 'the token is not in the file');

    caps.start('cs2gsi', 'cs2');
    let n = 0;
    while (caps.write('cs2gsi', { blob: 'x'.repeat(300), n })) n++;
    const capped = caps.status('cs2gsi');
    ok(!capped.on && /limit/.test(capped.reason) && capped.bytes <= 4096, `stops itself at the size limit and says why (${capped.bytes} B, "${capped.reason}")`);
    await caps.flushed();
    ok(fs.statSync(capped.file).size <= 4096, 'the file on disk is within the limit');
    caps.start('cs2gsi', 'cs2');
    ok(caps.status('cs2gsi').file !== capped.file && /-2\.jsonl$/.test(caps.status('cs2gsi').file), 'the next recording that day starts a new file rather than growing a full one');
    caps.closeAll();
    await caps.flushed();

    const rc = createRegistry({ state: fakeState(st), hub, runningFile: path.join(tmp, 'c.json'), captureDir: path.join(tmp, 'rcap') });
    await rc.load();
    ok(rc.adapters().find((a) => a.id === 'cs2gsi').capturable && !('capture' in rc.adapters().find((a) => a.id === 'cs2gsi')), 'the adapter list says it can record, but never where (that list reaches remote seats)');
    eq(rc.setCapture('cs2gsi', true).on, true, 'switch on through the registry');
    let notCap = false; try { rc.setCapture('manual', true); } catch (e) { notCap = e.status === 400; }
    ok(notCap, 'the Manual adapter has nothing to record (400)');
    rc.setCapture('cs2gsi', false);
    await rc.stopAll();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n== remote seats cannot reach the show-day routes ==');
  const { allow } = await import('./remote-policy.js');
  const PRODUCER = { id: 's1', name: 'Guest', role: 'producer' };
  const ALL_CAPS = { caps: { streamControl: true } };
  for (const [m, p] of [['POST', '/api/adapters/cs2gsi/install'], ['GET', '/api/adapters/cs2gsi/install'], ['POST', '/api/adapters/dota2gsi/install'],
    ['POST', '/api/adapters/cs2gsi/capture'], ['GET', '/api/adapters/cs2gsi/capture'], ['POST', '/api/adapters/cs2gsi/start'], ['POST', '/api/adapters/cs2gsi/stop']]) {
    const r = allow(PRODUCER, m, p, ALL_CAPS);
    ok(!r.ok && r.status === 403, `a producer seat, every cap on, cannot ${m} ${p}`);
  }

  console.log('\n== log: console lines in local time ==');
  const { localClock } = await import('./log.js');
  const d = new Date(2026, 9, 25, 9, 5, 7);
  eq(localClock(d), '09:05:07', 'HH:MM:SS on this PC\'s clock, the same clock as the launcher\'s own stamp in launcher.log');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
process.exit(failures ? 1 : 0);
