import { expect, it } from "vitest";
import { spawn, fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { delay } from "../packages/shared/src/util.js";
import { fixture, FakeRuntime } from "./helpers.js";
import { marked } from "../packages/shared/src/process.js";
import type { Context } from "@deepseek-ai/cordis";
import { apply } from "../packages/server/src/plugin.js";

it("releases the listener, discovery and controller when onReady throws", async () => {
  const f = fixture();
  let start!: () => Promise<unknown>;
  let provided = false;
  let url = "";
  let reported: unknown;
  const failure = new Error("embedding startup failed");
  const ctx = {
    effect: (effect: typeof start) => {
      start = effect;
    },
    provide: () => {
      provided = true;
      return () => {
        provided = false;
      };
    },
  } as unknown as Context;
  apply(ctx, {
    home: f.home,
    port: 0,
    runtime: new FakeRuntime(),
    onReady: (address) => {
      url = address;
      throw failure;
    },
    onError: (error) => {
      reported = error;
    },
  });
  await expect(start()).rejects.toBe(failure);
  expect(reported).toBe(failure);
  expect(provided).toBe(false);
  expect(existsSync(join(f.home, "service.json"))).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
  const replacement = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
  });
  await replacement.close();
});
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
it("a rejected service contender cannot issue a token before acquiring the home lock", async () => {
  const f = fixture();
  const first = new Controller({ home: f.home, runtime: new FakeRuntime() });
  try {
    await expect(
      promisify(execFile)(process.execPath, [
        resolve("dist/cli.js"),
        "serve",
        "--port",
        "0",
        "--home",
        f.home,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    expect(existsSync(join(f.home, "service-token"))).toBe(false);
    expect(existsSync(join(f.home, "service.json"))).toBe(false);
  } finally {
    await first.close();
  }
});

it("allows only one controller when two contenders reclaim the same dead owner", async () => {
  const f = fixture();
  mkdirSync(f.home, { recursive: true });
  writeFileSync(
    join(f.home, "controller.lock"),
    JSON.stringify({ pid: 99999999, start: "dead-fixture" }),
  );
  const children: ReturnType<typeof fork>[] = [];
  const exits: Promise<void>[] = [];
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 500 && !check(); i++) await delay(10);
    expect(check(), "contender barrier").toBe(true);
  }
  function start(role: string) {
    const child = fork(
      resolve("tests/fixtures/lock-contender.mjs"),
      [f.home, f.root, role],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: [],
      },
    );
    children.push(child);
    exits.push(new Promise<void>((r) => child.once("exit", () => r())));
    let outcome: { opened: boolean; error?: string } | undefined;
    child.once("message", (message) => {
      outcome = message as typeof outcome;
    });
    return () => outcome;
  }
  try {
    const a = start("a");
    await waitFor(() => existsSync(join(f.root, "a-paused")));
    const b = start("b");
    await waitFor(() => !!b() || existsSync(join(f.root, "b-paused")));
    writeFileSync(join(f.root, "b-resume"), "");
    await waitFor(() => !!b());
    writeFileSync(join(f.root, "a-resume"), "");
    await waitFor(() => !!a());
    expect([a(), b()].filter((r) => r?.opened)).toHaveLength(1);
  } finally {
    for (const role of ["a", "b"])
      writeFileSync(join(f.root, role + "-resume"), "");
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all(exits);
  }
  // The OS releases ownership on a crash, without requiring a graceful close.
  const recovered = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
  });
  await recovered.close();
}, 20000);
