import { expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { Controller } from "../packages/core/src/controller.js";
import { startHttp } from "../packages/server/src/http.js";
import { fixture, FakeRuntime } from "./helpers.js";
import type {
  TicketView,
  EvidenceBrief,
  TrajectoryPage,
  JournalPage,
} from "../packages/contracts/src/index.js";
import { runtimeSchema } from "../packages/contracts/src/index.js";
import type {
  summary,
  errors,
  diagnose,
  health,
} from "../packages/cli/src/diagnostics.js";
type Summary = ReturnType<typeof summary>;
type Issues = ReturnType<typeof errors>;
type Diagnosis = ReturnType<typeof diagnose>;
type Health = Awaited<ReturnType<typeof health>>;
const command = resolve("dist/cli.js");
function invoke<T = TicketView>(home: string, args: string[], input?: unknown) {
  return new Promise<{ code: number | null; value: T; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [command, ...args, "--home", home],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (v) => (stdout += v));
      child.stderr.on("data", (v) => (stderr += v));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          resolve({
            code,
            value: (stdout ? JSON.parse(stdout) : undefined) as T,
            stderr,
          });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(
        input === undefined
          ? undefined
          : typeof input === "string"
            ? input
            : JSON.stringify(input),
      );
    },
  );
}
async function setup() {
  const f = fixture();
  const runtime = new FakeRuntime();
  const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  const http = await startHttp(c, {
    port: 0,
    token: "cli-fixture",
    webDir: resolve("dist/web"),
  });
  writeFileSync(
    join(f.home, "service.json"),
    JSON.stringify({ url: http.url, token: "cli-fixture" }),
  );
  return {
    ...f,
    runtime,
    c,
    http,
    cli: <T = TicketView>(args: string[], input?: unknown) =>
      invoke<T>(f.home, args, input),
    close: async () => {
      await http.close();
      await c.close();
    },
  };
}
it.each([undefined, "deepseek-v4-flash"])(
  "prepares and dispatches the default or explicit worker model (%s)",
  async (model) => {
    const s = await setup();
    try {
      const input = {
        ...s.ticket,
        execution: { ...s.ticket.execution, model },
      };
      const expected = model ?? "deepseek-v4-pro";
      const prepared = await s.cli(["prepare", "--file", "-"], input);
      expect(prepared.code, prepared.stderr).toBe(0);
      expect(prepared.value.ticket.execution.model).toBe(expected);
      expect(s.c.store.get(s.ticket.ticketId).ticket.execution.model).toBe(
        expected,
      );
      let dispatched: string | undefined;
      s.runtime.handler = async (request) => {
        dispatched = request.ticket.execution.model;
        return {};
      };
      s.c.run(s.ticket.ticketId);
      expect((await s.c.wait(s.ticket.ticketId)).state).toBe("awaiting_review");
      expect(dispatched).toBe(expected);
    } finally {
      await s.close();
    }
  },
  15000,
);
it.each(["", "   ", null])(
  "rejects an invalid explicit model (%s)",
  (model) => {
    expect(
      runtimeSchema.safeParse({ provider: "deepseek-official", model }).success,
    ).toBe(false);
  },
);
it("diagnoses failed attempts without mutations and retains history after successful recovery", async () => {
  const s = await setup();
  try {
    s.runtime.handler = async () => ({ finalResponse: "Missing delivery" });
    s.c.prepare(s.ticket);
    s.c.run(s.ticket.ticketId);
    const failed = await s.c.wait(s.ticket.ticketId);
    const before = failed.updatedAt;
    const status = await s.cli<Summary>([
      "status",
      s.ticket.ticketId,
      "--summary",
    ]);
    expect(status.value.state).toBe("interrupted");
    expect(status.value).not.toHaveProperty("ticket");
    expect(status.value.attempt!.cleanExit).toBe(true);
    const report = await s.cli<Diagnosis>(["diagnose", s.ticket.ticketId]);
    expect(report.code).toBe(1);
    expect(report.value.nextSteps[0]!.argv).toContain("recover");
    const issues = await s.cli<Issues>([
      "errors",
      s.ticket.ticketId,
      "--attempt",
      failed.attempts[0]!.id,
    ]);
    expect(issues.code).toBe(0);
    expect(
      issues.value.issues.some((e) => e.message.includes("Delivery")),
    ).toBe(true);
    expect(s.c.status(s.ticket.ticketId).updatedAt).toBe(before);
    expect(s.runtime.count).toBe(1);
    const wrong = await s.cli([
      "errors",
      s.ticket.ticketId,
      "--attempt",
      "foreign",
    ]);
    expect(JSON.parse(wrong.stderr).code).toBe("attempt_not_found");
    await s.c.recover({
      ticketId: s.ticket.ticketId,
      revision: 1,
      attemptId: failed.attempts[0]!.id,
      snapshotDigest: failed.currentSnapshot,
      instruction: "Return valid delivery",
    });
    s.runtime.handler = undefined;
    s.c.run(s.ticket.ticketId);
    await s.c.wait(s.ticket.ticketId);
    const current = await s.cli<Diagnosis>(["diagnose", s.ticket.ticketId]);
    expect(current.code).toBe(0);
    expect(current.value.status.state).toBe("awaiting_review");
    expect(current.value.errors.count).toBeGreaterThan(0);
    expect(current.value.nextSteps[0]!.argv).toContain("verify");
    const list = await s.cli<{ tickets: Summary[] }>(["list", "--summary"]);
    expect(list.value.tickets[0]!.ticketId).toBe(s.ticket.ticketId);
    expect(list.value.tickets[0]).not.toHaveProperty("attempts");
  } finally {
    await s.close();
  }
}, 20000);
it("reports actual verification exit/output with explicit truncation and full stored output", async () => {
  const s = await setup();
  try {
    s.ticket.verification = [
      {
        args: [
          process.execPath,
          "-e",
          "process.stdout.write('x'.repeat(5000)+'VERIFICATION_FAILED');process.exit(7)",
        ],
        cwd: ".",
        timeoutSeconds: 10,
      },
    ];
    s.c.prepare(s.ticket);
    s.c.run(s.ticket.ticketId);
    await s.c.wait(s.ticket.ticketId);
    s.c.verify(s.ticket.ticketId);
    await s.c.wait(s.ticket.ticketId);
    const short = await s.cli<Issues>(["errors", s.ticket.ticketId]);
    const e = short.value.issues.find((e) => e.exitCode === 7)!;
    expect(e.output!.length).toBe(4000);
    expect(e.output).toContain("VERIFICATION_FAILED");
    expect(e.outputTruncated).toBe(true);
    const full = await s.cli<Issues>(["errors", s.ticket.ticketId, "--full"]);
    const f = full.value.issues.find((e) => e.exitCode === 7)!;
    expect(f.output!.length).toBeGreaterThan(5000);
    expect(f.outputTruncated).toBe(false);
    expect((await s.cli<Diagnosis>(["diagnose", s.ticket.ticketId])).code).toBe(
      1,
    );
  } finally {
    await s.close();
  }
}, 15000);
it("health distinguishes missing discovery and authentication failure without exposing tokens", async () => {
  const invalid = await invoke(join(fixture().root, "not-started"), ["status"]);
  expect(JSON.parse(invalid.stderr).code).toBe("invalid_contract");
  const missing = await invoke<Health>(join(fixture().root, "not-started"), [
    "health",
  ]);
  expect(missing.code).toBe(1);
  expect(missing.value.checks.some((c) => c.code === "service_missing")).toBe(
    true,
  );
  const s = await setup();
  try {
    // Upgrade leftovers must not override the current controller's ownership.
    writeFileSync(
      join(s.home, "service.lock"),
      JSON.stringify({ pid: 99999999, start: "dead" }),
    );
    const healthy = await s.cli<Health>(["health"]);
    const malformed = await s.cli(["prepare", "--file", "-"], "{");
    expect(JSON.parse(malformed.stderr).code).toBe("invalid_json");
    expect(healthy.code).toBe(0);
    expect(healthy.value.checks.find((c) => c.name === "owner")?.status).toBe(
      "pass",
    );
    expect(healthy.value.service!.active).toBe(0);
    expect(JSON.stringify(healthy.value)).not.toContain("cli-fixture");
    writeFileSync(
      join(s.home, "service.json"),
      JSON.stringify({ url: s.http.url, token: "incorrect-secret" }),
    );
    const auth = await s.cli<Health>(["health"]);
    expect(auth.code).toBe(1);
    expect(auth.value.checks.some((c) => c.code === "unauthorized")).toBe(true);
    expect(JSON.stringify(auth.value)).not.toContain("incorrect-secret");
    const state = await s.cli(["status", s.ticket.ticketId]);
    expect(JSON.parse(state.stderr).code).toBe("unauthorized");
    writeFileSync(join(s.home, "service.json"), "broken");
    const corrupt = await s.cli<Health>(["health"]);
    expect(corrupt.value.checks.some((c) => c.code === "service_config")).toBe(
      true,
    );
  } finally {
    await s.close();
  }
}, 15000);
it.each([false, true])(
  "retains verification exceptions after recovery (prior command: %s)",
  async (prior) => {
    const s = await setup();
    try {
      s.ticket.verification = [
        ...(prior
          ? [
              {
                args: [process.execPath, "-e", "process.exit(0)"],
                cwd: ".",
                timeoutSeconds: 10,
              },
            ]
          : []),
        {
          args: [process.execPath, "-e", "process.exit(0)"],
          cwd: "missing-directory",
          timeoutSeconds: 10,
        },
      ];
      s.c.prepare(s.ticket);
      s.c.run(s.ticket.ticketId);
      await s.c.wait(s.ticket.ticketId);
      s.c.verify(s.ticket.ticketId);
      const failed = await s.c.wait(s.ticket.ticketId);
      expect(failed.state).toBe("interrupted");
      const attempt = failed.attempts.at(-1)!;
      const report = await s.cli<Issues>([
        "errors",
        s.ticket.ticketId,
        "--attempt",
        attempt.id,
      ]);
      expect(
        report.value.issues.some(
          (e) =>
            e.source === "verification" &&
            e.message.includes("missing-directory"),
        ),
      ).toBe(true);
      expect(s.c.overview().active).toBe(0);
      await s.c.recover({
        ticketId: s.ticket.ticketId,
        revision: 1,
        attemptId: attempt.id,
        snapshotDigest: failed.currentSnapshot,
        instruction: "Fix verification configuration before another attempt",
      });
      expect(s.c.status(s.ticket.ticketId).error).toBeUndefined();
      const history = await s.cli<Issues>(["errors", s.ticket.ticketId]);
      expect(
        history.value.issues.some(
          (e) =>
            e.source === "verification" &&
            e.message.includes("missing-directory"),
        ),
      ).toBe(true);
    } finally {
      await s.close();
    }
  },
  15000,
);
it("CLI + skill handles preparation, instructions, verification, review, artifacts and archive without protocol registration", async () => {
  const s = await setup();
  try {
    const skill = await s.cli<{ path: string; content: string }>(["skill"]);
    expect(skill.code).toBe(0);
    expect(skill.value.content).toContain("CLI");
    expect(readFileSync(skill.value.path, "utf8")).toBe(skill.value.content);
    expect((await s.cli(["workflow"])).code).toBe(0);
    expect(
      (await s.cli(["prepare", "--file", "-"], s.ticket)).value.state,
    ).toBe("ready");
    const file = join(s.root, "instruction.txt");
    const text =
      "Keep `literal backticks` and $(literal substitution) as text.\n保持换行。";
    writeFileSync(file, text);
    const args = [
      "instruct",
      s.ticket.ticketId,
      "--instruction-file",
      file,
      "--revision",
      "1",
      "--instruction-id",
      "note-1",
    ];
    expect((await s.cli(args)).value.instructions![0]!.text).toBe(text);
    expect((await s.cli(args)).value.instructions).toHaveLength(1);
    expect(
      (
        await s.cli(["instruct", s.ticket.ticketId, "--file", "-"], {
          revision: 1,
          instructionId: "note-1",
          instruction: "conflict",
        })
      ).code,
    ).toBe(1);
    expect(
      (
        await s.cli(["instruct", s.ticket.ticketId, "--file", "-"], {
          revision: 1,
          instructionId: "note-2",
          instruction: "hello",
          ticketId: "OTHER",
        })
      ).code,
    ).toBe(1);
    s.runtime.handler = async (req) => {
      expect(req.prompt).toContain(text);
      return {};
    };
    const run = await s.cli([
      "run",
      s.ticket.ticketId,
      "--wait",
      "--timeout",
      "10",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.value.state).toBe("awaiting_review");
    const verified = await s.cli(["verify", s.ticket.ticketId, "--wait"]);
    expect(verified.value.verifications[0]!.passed).toBe(true);
    const a = verified.value.attempts[0]!;
    const review = {
      schemaVersion: 2,
      ticketId: s.ticket.ticketId,
      revision: 1,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      spec: { verdict: "pass", findings: [] },
      standards: { verdict: "pass", findings: [] },
      verdict: "accept",
      findings: [],
      reviewer: "CLI acceptance fixture",
    };
    expect((await s.cli(["review", "--file", "-"], review)).value.state).toBe(
      "accepted",
    );
    const digest = a.snapshot!.files.find(
      (f: { path: string }) => f.path === "source.txt",
    )!.hash!;
    const output = join(s.root, "artifact.txt");
    expect((await s.cli(["artifact", digest, "--output", output])).code).toBe(
      0,
    );
    expect(readFileSync(output, "utf8")).toBe("implemented\n");
    expect((await s.cli(["artifact", digest, "--output", output])).code).toBe(
      1,
    );
    expect((await s.cli(["archive", s.ticket.ticketId])).value.archived).toBe(
      true,
    );
    expect((await s.cli(["restore", s.ticket.ticketId])).value.archived).toBe(
      false,
    );
    expect((await s.cli(["status", s.ticket.ticketId])).value.state).toBe(
      "accepted",
    );
  } finally {
    await s.close();
  }
}, 25000);
it("CLI wait timeout leaves execution running; cancel and explicit recovery preserve control", async () => {
  const s = await setup();
  try {
    s.runtime.handler = async (_req, signal) => {
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
      return { termination: "cancelled" };
    };
    await s.cli(["prepare", "--file", "-"], s.ticket);
    await s.cli(["run", s.ticket.ticketId]);
    const timed = await s.cli([
      "wait",
      s.ticket.ticketId,
      "--brief",
      "--timeout",
      "0.01",
    ]);
    expect(timed.code).toBe(1);
    expect(timed.stderr).toContain("execution continues");
    expect(s.c.status(s.ticket.ticketId).state).toBe("running");
    expect(s.runtime.count).toBe(1);
    expect((await s.cli(["cancel", s.ticket.ticketId])).value.state).toBe(
      "interrupted",
    );
    const inspected = await s.cli<ReturnType<Controller["recovery"]>>([
      "recover",
      s.ticket.ticketId,
    ]);
    const continuation = {
      ticketId: s.ticket.ticketId,
      revision: 1,
      attemptId: inspected.value.attemptId,
      snapshotDigest: inspected.value.snapshotDigest,
      instruction: "Inspect the preserved edit and continue.",
    };
    const recovered = await s.cli(["recover", "--file", "-"], continuation);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.value.state).toBe("ready");
    expect(s.runtime.count).toBe(1);
  } finally {
    await s.close();
  }
}, 20000);
it("rejects the retired protocol command without requiring a configured service", async () => {
  for (const retired of ["mcp"]) {
    await expect(
      promisify(execFile)(process.execPath, [
        command,
        retired,
        "--home",
        "/no-service",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown command"),
    });
  }
});

it("reads bounded, filtered trajectory and task events without changing durable state", async () => {
  const s = await setup();
  try {
    s.c.prepare(s.ticket);
    s.c.run(s.ticket.ticketId);
    const delivered = await s.c.wait(s.ticket.ticketId);
    const a = delivered.attempts.at(-1)!;
    const after = s.c.store.events(0, 10000).at(-1)!.seq;
    const expected: number[] = [];
    for (let i = 0; i < 13; i++) {
      s.c.store.event(s.ticket.ticketId, "harness.notification", {
        attemptId: a.id,
        notification: {
          method: "session.event",
          params: {
            sessionId: a.sessionId,
            event: {
              type: i === 12 ? "assistant/message" : "tool/call",
              data:
                i === 12
                  ? {
                      message: {
                        content: [
                          { type: "reasoning", text: "PRIVATE REASONING" },
                          { type: "text", text: "z".repeat(5000) },
                        ],
                      },
                    }
                  : {
                      callId: `call-${i}`,
                      name: "read",
                      arguments: { path: "source.txt" },
                    },
            },
          },
        },
      });
      if (i === 12) expected.push(s.c.store.events(0, 10000).at(-1)!.seq);
    }
    s.c.store.event(s.ticket.ticketId, "execution.processes", {
      private: "process bookkeeping",
    });
    s.c.store.event(s.ticket.ticketId, "harness.notification", {
      attemptId: a.id,
      notification: {
        method: "session.event",
        params: {
          sessionId: a.sessionId,
          event: {
            type: "assistant/attempt",
            data: {
              error: "visible provider failure",
              stream: [
                {
                  type: "reasoning-chunks",
                  time0: 1,
                  index: 0,
                  dt: [0],
                  texts: ["OMITTED-ATTEMPT-STREAM"],
                },
              ],
            },
          },
        },
      },
    });
    s.c.store.event(s.ticket.ticketId, "ticket.test-warning", {
      message: "Evidence only",
    });
    s.c.store.event("UNRELATED", "ticket.test-warning", {});
    const beforeRecord = s.c.store.get(s.ticket.ticketId);
    const beforeJournal = s.c.store.events(0, 10000);
    let cursor = after;
    const found = [];
    let emptyPages = 0;
    for (let n = 0; n < 10; n++) {
      const result = await s.cli<
        TrajectoryPage & { entries: { textTruncated?: boolean }[] }
      >([
        "trajectory",
        s.ticket.ticketId,
        "--after",
        String(cursor),
        "--limit",
        "5",
        "--attempt",
        a.id,
        "--kind",
        "assistant/message",
      ]);
      expect(result.code, result.stderr).toBe(0);
      const page = result.value;
      if (!page.entries.length && page.hasMore) emptyPages++;
      found.push(...page.entries);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(emptyPages).toBeGreaterThan(0);
    expect(found.map((e) => e.seq)).toEqual(expected);
    expect(found[0]!.text).toHaveLength(4000);
    expect(found[0]).toMatchObject({ textTruncated: true });
    expect(found[0]).not.toHaveProperty("raw");
    const full = await s.cli<TrajectoryPage>([
      "trajectory",
      s.ticket.ticketId,
      "--after",
      String(after),
      "--kind",
      "assistant/message",
      "--full",
    ]);
    expect(full.value.entries[0]!.text).toHaveLength(5000);
    expect(full.value.entries[0]).toHaveProperty("raw");
    expect(JSON.stringify(full.value)).not.toContain("PRIVATE REASONING");
    for (const detail of [[], ["--full"]]) {
      const attempts = await s.cli<TrajectoryPage>([
        "trajectory",
        s.ticket.ticketId,
        "--after",
        String(after),
        "--kind",
        "assistant/attempt",
        ...detail,
      ]);
      expect(attempts.code, attempts.stderr).toBe(0);
      expect(attempts.value.entries[0]!.text).toContain(
        "visible provider failure",
      );
      expect(JSON.stringify(attempts.value.entries)).not.toContain(
        "OMITTED-ATTEMPT-STREAM",
      );
    }
    const projected = await fetch(
      `${s.http.url}/api/tickets/${s.ticket.ticketId}/trajectory?after=${after}&kind=assistant%2Fattempt`,
      { headers: { Authorization: "Bearer cli-fixture" } },
    );
    expect(await projected.text()).not.toContain("OMITTED-ATTEMPT-STREAM");
    const activity = await s.cli<TrajectoryPage>([
      "activity",
      s.ticket.ticketId,
      "--attempt",
      a.id,
    ]);
    expect(activity.code, activity.stderr).toBe(0);
    expect(activity.value.entries).toEqual([]);
    expect(activity.value.agents[0]).toMatchObject({
      attemptId: a.id,
      status: "ended",
    });
    const events = await s.cli<JournalPage>([
      "events",
      s.ticket.ticketId,
      "--after",
      String(after),
      "--limit",
      "1",
    ]);
    expect(events.value.entries.map((e) => e.type)).toEqual([
      "ticket.test-warning",
    ]);
    expect(events.value.hasMore).toBe(false);
    expect(s.runtime.count).toBe(1);
    expect(s.c.store.get(s.ticket.ticketId)).toEqual(beforeRecord);
    expect(s.c.store.events(0, 10000)).toEqual(beforeJournal);
  } finally {
    await s.close();
  }
}, 20000);

it("brief separates current evidence from claims, stale files and superseded revisions", async () => {
  const s = await setup();
  try {
    writeFileSync(join(s.repo, "source.txt"), "large baseline\n".repeat(12000));
    await promisify(execFile)("git", ["-C", s.repo, "add", "source.txt"]);
    await promisify(execFile)("git", [
      "-C",
      s.repo,
      "commit",
      "-m",
      "large fixture baseline",
    ]);
    s.ticket.baseCommit = (
      await promisify(execFile)("git", ["-C", s.repo, "rev-parse", "HEAD"])
    ).stdout.trim();
    s.runtime.handler = async (request) => {
      writeFileSync(
        join(request.worktree, "new.txt"),
        "large evidence\n".repeat(12000),
      );
      return {};
    };
    s.c.prepare(s.ticket);
    const ready = await s.cli<EvidenceBrief>(["brief", s.ticket.ticketId]);
    expect(ready.value.attempt).toBeNull();
    expect(ready.value.binding.currentSnapshot).toBeNull();
    s.c.run(s.ticket.ticketId);
    await s.c.wait(s.ticket.ticketId);
    const submitted = await s.cli<EvidenceBrief>(["brief", s.ticket.ticketId]);
    expect(submitted.value.workerReport!.outcome).toBe("submitted");
    expect(submitted.value.verification).toBeNull();
    expect(submitted.value.review).toBeNull();
    s.c.verify(s.ticket.ticketId);
    const verified = await s.c.wait(s.ticket.ticketId);
    const a = verified.attempts.at(-1)!;
    s.c.review({
      schemaVersion: 2,
      ticketId: s.ticket.ticketId,
      revision: 1,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      spec: { verdict: "pass", findings: [] },
      standards: { verdict: "pass", findings: [] },
      verdict: "accept",
      findings: [],
      reviewer: "test fixture",
    });
    const brief = (await s.cli<EvidenceBrief>(["brief", s.ticket.ticketId]))
      .value;
    expect(brief.state).toBe("accepted");
    expect(brief.binding.matchesDeliveredSnapshot).toBe(true);
    expect(brief.verification).toMatchObject({
      passed: true,
      matchesDeliveredSnapshot: true,
      matchesCurrentSnapshot: true,
    });
    expect(brief.review!.snapshotDigest).toBe(brief.binding.deliveredSnapshot);
    expect(brief.changes.paths).toEqual(["new.txt", "source.txt"]);
    const full = (await s.cli(["status", s.ticket.ticketId])).value;
    const sizes = {
      fullStatusBytes: Buffer.byteLength(JSON.stringify(full)),
      briefBytes: Buffer.byteLength(JSON.stringify(brief)),
    };
    expect(sizes.briefBytes).toBeLessThan(sizes.fullStatusBytes / 10);
    console.log("evidence projection payload", sizes);
    writeFileSync(
      join(verified.worktree, "source.txt"),
      "changed after acceptance\n",
    );
    // Existing display cache can legitimately lag up to three seconds.
    let stale: EvidenceBrief | undefined;
    await expect
      .poll(
        async () => {
          stale = (await s.cli<EvidenceBrief>(["brief", s.ticket.ticketId]))
            .value;
          return stale.binding.matchesDeliveredSnapshot;
        },
        { timeout: 6000, interval: 300 },
      )
      .toBe(false);
    expect(stale!.binding.deliveredSnapshot).toBe(a.snapshot!.digest);
    expect(stale!.verification!.matchesCurrentSnapshot).toBe(false);
    expect(stale!.review!.verdict).toBe("accept"); // Historical decision remains bound to its old bytes.
    s.c.prepare({
      ...s.ticket,
      revision: 2,
      objective: "Continue with revised requirements",
    });
    const revised = (await s.cli<EvidenceBrief>(["brief", s.ticket.ticketId]))
      .value;
    expect(revised.ticket.revision).toBe(2);
    expect(revised.attempt).toBeNull();
    expect(revised.workerReport).toBeNull();
    expect(revised.verification).toBeNull();
    expect(revised.review).toBeNull();
    expect(revised.binding.deliveredSnapshot).toBeNull();
  } finally {
    await s.close();
  }
}, 25000);

it("validates evidence options before contacting a service", async () => {
  for (const args of [
    ["trajectory", "ONE", "--after=-1"],
    ["trajectory", "ONE", "--after", "9007199254740992"],
    ["events", "ONE", "--limit", "101"],
    ["events", "ONE", "--limit", "NaN"],
    ["events", "ONE", "--kind", "tool/call"],
    ["brief", "ONE", "--attempt", "old"],
    ["activity", "ONE", "--after", "2"],
    ["run", "ONE", "--brief"],
    ["status", "ONE", "--brief"],
    ["workflow", "--brief"],
    ["skill", "--brief"],
    ["tools", "install", "--brief"],
  ]) {
    const result = await invoke("/no-service", args);
    expect(result.code).toBe(1);
    expect(["invalid_contract", "arguments"]).toContain(
      JSON.parse(result.stderr).code,
    );
  }
  for (const args of [
    ["tools", "install", "--brief", "--help"],
    ["tools", "install", "--help"],
    ["workflow", "--brief", "--help"],
  ]) {
    const result = await promisify(execFile)(process.execPath, [
      command,
      ...args,
      "--home",
      "/no-service",
    ]);
    expect(result.stdout).toContain("CLI + Skill control service");
  }
});

it("returns a bound brief after run or verify waiting and preserves full wait by default", async () => {
  const s = await setup();
  try {
    const prepared = s.c.prepare(s.ticket);
    const ready = await s.cli<EvidenceBrief>([
      "wait",
      s.ticket.ticketId,
      "--brief",
    ]);
    expect(ready.code, ready.stderr).toBe(0);
    expect(ready.value.attempt).toBeNull();
    expect(ready.value.worktree).toBe(prepared.worktree);
    expect(ready.value.ticket.baseCommit).toBe(s.ticket.baseCommit);
    expect(ready.value.ticket.targetRepo).toBe(prepared.ticket.targetRepo);
    const submitted = await s.cli<EvidenceBrief>([
      "run",
      s.ticket.ticketId,
      "--wait",
      "--brief",
    ]);
    expect(submitted.code, submitted.stderr).toBe(0);
    expect(submitted.value.state).toBe("awaiting_review");
    expect(submitted.value.workerReport!.outcome).toBe("submitted");
    expect(submitted.value.verification).toBeNull();
    expect(submitted.value.review).toBeNull();
    expect(submitted.value).not.toHaveProperty("attempts");
    const verified = await s.cli<EvidenceBrief>([
      "verify",
      s.ticket.ticketId,
      "--wait",
      "--brief",
    ]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.value.verification).toMatchObject({
      passed: true,
      matchesDeliveredSnapshot: true,
      matchesCurrentSnapshot: true,
    });
    expect(verified.value.binding.attemptId).toBe(
      submitted.value.binding.attemptId,
    );
    expect(verified.value.state).toBe("awaiting_review");
    expect(
      (await s.cli(["wait", s.ticket.ticketId])).value.attempts,
    ).toHaveLength(1);
    expect(s.runtime.count).toBe(1);
  } finally {
    await s.close();
  }
}, 15000);
