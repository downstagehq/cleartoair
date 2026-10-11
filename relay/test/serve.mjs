// Run the room relay on this machine, so the hosted control room can be tried
// without deploying anything.
//
//   node relay/test/serve.mjs            (port 8788)
//   node relay/test/serve.mjs --port 9000
//
// Then, in the local control room: Setup -> Remote seats, paste the address it
// prints, switch remote seats on, and mint an invite. Open the link in another
// browser - or on your phone on the same wifi, with 127.0.0.1 swapped for this
// PC's LAN address.
//
// This is the real relay/src/worker.js and relay/src/room.js running on Node
// stand-ins for Cloudflare's WebSocketPair and Durable Object storage (see
// harness.mjs). It is for trying things and for the tests; the real one lives
// on Cloudflare, where storage survives a restart.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHarness } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8788;

const assets = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(assets, 'index.html'))) {
  console.error('web/dist is missing - run npm run build first');
  process.exit(1);
}

const relay = await startHarness({ port, assetsDir: assets });
console.log(`
  Room relay (local)   ${relay.url}
  Paste that into      Setup -> Remote seats -> Room relay address
  Then                 switch remote seats on, and invite a producer.

  Nothing here leaves this PC. Ctrl+C to stop.
`);
process.on('SIGINT', () => { relay.close(); process.exit(0); });
