import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import type {
  Review,
  ReviewPool,
  ReviewPoolInput,
  ReviewRequest,
  ReviewRun,
  ReviewStatus,
  ScheduledOperation,
  TicketRecord,
} from "../../contracts/src/index.js";
import {
  reviewPoolInputSchema,
  reviewRequestSchema,
  ticketReviewReportSchema,
} from "../../contracts/src/index.js";
import {
  canonical,
  ensure,
  hash,
  immutable,
  now,
  uid,
  inside,
} from "../../shared/src/util.js";
import { discover, terminate, cleanEnv } from "../../shared/src/process.js";
import { redactor } from "../../shared/src/redaction.js";
import { credentialNames } from "../../runtime/src/credentials.js";
import {
  policyPatch,
  reviewerRole,
  workflow,
} from "../../runtime/src/policy.js";
import { deliveryDocument } from "../../runtime/src/delivery.js";
import type { RuntimeAdapter } from "../../runtime/src/adapter.js";
import { capture, git, gitText } from "./git.js";
import type { Store } from "./store.js";

export interface ReviewHost {
  store: Store;
  home: string;
  capacity: number;
  dispatchEnabled: boolean;
  runtime: RuntimeAdapter;
  dshBin?: string;
  activeCount(): number;
  run(id: string): unknown;
  verify(id: string): unknown;
  wait(id: string): Promise<unknown>;
}
export class ReviewCoordinator {
  private live = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  private closed = false;
  private pumping = false;
  private admitted = false;
  private queuedPump = false;
  constructor(private host: ReviewHost) {
    for (const run of this.runs()) {
      if (run.slotHeld) {
        run.state = "interrupted";
        run.phase = "cleanup";
        run.error =
          "Controller restarted; account for old processes before releasing the slot";
      }
      if (run.state === "queued") run.suspended = true;
      if (run.slotHeld || run.state === "queued")
        this.persist(run, "review.restart_fenced");
    }
    for (const op of this.operations())
      if (op.state === "queued") {
        op.suspended = true;
        this.host.store.putObject("scheduled_operations", op.requestId, op);
      }
  }
  runs() {
    return this.host.store.objects<ReviewRun>("review_runs");
  }
  pools() {
    return this.host.store.objects<ReviewPool>("review_pools");
  }
  operations() {
    return this.host.store.objects<ScheduledOperation>("scheduled_operations");
  }
  private pool(id: string) {
    const pool = this.pools().find((p) => p.poolId === id);
    ensure(
      pool,
      "review_pool_missing",
      "Configure the bound review pool first",
    );
    return pool;
  }
  private get(id: string) {
    const run = this.runs().find((r) => r.id === id);
    ensure(run, "not_found", "Unknown review run");
    return run;
  }
  private counts(poolId: string) {
    return {
      implementationOwned: this.host.store
        .list(false)
        .filter(
          (r) =>
            r.ticket.reviewPoolId === poolId &&
            (r.state === "running" || r.interruptedOperation === "execution") &&
            r.activeOperation,
        ).length,
      reviewOwned: this.runs().filter(
        (r) => r.request.poolId === poolId && r.slotHeld,
      ).length,
    };
  }
  status(): ReviewStatus {
    const runs = this.runs();
    return {
      capacity: this.host.capacity,
      capacityOwned: this.host.activeCount(),
      pools: this.pools().map((p) => {
        const queued = runs.filter(
          (r) => r.request.poolId === p.poolId && r.state === "queued",
        );
        return {
          ...p,
          ...this.counts(p.poolId),
          queued: queued.length,
          oldestWaitSeconds: queued.length
            ? Math.max(
                0,
                Math.floor(
                  (Date.now() -
                    Math.min(...queued.map((r) => Date.parse(r.createdAt)))) /
                    1000,
                ),
              )
            : null,
        };
      }),
      runs: runs.map((run) => {
        if (run.state !== "completed")
          return { ...run, applicability: "unavailable" as const };
        try {
          const record = this.host.store.get(run.request.ticketId, false);
          ensure(
            record.ticket.revision === run.request.revision &&
              record.attempts.at(-1)?.id === run.request.attemptId &&
              capture(record).digest === run.request.snapshotDigest,
            "stale_review",
            "Current ticket or source differs from the reviewed target",
          );
          ensure(
            hash(
              readFileSync(
                join(this.host.home, "reviews", run.id, "report.json"),
              ),
            ) === run.reportDigest &&
              hash(
                readFileSync(
                  join(this.host.home, "reviews", run.id, "input.json"),
                ),
              ) === run.inputDigest,
            "stale_review",
            "Stored review evidence changed",
          );
          return { ...run, applicability: "current" as const };
        } catch (error) {
          return {
            ...run,
            applicability: "stale" as const,
            applicabilityReason: String(error),
          };
        }
      }),
      operations: this.operations(),
    };
  }
  private persist(run: ReviewRun, event: string) {
    this.host.store.transaction(() => {
      this.host.store.putObject("review_runs", run.id, run);
      this.host.store.event(run.request.ticketId, event, {
        runId: run.id,
        state: run.state,
        phase: run.phase,
        slotHeld: run.slotHeld,
        error: run.error,
      });
    });
  }
  configure(raw: ReviewPoolInput) {
    const input = reviewPoolInputSchema.parse(raw);
    const old = this.pools().find((p) => p.poolId === input.poolId);
    ensure(
      (old?.version ?? 0) === input.expectedVersion,
      "pool_version",
      "Refresh pool configuration before updating it",
    );
    ensure(
      !old || old.batchId === input.batchId,
      "pool_binding",
      "A pool cannot be assigned to another batch",
    );
    ensure(
      !this.pools().some(
        (p) => p.batchId === input.batchId && p.poolId !== input.poolId,
      ),
      "pool_binding",
      "A batch has one pool",
    );
    const owned = this.counts(input.poolId);
    if (input.state === "closed")
      ensure(
        !this.host.store
          .list(false)
          .some(
            (r) => r.ticket.reviewPoolId === input.poolId && r.activeOperation,
          ) &&
          !owned.implementationOwned &&
          !owned.reviewOwned &&
          !this.runs().some(
            (r) => r.request.poolId === input.poolId && r.state === "queued",
          ) &&
          !this.operations().some(
            (o) =>
              o.state === "queued" &&
              this.host.store.get(o.ticketId, false).ticket.reviewPoolId ===
                input.poolId,
          ),
        "pool_busy",
        "Drain or cancel all pending work before closing the pool",
      );
    const config = {
      poolId: input.poolId,
      batchId: input.batchId,
      implementationLimit: input.implementationLimit,
      state: input.state,
      execution: input.execution,
      entrySkills: input.entrySkills,
    };
    const draining =
      input.implementationLimit <
      Math.max(owned.implementationOwned, owned.reviewOwned);
    const pool: ReviewPool = {
      ...config,
      version: (old?.version ?? 0) + 1,
      implementationLimit: draining
        ? old!.implementationLimit
        : input.implementationLimit,
      ...(draining ? { pendingLimit: input.implementationLimit } : {}),
      updatedAt: now(),
    };
    this.host.store.transaction(() => {
      this.host.store.putObject("review_pools", pool.poolId, pool);
      this.host.store.event(
        `pool:${pool.poolId}`,
        "review.pool_configured",
        pool,
      );
      if (pool.state === "enabled") {
        for (const run of this.runs())
          if (run.request.poolId === pool.poolId && run.state === "queued") {
            run.suspended = false;
            this.host.store.putObject("review_runs", run.id, run);
          }
        for (const op of this.operations())
          if (
            op.state === "queued" &&
            this.host.store.get(op.ticketId, false).ticket.reviewPoolId ===
              pool.poolId
          ) {
            op.suspended = false;
            this.host.store.putObject("scheduled_operations", op.requestId, op);
          }
      }
    });
    this.kick();
    return pool;
  }
  validateTicket(record: Pick<TicketRecord, "ticket">) {
    if (record.ticket.reviewPoolId) this.pool(record.ticket.reviewPoolId);
  }
  private subject(request: ReviewRequest) {
    const r = this.host.store.get(request.ticketId);
    const a = r.attempts.at(-1);
    ensure(
      r.ticket.reviewPoolId === request.poolId &&
        r.ticket.reviewPolicy === "worker_then_astra",
      "review_binding",
      "Review requires the ticket's two-level pool binding",
    );
    ensure(
      r.ticket.revision === request.revision &&
        a?.id === request.attemptId &&
        a.snapshot?.digest === request.snapshotDigest &&
        r.state === "awaiting_review" &&
        !r.archived,
      "review_binding",
      "Review target is not the current submitted snapshot",
    );
    ensure(
      a.cleanExit && a.delivery?.outcome === "submitted",
      "review_evidence",
      "Review requires a clean submitted implementation",
    );
    ensure(
      capture(r).digest === request.snapshotDigest,
      "stale_snapshot",
      "Review target changed",
    );
    return r;
  }
  request(raw: ReviewRequest) {
    const request = reviewRequestSchema.parse(raw);
    const old = this.runs().find(
      (r) => r.request.requestId === request.requestId,
    );
    if (old) {
      ensure(
        canonical(old.request) === canonical(request),
        "request_conflict",
        "Request ID already has different inputs",
      );
      return old;
    }
    ensure(
      this.host.dispatchEnabled,
      "dispatch_disabled",
      "Review model dispatch is disabled",
    );
    ensure(
      this.pool(request.poolId).state !== "closed",
      "pool_closed",
      "Reopen the review pool before requesting work",
    );
    const r = this.subject(request);
    ensure(
      !r.activeOperation &&
        !this.runs().some(
          (r) =>
            r.request.ticketId === request.ticketId && r.state === "queued",
        ),
      "active_operation",
      "A review is already active or queued for this ticket",
    );
    if (request.priorRunId) {
      const prior = this.get(request.priorRunId);
      ensure(
        prior.state === "completed" &&
          prior.request.ticketId === request.ticketId &&
          prior.report,
        "review_binding",
        "Focused review needs this ticket's completed prior report",
      );
    }
    let run!: ReviewRun;
    this.host.store.transaction(() => {
      const sequence = this.host.store.event(
        request.ticketId,
        "review.requested",
        request,
      );
      run = {
        id: uid(),
        request,
        sequence,
        state: "queued",
        phase: "queued",
        slotHeld: false,
        suspended: false,
        role: "reviewer",
        sessionId: `review-${uid()}`,
        marker: uid(),
        processes: [],
        createdAt: now(),
      };
      this.host.store.putObject("review_runs", run.id, run);
    });
    this.kick();
    return run;
  }
  schedule(requestId: string, ticketId: string, kind: "run" | "verify") {
    const r = this.host.store.get(ticketId, false);
    const old = this.operations().find((o) => o.requestId === requestId);
    if (old) {
      ensure(
        old.ticketId === ticketId &&
          old.kind === kind &&
          old.revision === r.ticket.revision,
        "request_conflict",
        "Scheduled request ID conflict",
      );
      return old;
    }
    ensure(
      this.host.dispatchEnabled || kind === "verify",
      "dispatch_disabled",
      "Dispatch is disabled",
    );
    ensure(
      r.ticket.reviewPoolId,
      "review_pool_missing",
      "Scheduled operations need a bound pool",
    );
    ensure(
      this.pool(r.ticket.reviewPoolId).state !== "closed",
      "pool_closed",
      "Reopen the review pool before scheduling work",
    );
    ensure(
      !this.operations().some(
        (o) => o.ticketId === ticketId && o.state === "queued",
      ),
      "active_operation",
      "An operation is already queued",
    );
    const op: ScheduledOperation = {
      requestId,
      ticketId,
      kind,
      revision: r.ticket.revision,
      sequence: 0,
      state: "queued",
      suspended: false,
      createdAt: now(),
    };
    this.host.store.transaction(() => {
      op.sequence = this.host.store.event(ticketId, "operation.queued", op);
      this.host.store.putObject("scheduled_operations", requestId, op);
    });
    this.kick();
    return op;
  }
  cancelScheduled(requestId: string) {
    const op = this.operations().find((o) => o.requestId === requestId);
    ensure(
      op?.state === "queued",
      "state",
      "Only a queued operation can be withdrawn",
    );
    op.state = "cancelled";
    this.host.store.putObject("scheduled_operations", requestId, op);
    this.kick();
    return op;
  }
  private eligible(
    poolId: string | undefined,
    kind: "review" | "run" | "verify",
  ) {
    if (!poolId) return true;
    const p = this.pool(poolId);
    if (p.state !== "enabled" || p.pendingLimit !== undefined) return false;
    const n = this.counts(poolId);
    return (
      kind === "verify" ||
      (kind === "review" ? n.reviewOwned : n.implementationOwned) <
        p.implementationLimit
    );
  }
  beforeOperation(ticketId: string, kind: "run" | "verify") {
    const r = this.host.store.get(ticketId, false);
    ensure(
      this.eligible(r.ticket.reviewPoolId, kind),
      "pool_capacity",
      "Pool is paused, draining, closed or at its implementation limit",
    );
    ensure(
      this.admitted || !this.candidates().length,
      "capacity_reserved",
      "Older executable work has priority; use schedule to join the durable queue",
    );
  }
  private candidates() {
    const records = new Map(
      this.host.store.list(false).map((r) => [r.ticket.ticketId, r]),
    );
    return [
      ...this.runs()
        .filter((r) => r.state === "queued" && !r.suspended)
        .map((r) => ({
          kind: "review" as const,
          sequence: r.sequence,
          id: r.id,
          ticketId: r.request.ticketId,
          poolId: r.request.poolId,
        })),
      ...this.operations()
        .filter((o) => o.state === "queued" && !o.suspended)
        .map((o) => ({
          kind: o.kind,
          sequence: o.sequence,
          id: o.requestId,
          ticketId: o.ticketId,
          poolId: records.get(o.ticketId)?.ticket.reviewPoolId,
        })),
    ]
      .filter(
        (c) =>
          !records.get(c.ticketId)?.activeOperation &&
          this.eligible(c.poolId, c.kind),
      )
      .sort((a, b) => a.sequence - b.sequence);
  }
  kick() {
    if (this.closed || this.queuedPump) return;
    this.queuedPump = true;
    queueMicrotask(() => {
      this.queuedPump = false;
      if (!this.closed) this.pump();
    });
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const p of this.pools())
        if (p.pendingLimit !== undefined) {
          const n = this.counts(p.poolId);
          if (
            Math.max(n.reviewOwned, n.implementationOwned) <= p.pendingLimit
          ) {
            p.implementationLimit = p.pendingLimit;
            delete p.pendingLimit;
            p.updatedAt = now();
            this.host.store.putObject("review_pools", p.poolId, p);
            this.host.store.event(`pool:${p.poolId}`, "review.pool_drained", p);
          }
        }
      while (this.host.activeCount() < this.host.capacity) {
        const c = this.candidates()[0];
        if (!c) break;
        if (c.kind === "review") {
          const run = this.get(c.id);
          try {
            this.start(run);
          } catch (e) {
            run.slotHeld =
              this.host.store.get(run.request.ticketId, false)
                .activeOperation === run.id;
            run.state = run.slotHeld ? "interrupted" : "failed";
            run.phase = run.slotHeld ? "cleanup" : "ended";
            run.error = String(e);
            run.endedAt = now();
            this.persist(run, "review.admission_failed");
          }
        } else {
          const op = this.operations().find((o) => o.requestId === c.id)!;
          try {
            ensure(
              this.host.store.get(op.ticketId, false).ticket.revision ===
                op.revision,
              "revision_conflict",
              "Queued operation revision changed",
            );
            this.admitted = true;
            this.host[op.kind](op.ticketId);
            op.state = "started";
          } catch (e) {
            op.state = "failed";
            op.error = String(e);
          } finally {
            this.admitted = false;
          }
          this.host.store.putObject("scheduled_operations", op.requestId, op);
          this.host.store.event(op.ticketId, "operation.dispatched", op);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private start(run: ReviewRun) {
    const r = this.subject(run.request);
    const p = this.pool(run.request.poolId);
    cleanEnv([...p.execution.envRequired, ...credentialNames(p.execution)]);
    run.execution = p.execution;
    run.entrySkills = p.entrySkills;
    run.poolVersion = p.version;
    run.state = "running";
    run.phase = "starting";
    run.slotHeld = true;
    run.startedAt = now();
    this.host.store.transaction(() => {
      const current = this.host.store.get(r.ticket.ticketId, false);
      ensure(
        !current.activeOperation,
        "active_operation",
        "Ticket already owned",
      );
      current.activeOperation = run.id;
      this.host.store.save(current, "review.started", { runId: run.id });
      this.host.store.putObject("review_runs", run.id, run);
    });
    const abort = new AbortController();
    const done = Promise.resolve().then(() =>
      this.execute(run, r, abort.signal),
    );
    this.live.set(run.id, { abort, done });
    void done
      .finally(() => {
        this.live.delete(run.id);
        this.kick();
      })
      .catch(() => {
        /* Durable operation ownership remains fenced on persistence failure. */
      });
  }
  private async execute(
    run: ReviewRun,
    source: TicketRecord,
    signal: AbortSignal,
  ) {
    const dir = join(this.host.home, "reviews", run.id);
    const secrets = redactor([
      ...run.execution!.envRequired,
      ...credentialNames(run.execution!),
    ]);
    let inputRecord: TicketRecord | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, "workspace");
      git(dir, [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        source.ticket.targetRepo,
        target,
      ]);
      git(target, ["checkout", "--detach", source.ticket.baseCommit]);
      const owner = uid();
      writeFileSync(
        join(
          gitText(target, ["rev-parse", "--absolute-git-dir"]),
          "dsh-worker-owner",
        ),
        owner,
      );
      // Clear the checkout, then reconstruct ALL snapshot files, not only changed paths.
      for (const path of readdirSync(target))
        if (path !== ".git")
          rmSync(join(target, path), { recursive: true, force: true });
      const snapshot = source.attempts.at(-1)!.snapshot!;
      for (const f of snapshot.files
        .filter((f) => f.kind !== "deleted")
        .sort((a, b) => a.path.localeCompare(b.path))) {
        const path = join(target, f.path);
        ensure(inside(target, path), "snapshot_path", "Invalid snapshot path");
        mkdirSync(dirname(path), { recursive: true });
        if (f.kind === "symlink") {
          ensure(
            f.target && inside(target, resolve(dirname(path), f.target)),
            "snapshot_path",
            "Review symlink escapes input",
          );
          symlinkSync(f.target, path);
        } else {
          const bytes = readFileSync(join(source.worktree, f.path));
          ensure(
            hash(bytes) === f.hash,
            "stale_snapshot",
            "Source bytes changed during review preparation",
          );
          writeFileSync(path, bytes);
          chmodSync(path, f.mode & 0o777);
        }
      }
      if (snapshot.indexDiff)
        git(
          target,
          ["apply", "--cached", "--binary", "-"],
          Buffer.from(snapshot.indexDiff),
        );
      inputRecord = {
        ...source,
        owner,
        worktree: target,
        checkoutBaseline: undefined,
        ticket: { ...source.ticket, targetRepo: target },
      };
      run.workspace = target;
      run.workspaceDigest = capture(inputRecord).digest;
      const local = workflow(this.host.home, dir, run.entrySkills);
      const prior = run.request.priorRunId
        ? this.get(run.request.priorRunId)
        : undefined;
      const input = {
        ticket: source.ticket,
        snapshot,
        implementationReport: source.attempts.at(-1)!.delivery,
        verification: source.verifications.findLast(
          (v) =>
            v.attemptId === run.request.attemptId &&
            v.revision === run.request.revision,
        ),
        priorReport: prior?.report,
        priorDispositions: source.reviews.filter(
          (r) => r.source?.runId === prior?.id,
        ),
        mode: run.request.mode,
        workflow: {
          evidence: local.evidence,
          skills: local.skills,
          entrySkills: local.entrySkills,
          configPath: local.configPath,
        },
      };
      run.inputDigest = hash(canonical(input));
      immutable(join(dir, "input.json"), canonical(input));
      const patches = run.execution!.patches.map((p, i) => {
        const dest = join(dir, `user-${i}${extname(p)}`);
        immutable(dest, readFileSync(p));
        return dest;
      });
      if (local.patch) patches.push(local.patch);
      patches.push(policyPatch(dir));
      run.deadlineAt = new Date(
        Date.now() + run.execution!.timeoutSeconds * 1000,
      ).toISOString();
      run.phase = "running";
      this.persist(run, "review.executing");
      const example = {
        spec: { verdict: "pass", rationale: "Actual evidence" },
        standards: { verdict: "pass", rationale: "Actual evidence" },
        recommendation: "pass",
        coverage: source.ticket.acceptance.map((a) => ({
          acceptanceId: a.id,
          evidence: "Actual evidence",
        })),
        inspectedPaths: snapshot.changedPaths?.length
          ? snapshot.changedPaths
          : ["."],
        findings: [],
        commands: [],
        limitations: [],
      };
      signal.throwIfAborted();
      const result = secrets.value(
        await this.host.runtime.execute(
          {
            ticket: {
              ...source.ticket,
              targetRepo: target,
              execution: run.execution!,
            },
            attemptId: run.id,
            sessionId: run.sessionId,
            worktree: target,
            harnessHome: join(dir, "harness-home"),
            controllerHome: this.host.home,
            patches,
            deadlineAt: run.deadlineAt,
            dshBin: this.host.dshBin,
            prompt: `${reviewerRole}\n${local.context}\nReview mode: ${run.request.mode}. ${run.request.mode === "focused" ? "Read the prior report and dispositions. Focus on fixes, their effects and any demonstrated new defects; ordinary suggestions do not reopen unrelated passing scope. Cover every original criterion with retained or new applicable evidence." : "Perform one complete Spec and Standards review."} Review the full target in ${target}. Frozen evidence is at ${join(dir, "input.json")}. Read it and the relevant source. Do not modify input files; disposable checks go outside this workspace. Deadline ${run.deadlineAt}.\nspec.verdict and standards.verdict MUST each be pass, fail, or inconclusive, with a nonempty rationale. recommendation MUST be pass, request_changes, or blocked; NEVER use fail as a recommendation. Use request_changes for demonstrated defects and blocked for missing critical evidence. commands MUST be an array of objects {"command":"exact command","result":"actual result and exit code"}, NEVER strings. inspectedPaths and findings.path MUST be repository-relative paths, NEVER absolute paths, parent paths, or evidence paths outside the target. Keep evidence file references in rationale instead. coverage MUST contain exactly one object {"acceptanceId":"original ID","evidence":"actual evidence"} per original criterion. Do not copy placeholder evidence. Findings require findingId, dimension (spec/standards), severity (critical/high/medium/low), blocking, path, optional line, requirement, trigger and evidence. Missing evidence is inconclusive. A non-pass needs findings or limitations. Return ONLY JSON matching this example: ${canonical(example)}`,
          },
          dir,
          run.marker,
          signal,
          (message) => {
            if (message.type === "notification")
              this.host.store.event(
                source.ticket.ticketId,
                "review.notification",
                {
                  runId: run.id,
                  notification: secrets.value(message.notification),
                },
              );
          },
          (processes) => {
            run.processes = processes;
            this.persist(run, "review.processes");
          },
        ),
      );
      run.phase = "cleanup";
      run.receipt = result.receipt;
      run.cleanExit = result.cleanExit;
      this.persist(run, "review.runtime_returned");
      ensure(
        !signal.aborted &&
          result.receipt &&
          result.cleanExit &&
          result.finishReason === "completed" &&
          result.termination === "completed",
        "review_execution",
        result.error ?? `Review did not complete: ${result.termination}`,
      );
      ensure(
        capture(inputRecord).digest === run.workspaceDigest &&
          hash(readFileSync(join(dir, "input.json"))) === run.inputDigest,
        "review_input_changed",
        "Reviewer modified frozen input",
      );
      ensure(
        local.evidence.every((e) => hash(readFileSync(e.path)) === e.hash),
        "review_input_changed",
        "Review instruction sources changed",
      );
      ensure(
        capture(this.host.store.get(source.ticket.ticketId)).digest ===
          run.request.snapshotDigest,
        "stale_snapshot",
        "Original source changed during review",
      );
      immutable(join(dir, "response.txt"), result.finalResponse ?? "");
      const report = ticketReviewReportSchema.parse(
        deliveryDocument(result.finalResponse ?? ""),
      );
      const ids = report.coverage.map((c) => c.acceptanceId);
      ensure(
        new Set(ids).size === ids.length &&
          ids.length === source.ticket.acceptance.length &&
          source.ticket.acceptance.every((a) => ids.includes(a.id)),
        "review_coverage",
        "Report must cover every original acceptance exactly once",
      );
      ensure(
        new Set(report.findings.map((f) => f.findingId)).size ===
          report.findings.length,
        "review_findings",
        "Finding IDs must be unique",
      );
      run.report = report;
      run.reportDigest = hash(canonical(report));
      immutable(join(dir, "report.json"), canonical(report));
      run.state = "completed";
    } catch (error) {
      run.state = signal.aborted ? "cancelled" : "failed";
      run.error = secrets.text(String(error));
    } finally {
      run.phase = "cleanup";
      this.persist(run, "review.cleaning");
      try {
        run.processes = await terminate(run.marker, run.processes);
        run.slotHeld = run.processes.length > 0;
        if (run.slotHeld) {
          run.state = "interrupted";
          run.error = "Review process cleanup remains uncertain";
        }
      } catch (error) {
        run.slotHeld = true;
        run.state = "interrupted";
        run.error = secrets.text(String(error));
      }
      run.endedAt = now();
      run.phase = run.slotHeld ? "cleanup" : "ended";
      this.host.store.transaction(() => {
        this.host.store.putObject("review_runs", run.id, run);
        const r = this.host.store.get(source.ticket.ticketId, false);
        if (!run.slotHeld && r.activeOperation === run.id) {
          delete r.activeOperation;
          this.host.store.save(r, "review.released", { runId: run.id });
        }
        this.host.store.event(source.ticket.ticketId, "review.settled", {
          runId: run.id,
          state: run.state,
          error: run.error,
        });
      });
    }
  }
  validateAcceptance(review: Review, record: TicketRecord) {
    if (!review.source) {
      ensure(
        record.ticket.reviewPolicy !== "worker_then_astra" ||
          review.verdict !== "accept",
        "review_source_required",
        "Two-level tickets require a bound independent review report",
      );
      return;
    }
    const run = this.get(review.source.runId);
    ensure(
      run.state === "completed" &&
        !run.slotHeld &&
        run.role === "reviewer" &&
        run.report &&
        run.reportDigest === review.source.reportDigest &&
        hash(canonical(run.report)) === run.reportDigest,
      "review_source",
      "Review source is incomplete or corrupt",
    );
    ensure(
      run.request.ticketId === review.ticketId &&
        run.request.revision === review.revision &&
        run.request.attemptId === review.attemptId &&
        run.request.snapshotDigest === review.snapshotDigest &&
        !record.attempts.some((a) => a.sessionId === run.sessionId),
      "review_source",
      "Review source binding or independent session mismatch",
    );
    ensure(
      hash(
        readFileSync(join(this.host.home, "reviews", run.id, "report.json")),
      ) === run.reportDigest &&
        hash(
          readFileSync(join(this.host.home, "reviews", run.id, "input.json")),
        ) === run.inputDigest,
      "review_source",
      "Review artifacts changed",
    );
    if (review.verdict === "accept") {
      ensure(
        run.report.spec.verdict !== "inconclusive" &&
          run.report.standards.verdict !== "inconclusive" &&
          run.report.recommendation !== "blocked",
        "review_inconclusive",
        "Resolve missing evidence before acceptance",
      );
      const blocking = run.report.findings.filter((f) => f.blocking);
      ensure(
        (run.report.recommendation === "pass" || blocking.length > 0) &&
          blocking.every((f) =>
            review.dispositions?.some(
              (d) => d.findingId === f.findingId && d.evidence.trim(),
            ),
          ),
        "review_disposition",
        "Record evidence for each disputed blocking finding before acceptance",
      );
    }
  }
  owns(id: string) {
    return this.runs().some((r) => r.id === id && r.slotHeld);
  }
  async cancel(id: string) {
    const run = this.get(id);
    const live = this.live.get(id);
    if (live) {
      live.abort.abort();
      await live.done;
      return this.get(id);
    }
    ensure(
      run.state === "queued",
      "review_recovery_required",
      "Account for interrupted review processes explicitly",
    );
    run.state = "cancelled";
    run.phase = "ended";
    run.endedAt = now();
    this.persist(run, "review.cancelled");
    this.kick();
    return run;
  }
  async recover(id: string) {
    const run = this.get(id);
    ensure(
      run.slotHeld && !this.live.has(id),
      "state",
      "Only an interrupted owned review can be recovered",
    );
    run.processes = await terminate(
      run.marker,
      discover(run.marker, run.processes),
    );
    ensure(
      !run.processes.length,
      "process_cleanup",
      "Review still owns processes",
    );
    run.slotHeld = false;
    run.phase = "ended";
    run.state = "interrupted";
    run.endedAt = now();
    this.host.store.transaction(() => {
      const r = this.host.store.get(run.request.ticketId, false);
      ensure(
        r.activeOperation === run.id,
        "review_binding",
        "Ticket operation owner changed",
      );
      delete r.activeOperation;
      this.host.store.save(r, "review.recovered", { runId: id });
      this.host.store.putObject("review_runs", id, run);
    });
    this.kick();
    return run;
  }
  async wait(id: string) {
    await this.live.get(id)?.done;
  }
  async close() {
    this.closed = true;
    for (const live of this.live.values()) live.abort.abort();
    await Promise.all([...this.live.values()].map((l) => l.done));
  }
}
