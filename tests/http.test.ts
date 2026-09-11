import { request as rawRequest } from "node:http";
import { afterEach, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Controller } from "../packages/core/src/controller.js";
import { startHttp } from "../packages/server/src/http.js";
import { sessions } from "../packages/server/src/observer.js";
import { fixture, FakeRuntime } from "./helpers.js";
import type {
  EvidenceBrief,
  JournalPage,
} from "../packages/contracts/src/index.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function server() {
  const f = fixture();
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  const http = await startHttp(c, {
    port: 0,
    token: "a".repeat(64),
    webDir: resolve("dist/web"),
  });
  closes.push(async () => {
    await http.close();
    await c.close();
  });
  const headers = {
    Authorization: `Bearer ${"a".repeat(64)}`,
    "Content-Type": "application/json",
  };
  return { ...f, c, http, headers };
}
it("authenticates every data route and rejects cross-origin writes", async () => {
  const s = await server();
  expect((await fetch(s.http.url + "/api/overview")).status).toBe(401);
  expect(
    (await fetch(s.http.url + "/api/overview", { headers: s.headers })).status,
  ).toBe(200);
  expect(
    (
      await fetch(s.http.url + "/api/actions", {
        method: "POST",
        headers: { ...s.headers, Origin: "https://attacker.example" },
        body: JSON.stringify({ action: "prepare", ticket: s.ticket }),
      })
    ).status,
  ).toBe(403);
  expect(s.c.store.list()).toHaveLength(0);
});
it.each(["", "   "])(
  "refuses an empty service token %j before listening",
  async (token) => {
    const f = fixture();
    const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
    closes.push(() => c.close());
    await expect(
      startHttp(c, { port: 0, token, webDir: resolve("dist/web") }),
    ).rejects.toMatchObject({ code: "service_token" });
  },
);
it("validates shared action contracts and never mutates on GET", async () => {
  const s = await server();
  const bad = await fetch(s.http.url + "/api/actions", {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({ action: "prepare", ticket: {} }),
  });
  expect(bad.status).toBe(400);
  expect(
    (await fetch(s.http.url + "/api/actions", { headers: s.headers })).status,
  ).toBe(404);
  const good = await fetch(s.http.url + "/api/actions", {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({ action: "prepare", ticket: s.ticket }),
  });
  expect(good.status).toBe(200);
  expect(s.c.store.list()).toHaveLength(1);
});
it("authenticates evidence queries and rejects invalid query options", async () => {
  const s = await server();
  s.c.prepare(s.ticket);
  for (const route of ["brief", "trajectory", "activity", "events"]) {
    expect(
      (await fetch(`${s.http.url}/api/tickets/${s.ticket.ticketId}/${route}`))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${s.http.url}/api/tickets/MISSING/${route}`, {
          headers: s.headers,
        })
      ).status,
    ).toBe(404);
  }
  for (const route of [
    "events?limit=0",
    "events?after=1.2",
    "trajectory?limit=101",
    "trajectory?attempt=foreign",
    "brief?kind=tool/call",
    "activity?limit=2",
    "events?unknown=1",
  ]) {
    expect(
      (
        await fetch(`${s.http.url}/api/tickets/${s.ticket.ticketId}/${route}`, {
          headers: s.headers,
        })
      ).status,
    ).toBe(400);
  }
});

it("replays control pages and retains the latest failed verification in a read-only brief after restart", async () => {
  const f = fixture();
  const failureFlag = join(f.root, "fail-verification");
  f.ticket.verification = [
    {
      args: [
        process.execPath,
        "-e",
        `console.log('START'+'o'.repeat(5000)+'END');if(require('fs').existsSync(${JSON.stringify(failureFlag)}))process.exit(7)`,
      ],
      cwd: ".",
      timeoutSeconds: 10,
    },
  ];
  let c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  const options = {
    port: 0,
    token: "evidence-test",
    webDir: resolve("dist/web"),
  };
  let http = await startHttp(c, options);
  closes.push(async () => {
    await http.close();
    await c.close();
  });
  const headers = { Authorization: "Bearer evidence-test" };
  const query = async <T>(route: string) => {
    const response = await fetch(
      `${http.url}/api/tickets/${f.ticket.ticketId}/${route}`,
      { headers },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  c.prepare(f.ticket);
  c.run(f.ticket.ticketId);
  await c.wait(f.ticket.ticketId);
  c.verify(f.ticket.ticketId);
  await c.wait(f.ticket.ticketId);
  expect((await query<EvidenceBrief>("brief")).verification!.passed).toBe(true);
  writeFileSync(failureFlag, "fail");
  c.verify(f.ticket.ticketId);
  await c.wait(f.ticket.ticketId);
  const record = c.store.get(f.ticket.ticketId);
  const journal = c.store.events(0, 10000);
  const brief = await query<EvidenceBrief>("brief");
  expect(brief.verification).toMatchObject({
    id: record.verifications.at(-1)!.id,
    passed: false,
    matchesDeliveredSnapshot: true,
    matchesCurrentSnapshot: true,
  });
  expect(brief.verification!.commands[0]).toMatchObject({
    exitCode: 7,
    outputTruncated: true,
    serviceOutputTruncated: false,
  });
  expect(brief.verification!.commands[0]!.outputTail).toHaveLength(4000);
  expect(brief.verification!.commands[0]!.outputTail).toContain("END");
  expect(brief.review).toBeNull();
  expect(c.store.get(f.ticket.ticketId)).toEqual(record);
  expect(c.store.events(0, 10000)).toEqual(journal);
  const first = await query<JournalPage>("events?limit=2");
  expect(first.entries).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  await http.close();
  await c.close();
  c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  http = await startHttp(c, options);
  expect((await query<EvidenceBrief>("brief")).verification!.id).toBe(
    brief.verification!.id,
  );
  const replay = await query<JournalPage>("events?limit=2");
  expect(replay).toEqual(first);
  const seen = first.entries.map((e) => e.seq);
  let cursor = first.cursor;
  for (let n = 0; n < 100; n++) {
    const page = await query<JournalPage>(`events?limit=2&after=${cursor}`);
    seen.push(...page.entries.map((e) => e.seq));
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  const expected = journal
    .filter(
      (e) =>
        e.ticketId === f.ticket.ticketId &&
        e.type !== "harness.notification" &&
        !e.type.endsWith(".processes"),
    )
    .map((e) => e.seq);
  expect(seen).toEqual(expected);
  expect(c.store.get(f.ticket.ticketId).attempts).toHaveLength(1);
}, 20000);
it("replays durable event cursors through the authenticated stream", async () => {
  const s = await server();
  s.c.prepare(s.ticket);
  const initial = s.c.store.events();
  const abort = new AbortController();
  const response = await fetch(
    s.http.url + `/api/events?after=${initial[0]!.seq}`,
    {
      headers: { ...s.headers, Accept: "text/event-stream" },
      signal: abort.signal,
    },
  );
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  expect(text).toContain("ticket.prepared");
  expect(text).not.toContain("ticket.reserved");
  s.c.prepare({ ...s.ticket, ticketId: "STREAM-2" });
  const live = await reader.read();
  expect(new TextDecoder().decode(live.value)).toContain("STREAM-2");
  abort.abort();
});
it("serves CSP-protected assets and refuses traversal or unexpected host", async () => {
  const s = await server();
  const page = await fetch(s.http.url);
  expect(page.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(
    await new Promise<number | undefined>((resolve) => {
      const req = rawRequest(
        s.http.url + "/api/overview",
        { headers: { ...s.headers, Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end();
    }),
  ).toBe(403);
  expect((await fetch(s.http.url + "/%2e%2e/package.json")).status).toBe(404);
});
it("reads canonical v0/v1/v2/v3 compressed/plain headers, never the transcript", async () => {
  const f = fixture();
  for (const version of [0, 1, 2, 3]) {
    const dir = join(f.home, "sessions", "project", `s${version}`);
    mkdirSync(dir, { recursive: true });
    const data =
      JSON.stringify({
        type: "session",
        version,
        id: `s${version}`,
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      }) + "\nSECRET TRANSCRIPT\n";
    writeFileSync(
      join(dir, version ? `session.v${version}.jsonl.zstd` : "session.jsonl"),
      version ? zstdCompressSync(data) : data,
    );
  }
  const result = await sessions([f.home]);
  expect(result.sessions).toHaveLength(4);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(result.sessions.every((s) => s.liveness === "unknown")).toBe(true);
});
it.each([3, 4])(
  "does not fall back from corrupted or unsupported generation %s",
  async (version) => {
    const f = fixture();
    const dir = join(f.home, "sessions", "project", "sample");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({
        type: "session",
        version: 0,
        id: "sample",
        createdAt: 1,
      }) + "\n",
    );
    writeFileSync(join(dir, `session.v${version}.jsonl`), "broken\n");
    const result = await sessions([f.home]);
    expect(result.sessions).toHaveLength(0);
    if (version === 4)
      expect(result.diagnostics.join()).toContain("highest generation 4");
    else expect(result.diagnostics.join()).toMatch(/JSON|Unexpected/);
  },
);
it("selects V3 over V2, links parents, and validates the V3 header identity", async () => {
  const f = fixture();
  const write = (id: string, version: number, fields = {}) => {
    const dir = join(f.home, "sessions", "project", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session.v${version}.jsonl`),
      JSON.stringify({
        type: "session",
        version,
        id,
        createdAt: 1,
        ...fields,
      }) + "\n",
    );
  };
  write("parent", 2, { cwd: "/old" });
  write("parent", 3, { cwd: "/current" });
  write("child", 3, { parentSession: "parent", origin: "subagent" });
  const result = await sessions([f.home]);
  expect(result.diagnostics).toEqual([]);
  expect(result.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "parent", format: 3, cwd: "/current" }),
      expect.objectContaining({
        id: "child",
        parent: "parent",
        origin: "subagent",
      }),
    ]),
  );
  expect(result.sessions).toHaveLength(2);
  write("child", 3, { id: "impostor" });
  expect((await sessions([f.home])).diagnostics.join()).toContain(
    "identity mismatch",
  );
  write("child", 3, { version: 2 });
  expect((await sessions([f.home])).diagnostics.join()).toContain(
    "generation mismatch",
  );
});
it("reports a compressed session removed between stat and open without crashing", async () => {
  const f = fixture();
  const dir = join(f.home, "sessions", "project", "rotated");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl.zstd");
  writeFileSync(
    path,
    zstdCompressSync(
      JSON.stringify({
        type: "session",
        version: 0,
        id: "rotated",
        createdAt: 1,
      }) + "\n",
    ),
  );
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.lstatSync;
    fs.lstatSync = (...args) => {
      const result = original(...args);
      if (args[0] === ${JSON.stringify(path)}) fs.unlinkSync(args[0]);
      return result;
    };
    syncBuiltinESMExports();
    const { sessions } = await import('./packages/server/src/observer.ts');
    console.log(JSON.stringify(await sessions([${JSON.stringify(f.home)}])));
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { timeout: 10000 },
  );
  const parsed = JSON.parse(result.stdout);
  expect(parsed.sessions).toEqual([]);
  expect(parsed.diagnostics.join()).toContain("ENOENT");
});
it("preserves UTF-8 characters split across HTTP chunks and rejects malformed UTF-8", async () => {
  const s = await server();
  s.c.prepare(s.ticket);
  const payload = Buffer.from(
    JSON.stringify({
      action: "instruct",
      ticketId: s.ticket.ticketId,
      revision: 1,
      instructionId: "utf8-1",
      instruction: "中文指令🙂",
    }),
  );
  const split = payload.indexOf(Buffer.from("文")) + 1;
  const send = (parts: Buffer[]) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = rawRequest(
        s.http.url + "/api/actions",
        {
          method: "POST",
          headers: { ...s.headers, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write(parts[0]);
      setTimeout(() => req.end(parts[1]), 20);
    });
  expect(
    await send([payload.subarray(0, split), payload.subarray(split)]),
  ).toBe(200);
  expect(s.c.store.get(s.ticket.ticketId).instructions?.[0]?.text).toBe(
    "中文指令🙂",
  );
  expect(
    await send([Buffer.from('{"bad":"'), Buffer.from([0xff, 34, 125])]),
  ).toBe(400);
});
