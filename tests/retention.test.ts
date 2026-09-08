import { expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { fixture, FakeRuntime } from "./helpers.js";
it("prunes only old clean scratch homes and preserves durable evidence and uncertain work", async () => {
  const f = fixture();
  const c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    const t = await c.wait(f.ticket.ticketId);
    const attempt = t.attempts[0]!;
    const dir = join(c.home, "runs", attempt.id, "harness-home");
    mkdirSync(dir);
    writeFileSync(join(dir, "scratch"), "temporary");
    c.store.update(f.ticket.ticketId, "age.fixture", (r) => {
      r.attempts[0]!.endedAt = "2020-01-01T00:00:00Z";
      r.activeOperation = "uncertain";
    });
    expect((await c.action({ action: "prune", days: 7 })).removed).toEqual([]);
    c.store.update(f.ticket.ticketId, "idle.fixture", (r) => {
      delete r.activeOperation;
    });
    expect((await c.action({ action: "prune", days: 7 })).removed).toEqual([
      dir,
    ]);
    expect(existsSync(join(f.home, "runs", attempt.id, "input.json"))).toBe(
      true,
    );
    expect(c.store.get(f.ticket.ticketId).attempts[0]?.snapshot).toEqual(
      attempt.snapshot,
    );
    expect(c.store.events().length).toBeGreaterThan(0);
    symlinkSync(f.repo, dir);
    expect((await c.action({ action: "prune", days: 7 })).removed).toEqual([]);
    expect(existsSync(join(f.repo, "source.txt"))).toBe(true);
  } finally {
    await c.close();
  }
});
