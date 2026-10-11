// Ring buffer of recent log lines, mirrored to the console and pushed to
// every hub client as {type:"log", line}.
//
// line.t is ISO UTC (the control room shows it in local time). The console line
// is stamped in LOCAL time: the launcher writes the agent's console into
// launcher.log after its own local date-time, and two different clocks on one
// line read as a two-hour gap on a show day.

const CAPACITY = 500;
const lines = [];
let hub = null;

/** HH:MM:SS on this PC's clock. */
export function localClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function push(level, tag, msg) {
  const now = new Date();
  const line = { t: now.toISOString(), level, tag, msg: String(msg) };
  lines.push(line);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
  const out = `${localClock(now)} [${tag}] ${line.msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
  if (hub) hub.send({ type: 'log', line });
  return line;
}

export const log = {
  info: (tag, msg) => push('info', tag, msg),
  warn: (tag, msg) => push('warn', tag, msg),
  error: (tag, msg) => push('error', tag, msg),
  recent: (n = 200) => lines.slice(-Math.max(1, Math.min(CAPACITY, Number(n) || 200))),
  attachHub: (h) => { hub = h; },
};

export default log;
