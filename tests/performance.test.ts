import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { FakeRuntime, fixture } from "./helpers.js";

it("polls a 5000-file delivery without blocking the event loop or duplicating its manifest", async () => {
  const f = fixture();
  mkdirSync(join(f.repo, "files"));
  for (let i = 0; i < 5000; i++)
    writeFileSync(join(f.repo, "files", `${i}.txt`), `baseline ${i}\n`);
  execFileSync("git", ["-C", f.repo, "add", "."]);
  execFileSync("git", ["-C", f.repo, "commit", "-m", "large baseline"], {
    stdio: "ignore",
  });
  f.ticket.baseCommit = execFileSync(
    "git",
    ["-C", f.repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    const full = await c.wait(f.ticket.ticketId);
    let loopAdvanced = false;
    setImmediate(() => {
      loopAdvanced = true;
    });
    const first = await c.pollStatus(f.ticket.ticketId);
    expect(loopAdvanced).toBe(true);
    const started = performance.now();
    const repeated = await c.pollStatus(f.ticket.ticketId);
    const pollMs = performance.now() - started;
    expect(repeated.snapshotCheckedAt).toBe(first.snapshotCheckedAt);
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const compactBytes = Buffer.byteLength(JSON.stringify(repeated));
    expect(fullBytes).toBeGreaterThan(500000);
    expect(compactBytes).toBeLessThan(15000);
    expect(readdirSync(join(f.home, "artifacts", "blobs"))).toHaveLength(1);
    console.log(
      JSON.stringify({
        files: 5000,
        fullBytes,
        compactBytes,
        cachedPollMs: Math.round(pollMs * 100) / 100,
      }),
    );
  } finally {
    await c.close();
  }
}, 30000);

it("journals only changes to process ownership, including the final empty set", async () => {
  const f = fixture();
  const fake = new FakeRuntime();
  const c = new Controller({
    home: f.home,
    dispatchEnabled: true,
    runtime: {
      execute: async (
        request,
        dir,
        marker,
        signal,
        _onMessage,
        onProcesses,
      ) => {
        for (let i = 0; i < 20; i++)
          onProcesses([{ pid: 123456, start: "fixture identity" }]);
        onProcesses([]);
        onProcesses([]);
        return fake.execute(request, dir, marker, signal);
      },
    },
  });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    await c.wait(f.ticket.ticketId);
    expect(
      c.store.events(0, 1000).filter((e) => e.type === "attempt.processes"),
    ).toHaveLength(2);
    expect(c.store.get(f.ticket.ticketId).attempts[0]?.processes).toEqual([]);
  } finally {
    await c.close();
  }
});
