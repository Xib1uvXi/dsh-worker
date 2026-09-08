import { Worker } from "node:worker_threads";
import type { TicketRecord } from "../../contracts/src/index.js";

type Reading = { digest: string; checkedAt: string };

// One worker bounds repository I/O concurrency and keeps polling off the HTTP loop.
export class SnapshotReader {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (reading: Reading) => void; reject: (error: Error) => void }
  >();
  private cache = new Map<
    string,
    { key: string; expires: number; result: Promise<Reading> }
  >();
  read(record: TicketRecord): Promise<Reading> {
    const id = record.ticket.ticketId;
    const key = `${record.ticket.revision}:${record.updatedAt}`;
    const cached = this.cache.get(id);
    if (cached?.key === key && cached.expires > Date.now())
      return cached.result;
    if (!this.worker) {
      const worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../../dist/snapshot-worker.js"
            : "./snapshot-worker.js",
          import.meta.url,
        ),
      );
      this.worker = worker;
      worker.on("message", ({ id, digest, checkedAt, error }) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (error) pending?.reject(new Error(error));
        else pending?.resolve({ digest, checkedAt });
      });
      const fail = (error: Error) => {
        if (this.worker !== worker) return;
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.cache.clear();
        if (this.worker === worker) this.worker = undefined;
      };
      worker.on("error", fail);
      worker.on("exit", () => fail(new Error("Snapshot reader exited")));
    }
    const result = new Promise<Reading>((resolve, reject) => {
      const request = ++this.next;
      this.pending.set(request, { resolve, reject });
      this.worker!.postMessage({
        id: request,
        record: {
          ...record,
          attempts: [],
          verifications: [],
          reviews: [],
          instructions: [],
        },
      });
    });
    this.cache.set(id, { key, expires: Infinity, result });
    void result.then(
      () => {
        const entry = this.cache.get(id);
        if (entry?.result === result) entry.expires = Date.now() + 3000;
      },
      () => {
        if (this.cache.get(id)?.result === result) this.cache.delete(id);
      },
    );
    return result;
  }
  async close() {
    await this.worker?.terminate();
    this.cache.clear();
  }
}
