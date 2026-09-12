import { expect, it, vi } from "vitest";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as ownedProcesses from "../packages/shared/src/process.js";
import { Controller } from "../packages/core/src/controller.js";
import { fixture, FakeRuntime } from "./helpers.js";
import type { RuntimeAdapter } from "../packages/runtime/src/adapter.js";
import type { RunnerRequest } from "../packages/runtime/src/runner.js";
import type {
  ReviewRun,
  TicketReviewReport,
  Review,
} from "../packages/contracts/src/index.js";

export function passingReport(request: RunnerRequest): TicketReviewReport {
  return {
    spec: {
      verdict: "pass",
      rationale: "source.txt matches the pinned original requirement",
    },
    standards: {
      verdict: "pass",
      rationale: "No applicable standards violations",
    },
    recommendation: "pass",
    coverage: request.ticket.acceptance.map((a) => ({
      acceptanceId: a.id,
      evidence: "Read source.txt and its verification command",
    })),
    inspectedPaths: ["source.txt"],
    findings: [],
    commands: [],
    limitations: [],
  };
}
async function setup(count = 1, limit = 2, capacity = 4) {
  const f = fixture();
  const implementation = new FakeRuntime();
  const entered: RunnerRequest[] = [];
  let handler: (
    r: RunnerRequest,
    s: AbortSignal,
  ) => Promise<TicketReviewReport> = async (r) => passingReport(r);
  const runtime: RuntimeAdapter = {
    async execute(r, dir, marker, signal, _notify, _processes) {
      if (!r.sessionId.startsWith("review-"))
        return implementation.execute(r, dir, marker, signal);
      entered.push(r);
      const report = await handler(r, signal);
      return {
        receipt: true,
        cleanExit: true,
        finishReason: "completed",
        termination: "completed",
        finalResponse: JSON.stringify(report),
      };
    },
  };
  const c = new Controller({
    home: f.home,
    runtime,
    dispatchEnabled: true,
    capacity,
  });
  const pool = {
    poolId: "pool",
    batchId: "batch",
    expectedVersion: 0,
    state: "enabled" as const,
    implementationLimit: limit,
    execution: f.ticket.execution,
    entrySkills: [],
  };
  c.reviewCoordinator.configure(pool);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const ticketId = `REVIEW-${i}`;
    ids.push(ticketId);
    c.prepare({
      ...f.ticket,
      ticketId,
      reviewPoolId: "pool",
      reviewPolicy: "worker_then_astra",
    });
    c.run(ticketId);
    await c.wait(ticketId);
    c.verify(ticketId);
    await c.wait(ticketId);
  }
  const request = (ticketId: string, requestId = `request-${ticketId}`) => {
    const t = c.status(ticketId);
    const a = t.attempts.at(-1)!;
    return c.reviewCoordinator.request({
      requestId,
      ticketId,
      poolId: "pool",
      revision: t.ticket.revision,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      mode: "initial",
    });
  };
  const wait = async (id: string) => {
    await expect
      .poll(() => c.reviewCoordinator.runs().find((r) => r.id === id)?.phase, {
        timeout: 10000,
      })
      .toBe("ended");
    return c.reviewCoordinator.runs().find((r) => r.id === id)!;
  };
  return {
    ...f,
    c,
    pool,
    ids,
    entered,
    request,
    wait,
    implementation,
    runtime,
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
}
function acceptance(
  _s: Awaited<ReturnType<typeof setup>>,
  run: ReviewRun,
): Review {
  return {
    schemaVersion: 2,
    ticketId: run.request.ticketId,
    revision: 1,
    attemptId: run.request.attemptId,
    snapshotDigest: run.request.snapshotDigest,
    spec: { verdict: "pass", findings: [] },
    standards: { verdict: "pass", findings: [] },
    verdict: "accept",
    findings: [],
    reviewer: "Astra",
    source: { runId: run.id, reportDigest: run.reportDigest! },
  };
}
it("binds independent review provenance, preserves full input and requires host adoption", async () => {
  const s = await setup();
  try {
    const pending = s.request(s.ids[0]!);
    const run = await s.wait(pending.id);
    expect(run.error).toBeUndefined();
    expect(run.state).toBe("completed");
    expect(run.slotHeld).toBe(false);
    expect(s.c.status(s.ids[0]!).state).toBe("awaiting_review");
    expect(run.sessionId).not.toBe(
      s.c.status(s.ids[0]!).attempts[0]!.sessionId,
    );
    expect(readFileSync(join(run.workspace!, "source.txt"), "utf8")).toBe(
      "implemented\n",
    );
    const review = acceptance(s, run);
    const bare = { ...review };
    delete bare.source;
    expect(() => s.c.review(bare)).toThrow(/bound independent/);
    expect(() =>
      s.c.review({
        ...review,
        source: { ...review.source!, reportDigest: "0".repeat(64) },
      }),
    ).toThrow(/corrupt/);
    expect(s.c.review(review).state).toBe("accepted");
  } finally {
    await s.c.close();
  }
}, 20000);
it("scales to the implementation limit and drains review after all implementers exit", async () => {
  const s = await setup(3, 2, 3);
  const releases = new Map<string, () => void>();
  s.setHandler(async (r, signal) => {
    await new Promise<void>((resolve) => {
      releases.set(r.attemptId, resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return passingReport(r);
  });
  try {
    const runs = s.ids.map((id) => s.request(id));
    await expect.poll(() => s.entered.length, { timeout: 10000 }).toBe(2);
    expect(s.c.reviewCoordinator.status().pools[0]).toMatchObject({
      implementationOwned: 0,
      reviewOwned: 2,
      queued: 1,
    });
    const p = s.c.reviewCoordinator.configure({
      ...s.pool,
      expectedVersion: 1,
      implementationLimit: 1,
    });
    expect(p.implementationLimit).toBe(2);
    expect(p.pendingLimit).toBe(1);
    releases.get(runs[0]!.id)!();
    await s.wait(runs[0]!.id);
    expect(s.entered).toHaveLength(2);
    expect(s.c.reviewCoordinator.status().pools[0]?.implementationLimit).toBe(
      1,
    );
    releases.get(runs[1]!.id)!();
    await s.wait(runs[1]!.id);
    await expect.poll(() => s.entered.length, { timeout: 10000 }).toBe(3);
    releases.get(runs[2]!.id)!();
    await s.wait(runs[2]!.id);
    expect(s.c.reviewCoordinator.status().pools[0]).toMatchObject({
      reviewOwned: 0,
      queued: 0,
    });
  } finally {
    await s.c.close();
  }
}, 30000);
it.each(["input", "source", "coverage", "malformed"])(
  "refuses invalid reviewer evidence: %s",
  async (kind) => {
    const s = await setup();
    s.setHandler(async (r) => {
      if (kind === "input")
        writeFileSync(join(r.worktree, "source.txt"), "reviewer edit\n");
      if (kind === "source")
        writeFileSync(
          join(s.c.status(s.ids[0]!).worktree, "source.txt"),
          "external edit\n",
        );
      const report = passingReport(r);
      if (kind === "coverage") report.coverage = [];
      if (kind === "malformed") return {} as TicketReviewReport;
      return report;
    });
    try {
      const run = await s.wait(s.request(s.ids[0]!).id);
      expect(run.state).toBe("failed");
      expect(s.c.status(s.ids[0]!).state).toBe("awaiting_review");
      expect(run.reportDigest).toBeUndefined();
    } finally {
      await s.c.close();
    }
  },
  20000,
);
it("keeps blocked evidence inconclusive and cannot bypass it with reviewer text", async () => {
  const s = await setup();
  s.setHandler(async (r) => ({
    ...passingReport(r),
    spec: {
      verdict: "inconclusive",
      rationale: "Required evidence unavailable",
    },
    recommendation: "blocked",
    limitations: ["Missing provider fixture"],
  }));
  try {
    const run = await s.wait(s.request(s.ids[0]!).id);
    expect(run.state).toBe("completed");
    expect(() => s.c.review(acceptance(s, run))).toThrow(/missing evidence/);
  } finally {
    await s.c.close();
  }
}, 20000);
it("persists queued requests, deduplicates identity and requires explicit rearming after restart", async () => {
  const s = await setup();
  let c = s.c;
  try {
    c.reviewCoordinator.configure({
      ...s.pool,
      expectedVersion: 1,
      state: "paused",
    });
    const run = s.request(s.ids[0]!);
    expect(s.request(s.ids[0]!).id).toBe(run.id);
    expect(() =>
      c.reviewCoordinator.request({
        ...run.request,
        snapshotDigest: "0".repeat(64),
      }),
    ).toThrow(/different inputs/);
    await c.close();
    c = new Controller({
      home: s.home,
      runtime: new FakeRuntime(),
      dispatchEnabled: true,
    });
    expect(c.reviewCoordinator.runs()[0]).toMatchObject({
      state: "queued",
      suspended: true,
    });
    await c.reviewCoordinator.cancel(run.id);
    expect(c.reviewCoordinator.runs()[0]?.state).toBe("cancelled");
    expect(
      c.reviewCoordinator.configure({
        ...s.pool,
        expectedVersion: 2,
        state: "closed",
      }).state,
    ).toBe("closed");
  } finally {
    await c.close();
  }
}, 20000);

it("admits the oldest executable role without allowing newer direct calls to steal capacity", async () => {
  const s = await setup(3, 2, 1);
  const release = new Map<string, () => void>();
  s.setHandler(async (r, signal) => {
    await new Promise<void>((done) => {
      release.set(r.attemptId, done);
      signal.addEventListener("abort", () => done(), { once: true });
    });
    return passingReport(r);
  });
  try {
    const first = s.request(s.ids[0]!);
    await expect.poll(() => s.entered.length).toBe(1);
    const verify = s.c.reviewCoordinator.schedule(
      "old-verify",
      s.ids[1]!,
      "verify",
    );
    const later = s.request(s.ids[2]!);
    expect(verify.state).toBe("queued");
    expect(s.c.reviewCoordinator.status().capacityOwned).toBe(1);
    expect(() => s.c.verify(s.ids[1]!)).toThrow(/Older executable/);
    expect(
      s.c.reviewCoordinator.schedule("old-verify", s.ids[1]!, "verify")
        .requestId,
    ).toBe("old-verify");
    release.get(first.id)!();
    await s.wait(first.id);
    await expect.poll(() => s.entered.length, { timeout: 10000 }).toBe(2);
    expect(s.c.status(s.ids[1]!).verifications).toHaveLength(2);
    expect(s.c.status(s.ids[1]!).verifications.at(-1)?.passed).toBe(true);
    expect(s.c.reviewCoordinator.operations()[0]?.state).toBe("started");
    expect(s.c.reviewCoordinator.status().capacityOwned).toBe(1);
    release.get(later.id)!();
    await s.wait(later.id);
  } finally {
    await s.c.close();
  }
}, 30000);

it("retains cleanup ownership across restart and never replays an uncertain review", async () => {
  const s = await setup(2, 2, 1);
  let c = s.c;
  const cleanup = vi
    .spyOn(ownedProcesses, "terminate")
    .mockResolvedValueOnce([{ pid: 2147483647, start: "fixture-unknown" }]);
  try {
    const first = s.request(s.ids[0]!);
    const queued = s.request(s.ids[1]!);
    await expect
      .poll(
        () => c.reviewCoordinator.runs().find((r) => r.id === first.id)?.state,
        { timeout: 10000 },
      )
      .toBe("interrupted");
    expect(c.reviewCoordinator.status()).toMatchObject({ capacityOwned: 1 });
    expect(s.entered).toHaveLength(1);
    cleanup.mockRestore();
    await c.close();
    c = new Controller({
      home: s.home,
      runtime: s.runtime,
      dispatchEnabled: true,
      capacity: 1,
    });
    expect(
      c.reviewCoordinator.runs().find((r) => r.id === first.id),
    ).toMatchObject({ slotHeld: true, phase: "cleanup", state: "interrupted" });
    expect(
      c.reviewCoordinator.runs().find((r) => r.id === queued.id),
    ).toMatchObject({ state: "queued", suspended: true });
    await c.reviewCoordinator.recover(first.id);
    expect(c.reviewCoordinator.status().capacityOwned).toBe(0);
    expect(s.entered).toHaveLength(1);
    expect(
      c.reviewCoordinator.runs().find((r) => r.id === queued.id)?.suspended,
    ).toBe(true);
    await c.reviewCoordinator.cancel(queued.id);
  } finally {
    cleanup.mockRestore();
    await c.close();
  }
}, 30000);

it("rejects stale, replaced and implementer-session provenance while keeping historical results", async () => {
  const s = await setup();
  try {
    const run = await s.wait(s.request(s.ids[0]!).id);
    const review = acceptance(s, run);
    s.c.store.putObject("review_runs", run.id, {
      ...run,
      sessionId: s.c.status(s.ids[0]!).attempts[0]!.sessionId,
    });
    expect(() => s.c.review(review)).toThrow(/independent session/);
    s.c.store.putObject("review_runs", run.id, run);
    writeFileSync(join(s.home, "reviews", run.id, "report.json"), "{}");
    expect(() => s.c.review(review)).toThrow(/artifacts changed/);
    expect(s.c.reviewCoordinator.status().runs[0]).toMatchObject({
      state: "completed",
      applicability: "stale",
    });
    s.c.prepare({
      ...s.c.status(s.ids[0]!).ticket,
      revision: 2,
      objective: "Revised requirement",
    });
    expect(() => s.c.review(review)).toThrow();
    expect(s.c.reviewCoordinator.runs()[0]?.reportDigest).toBe(
      run.reportDigest,
    );
  } finally {
    await s.c.close();
  }
}, 20000);

it("supports evidence dispositions and focused rereview after a real new attempt", async () => {
  const s = await setup();
  s.setHandler(async (r) => ({
    ...passingReport(r),
    spec: { verdict: "fail", rationale: "Demonstrated requirement failure" },
    recommendation: "request_changes",
    findings: [
      {
        findingId: "F1",
        dimension: "spec",
        severity: "high",
        blocking: true,
        path: "source.txt",
        line: 1,
        requirement: "AC1",
        trigger: "Read source",
        evidence: "Observed mismatch",
      },
    ],
  }));
  try {
    const first = await s.wait(s.request(s.ids[0]!).id);
    expect(() => s.c.review(acceptance(s, first))).toThrow(/each disputed/);
    s.c.review({
      ...acceptance(s, first),
      verdict: "request_changes",
      spec: { verdict: "fail", findings: ["F1"] },
    });
    s.c.run(s.ids[0]!);
    await s.c.wait(s.ids[0]!);
    s.c.verify(s.ids[0]!);
    await s.c.wait(s.ids[0]!);
    s.setHandler(async (r) => {
      expect(r.prompt).toContain("Focus on fixes");
      return passingReport(r);
    });
    const t = s.c.status(s.ids[0]!);
    const a = t.attempts.at(-1)!;
    const next = s.c.reviewCoordinator.request({
      ...first.request,
      requestId: "focused",
      mode: "focused",
      priorRunId: first.id,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
    });
    const final = await s.wait(next.id);
    expect(final.state).toBe("completed");
    expect(() => s.c.review(acceptance(s, first))).toThrow(/current attempt/);
    expect(s.c.review(acceptance(s, final)).state).toBe("accepted");
  } finally {
    await s.c.close();
  }
}, 30000);

it("cancels a running reviewer, releases its slot and rejects new work in a closed pool", async () => {
  const s = await setup();
  s.setHandler(async (r, signal) => {
    await new Promise<void>((done) =>
      signal.addEventListener("abort", () => done(), { once: true }),
    );
    return passingReport(r);
  });
  try {
    const run = s.request(s.ids[0]!);
    await expect.poll(() => s.entered.length).toBe(1);
    expect(() => s.c.verify(s.ids[0]!)).toThrow();
    await s.c.reviewCoordinator.cancel(run.id);
    expect(s.c.reviewCoordinator.runs()[0]).toMatchObject({
      state: "cancelled",
      slotHeld: false,
      phase: "ended",
    });
    expect(s.c.status(s.ids[0]!).activeOperation).toBeUndefined();
    s.c.reviewCoordinator.configure({
      ...s.pool,
      expectedVersion: 1,
      state: "closed",
    });
    expect(() => s.request(s.ids[0]!, "new-request")).toThrow(/Reopen/);
    expect(() =>
      s.c.reviewCoordinator.schedule("new-op", s.ids[0]!, "verify"),
    ).toThrow(/Reopen/);
  } finally {
    await s.c.close();
  }
}, 20000);

it("keeps a newer failed verification authoritative over an independent passing report", async () => {
  const s = await setup(0);
  try {
    const ticket = {
      ...s.ticket,
      reviewPolicy: "worker_then_astra",
      reviewPoolId: "pool",
      verification: [
        {
          args: [
            process.execPath,
            "-e",
            "if(require('fs').existsSync('.verification-fail'))process.exit(1)",
          ],
        },
      ],
    };
    s.c.prepare(ticket);
    s.c.run(ticket.ticketId);
    await s.c.wait(ticket.ticketId);
    const t = s.c.status(ticket.ticketId);
    const exclude = execFileSync(
      "git",
      ["-C", t.worktree, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim();
    writeFileSync(exclude, ".verification-fail\n", { flag: "a" });
    s.c.verify(ticket.ticketId);
    await s.c.wait(ticket.ticketId);
    const report = await s.wait(s.request(ticket.ticketId).id);
    writeFileSync(join(t.worktree, ".verification-fail"), "fail");
    s.c.verify(ticket.ticketId);
    await s.c.wait(ticket.ticketId);
    expect(s.c.status(ticket.ticketId).verifications.at(-1)?.passed).toBe(
      false,
    );
    expect(s.c.reviewCoordinator.status().runs[0]?.applicability).toBe(
      "current",
    );
    expect(() => s.c.review(acceptance(s, report))).toThrow(/verification/);
  } finally {
    await s.c.close();
  }
}, 20000);

it("reconstructs directory replacement, binary staged additions, modes, symlinks and deletions", async () => {
  const s = await setup(0);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", s.repo, ...args], { encoding: "utf8" }).trim();
  try {
    mkdirSync(join(s.repo, "nested"));
    writeFileSync(join(s.repo, "nested", "old.txt"), "old");
    writeFileSync(join(s.repo, "deleted.txt"), "old");
    git("add", ".");
    git("commit", "-qm", "snapshot fixture");
    s.implementation.handler = async (r) => {
      rmSync(join(r.worktree, "nested"), { recursive: true });
      writeFileSync(join(r.worktree, "nested"), "now a file");
      rmSync(join(r.worktree, "deleted.txt"));
      writeFileSync(join(r.worktree, "new.txt"), Buffer.from([0, 255, 1, 2]));
      chmodSync(join(r.worktree, "source.txt"), 0o755);
      symlinkSync("source.txt", join(r.worktree, "link"));
      execFileSync("git", ["-C", r.worktree, "add", "new.txt"]);
      return {};
    };
    const ticket = {
      ...s.ticket,
      baseCommit: git("rev-parse", "HEAD"),
      scope: { paths: ["."] },
      reviewPolicy: "worker_then_astra",
      reviewPoolId: "pool",
    };
    s.c.prepare(ticket);
    s.c.run(ticket.ticketId);
    await s.c.wait(ticket.ticketId);
    expect(s.c.status(ticket.ticketId).error).toBeUndefined();
    s.c.verify(ticket.ticketId);
    await s.c.wait(ticket.ticketId);
    s.setHandler(async (r) => {
      expect(readFileSync(join(r.worktree, "nested"), "utf8")).toBe(
        "now a file",
      );
      expect(readFileSync(join(r.worktree, "new.txt"))).toEqual(
        Buffer.from([0, 255, 1, 2]),
      );
      expect(readlinkSync(join(r.worktree, "link"))).toBe("source.txt");
      expect(statSync(join(r.worktree, "source.txt")).mode & 0o111).toBe(0o111);
      expect(() => statSync(join(r.worktree, "deleted.txt"))).toThrow();
      expect(
        execFileSync(
          "git",
          ["-C", r.worktree, "diff", "--cached", "--name-only"],
          { encoding: "utf8" },
        ),
      ).toContain("new.txt");
      return passingReport(r);
    });
    const run = await s.wait(s.request(ticket.ticketId).id);
    expect(run.error).toBeUndefined();
    expect(run.state).toBe("completed");
  } finally {
    await s.c.close();
  }
}, 20000);

it("shares one global slot across independent batch pools and refuses quota aliasing", async () => {
  const s = await setup(2, 2, 1);
  const releases = new Map<string, () => void>();
  s.setHandler(async (r, signal) => {
    await new Promise<void>((done) => {
      releases.set(r.attemptId, done);
      signal.addEventListener("abort", () => done(), { once: true });
    });
    return passingReport(r);
  });
  try {
    expect(() =>
      s.c.reviewCoordinator.configure({
        ...s.pool,
        poolId: "alias",
        expectedVersion: 0,
      }),
    ).toThrow(/one pool/);
    s.c.reviewCoordinator.configure({
      ...s.pool,
      poolId: "second",
      batchId: "second-batch",
      implementationLimit: 1,
      expectedVersion: 0,
    });
    const secondTicket = s.c.status(s.ids[1]!).ticket;
    s.c.prepare({ ...secondTicket, revision: 2, reviewPoolId: "second" });
    s.c.run(secondTicket.ticketId);
    await s.c.wait(secondTicket.ticketId);
    s.c.verify(secondTicket.ticketId);
    await s.c.wait(secondTicket.ticketId);
    const first = s.request(s.ids[0]!);
    const secondSource = s.c.status(secondTicket.ticketId);
    const a = secondSource.attempts.at(-1)!;
    const second = s.c.reviewCoordinator.request({
      requestId: "second-batch-review",
      ticketId: secondTicket.ticketId,
      poolId: "second",
      revision: 2,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      mode: "initial",
    });
    await expect.poll(() => s.entered.length, { timeout: 10000 }).toBe(1);
    expect(s.c.reviewCoordinator.status().capacityOwned).toBe(1);
    expect(
      s.c.reviewCoordinator.runs().find((r) => r.id === second.id)?.state,
    ).toBe("queued");
    releases.get(first.id)!();
    await s.wait(first.id);
    await expect.poll(() => s.entered.length, { timeout: 10000 }).toBe(2);
    expect(s.c.reviewCoordinator.status().capacityOwned).toBe(1);
    releases.get(second.id)!();
    await s.wait(second.id);
    expect(s.c.reviewCoordinator.status().capacityOwned).toBe(0);
  } finally {
    await s.c.close();
  }
}, 30000);
