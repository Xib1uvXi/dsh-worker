import { expect, it } from "vitest";
import { spawn, fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { Store } from "../packages/core/src/store.js";
import { SdkRuntime } from "../packages/runtime/src/adapter.js";
import { delay } from "../packages/core/src/util.js";
import { fixture, FakeRuntime } from "./helpers.js";
import { marked } from "../packages/core/src/process.js";
it("refuses a second controller instead of fencing the active owner", async () => {
  const f = fixture();
  const first = new Controller({ home: f.home, runtime: new FakeRuntime() });
  try {
    first.prepare(f.ticket);
    expect(
      () => new Controller({ home: f.home, runtime: new FakeRuntime() }),
    ).toThrow(/already owns/);
    expect(first.status(f.ticket.ticketId).state).toBe("ready");
  } finally {
    await first.close();
  }
});
it("runs the CLI service and CLI client with Cordis disposal without dispatch", async () => {
  const f = fixture();
  const child = spawn(
    process.execPath,
    ["dist/cli.js", "serve", "--port", "0", "--home", f.home],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const cli = (...args: string[]) =>
    promisify(execFile)(process.execPath, [
      resolve("dist/cli.js"),
      ...args,
      "--home",
      f.home,
    ]);
  try {
    for (let i = 0; i < 100 && !existsSync(join(f.home, "service.json")); i++)
      await delay(100);
    expect(existsSync(join(f.home, "service.json")), stderr).toBe(true);
    const file = join(f.root, "ticket.json");
    writeFileSync(file, JSON.stringify(f.ticket));
    const prepared = await cli("prepare", "--file", file);
    expect(JSON.parse(prepared.stdout).state).toBe("ready");
    const listed = JSON.parse((await cli("list")).stdout);
    expect(listed.tickets).toHaveLength(1);
    expect(listed.dispatchEnabled).toBe(false);
    await expect(cli("run", f.ticket.ticketId)).rejects.toMatchObject({
      code: 1,
    });
    expect(
      JSON.parse((await cli("status", f.ticket.ticketId)).stdout).attempts,
    ).toHaveLength(0);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
  expect(existsSync(join(f.home, "controller.lock"))).toBe(false);
  expect(existsSync(join(f.home, "service.json"))).toBe(false);
}, 20000);
it("fences a real controller crash, accounts for inherited writers, and never replays", async () => {
  const f = fixture();
  const child = fork(resolve("tests/fixtures/service.mjs"), [f.home], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const { url } = await new Promise<{ url: string }>((resolve, reject) => {
    child.once("message", (m) => resolve(m as { url: string }));
    child.once("error", reject);
  });
  const headers = {
    Authorization: `Bearer ${"a".repeat(64)}`,
    "Content-Type": "application/json",
  };
  const post = async (action: unknown) => {
    const r = await fetch(url + "/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify(action),
    });
    return r.json();
  };
  let recovered: Controller | undefined;
  try {
    f.ticket.context = "FIXTURE_HANG";
    await post({ action: "prepare", ticket: f.ticket });
    await post({ action: "run", ticketId: f.ticket.ticketId });
    let attempt;
    for (let i = 0; i < 60; i++) {
      await delay(100);
      const r = await fetch(url + `/api/tickets/${f.ticket.ticketId}`, {
        headers,
      });
      attempt = (await r.json()).attempts[0];
      if (attempt.processes.length >= 2 && attempt.receipt) break;
    }
    child.kill("SIGKILL");
    await exited;
    const runtime = new FakeRuntime();
    recovered = new Controller({
      home: f.home,
      runtime,
      dispatchEnabled: true,
    });
    const t = recovered.status(f.ticket.ticketId);
    expect(t.state).toBe("interrupted");
    expect(runtime.count).toBe(0);
    const report = recovered.recovery(f.ticket.ticketId);
    const result = await recovered.recover({
      ticketId: f.ticket.ticketId,
      revision: 1,
      attemptId: t.attempts[0]!.id,
      snapshotDigest: report.snapshotDigest,
      instruction: "Inspect current changes before continuing",
    });
    expect(result.state).toBe("ready");
    expect(marked(t.attempts[0]!.marker)).toHaveLength(0);
    expect(runtime.count).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await recovered?.close();
  }
}, 25000);
