import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseArgs } from "node:util";
import { Controller } from "../packages/core/src/controller.js";
import { capture, type FileCache } from "../packages/core/src/git.js";
import { ticketSchema } from "../packages/contracts/src/index.js";

const { values } = parseArgs({
  options: {
    files: { type: "string", default: "5000" },
    samples: { type: "string", default: "7" },
    label: { type: "string", default: "current" },
    baseline: { type: "string" },
  },
});
const files = Number(values.files),
  samples = Number(values.samples);
assert(Number.isInteger(files) && files > 0 && files <= 20000);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 30);
const root = mkdtempSync(join(tmpdir(), "dsh-benchmark-"));
const repo = join(root, "repo");
const original = childProcess.execFileSync;
const git = (...args: string[]) =>
  original("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let controller: Controller | undefined;
try {
  mkdirSync(repo);
  git("init");
  git("config", "user.email", "benchmark@example.invalid");
  git("config", "user.name", "Benchmark");
  mkdirSync(join(repo, "files"));
  for (let i = 0; i < files; i++)
    writeFileSync(join(repo, "files", `${i}.txt`), `baseline ${i}\n`);
  git("add", ".");
  git("commit", "-m", "fixture");
  const ticket = ticketSchema.parse({
    schemaVersion: 2,
    ticketId: "BENCH",
    revision: 1,
    title: "Snapshot benchmark",
    targetRepo: repo,
    baseCommit: git("rev-parse", "HEAD"),
    objective: "Measure snapshot reads",
    scope: { paths: ["files/0.txt"] },
    acceptance: [{ id: "AC1", description: "Keep exact evidence" }],
    verification: [{ args: [process.execPath, "-e", ""] }],
    execution: { provider: "unused", model: "unused" },
  });
  controller = new Controller({
    home: join(root, "home"),
    runtime: {
      execute() {
        throw new Error("Benchmark must not dispatch");
      },
    },
  });
  const record = controller.prepare(ticket);
  writeFileSync(join(record.worktree, "files/0.txt"), "changed\n");
  const expected = capture(record);
  const implementations: {
    name: string;
    capture: typeof capture;
    cache: FileCache;
  }[] = [{ name: "current", capture, cache: new Map() }];
  if (values.baseline) {
    const source = original(
      "git",
      ["show", `${values.baseline}:packages/core/src/git.ts`],
      { encoding: "utf8" },
    ).replaceAll('from "./util.js"', 'from "../../shared/src/util.js"');
    const bundled = await build({
      stdin: {
        contents: source,
        resolveDir: resolve("packages/core/src"),
        sourcefile: "baseline-git.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      packages: "external",
    });
    const path = join(root, "baseline.mjs");
    writeFileSync(path, bundled.outputFiles[0]!.contents);
    const baseline = (await import(pathToFileURL(path).href)) as {
      capture: typeof capture;
    };
    implementations.unshift({
      name: "baseline",
      capture: baseline.capture,
      cache: new Map(),
    });
  }
  const modes = ["exact", "cached", "evidence"] as const;
  const cases = implementations.flatMap((implementation) =>
    modes.map((mode) => ({
      name: `${implementation.name}/${mode}`,
      implementation,
      mode,
    })),
  );
  const variants = cases.map((c) => c.name);
  const results = Object.fromEntries(
    variants.map((name) => [
      name,
      [] as { ms: number; gitMs: number; gitCalls: number }[],
    ]),
  );
  let active: { ms: number; gitMs: number; gitCalls: number } | undefined;
  childProcess.execFileSync = ((...args: Parameters<typeof original>) => {
    const started = performance.now();
    try {
      return original(...args);
    } finally {
      if (active && args[0] === "git") {
        active.gitCalls++;
        active.gitMs += performance.now() - started;
      }
    }
  }) as typeof original;
  syncBuiltinESMExports();
  // Warm each variant, then rotate ordering to reduce filesystem/order bias.
  for (let round = -1; round < samples; round++) {
    for (let offset = 0; offset < variants.length; offset++) {
      const name = variants[(Math.max(round, 0) + offset) % variants.length]!;
      const reading = { ms: 0, gitMs: 0, gitCalls: 0 };
      active = reading;
      const started = performance.now();
      const variant = cases.find((c) => c.name === name)!;
      const snapshot = variant.implementation.capture(
        record,
        variant.mode === "evidence"
          ? join(root, "evidence", variant.implementation.name)
          : undefined,
        variant.mode === "cached" ? variant.implementation.cache : undefined,
      );
      reading.ms = performance.now() - started;
      active = undefined;
      assert.equal(
        snapshot.digest,
        expected.digest,
        "Ablation changed snapshot identity",
      );
      if (round >= 0) results[name]!.push(reading);
    }
  }
  const stats = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return {
      median: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)),
      p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(2)),
    };
  };
  console.log(
    JSON.stringify(
      {
        label: values.label,
        baseline: values.baseline ?? null,
        baselineUtilities:
          "Shared utilities from current checkout; compare Git collector only",
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        files,
        samples,
        scope:
          "Warm filesystem; one changed file; exact digest equality; no model requests",
        results: Object.fromEntries(
          variants.map((name) => [
            name,
            {
              wallMs: stats(results[name]!.map((x) => x.ms)),
              gitMs: stats(results[name]!.map((x) => x.gitMs)),
              gitCalls: [...new Set(results[name]!.map((x) => x.gitCalls))],
              samples: results[name],
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  childProcess.execFileSync = original;
  syncBuiltinESMExports();
  await controller?.close();
  rmSync(root, { recursive: true, force: true });
}
