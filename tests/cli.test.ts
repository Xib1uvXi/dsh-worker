import { expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { Controller } from "../packages/core/src/controller.js";
import { startHttp } from "../packages/server/src/http.js";
import { fixture, FakeRuntime } from "./helpers.js";
import type { TicketView } from "../packages/contracts/src/index.js";
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
    const timed = await s.cli(["wait", s.ticket.ticketId, "--timeout", "0.01"]);
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
it("rejects retired integration and trace commands without requiring a configured service", async () => {
  for (const retired of ["mcp", "trajectory", "activity", "events"]) {
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
