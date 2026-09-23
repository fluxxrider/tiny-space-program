// Module worker: builds terrain chunks off the main thread. Only relative imports (workers have no import map).
import { buildChunk, chunkTransferables } from './chunkBuilder.js';

self.onmessage = (e) => {
  const req = e.data;
  try {
    const c = buildChunk(req);
    self.postMessage(c, chunkTransferables(c));
  } catch (err) {
    self.postMessage({ id: req.id, error: String((err && err.stack) || err) });
  }
};
