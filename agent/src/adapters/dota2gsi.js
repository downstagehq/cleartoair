// dota2gsi.js — Dota 2 Game State Integration receiver (HTTP :7702).
// Sanctioned by Valve. Requires the `-gamestateintegration` launch option and the cfg in
// game\dota\cfg\gamestate_integration\. In spectator mode the payload carries per-team dicts:
// player.team2/team3, hero.team2/team3, items.team2/team3 (team2 = Radiant, team3 = Dire), keyed
// player0..4 under team2 and player5..9 under team3.
// `player.team_name` is the SIDE ('radiant' / 'dire'), not the organisation. Real org names only arrive in the
// `league` block (league.radiant.name / league.dire.name) when spectating a league match with "league" "1".

import { createGsiServer, gsiStatus, resolveToken, resolveOpts } from './_gsi.js';
import { normalize, pushEvent, fmtClock } from './_normalize.js';

export const id = 'dota2gsi';
export const games = ['dota2'];
export const label = 'Dota 2 Game State Integration';
export const describe = 'Listens on :7702 for POSTs from gamestate_integration_cleartoair.cfg (needs -gamestateintegration)';
// Where Install writes the cfg (see _steam.js): Steam app 570, <library>\steamapps\common\<installdir>\game\dota\cfg\gamestate_integration\
// game\dota\cfg must exist; the gamestate_integration folder is created if it is not there yet.
export const steam = { appId: 570, name: 'Dota 2', installDir: 'dota 2 beta', cfgDir: ['game', 'dota', 'cfg', 'gamestate_integration'], createLast: true,
  restart: 'Check the -gamestateintegration launch option (Steam > Dota 2 > Properties > Launch Options), then restart Dota 2.' };
// "Record raw game data" is offered on the Data tab (registry.js / capture.js).
export const capturable = true;

const HERO_NAMES = {
  antimage: 'Anti-Mage', axe: 'Axe', bane: 'Bane', bloodseeker: 'Bloodseeker', crystal_maiden: 'Crystal Maiden', drow_ranger: 'Drow Ranger',
  earthshaker: 'Earthshaker', juggernaut: 'Juggernaut', mirana: 'Mirana', morphling: 'Morphling', nevermore: 'Shadow Fiend',
  phantom_lancer: 'Phantom Lancer', puck: 'Puck', pudge: 'Pudge', razor: 'Razor', sand_king: 'Sand King', storm_spirit: 'Storm Spirit',
  sven: 'Sven', tiny: 'Tiny', vengefulspirit: 'Vengeful Spirit', windrunner: 'Windranger', zuus: 'Zeus', kunkka: 'Kunkka', lina: 'Lina',
  lion: 'Lion', shadow_shaman: 'Shadow Shaman', slardar: 'Slardar', tidehunter: 'Tidehunter', witch_doctor: 'Witch Doctor', lich: 'Lich',
  riki: 'Riki', enigma: 'Enigma', tinker: 'Tinker', sniper: 'Sniper', necrolyte: 'Necrophos', warlock: 'Warlock', beastmaster: 'Beastmaster',
  queenofpain: 'Queen of Pain', venomancer: 'Venomancer', faceless_void: 'Faceless Void', skeleton_king: 'Wraith King', death_prophet: 'Death Prophet',
  phantom_assassin: 'Phantom Assassin', pugna: 'Pugna', templar_assassin: 'Templar Assassin', viper: 'Viper', luna: 'Luna', dragon_knight: 'Dragon Knight',
  dazzle: 'Dazzle', rattletrap: 'Clockwerk', leshrac: 'Leshrac', furion: "Nature's Prophet", life_stealer: 'Lifestealer', dark_seer: 'Dark Seer',
  clinkz: 'Clinkz', omniknight: 'Omniknight', enchantress: 'Enchantress', huskar: 'Huskar', night_stalker: 'Night Stalker', broodmother: 'Broodmother',
  bounty_hunter: 'Bounty Hunter', weaver: 'Weaver', jakiro: 'Jakiro', batrider: 'Batrider', chen: 'Chen', spectre: 'Spectre', ancient_apparition: 'Ancient Apparition',
  doom_bringer: 'Doom', ursa: 'Ursa', spirit_breaker: 'Spirit Breaker', gyrocopter: 'Gyrocopter', alchemist: 'Alchemist', invoker: 'Invoker',
  silencer: 'Silencer', obsidian_destroyer: 'Outworld Destroyer', lycan: 'Lycan', brewmaster: 'Brewmaster', shadow_demon: 'Shadow Demon',
  lone_druid: 'Lone Druid', chaos_knight: 'Chaos Knight', meepo: 'Meepo', treant: 'Treant Protector', ogre_magi: 'Ogre Magi', undying: 'Undying',
  rubick: 'Rubick', disruptor: 'Disruptor', nyx_assassin: 'Nyx Assassin', naga_siren: 'Naga Siren', keeper_of_the_light: 'Keeper of the Light',
  wisp: 'Io', visage: 'Visage', slark: 'Slark', medusa: 'Medusa', troll_warlord: 'Troll Warlord', centaur: 'Centaur Warrunner', magnataur: 'Magnus',
  shredder: 'Timbersaw', bristleback: 'Bristleback', tusk: 'Tusk', skywrath_mage: 'Skywrath Mage', abaddon: 'Abaddon', elder_titan: 'Elder Titan',
  legion_commander: 'Legion Commander', techies: 'Techies', ember_spirit: 'Ember Spirit', earth_spirit: 'Earth Spirit', abyssal_underlord: 'Underlord',
  terrorblade: 'Terrorblade', phoenix: 'Phoenix', oracle: 'Oracle', winter_wyvern: 'Winter Wyvern', arc_warden: 'Arc Warden', monkey_king: 'Monkey King',
  dark_willow: 'Dark Willow', pangolier: 'Pangolier', grimstroke: 'Grimstroke', hoodwink: 'Hoodwink', void_spirit: 'Void Spirit', snapfire: 'Snapfire',
  mars: 'Mars', dawnbreaker: 'Dawnbreaker', marci: 'Marci', primal_beast: 'Primal Beast', muerta: 'Muerta', kez: 'Kez', ringmaster: 'Ringmaster',
};
export function prettyHero(name) {
  if (!name) return '';
  const n = String(name).replace(/^npc_dota_hero_/, '');
  return HERO_NAMES[n] || n.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const STATE_PHASE = {
  DOTA_GAMERULES_STATE_INIT: 'warmup', DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: 'warmup', DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD: 'warmup',
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'draft', DOTA_GAMERULES_STATE_STRATEGY_TIME: 'draft', DOTA_GAMERULES_STATE_TEAM_SHOWCASE: 'draft',
  DOTA_GAMERULES_STATE_PRE_GAME: 'freezetime', DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'live',
  DOTA_GAMERULES_STATE_POST_GAME: 'gameover', DOTA_GAMERULES_STATE_DISCONNECT: 'unknown',
};

function teamDict(block, teamKey) {
  const d = block?.[teamKey];
  return d && typeof d === 'object' ? d : null;
}

function parseDraft(draft) {
  if (!draft || typeof draft !== 'object') return null;
  const side = (t) => {
    const out = { picks: [], bans: [] };
    const d = draft[t] || {};
    for (let i = 0; i < 10; i++) {
      if (d[`pick${i}_class`]) out.picks.push({ id: d[`pick${i}_id`], hero: prettyHero(d[`pick${i}_class`]) });
      if (d[`ban${i}_class`]) out.bans.push({ id: d[`ban${i}_id`], hero: prettyHero(d[`ban${i}_class`]) });
    }
    return out;
  };
  return {
    activeTeam: draft.activeteam === 2 ? 'RADIANT' : draft.activeteam === 3 ? 'DIRE' : null,
    pick: !!draft.pick, timeRemaining: draft.activeteam_time_remaining,
    radiantBonusTime: draft.radiant_bonus_time, direBonusTime: draft.dire_bonus_time,
    radiant: side('team2'), dire: side('team3'),
  };
}

/** Pure parser: GSI payload -> raw report. */
export function parsePayload(p, ctx = { events: [], prev: {} }) {
  const map = p.map || {};
  const events = ctx.events;
  let phase = STATE_PHASE[map.game_state] || 'unknown';
  if (map.paused && phase === 'live') phase = 'paused';
  const clockSeconds = Number(map.clock_time ?? map.game_time ?? 0);

  const players = [];
  // Org names: league.radiant/dire.name (league matches only). pl.team_name is just 'radiant'/'dire' and is
  // only kept when it is something else (a custom lobby that sets real names).
  const league = p.league && typeof p.league === 'object' ? p.league : {};
  const orgName = (o) => (o && typeof o === 'object' ? (o.name || o.team_name || o.tag || '') : '');
  const teamNames = { RADIANT: orgName(league.radiant), DIRE: orgName(league.dire) };
  const isSideWord = (n) => /^(radiant|dire|team ?[23])$/i.test(String(n || '').trim());
  for (const [teamKey, sideKey] of [['team2', 'RADIANT'], ['team3', 'DIRE']]) {
    const pd = teamDict(p.player, teamKey);
    const hd = teamDict(p.hero, teamKey) || {};
    const idd = teamDict(p.items, teamKey) || {};
    if (!pd) continue;
    for (const [slot, pl] of Object.entries(pd)) {
      const hero = hd[slot] || {};
      const items = idd[slot] || {};
      if (pl.team_name && !teamNames[sideKey] && !isSideWord(pl.team_name)) teamNames[sideKey] = pl.team_name;
      const inv = Object.entries(items).filter(([k, v]) => k.startsWith('slot') && v?.name && v.name !== 'empty').map(([, v]) => v.name.replace(/^item_/, ''));
      // Aegis sits in the inventory/stash as item_aegis; check every item slot (slot*, stash*, teleport*, neutral*).
      const aegis = Object.values(items).some(v => v?.name === 'item_aegis');
      players.push({
        team: sideKey, name: pl.name || slot, champion: prettyHero(hero.name),
        hp: Number(hero.health ?? 0), armor: 0, money: Number(pl.gold ?? 0),
        kills: Number(pl.kills ?? 0), deaths: Number(pl.deaths ?? 0), assists: Number(pl.assists ?? 0),
        alive: hero.alive !== false && Number(hero.health ?? 1) > 0, score: Number(pl.net_worth ?? 0),
        extra: { slot, steamid: pl.steamid, level: hero.level ?? 0, maxHp: hero.max_health ?? 0, mana: hero.mana ?? 0, maxMana: hero.max_mana ?? 0,
          respawnSeconds: hero.respawn_seconds ?? 0, lastHits: pl.last_hits ?? 0, denies: pl.denies ?? 0, gpm: pl.gpm ?? 0, xpm: pl.xpm ?? 0,
          netWorth: pl.net_worth ?? 0, items: inv, scepter: !!hero.aghanims_scepter, shard: !!hero.aghanims_shard, aegis },
      });
    }
  }
  // Single-player (non-spectator) payload fallback
  if (!players.length && p.player && p.hero && p.player.team_name) {
    const pl = p.player, hero = p.hero;
    const sideKey = String(pl.team_name).toLowerCase() === 'dire' ? 'DIRE' : 'RADIANT';
    const aegis = Object.values(p.items || {}).some(v => v?.name === 'item_aegis');
    players.push({ team: sideKey, name: pl.name, champion: prettyHero(hero.name), hp: Number(hero.health ?? 0), money: Number(pl.gold ?? 0),
      kills: Number(pl.kills ?? 0), deaths: Number(pl.deaths ?? 0), assists: Number(pl.assists ?? 0), alive: hero.alive !== false, score: Number(pl.net_worth ?? 0),
      extra: { level: hero.level ?? 0, lastHits: pl.last_hits ?? 0, denies: pl.denies ?? 0, gpm: pl.gpm ?? 0, xpm: pl.xpm ?? 0,
        scepter: !!hero.aghanims_scepter, shard: !!hero.aghanims_shard, aegis } });
  }

  const sides = {
    left: { key: 'RADIANT', name: teamNames.RADIANT || 'Radiant', score: Number(map.radiant_score ?? 0), aliases: ['radiant', 'team2', '2'], tag: league.radiant?.tag, seriesWins: league.radiant?.series_wins },
    right: { key: 'DIRE', name: teamNames.DIRE || 'Dire', score: Number(map.dire_score ?? 0), aliases: ['dire', 'team3', '3'], tag: league.dire?.tag, seriesWins: league.dire?.series_wins },
  };
  const netWorth = { RADIANT: 0, DIRE: 0 };
  for (const pl of players) netWorth[pl.team] += Number(pl.extra?.netWorth || 0);

  // Events
  const prev = ctx.prev;
  if (prev.rs != null && map.radiant_score > prev.rs) pushEvent(events, 'kill', `${sides.left.name} kill (${map.radiant_score})`);
  if (prev.ds != null && map.dire_score > prev.ds) pushEvent(events, 'kill', `${sides.right.name} kill (${map.dire_score})`);
  if (map.roshan_state && map.roshan_state !== prev.rosh) {
    if (map.roshan_state === 'alive' && prev.rosh) pushEvent(events, 'roshan', 'Roshan has respawned');
    else if (map.roshan_state !== 'alive') pushEvent(events, 'roshan', 'Roshan slain');
  }
  if (map.game_state !== prev.gs) {
    if (phase === 'live') pushEvent(events, 'match_start', 'Horn — game in progress');
    if (phase === 'gameover') pushEvent(events, 'match_end', `${map.win_team === 'dire' ? sides.right.name : map.win_team === 'radiant' ? sides.left.name : 'Game'} wins`);
    if (phase === 'draft') pushEvent(events, 'draft', 'Draft phase');
  }
  // "events" "1" block: a list of recent game events. Only the aegis ones are surfaced (Roshan is covered by
  // map.roshan_state above); deduped by game_time + type because the game repeats the list across payloads.
  ctx.seenEvents ||= new Set();
  const nameById = (pid) => players.find(pl => pl.extra?.slot === `player${pid}`)?.name || `player ${pid}`;
  for (const e of Array.isArray(p.events) ? p.events : []) {
    const key = `${e?.game_time}:${e?.event_type}:${e?.player_id ?? ''}`;
    if (!e || ctx.seenEvents.has(key)) continue;
    ctx.seenEvents.add(key);
    if (e.event_type === 'aegis_picked_up') pushEvent(events, 'info', `${nameById(e.player_id)} ${e.snatched ? 'snatched' : 'picked up'} the Aegis`);
    else if (e.event_type === 'aegis_denied') pushEvent(events, 'info', `${nameById(e.player_id)} denied the Aegis`);
  }
  if (ctx.seenEvents.size > 500) ctx.seenEvents = new Set([...ctx.seenEvents].slice(-200));
  ctx.prev = { rs: map.radiant_score, ds: map.dire_score, rosh: map.roshan_state, gs: map.game_state };

  return {
    source: id, connected: true, phase, round: 0, clock: fmtClock(clockSeconds, { showSign: true }), clockSeconds,
    overtime: false, mapName: map.name === 'start' ? 'Dota 2' : (map.name || 'Dota 2'), sides, players, bomb: null, ball: null, events: [...events],
    extra: {
      gameState: map.game_state, paused: !!map.paused, daytime: map.daytime, winTeam: map.win_team, matchId: map.matchid,
      // radiant_win_chance is unconfirmed in live payloads: omitted (undefined) when the game does not send it.
      radiantWinChance: Number.isFinite(Number(map.radiant_win_chance)) && map.radiant_win_chance !== '' && map.radiant_win_chance != null ? Number(map.radiant_win_chance) : undefined,
      league: league.league_id != null || league.name ? { id: league.league_id, name: league.name, seriesType: league.series_type } : undefined,
      roshan: { state: map.roshan_state, endsIn: map.roshan_state_end_seconds },
      netWorth, draft: parseDraft(p.draft), wardCooldown: map.ward_purchase_cooldown, spectating: p.provider?.name,
    },
  };
}

export function create({ config, emit, log, state, getState, capture } = {}) {
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const port = o.port('dota2gsi', 7702);
  const host = o.host('gsi');
  const ctx = { events: [], prev: {} };
  let last = null;
  const srv = createGsiServer({
    port, host, tag: id, log, capture,
    getToken: () => resolveToken({ config, getState }),
    onPayload: (p) => { const raw = parsePayload(p, ctx); last = raw; emit?.(normalize(raw, getState?.())); },
  });
  return {
    start: async () => { await srv.start(); },
    stop: async () => { await srv.stop(); emit?.({ source: id, connected: false }); },
    status: () => gsiStatus(srv, 15_000, last ? `${last.sides.left.score}-${last.sides.right.score} ${last.clock} ${last.phase}` : ''),
    parse: (p) => parsePayload(p, ctx),
  };
}

export function install({ config, state, getState } = {}) {
  const o = resolveOpts({ config, state, getState });
  const port = o.port('dota2gsi', 7702);
  const token = resolveToken({ config, getState: o.getState });
  const content = `"Clear to Air"
{
  "uri"       "http://127.0.0.1:${port}/"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.1"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider"  "1"
    "map"       "1"
    "player"    "1"
    "hero"      "1"
    "abilities" "1"
    "items"     "1"
    "draft"     "1"
    "league"    "1"
    "events"    "1"
    "wearables" "0"
    "buildings" "1"
  }
}
`;
  return {
    files: [{ path: 'gamestate_integration_cleartoair.cfg', content }],
    instructions: [
      `1. Install saves this file for you. To save it by hand instead, save gamestate_integration_cleartoair.cfg into:`,
      `   <Steam>\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\gamestate_integration\\`,
      `   (create the gamestate_integration folder if it does not exist).`,
      `2. Add the launch option  -gamestateintegration  in Steam > Dota 2 > Properties > Launch Options. Without it nothing is sent.`,
      `3. Restart Dota 2, start the dota2gsi adapter (http://127.0.0.1:${port}/) and spectate the match (or watch via DotaTV)`,
      `   so the per-team player/hero/items dicts (team2 = Radiant, team3 = Dire) are included.`,
      `   Organisation names come from the "league" block, which the game only fills when spectating a league match;`,
      `   otherwise the sides show as Radiant / Dire and the control room's team names are used.`,
      `4. Token "${token}" is the current settings.gsiToken. If it is changed or regenerated, press Install again`,
      `   and restart Dota 2. Save the file WITHOUT a UTF-8 BOM. The spectating client must run on this PC for now.`,
    ].join('\n'),
  };
}
