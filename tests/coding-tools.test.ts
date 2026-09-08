import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import LocalFs from "@deepseek-ai/dsh-fs-local";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as CodingPlugin from "../packages/runtime/src/coding-plugin.js";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fixture } from "./helpers.js";
import {
  codingPatch,
  inspectCodingTools,
  managedTgrep,
} from "../packages/runtime/src/coding-tools.js";
import { TgrepSearch } from "../packages/runtime/src/tgrep.js";
import { policyPatch } from "../packages/runtime/src/policy.js";
import { cleanEnv } from "../packages/shared/src/process.js";
const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const binary =
  process.env.DSH_WORKER_TEST_TGREP ??
  managedTgrep(join(homedir(), ".dsh-worker-v2"));
function setup(languages: string[] | "auto" = []) {
  const f = fixture();
  roots.push(f.root);
  writeFileSync(
    join(f.home, "tools.json"),
    JSON.stringify({ tgrep: binary, languages }),
  );
  return f;
}
async function searcher(repo: string, indexDirectory: string) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalSubprocess);
  return {
    ctx,
    search: new TgrepSearch(ctx, {
      workspace: await import("node:fs/promises").then((fs) =>
        fs.realpath(repo),
      ),
      tgrep: binary,
      indexDirectory,
      indexed: true,
    }),
  };
}
it("uses tgrep's index and sees immediate creates, edits, deletes and independent workspaces", async () => {
  const f = setup();
  const g = setup();
  const a = await searcher(f.repo, join(f.home, "index"));
  const b = await searcher(g.repo, join(g.home, "index"));
  const exec = { signal: new AbortController().signal };
  const query = () => a.search.search({ pattern: "needle" }, exec);
  writeFileSync(join(f.repo, "a.ts"), "const needle = 1;\n");
  expect(await query()).toMatchObject({
    mode: "index",
    matches: [{ path: "a.ts", lineNumber: 1 }],
  });
  writeFileSync(join(f.repo, "b.ts"), "needle\n");
  expect((await query()).matches.map((m) => m.path).sort()).toEqual([
    "a.ts",
    "b.ts",
  ]);
  writeFileSync(join(f.repo, "a.ts"), "changed\n");
  rmSync(join(f.repo, "b.ts"));
  expect((await query()).matches).toEqual([]);
  writeFileSync(join(g.repo, "a.ts"), "needle elsewhere\n");
  expect(
    (await b.search.search({ pattern: "needle" }, exec)).matches,
  ).toHaveLength(1);
  expect((await query()).matches).toEqual([]);
  await expect(
    a.search.search({ pattern: "needle", path: g.repo }, exec),
  ).rejects.toThrow(/workspace/);
}, 30000);
it("preserves live explicit-file/filter behavior, Unicode, metacharacters and cancellation", async () => {
  const f = setup();
  const a = await searcher(f.repo, join(f.home, "index"));
  const exec = { signal: new AbortController().signal };
  writeFileSync(join(f.repo, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(f.repo, "ignored.ts"), "中文🙂 needle\n");
  writeFileSync(join(f.repo, "a.ts"), "中文🙂 needle\n");
  expect(
    (await a.search.search({ pattern: "中文🙂", include: "*.ts" }, exec))
      .matches,
  ).toHaveLength(1);
  expect(
    (await a.search.search({ pattern: "中文🙂", path: "ignored.ts" }, exec))
      .matches[0]?.line,
  ).toContain("中文🙂");
  await expect(a.search.search({ pattern: "[" }, exec)).rejects.toThrow(
    /TGREP_FAILED/,
  );
  expect(
    (await a.search.search({ pattern: "$(touch nope)" }, exec)).matches,
  ).toEqual([]);
  const abort = new AbortController();
  abort.abort();
  await expect(
    a.search.search({ pattern: "needle" }, { signal: abort.signal }),
  ).rejects.toThrow();
  symlinkSync(f.home, join(f.repo, "outside"));
  await expect(
    a.search.search({ pattern: "needle", path: "outside" }, exec),
  ).rejects.toThrow(/workspace/);
}, 30000);
it("reports missing configured tools and honors explicit opt-out without changing configuration", async () => {
  const f = setup("auto");
  writeFileSync(join(f.repo, "example.ts"), "export const value = 1;\n");
  const config = { tgrep: "/missing/tgrep", languages: "auto" };
  writeFileSync(join(f.home, "tools.json"), JSON.stringify(config));
  const report = await inspectCodingTools(f.home, f.repo);
  expect(report.ok).toBe(false);
  expect(report.languages).toEqual(["typescript"]);
  expect(report.checks.find((c) => c.tool === "tgrep")?.error).toContain(
    "Install",
  );
  expect(JSON.parse(readFileSync(join(f.home, "tools.json"), "utf8"))).toEqual(
    config,
  );
  writeFileSync(
    join(f.home, "tools.json"),
    JSON.stringify({ search: "ripgrep", languages: [] }),
  );
  expect(await inspectCodingTools(f.home, f.repo)).toMatchObject({
    ok: true,
    servers: {},
  });
  writeFileSync(join(f.home, "tools.json"), JSON.stringify({ unknown: true }));
  await expect(inspectCodingTools(f.home, f.repo)).rejects.toThrow();
});
it("loads default tgrep and native TypeScript tools in the released SDK without a model call", async () => {
  const f = setup(["typescript"]);
  const dir = join(f.home, "run");
  mkdirSync(dir);
  const patch = await codingPatch(f.home, f.repo, dir);
  const harness = new DeepSeekHarness({
    cwd: f.repo,
    processCwd: f.repo,
    dshHome: join(dir, "harness"),
    profile: "sdk",
    patches: [patch, policyPatch(dir)],
    env: cleanEnv([]),
    initializeTimeoutMs: 30000,
  });
  try {
    await harness.start();
  } finally {
    await harness.close();
  }
}, 40000);
const cases = [
  {
    language: "typescript",
    file: "source.ts",
    source:
      "export function twice(n: number): number { return n * 2; }\nexport const answer = twice(2);\n",
    token: "twice",
    files: { "tsconfig.json": '{"compilerOptions":{"strict":true}}' },
  },
  {
    language: "go",
    file: "source.go",
    source:
      "package sample\nfunc Twice(n int) int { return n * 2 }\nfunc Answer() int { return Twice(2) }\n",
    token: "Twice",
    files: { "go.mod": "module example.test/sample\n\ngo 1.24\n" },
  },
  {
    language: "rust",
    file: "src/lib.rs",
    source:
      "pub fn twice(n: i32) -> i32 { n * 2 }\npub fn answer() -> i32 { twice(2) }\n",
    token: "twice",
    files: {
      "Cargo.toml":
        '[package]\nname="worker-lsp-fixture"\nversion="0.1.0"\nedition="2021"\n',
    },
  },
];
it.each(cases)(
  "queries the real $language server and disposes every owned process",
  async (c) => {
    const f = setup([c.language]);
    mkdirSync(join(f.repo, "src"), { recursive: true });
    c = {
      ...c,
      source:
        c.source +
        (c.language === "typescript"
          ? "export interface Shape { area(): number }\nexport class Circle implements Shape { area() { return 1; } }\n"
          : c.language === "go"
            ? "type Shape interface { Area() int }\ntype Circle struct{}\nfunc (Circle) Area() int { return 1 }\n"
            : "pub trait Shape { fn area(&self) -> i32; }\npub struct Circle;\nimpl Shape for Circle { fn area(&self) -> i32 { 1 } }\n"),
    };
    writeFileSync(join(f.repo, c.file), c.source);
    for (const [file, content] of Object.entries(c.files))
      writeFileSync(join(f.repo, file), content!);
    const report = await inspectCodingTools(f.home, f.repo);
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    const ctx = new Context();
    contexts.push(ctx);
    await ctx.plugin(LocalSubprocess);
    await ctx.plugin(LocalFs, { cwd: f.repo });
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const spawn = vi.spyOn(ctx.subprocess, "spawn");
    await ctx.plugin(CodingPlugin, {
      ...report,
      workspace: f.repo,
      indexDirectory: join(f.home, "index"),
    });
    const prefix = c.source.slice(0, c.source.lastIndexOf(c.token)).split("\n");
    const position = {
      line: prefix.length - 1,
      character: prefix.at(-1)!.length,
    };
    const signal = AbortSignal.timeout(30000);
    async function query(
      operation:
        | "goToDefinition"
        | "findReferences"
        | "hover"
        | "goToImplementation",
      at = position,
    ) {
      for (let retry = 0; ; retry++) {
        try {
          return await ctx.lsp.query(
            {
              operation,
              filePath: c.file,
              workspaceRoot: f.repo,
              position: at,
            },
            signal,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "content modified" ||
            retry >= 20
          )
            throw error;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    let result;
    for (let i = 0; i < 40; i++) {
      result = await query("goToDefinition");
      if (result.kind === "locations" && result.locations.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(result?.kind).toBe("locations");
    if (result?.kind === "locations")
      expect(result.locations[0]?.uri).toContain(c.file);
    const refs = await query("findReferences");
    expect(
      refs.kind === "locations" && refs.locations.length,
    ).toBeGreaterThanOrEqual(2);
    const hover = await query("hover");
    expect(hover.kind === "hover" && hover.hover?.contents).toBeTruthy();
    const shape = c.source.slice(0, c.source.indexOf("Shape")).split("\n");
    const implementation = await query("goToImplementation", {
      line: shape.length - 1,
      character: shape.at(-1)!.length,
    });
    expect(
      implementation.kind === "locations" && implementation.locations.length,
    ).toBeGreaterThan(0);
    writeFileSync(join(f.repo, c.file), c.source.replaceAll(c.token, "Triple"));
    const changed = await query("hover");
    expect(changed.kind === "hover" && changed.hover?.contents).toContain(
      "Triple",
    );
    await ctx.fiber.dispose();
    contexts.splice(contexts.indexOf(ctx), 1);
    expect(spawn.mock.results.length).toBeGreaterThan(0);
    for (const call of spawn.mock.results)
      if (call.type === "return")
        await expect(call.value.done).resolves.toBeDefined();
  },
  45000,
);
it("executes the model-facing grep through Harness and reports capped output honestly", async () => {
  const f = setup();
  writeFileSync(join(f.repo, "many.txt"), "needle\n".repeat(300));
  const report = await inspectCodingTools(f.home, f.repo);
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalSubprocess);
  await ctx.plugin(LocalFs, { cwd: f.repo });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CodingPlugin, {
    ...report,
    workspace: f.repo,
    indexDirectory: join(f.home, "index"),
  });
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: "grep-probe" as never,
    name: "grep",
    arguments: { pattern: "needle" },
    agent: { session: { header: { cwd: f.repo } } } as never,
  });
  expect(result.isError, JSON.stringify(result)).toBe(false);
  expect(JSON.stringify(result)).toContain("Found 250 of 300 matches");
  expect(JSON.stringify(result)).toContain("could not");
});
it("cancels a running search process, rather than only rejecting a pre-aborted call", async () => {
  const f = setup();
  const slow = join(f.home, "slow-tgrep");
  writeFileSync(slow, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalSubprocess);
  const spawn = vi.spyOn(ctx.subprocess, "spawn");
  const search = new TgrepSearch(ctx, {
    tgrep: slow,
    workspace: f.repo,
    indexDirectory: join(f.home, "index"),
    indexed: false,
  });
  const abort = new AbortController();
  const done = search.search({ pattern: "needle" }, { signal: abort.signal });
  const rejection = done.then(
    () => new Error("Unexpected completion"),
    (error) => error,
  );
  for (let i = 0; i < 100 && !spawn.mock.results.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(spawn.mock.results.length).toBe(1);
  abort.abort();
  expect(await rejection).toBeInstanceOf(Error);
  await expect(spawn.mock.results[0]!.value.done).resolves.toBeDefined();
}, 10000);
it("reaps the language server after its exact Harness owner is killed", async () => {
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { identity, marked, terminate } = await import(
    "../packages/shared/src/process.js"
  );
  const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  const marker = randomUUID();
  const id = identity(owner.pid!)!;
  expect(id).toBeDefined();
  const wrapper = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist/lsp-launcher.js"),
      JSON.stringify(id),
      marker,
      process.execPath,
      "-e",
      "setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  const exit = new Promise((r) => wrapper.once("exit", r));
  try {
    for (let i = 0; i < 100 && marked(marker).length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(marked(marker).length).toBeGreaterThan(0);
    owner.kill("SIGKILL");
    await exit;
    expect(marked(marker)).toEqual([]);
  } finally {
    owner.kill("SIGKILL");
    wrapper.kill("SIGKILL");
    await terminate(marker, []);
  }
}, 10000);
it("preserves selected Rust toolchains and reports an absent one without automatic installation", async () => {
  const f = setup(["rust"]);
  const before = process.env.RUSTUP_TOOLCHAIN;
  process.env.RUSTUP_TOOLCHAIN = "worker-intentionally-missing-toolchain";
  try {
    const report = await inspectCodingTools(f.home, f.repo);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.tool === "rust")?.error).toContain(
      "worker-intentionally-missing-toolchain",
    );
    expect(report.checks.find((c) => c.tool === "rust")?.error).toMatch(
      /not installed|not a valid|invalid/,
    );
  } finally {
    if (before === undefined) delete process.env.RUSTUP_TOOLCHAIN;
    else process.env.RUSTUP_TOOLCHAIN = before;
  }
});
it("rediscovers and terminates a search after host SIGKILL without any prior child identity", async () => {
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { existsSync } = await import("node:fs");
  const { marked, terminate, alive, identity } = await import(
    "../packages/shared/src/process.js"
  );
  const f = setup();
  const ready = join(f.home, "search-ready.json");
  const slow = join(f.home, "slow-tgrep");
  writeFileSync(
    slow,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,marker:process.env.DSH_WORKER_PROCESS_TOKEN}));setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  const marker = randomUUID();
  const host = spawn(
    process.execPath,
    [
      join(process.cwd(), "tests/fixtures/search-host.mjs"),
      f.repo,
      join(f.home, "index"),
      slow,
    ],
    { env: cleanEnv([], marker), stdio: "ignore" },
  );
  const exited = new Promise((r) => host.once("exit", r));
  let childIdentity;
  try {
    for (let i = 0; i < 150 && !existsSync(ready); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(ready)).toBe(true);
    const child = JSON.parse(readFileSync(ready, "utf8"));
    // Kill before consulting process discovery, reproducing the controller scan gap.
    host.kill("SIGKILL");
    await exited;
    childIdentity = identity(child.pid);
    expect(child.marker).toBe(marker);
    expect(marked(marker).some((p) => p.pid === child.pid)).toBe(true);
    expect(await terminate(marker, [])).toEqual([]);
    if (childIdentity) expect(alive(childIdentity)).toBe(false);
  } finally {
    host.kill("SIGKILL");
    await terminate(marker, []);
    if (childIdentity && alive(childIdentity))
      process.kill(childIdentity.pid, "SIGKILL");
  }
}, 10000);
