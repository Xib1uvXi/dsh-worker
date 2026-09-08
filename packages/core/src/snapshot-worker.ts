import { parentPort } from "node:worker_threads";
import { capture, type FileCache } from "./git.js";
const cache: FileCache = new Map();
parentPort!.on("message", ({ id, record }) => {
  try {
    parentPort!.postMessage({
      id,
      digest: capture(record, undefined, cache).digest,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});
