import { homedir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { evidenceBrief } from "../packages/core/src/evidence.js";
import { SdkRuntime } from "../packages/runtime/src/adapter.js";
import {
  credentialPatch,
  taskEnvironment,
} from "../packages/runtime/src/credentials.js";
import { executeCommand } from "../packages/runtime/src/commands.js";
import { commandSchema } from "../packages/contracts/src/index.js";
import { redactor } from "../packages/shared/src/redaction.js";
import { marked } from "../packages/shared/src/process.js";
import { hash } from "../packages/shared/src/util.js";
import { randomUUID } from "node:crypto";
import { fixture, FakeRuntime } from "./helpers.js";
const controllers: Controller[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of controllers.splice(0)) await c.close();
});
const node = (script: string) =>
  commandSchema.parse({
    args: [process.execPath, "-e", script],
    timeoutSeconds: 5,
  });
function setup(runtime = new FakeRuntime()) {
  const f = fixture();
  const c = new Controller({ home: f.home, dispatchEnabled: true, runtime });
  controllers.push(c);
  return { ...f, c, runtime };
}
it("runs setup before the worker and verification, keeping setup separate from immutable baseline comparisons", async () => {
  const s = setup();
  writeFileSync(join(s.repo, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["-C", s.repo, "add", ".gitignore"]);
  execFileSync("git", ["-C", s.repo, "commit", "-m", "ignore dependencies"]);
  s.ticket.baseCommit = execFileSync(
    "git",
    ["-C", s.repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  s.ticket.setup = [
    node(
      "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ready','ok');console.log('setup-evidence')",
    ),
  ];
  s.runtime.handler = async (req) => {
    expect(readFileSync(join(req.worktree, "node_modules/ready"), "utf8")).toBe(
      "ok",
    );
    return {};
  };
  s.ticket.verification = [
    node(
      "process.exit(require('fs').readFileSync('source.txt','utf8')==='implemented\\n'?1:0)",
    ),
    node("process.exit(2)"),
    node(
      "process.exit(require('fs').readFileSync('source.txt','utf8')==='implemented\\n'?0:1)",
    ),
    node("process.exit(0)"),
  ];
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  let result = await s.c.wait(s.ticket.ticketId);
  expect(result.state, result.error).toBe("awaiting_review");
  const baseline = structuredClone(result.verificationBaselines![0]!);
  expect(baseline.comparable).toBe(true);
  expect(result.attempts[0]!.setup?.commands[0]!.output).toContain(
    "setup-evidence",
  );
  s.c.verify(s.ticket.ticketId);
  result = await s.c.wait(s.ticket.ticketId);
  expect(result.verifications[0]!.commands.map((c) => c.comparison)).toEqual([
    "regressed",
    "pre-existing",
    "pass",
    "pass",
  ]);
  expect(result.verifications[0]!.passed).toBe(false);
  expect(result.verifications[0]!.setup?.passed).toBe(true);
  expect(result.verificationBaselines![0]).toEqual(baseline);
  expect(
    evidenceBrief(result).verification!.commands[0]!.confinement?.mode,
  ).toBe("workspace-write");
  expect(baseline.worktree).not.toBe(result.worktree);
});
it("persists failed setup without sending a model prompt", async () => {
  const s = setup();
  s.ticket.setup = [node("console.log('bootstrap failed');process.exit(7)")];
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const result = await s.c.wait(s.ticket.ticketId);
  expect(result.state, result.error).toBe("blocked");
  expect(result.activeOperation).toBeUndefined();
  expect(result.attempts[0]!.setup?.commands[0]!.exitCode).toBe(7);
  expect(result.attempts[0]!.receipt).toBe(false);
  expect(result.attempts[0]!.cleanExit).toBe(true);
  expect(s.runtime.count).toBe(0);
});
it("persists verification setup progress when a later command cannot start", async () => {
  const s = setup();
  writeFileSync(join(s.repo, ".gitignore"), "bootstrap/\n");
  execFileSync("git", ["-C", s.repo, "add", ".gitignore"]);
  execFileSync("git", ["-C", s.repo, "commit", "-m", "ignore bootstrap"]);
  s.ticket.baseCommit = execFileSync(
    "git",
    ["-C", s.repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  s.ticket.setup = [
    node(
      "const fs=require('fs');fs.mkdirSync('bootstrap',{recursive:true});if(fs.readFileSync('source.txt','utf8')==='implemented\\n')fs.rmSync('bootstrap',{recursive:true});console.log('completed-setup-evidence')",
    ),
    { ...node("console.log('second command')"), cwd: "bootstrap" },
  ];
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  expect((await s.c.wait(s.ticket.ticketId)).state).toBe("awaiting_review");
  s.c.verify(s.ticket.ticketId);
  const result = await s.c.wait(s.ticket.ticketId);
  expect(result.state).toBe("interrupted");
  const verification = result.verifications[0]!;
  expect(verification.setup?.commands).toHaveLength(1);
  expect(verification.setup?.commands[0]?.output).toContain(
    "completed-setup-evidence",
  );
  expect(verification.setup?.passed).toBe(false);
  expect(verification.commands).toEqual([]);
  expect(
    s.c.store.events(0, 10000).filter((e) => e.type === "verification.setup")
      .length,
  ).toBeGreaterThanOrEqual(2);
});
it("confines controller commands, preserves marker accounting, and redacts split output", async () => {
  const s = fixture();
  const marker = randomUUID();
  const protectedDir = mkdtempSync(join(homedir(), ".dsh-worker-confinement-"));
  const outside = join(protectedDir, "outside.txt");
  const workspace = join(s.repo, "nested");
  mkdirSync(workspace);
  process.env.WORKER_TEST_SECRET = "secret-with-unicode-🙂-end";
  try {
    const result = await executeCommand(
      node(
        `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{console.log('denied')}fs.writeFileSync('inside','ok');const value=process.env.WORKER_TEST_SECRET;process.stdout.write(value.slice(0,10));setTimeout(()=>process.stdout.write(value.slice(10)),50)`,
      ),
      workspace,
      { ...s.ticket.execution, envRequired: ["WORKER_TEST_SECRET"] },
      marker,
      new AbortController().signal,
      () => {},
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(workspace, "inside"))).toBe(true);
    expect(result.output).toContain("[REDACTED:WORKER_TEST_SECRET]");
    expect(result.output).not.toContain("secret-with");
    expect(marked(marker)).toEqual([]);
  } finally {
    delete process.env.WORKER_TEST_SECRET;
    rmSync(protectedDir, { recursive: true });
  }
});
it("separates credential references from tool environment and redacts nested and chunked evidence", () => {
  const s = fixture();
  process.env.DEEPSEEK_API_KEY = "synthetic-provider-key";
  try {
    const execution = {
      ...s.ticket.execution,
      envRequired: ["DEEPSEEK_API_KEY"],
    };
    expect(taskEnvironment(execution).DEEPSEEK_API_KEY).toBeUndefined();
    const patch = credentialPatch(execution, join(s.home, "private"))!;
    expect(readFileSync(patch, "utf8")).not.toContain(
      process.env.DEEPSEEK_API_KEY,
    );
    const conf = JSON.parse(readFileSync(patch, "utf8"))[0].config;
    expect(
      JSON.parse(readFileSync(conf.path, "utf8")).refs.DEEPSEEK_API_KEY,
    ).toBe(process.env.DEEPSEEK_API_KEY);
    const redact = redactor(["DEEPSEEK_API_KEY"]);
    expect(redact.value({ nested: [process.env.DEEPSEEK_API_KEY] })).toEqual({
      nested: ["[REDACTED:DEEPSEEK_API_KEY]"],
    });
    expect(
      redact.value({
        stream: [{ texts: ["prefix synthetic-", "provider-", "key suffix"] }],
      }),
    ).toEqual({
      stream: [
        { texts: ["prefix [REDACTED:DEEPSEEK_API_KEY]", "", " suffix"] },
      ],
    });
    expect(redact.value(["", "synthetic-", "", "provider-key", ""])).toEqual([
      "",
      "[REDACTED:DEEPSEEK_API_KEY]",
      "",
      "",
      "",
    ]);
    let output = "";
    const stream = redact.stream((text) => {
      output += text;
    });
    for (const character of process.env.DEEPSEEK_API_KEY)
      stream.write(Buffer.from(character));
    stream.end();
    expect(output).toBe("[REDACTED:DEEPSEEK_API_KEY]");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});
it("resumes a blocked conversation through the actual SDK and persistence with a new attempt owner", async () => {
  const f = fixture();
  vi.stubEnv("DEEPSEEK_API_KEY", "fixture-only-provider-secret");
  f.ticket.execution.credentialEnv = ["DEEPSEEK_API_KEY"];
  const patch = join(f.root, "provider.patch.json");
  writeFileSync(
    patch,
    JSON.stringify([
      {
        insert: [
          {
            id: "lifecycle-provider",
            name: resolve("tests/fixtures/lifecycle-provider.mjs"),
            config: { trace: join(f.root, "messages.json") },
          },
        ],
      },
    ]),
  );
  f.ticket.execution.patches = [patch];
  f.ticket.execution.timeoutSeconds = 30;
  const c = new Controller({
    home: f.home,
    dispatchEnabled: true,
    runtime: new SdkRuntime(),
  });
  controllers.push(c);
  c.prepare(f.ticket);
  c.run(f.ticket.ticketId);
  const blocked = await c.wait(f.ticket.ticketId);
  expect(blocked.state, JSON.stringify(blocked.attempts.at(-1))).toBe(
    "blocked",
  );
  const old = blocked.attempts[0]!;
  expect(old.delivery?.summary).toBe("prior-investigation-7419");
  const journal = JSON.stringify(c.store.events(0, 10000));
  const runtimeEvents = readFileSync(
    join(f.home, "runs", old.id, "events.jsonl"),
    "utf8",
  );
  for (const evidence of [journal, runtimeEvents]) {
    expect(evidence).not.toContain("fixture-only");
    expect(evidence).not.toContain("-provider-secret");
    expect(evidence).toContain("[REDACTED:DEEPSEEK_API_KEY]");
    expect(evidence).toContain('"texts"');
  }
  expect(old.delivery?.commands[0]?.result).toBe("[REDACTED:DEEPSEEK_API_KEY]");
  expect(existsSync(join(f.home, "runs", old.id, "credentials"))).toBe(false);
  const answerInput = {
    kind: "answer",
    ticketId: f.ticket.ticketId,
    revision: 1,
    attemptId: old.id,
    snapshotDigest: old.snapshot!.digest,
    instruction: "Choose X",
  };
  await expect(c.recover({ ...answerInput, revision: 2 })).rejects.toThrow(
    /match/,
  );
  await expect(
    c.recover({ ...answerInput, snapshotDigest: "f".repeat(64) }),
  ).rejects.toThrow(/stale/);
  await c.recover(answerInput);
  expect(c.status(f.ticket.ticketId).attempts).toHaveLength(1);
  c.run(f.ticket.ticketId);
  const resumed = await c.wait(f.ticket.ticketId);
  expect(resumed.state, JSON.stringify(resumed.attempts.at(-1))).toBe(
    "awaiting_review",
  );
  const next = resumed.attempts[1]!;
  expect(next.id).not.toBe(old.id);
  expect(next.marker).not.toBe(old.marker);
  expect(next.sessionId).toBe(old.sessionId);
  expect(next.resumedFrom).toBe(old.id);
  const execution = JSON.parse(
    readFileSync(join(f.home, "runs", next.id, "execution.json"), "utf8"),
  );
  const request = JSON.parse(
    readFileSync(join(f.home, "runs", next.id, "request.json"), "utf8"),
  );
  expect(execution.promptHash).toBe(hash(request.prompt));
  expect(execution.deadlineAt).toBe(next.deadlineAt);
  expect(next.delivery?.summary).toContain("Resumed prior-investigation-7419");
  expect(marked(old.marker)).toEqual([]);
  expect(marked(next.marker)).toEqual([]);
  c.verify(f.ticket.ticketId);
  const verified = await c.wait(f.ticket.ticketId);
  expect(verified.verifications.at(-1)?.passed).toBe(true);
  c.prepare({ ...f.ticket, revision: 2 });
  c.run(f.ticket.ticketId);
  const revised = await c.wait(f.ticket.ticketId);
  expect(revised.attempts.at(-1)?.sessionId).not.toBe(old.sessionId);
  expect(revised.attempts.at(-1)?.resumedFrom).toBeUndefined();
  expect(revised.verificationBaselines).toHaveLength(2);
}, 90000);

it("keeps unsent instructions queued when setup is cancelled", async () => {
  const s = setup();
  s.ticket.setup = [node("setTimeout(()=>{},10000)")];
  s.c.prepare(s.ticket);
  await s.c.action({
    action: "instruct",
    ticketId: s.ticket.ticketId,
    revision: 1,
    instructionId: "before-setup",
    instruction: "Preserve this unsent instruction",
  });
  s.c.run(s.ticket.ticketId);
  await expect
    .poll(
      () => s.c.store.get(s.ticket.ticketId).attempts[0]?.processes.length,
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
  const cancelled = await s.c.cancel(s.ticket.ticketId);
  expect(cancelled.state).toBe("interrupted");
  expect(cancelled.instructions?.[0]?.status).toBe("queued");
  expect(cancelled.instructions?.[0]?.attemptId).toBeUndefined();
  expect(s.runtime.count).toBe(0);
  expect(marked(cancelled.attempts[0]!.marker)).toEqual([]);
});
