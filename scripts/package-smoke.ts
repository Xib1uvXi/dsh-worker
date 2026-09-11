import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { managedTgrep } from "../packages/runtime/src/coding-tools.js";
import { dirname, join, resolve } from "node:path";

const exec = promisify(execFile);
const source = resolve(".");
const consumer = mkdtempSync(join(tmpdir(), "dsh-package-smoke-"));
const run = (command: string, args: string[], cwd = consumer) =>
  exec(command, args, { cwd, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
let passed = false;
try {
  const packed = JSON.parse(
    (
      await run(
        "npm",
        ["pack", "--json", "--pack-destination", consumer],
        source,
      )
    ).stdout,
  ) as { filename: string }[];
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  // Honor the user's npm script policy. A script-disabled install must not be
  // treated as evidence that the released native runtime is usable.
  await run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    ...(process.argv.includes("--offline") ? ["--offline"] : []),
    join(consumer, packed[0]!.filename),
  ]);
  const entry = join(consumer, "node_modules/@dsh-worker/worker/dist/cli.js");
  const home = join(consumer, "doctor-home");
  const tgrep =
    process.env.DSH_WORKER_TEST_TGREP ??
    managedTgrep(join(homedir(), ".dsh-worker-v2"));
  mkdirSync(dirname(managedTgrep(home)), { recursive: true });
  copyFileSync(tgrep, managedTgrep(home));
  await run("git", ["init", "-q"]);
  writeFileSync(join(consumer, ".gitignore"), "node_modules/\ndoctor-home/\n");
  writeFileSync(
    join(consumer, "probe.ts"),
    "export const answer: number = 42;\n",
  );
  const tools = JSON.parse(
    (
      await run(process.execPath, [
        entry,
        "tools",
        "--home",
        home,
        "--repo",
        consumer,
      ])
    ).stdout,
  );
  assert.equal(tools.ok, true);
  assert.equal(tools.search, "tgrep");
  assert.equal(tools.plugins.ok, true);
  assert.equal(tools.plugins.config.stats, true);
  assert.deepEqual(tools.languages, ["typescript"]);
  const composition = JSON.parse(
    (
      await run(process.execPath, [
        entry,
        "doctor",
        "--home",
        home,
        "--repo",
        consumer,
      ])
    ).stdout,
  );
  assert.equal(composition.initialized, true);
  writeFileSync(
    join(home, "plugins.json"),
    JSON.stringify({ terminal: true, ptc: "both" }),
  );
  const optional = JSON.parse(
    (
      await run(process.execPath, [
        entry,
        "doctor",
        "--home",
        home,
        "--repo",
        consumer,
      ])
    ).stdout,
  );
  assert.equal(optional.initialized, true);
  assert.equal(optional.closed, true);
  rmSync(join(home, "plugins.json"));
  const doctor = () => run(process.execPath, [entry, "doctor", "--home", home]);
  for (let i = 0; i < 2; i++) {
    const result = JSON.parse((await doctor()).stdout);
    assert.equal(result.initialized, true);
    assert.equal(result.closed, true);
    assert.equal(result.modelCalls, 0);
    assert.deepEqual(readdirSync(join(home, "doctor")), []);
  }
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    'const m=await import("@dsh-worker/worker"); for(const key of ["Controller","SdkRuntime","WorkerClient"]) if(typeof m[key]!=="function") throw new Error(key);',
  ]);
  // Remove a required persistence dependency only in this disposable install.
  // The diagnostic must preserve the actual missing module, not prescribe fs-ext.
  const sdk = createRequire(
    createRequire(entry).resolve("@deepseek-ai/dsh-sdk-client"),
  );
  const runtime = createRequire(sdk.resolve("@deepseek-ai/dsh/package.json"));
  const persistence = createRequire(
    runtime.resolve("@deepseek-ai/dsh-session-persistence-jsonl"),
  );
  const dependency = dirname(
    persistence.resolve("@deepseek-ai/dsh-session-format-v2-to-v3"),
  );
  renameSync(dependency, dependency + ".saved");
  try {
    await assert.rejects(doctor(), (error: unknown) => {
      const failure = error as { code: number; stderr: string };
      assert.equal(failure.code, 1);
      const diagnostic = JSON.parse(failure.stderr);
      assert.equal(diagnostic.code, "runtime_dependencies");
      assert.match(diagnostic.error, /session-format-v2-to-v3/);
      assert.doesNotMatch(diagnostic.error, /npm rebuild fs-ext/);
      return true;
    });
  } finally {
    renameSync(dependency + ".saved", dependency);
  }
  assert.equal(JSON.parse((await doctor()).stdout).initialized, true);
  passed = true;
  console.log(
    JSON.stringify({
      installedDoctorRuns: 5,
      codingToolsComposition: "passed",
      optionalPluginsComposition: "passed",
      missingPersistenceDependencyDiagnostic: "passed",
      publicExports: "passed",
      modelCalls: 0,
    }),
  );
} finally {
  if (passed) rmSync(consumer, { recursive: true, force: true });
  else console.error(`Package smoke evidence retained at ${consumer}`);
}
