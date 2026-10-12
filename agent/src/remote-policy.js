// What a remote seat may do, and what it may see. Pure functions, no I/O: this
// is the file to read (and the file the tests hammer) when asking "can a
// producer on a laptop across the venue start the stream?".
//
// Three rules shape everything here:
//
//  1. The AGENT decides, never the relay. The relay is a dumb pipe on someone
//     else's computer; it says which seat a request came from and nothing more.
//     Every allow/deny below runs on the broadcast PC.
//  2. A secret never leaves the PC. /api/state carries the OBS password, the GSI
//     token, the start.gg token and the VDO.Ninja password - the whole reason the
//     local API refuses cross-site callers (http.js). Redaction here is not a UI
//     nicety; it is the thing that makes a hosted control room safe at all.
//  3. Deny by default. A route that is not listed is refused, so a new endpoint
//     added later is unreachable from the internet until someone puts it on the
//     list on purpose.

/** Dot-paths in state that a remote seat must never read. */
export const SECRET_PATHS = [
  'settings.obsPassword',
  'settings.gsiToken',
  'settings.startggToken',
  'settings.vdo.password',
  // The talent TURN server (agent/src/talent.js). Its credentials reach a
  // talent seat only as short-lived ICE config on that seat's own signaling
  // socket - never through /api/state, the hub, or any other seat.
  'settings.talent.turn.username',
  'settings.talent.turn.credential',
  'settings.talent.turn.secret',
];

// --- talent seats ------------------------------------------------------------
// A talent seat is a caster's phone or laptop. It may load the join page and
// open the signaling socket for the ONE slot its invite was minted for (the
// binding is kept by remote.js on this PC, never taken from the relay or the
// page). It reads nothing of the desk: no /api, no hub, no packs, no other
// overlay, no other slot.
export const TALENT_PAGE = '/overlays/talent/join.html';
export const TALENT_SOCKET = '/talent/signaling';
const TALENT_RULES = [
  { m: 'GET', re: /^\/overlays\/talent\/join\.html$/ },
];

/** Top-level state keys a remote seat may never write, whatever its role.
 *  settings holds the secrets and the OBS connection; live is the adapters' own
 *  output and a patch would fight the game feed. */
export const PATCH_DENY = ['settings', 'live'];

/** A scorer is at the desk to keep the score, not to re-dress the show. */
export const SCORER_PATCH_ALLOW = [
  'series', 'veto', 'draft', 'standings', 'set', 'matchStats', 'stats', 'teams', 'rundown',
];

// Route rules, in order. The first whose method and pattern match decides.
// `roles` is who may call it; `cap` names a capability the operator can switch
// off on the broadcast PC (see remote.js / state.settings is NOT used - the
// toggle lives in agent/data/remote.json, out of reach of a state patch).
const RULES = [
  // --- read-only, every seat -------------------------------------------------
  { m: 'GET', re: /^\/healthz$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/state$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/packs$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/obs$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/preflight$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/log$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/adapters$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/sims$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/version$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/talent$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/game\/rundown$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/rehearse$/, roles: ['producer', 'scorer', 'viewer'] },
  { m: 'GET', re: /^\/api\/remote\/me$/, roles: ['producer', 'scorer', 'viewer'] },
  // Team logos and player photos the hosted room draws. Read-only files under
  // packs/, which is why the tunnel serves static GETs at all.
  { m: 'GET', re: /^\/packs\/[A-Za-z0-9_-]+\/(assets|overlay)\/[\w./-]+$/, roles: ['producer', 'scorer', 'viewer'] },
  // Program and preview thumbnails. Capped and re-encoded as JPEG before it
  // goes down the tunnel (see shotQuery) - a 640px PNG of a game scene is most
  // of a megabyte, twice every four seconds.
  { m: 'GET', re: /^\/api\/obs\/shot$/, roles: ['producer', 'scorer', 'viewer'] },

  // --- the desk -------------------------------------------------------------
  { m: 'POST', re: /^\/api\/state$/, roles: ['producer', 'scorer'] },
  { m: 'POST', re: /^\/api\/state\/undo$/, roles: ['producer'] },
  { m: 'POST', re: /^\/api\/log$/, roles: ['producer', 'scorer'] },
  { m: 'POST', re: /^\/api\/preflight\/run$/, roles: ['producer'] },
  { m: 'POST', re: /^\/api\/stats\/ocr$/, roles: ['producer', 'scorer'] },
  { m: 'GET', re: /^\/api\/liquipedia\/team$/, roles: ['producer', 'scorer'] },
  { m: 'POST', re: /^\/api\/liquipedia\/team$/, roles: ['producer', 'scorer'] },

  // --- the air --------------------------------------------------------------
  // Cutting, arming and the graphics are what a remote producer is for.
  { m: 'POST', re: /^\/api\/obs\/(scene|preview|take|item|refresh|reload|mute)$/, roles: ['producer'] },
  { m: 'POST', re: /^\/api\/obs\/replay$/, roles: ['producer'] },
  // Starting or stopping the actual broadcast is off unless the operator on the
  // PC turns it on. A mis-click here ends the stream.
  { m: 'POST', re: /^\/api\/obs\/(stream|record)$/, roles: ['producer'], cap: 'streamControl' },

  // --- never, from anywhere off this PC -------------------------------------
  // Listed so the reason is written down next to the rule, rather than relying
  // on the deny-by-default fall-through:
  //   obs/raw            - an arbitrary obs-websocket call is the whole API again
  //   obs/collection/*   - writes and deletes files in OBS's own config folder
  //   adapters/*/install - writes GSI config files into a game's install (GET shows the token)
  //   adapters/*/capture - records raw game data to a file on this PC, and says where
  //   adapters/*/start|stop - opens or closes a listener on the broadcast PC
  //   adapters/*/run     - pushes fabricated telemetry at the overlays
  //   sim/*              - a simulator on air would look like a real game
  //   game, event/new    - resets the show out from under the operator
  //   update, shutdown   - installs a zip, or stops the agent mid-show
  //   rehearse           - cuts through every scene on the real program bus
];

/** The rule that matches, or null. Exported for the tests. */
export function matchRule(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  for (const r of RULES) {
    if (r.m !== m) continue;
    if (r.re.test(pathname)) return r;
  }
  return null;
}

/**
 * May this seat make this request?
 *   allow(seat, 'POST', '/api/obs/take', { caps: { streamControl: false } })
 * Returns {ok:true, rule} or {ok:false, status, error}.
 */
export function allow(seat, method, pathname, { caps = {} } = {}) {
  const role = seat && seat.role;
  if (!role) return { ok: false, status: 401, error: 'no seat' };
  if (role === 'talent') return allowTalent(seat, method, pathname);
  const rule = matchRule(method, pathname);
  if (!rule) return { ok: false, status: 403, error: `${method} ${pathname} is not available to a remote seat` };
  // A seat held at the door can still ask who it is - that is how the waiting
  // page knows it has been let in. Everything else waits.
  if (seat.pending && pathname !== '/api/remote/me') {
    return { ok: false, status: 403, error: 'this seat is still waiting to be admitted at the desk' };
  }
  if (!rule.roles.includes(role)) return { ok: false, status: 403, error: `a ${role} may not ${method} ${pathname}` };
  if (rule.cap && !caps[rule.cap]) {
    return { ok: false, status: 403, error: rule.cap === 'streamControl'
      ? 'starting and stopping the stream from a remote seat is switched off on the broadcast PC'
      : `${rule.cap} is switched off on the broadcast PC` };
  }
  return { ok: true, rule };
}

/**
 * A talent seat's HTTP: the join page, and only once the rig has bound the
 * seat to a slot (`seat.slot`, filled in by remote.js from its own records).
 * Separate from RULES on purpose: no shared rule can widen it by accident.
 */
export function allowTalent(seat, method, pathname) {
  if (!seat || seat.role !== 'talent') return { ok: false, status: 403, error: 'not a talent seat' };
  if (!isSlot(seat.slot)) return { ok: false, status: 403, error: 'this talent link is not bound to a slot on the rig - ask the desk for a fresh one' };
  const m = String(method || 'GET').toUpperCase();
  const rule = TALENT_RULES.find((r) => r.m === m && r.re.test(pathname));
  if (!rule) return { ok: false, status: 403, error: `a talent seat may only open its join page, not ${m} ${pathname}` };
  return { ok: true, rule };
}

const isSlot = (v) => typeof v === 'string' && /^caster[1-8]$/.test(v);

/**
 * May this seat have the tunnelled WebSocket it asked for?
 *   allowChannel({role:'talent', slot:'caster2'}, '/talent/signaling') -> {ok, kind:'talent', role:'caster', slot:'caster2'}
 *   allowChannel({role:'producer'}, '/ws')                             -> {ok, kind:'hub'}
 * A talent seat gets ONLY its bound slot's signaling, always as the caster -
 * never the hub, never a receiver (which would hand it the OBS side of a call),
 * and never a slot named by the page. Every other seat gets ONLY the hub.
 */
export function allowChannel(seat, path) {
  const role = seat && seat.role;
  if (!role) return { ok: false, status: 401, error: 'no seat' };
  const p = path || '/ws';   // a relay from before the talent path only ever opened /ws
  if (role === 'talent') {
    if (p !== TALENT_SOCKET) return { ok: false, status: 403, error: 'a talent seat may only open its own signaling socket' };
    if (!isSlot(seat.slot)) return { ok: false, status: 403, error: 'this talent link is not bound to a slot on the rig' };
    return { ok: true, kind: 'talent', role: 'caster', slot: seat.slot };
  }
  if (p !== '/ws') return { ok: false, status: 403, error: `a ${role} seat cannot open ${p}` };
  if (seat.pending) return { ok: false, status: 403, error: 'this seat is still waiting to be admitted at the desk' };
  return { ok: true, kind: 'hub' };
}

/** Walk a dot-path and hand back {parent, key} if the whole path exists. */
function locate(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[parts[i]];
  }
  if (!cur || typeof cur !== 'object') return null;
  return { parent: cur, key: parts[parts.length - 1] };
}

/**
 * A copy of `state` with every secret removed, for a remote seat. Structural
 * clone first, so redacting can never reach the live object the agent is
 * running off. Absent keys stay absent; a present secret becomes '' and is
 * listed in `__remote.redacted` so the hosted UI can say "set on the rig"
 * instead of showing an empty box that looks editable.
 */
export function redactState(state, { role = 'viewer' } = {}) {
  const copy = JSON.parse(JSON.stringify(state == null ? {} : state));
  const redacted = [];
  for (const p of SECRET_PATHS) {
    const at = locate(copy, p);
    if (!at) continue;
    if (!(at.key in at.parent)) continue;
    if (at.parent[at.key] === '' || at.parent[at.key] == null) { at.parent[at.key] = ''; continue; }
    at.parent[at.key] = '';
    redacted.push(p);
  }
  copy.__remote = { role, redacted };
  return copy;
}

/** Collect every dot-path a patch actually writes (arrays and null count as leaves). */
export function patchPaths(patch, prefix = '', out = []) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const k of Object.keys(patch)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Object.keys(v).length === 0) out.push(path);
      else patchPaths(v, path, out);
    } else out.push(path);
  }
  return out;
}

/**
 * Is this state patch allowed from this seat? Returns {ok} or {ok:false, status, error}.
 * Rejects the whole patch rather than silently dropping part of it: a desk that
 * half-applies a change is worse than one that says no.
 */
export function allowPatch(seat, patch) {
  const role = seat && seat.role;
  if (role !== 'producer' && role !== 'scorer') return { ok: false, status: 403, error: 'a viewer cannot change the desk' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, status: 400, error: 'patch must be an object' };
  const paths = patchPaths(patch);
  if (!paths.length) return { ok: true };
  for (const p of paths) {
    const top = p.split('.')[0];
    if (PATCH_DENY.includes(top)) {
      return { ok: false, status: 403, error: top === 'settings'
        ? 'settings are set on the broadcast PC, not from a remote seat'
        : 'live telemetry comes from the game, it cannot be patched remotely' };
    }
    if (role === 'scorer' && !SCORER_PATCH_ALLOW.includes(top)) {
      return { ok: false, status: 403, error: `a scorer may change ${SCORER_PATCH_ALLOW.join(', ')} - not ${top}` };
    }
  }
  return { ok: true };
}

/** The hub message types a remote seat may send up its WebSocket. The control
 *  room drives OBS over the socket as well as over REST, so both doors need the
 *  same lock - this routes an {type:"obs"} frame through the very same rule. */
export function allowHubMessage(seat, msg, opts = {}) {
  const type = msg && msg.type;
  if (type === 'ping') return { ok: true };
  if (type === 'patch') return allowPatch(seat, msg.data || {});
  if (type === 'obs') {
    const action = String((msg && msg.action) || '');
    if (!/^[a-z-]+$/.test(action)) return { ok: false, status: 400, error: 'bad obs action' };
    return allow(seat, 'POST', `/api/obs/${action}`, opts);
  }
  return { ok: false, status: 403, error: `"${type}" is not accepted from a remote seat` };
}

export const REMOTE_SHOT_MAX_WIDTH = 480;
export const REMOTE_SHOT_QUALITY = 55;

/**
 * Rewrite a /api/obs/shot query for the tunnel: JPEG, capped width. A 640px PNG
 * of a busy game scene runs 400-800 KB and the control room asks for two of
 * them every four seconds, which no venue uplink will carry.
 */
export function shotQuery(search) {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const w = Number(q.get('w'));
  q.set('w', String(Math.max(160, Math.min(REMOTE_SHOT_MAX_WIDTH, Number.isFinite(w) && w > 0 ? w : REMOTE_SHOT_MAX_WIDTH))));
  q.set('fmt', 'jpg');
  q.set('q', String(REMOTE_SHOT_QUALITY));
  q.delete('cut');   // never let a remote seat cut program to take a picture
  return q.toString();
}

export const policy = {
  SECRET_PATHS, PATCH_DENY, SCORER_PATCH_ALLOW, REMOTE_SHOT_MAX_WIDTH, REMOTE_SHOT_QUALITY, TALENT_PAGE, TALENT_SOCKET,
  matchRule, allow, allowTalent, allowChannel, allowPatch, allowHubMessage, redactState, patchPaths, shotQuery,
};
export default policy;
