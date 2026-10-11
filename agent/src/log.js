// Ring buffer of recent log lines, mirrored to the console and pushed to
// every hub client as {type:"log", line}.

const CAPACITY = 500;
const lines = [];
let hub = null;

function stamp() {
  return new Date().toISOString();
}

function push(level, tag, msg) {
  const line = { t: stamp(), level, tag, msg: String(msg) };
  lines.push(line);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
  const out = `${line.t.slice(11, 19)} [${tag}] ${line.msg}`;
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
