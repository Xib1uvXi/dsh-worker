import { request as rawRequest } from "node:http";
import { afterEach, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { Controller } from "../packages/core/src/controller.js";
import { startHttp } from "../packages/server/src/http.js";
import { sessions } from "../packages/server/src/observer.js";
import { fixture, FakeRuntime } from "./helpers.js";
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
it("reads canonical v0/v1/v2 compressed/plain headers, never the transcript", async () => {
  const f = fixture();
  for (const version of [0, 1, 2]) {
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
  expect(result.sessions).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(result.sessions.every((s) => s.liveness === "unknown")).toBe(true);
});
it("does not fall back from unknown or corrupted highest session generation", async () => {
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
  writeFileSync(join(dir, "session.v3.jsonl"), "broken");
  const result = await sessions([f.home]);
  expect(result.sessions).toHaveLength(0);
  expect(result.diagnostics.join()).toContain("highest generation 3");
});
