// Worker thread for stats/ocr.js. The whole read happens here - decoding the
// screenshot, building the layouts, starting PowerShell (CreateProcess is
// synchronous, 5-30 ms on Windows) and the vote - so the agent's event loop
// only ever waits for this one message.
// Protocol: workerData = { image: Uint8Array, opts } -> postMessage(ocrInline result).

import { parentPort, workerData } from 'node:worker_threads';
import { ocrInline } from './ocr.js';

try {
  parentPort.postMessage(await ocrInline(Buffer.from(workerData.image), workerData.opts));
} catch (e) {
  parentPort.postMessage({ ok: false, status: e.status || 500, reason: `OCR failed: ${e.message}`, ms: 0 });
}
