import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Attempt,
  Action,
  Overview,
  TicketRecord,
  TicketView,
  Verification,
} from "../../contracts/src/index.js";
import {
  actionSchema,
  deliverySchema,
  ticketSchema,
  reviewSchema,
  continuationSchema,
} from "../../contracts/src/index.js";
import { runtimeVersion } from "../../runtime/src/version.js";
import { pruneEphemeral } from "./retention.js";
import { SnapshotReader } from "./snapshot-reader.js";
import { ControllerLock } from "./controller-lock.js";
import { Store, compactRecord } from "./store.js";
import {
  canonical,
  ensure,
  now,
  uid,
  hash,
  immutable,
  inside,
} from "./util.js";
import {
  capture,
  checkOwnership,
  createWorktree,
  createCheckoutBaseline,
  validateRepo,
} from "./git.js";
import { cleanEnv, discover, execute, terminate } from "./process.js";
import type { RuntimeAdapter } from "../../runtime/src/adapter.js";
import { policyPatch, workflow, workerRole } from "../../runtime/src/policy.js";
import { deliveryDocument } from "../../runtime/src/delivery.js";

export interface ControllerOptions {
  home: string;
  capacity?: number;
  dispatchEnabled?: boolean;
  runtime: RuntimeAdapter;
  dshBin?: string;
}
export class Controller {
  readonly store: Store;
  readonly home: string;
  readonly capacity: number;
  readonly dispatchEnabled: boolean;
  private operations = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  private closing = false;
  private readonly lock: ControllerLock;
  private snapshotReader = new SnapshotReader();
  constructor(readonly options: ControllerOptions) {
    mkdirSync(resolve(options.home), { recursive: true, mode: 0o700 });
    this.home = realpathSync(options.home);
    this.capacity = options.capacity ?? 2;
    this.dispatchEnabled = options.dispatchEnabled ?? false;
    ensure(
      Number.isInteger(this.capacity) &&
        this.capacity > 0 &&
        this.capacity <= 32,
      "capacity",
      "Capacity must be 1–32",
    );
    this.lock = new ControllerLock(this.home);
    let store: Store | undefined;
    try {
      this.store = store = new Store(this.home);
      // Startup fences incomplete operations. It never sends or retries a prompt.
      for (const r of this.store.list())
        if (r.activeOperation)
          this.store.update(
            r.ticket.ticketId,
            "execution.interrupted",
            (record) => {
              for (const instruction of record.instructions ?? [])
                if (instruction.status === "sending") {
                  instruction.status = "uncertain";
                  instruction.error = "Controller restarted before receipt";
                }
              record.interruptedOperation ??= record.verifications.some(
                (v) => v.id === record.activeOperation,
              )
                ? "verification"
                : "execution";
              record.activeOperation = `uncertain:${uid()}`;
              record.state = "interrupted";
              record.error =
                "Controller restarted during an operation; explicit recovery and process accounting required";
            },
          );
    } catch (error) {
      store?.close();
      this.lock.close();
      throw error;
    }
  }
  private artifactDir() {
    return join(this.home, "artifacts");
  }
  private idle(r: TicketRecord) {
    ensure(
      !r.activeOperation,
      "active_operation",
      "Ticket has an active or uncertain operation; inspect recovery",
    );
  }
  private current(r: TicketRecord) {
    const a = r.attempts.at(-1);
    ensure(a, "attempt_missing", "No attempt exists");
    return a;
  }
  private view(r: TicketRecord, detailed = false): TicketView {
    if (!detailed)
      return {
        ...r,
        stale: false,
        currentSnapshot: r.attempts.at(-1)?.snapshot?.digest,
      };
    try {
      const snapshot = capture(r);
      const accepted =
        r.state === "accepted" ? r.reviews.at(-1)?.snapshotDigest : undefined;
      return {
        ...r,
        stale: !!accepted && accepted !== snapshot.digest,
        currentSnapshot: snapshot.digest,
      };
    } catch (error) {
      return {
        ...r,
        stale: r.state === "accepted",
        error: `${r.error ?? ""} ${String(error)}`.trim(),
      };
    }
  }
  async pollStatus(id: string, details = false): Promise<TicketView> {
    const stored = this.store.get(id, details);
    const r = details ? stored : compactRecord(stored);
    // Running/ready polling has no freshness decision to make.
    if (
      !["accepted", "awaiting_review", "blocked", "interrupted"].includes(
        r.state,
      )
    )
      return { ...r, stale: false };
    try {
      const { digest, checkedAt } = await this.snapshotReader.read(r);
      // Do not present an older operation as current after asynchronous I/O.
      if (this.store.get(id, false).updatedAt !== r.updatedAt)
        return this.pollStatus(id, details);
      return {
        ...r,
        stale:
          r.state === "accepted" && r.reviews.at(-1)?.snapshotDigest !== digest,
        currentSnapshot: digest,
        snapshotCheckedAt: checkedAt,
        snapshotMaxAgeMs: 3000,
      };
    } catch (error) {
      return {
        ...r,
        stale: r.state === "accepted",
        error: `${r.error ?? ""} ${String(error)}`.trim(),
      };
    }
  }
  async pollOverview(): Promise<Overview> {
    return {
      ...this.overview(false),
      tickets: await Promise.all(
        this.store.list(false).map((r) => this.pollStatus(r.ticket.ticketId)),
      ),
    };
  }
  overview(fresh = false): Overview {
    return {
      tickets: this.store.list(false).map((record) => {
        const r = compactRecord(record);
        return fresh ? this.view(r, true) : { ...r, stale: false };
      }),
      capacity: this.capacity,
      active: this.operations.size,
      dispatchEnabled: this.dispatchEnabled,
      runtimeVersion: this.options.dshBin
        ? "custom executable (version unverified)"
        : runtimeVersion,
    };
  }
  status(id: string) {
    return this.view(this.store.get(id), true);
  }
  async action(
    input: Extract<Action, { action: "prune" }>,
  ): Promise<ReturnType<typeof pruneEphemeral>>;
  async action(
    input: Exclude<Action, { action: "prune" }>,
  ): Promise<TicketView>;
  async action(
    input: unknown,
  ): Promise<TicketView | ReturnType<typeof pruneEphemeral>>;
  async action(input: unknown) {
    ensure(!this.closing, "shutting_down", "Controller is shutting down");
    const command = actionSchema.parse(input);
    switch (command.action) {
      case "prune":
        return pruneEphemeral(this.home, this.store.list(false), command.days);
      case "instruct":
        return this.instruct(command);
      case "archive": {
        this.store.update(command.ticketId, "ticket.archived", (r) => {
          this.idle(r);
          r.archived = command.archived;
        });
        return this.status(command.ticketId);
      }
      case "prepare":
        return this.prepare(command.ticket);
      case "run":
        return this.run(command.ticketId);
      case "cancel":
        return this.cancel(command.ticketId);
      case "verify":
        return this.verify(command.ticketId);
      case "review":
        return this.review(command.review);
      case "recover":
        return this.recover(command.continuation);
    }
  }
  async instruct(command: Extract<Action, { action: "instruct" }>) {
    const r = this.store.get(command.ticketId);
    const existing = r.instructions?.find(
      (i) => i.id === command.instructionId,
    );
    if (existing) {
      ensure(
        existing.text === command.instruction &&
          existing.revision === command.revision,
        "instruction_conflict",
        "Instruction identity already used for different content",
      );
      return this.status(command.ticketId);
    }
    ensure(
      !r.archived && r.ticket.revision === command.revision,
      "revision_conflict",
      "Refresh the current unarchived revision before sending instructions",
    );
    ensure(
      ["ready", "changes_requested", "running"].includes(r.state),
      "state",
      "Review or explicitly recover this task before adding execution instructions",
    );
    const running = r.state === "running";
    const attempt = r.attempts.at(-1);
    if (running)
      ensure(
        attempt?.receipt && this.options.runtime.instruct && !this.closing,
        "runtime_unavailable",
        "Wait for the initial runtime receipt before sending instructions",
      );
    else this.idle(r);
    this.store.update(command.ticketId, "instruction.recorded", (record) => {
      (record.instructions ??= []).push({
        id: command.instructionId,
        revision: command.revision,
        text: command.instruction,
        time: now(),
        status: running ? "sending" : "queued",
        ...(running ? { attemptId: attempt!.id } : {}),
      });
    });
    if (running) {
      try {
        const messageId = await this.options.runtime.instruct!(
          attempt!.id,
          command.instructionId,
          `Additional execution instruction within the assigned scope (external review and delivery contract still apply):\n${command.instruction}`,
        );
        this.store.update(
          command.ticketId,
          "instruction.received",
          (record) => {
            const i = record.instructions!.find(
              (i) => i.id === command.instructionId,
            )!;
            i.status = "received";
            i.messageId = messageId;
          },
        );
      } catch (error) {
        this.store.update(
          command.ticketId,
          "instruction.uncertain",
          (record) => {
            const i = record.instructions!.find(
              (i) => i.id === command.instructionId,
            )!;
            i.status = "uncertain";
            i.error = String(error);
          },
        );
      }
    }
    return this.status(command.ticketId);
  }
  prepare(input: unknown) {
    const ticket = ticketSchema.parse(input);
    ensure(
      ticket.targetRepo.startsWith("/"),
      "repository_path",
      "Repository path must be absolute",
    );
    ticket.targetRepo = realpathSync(ticket.targetRepo);
    validateRepo(ticket);
    workflow(this.home);
    for (const path of ticket.execution.patches)
      ensure(
        resolve(path) === path && existsSync(path),
        "patch_path",
        "Runtime patches must be existing absolute paths",
      );
    const record = this.store.transaction(() => {
      let existing: TicketRecord | undefined;
      if (this.store.has(ticket.ticketId))
        existing = this.store.get(ticket.ticketId);
      if (existing) {
        this.idle(existing);
        ensure(
          existing.ticket.targetRepo === ticket.targetRepo &&
            existing.ticket.baseCommit === ticket.baseCommit,
          "ticket_lineage",
          "Repository/base changes require a new ticket",
        );
        if (existing.ticket.revision === ticket.revision) {
          ensure(
            canonical(existing.ticket) === canonical(ticket),
            "revision_conflict",
            "Cannot change an existing revision",
          );
          return existing;
        }
        ensure(
          ticket.revision === existing.ticket.revision + 1,
          "revision_order",
          "Revision must increment by one",
        );
        checkOwnership(existing);
      } else
        ensure(
          ticket.revision === 1,
          "revision_order",
          "New ticket must start at revision 1",
        );
      const owner = existing?.owner ?? uid();
      const worktree =
        existing?.worktree ??
        join(this.home, "worktrees", `${ticket.ticketId}-${owner.slice(0, 8)}`);
      ensure(
        !inside(ticket.targetRepo, this.home) &&
          !inside(this.home, ticket.targetRepo),
        "home_overlap",
        "Controller home and target repository must not contain each other",
      );
      for (const other of this.store.list())
        if (other.ticket.ticketId !== ticket.ticketId)
          ensure(
            !inside(other.worktree, worktree) &&
              !inside(worktree, other.worktree),
            "worktree_overlap",
            "Ticket worktrees overlap",
          );
      const r: TicketRecord = {
        archived: existing?.archived,
        instructions: existing?.instructions ?? [],
        ticket,
        state: "ready",
        worktree,
        owner,
        prepared: false,
        checkoutBaseline: existing?.checkoutBaseline,
        updatedAt: now(),
        attempts: existing?.attempts ?? [],
        reviews: existing?.reviews ?? [],
        continuations: existing?.continuations ?? [],
        verifications: existing?.verifications ?? [],
      };
      this.store.revision(r);
      this.store.save(r, "ticket.reserved");
      return r;
    });
    try {
      if (createWorktree(record)) {
        const baseline = createCheckoutBaseline(record, this.artifactDir());
        this.store.update(ticket.ticketId, "ticket.baseline", (r) => {
          r.checkoutBaseline = baseline;
        });
        record.checkoutBaseline = baseline;
      }
      const baseline = capture(record, this.artifactDir());
      ensure(
        !baseline.violations.length,
        "scope",
        baseline.violations.join("; "),
      );
      if (!record.prepared)
        this.store.update(ticket.ticketId, "ticket.prepared", (r) => {
          r.prepared = true;
          r.state = "ready";
          delete r.error;
        });
    } catch (error) {
      this.store.update(ticket.ticketId, "ticket.blocked", (r) => {
        r.state = "blocked";
        r.error = String(error);
      });
      throw error;
    }
    return this.status(ticket.ticketId);
  }
  run(id: string) {
    ensure(
      this.dispatchEnabled,
      "dispatch_disabled",
      "Dispatch is disabled. Start the service with --enable-dispatch after development acceptance.",
    );
    ensure(
      this.operations.size < this.capacity,
      "capacity",
      "Worker capacity reached",
    );
    const r = this.store.get(id);
    this.idle(r);
    ensure(!r.archived, "archived", "Restore this task before running it");
    ensure(
      r.prepared && ["ready", "changes_requested"].includes(r.state),
      "state",
      "Ticket is not ready to run",
    );
    checkOwnership(r);
    cleanEnv(r.ticket.execution.envRequired);
    const before = capture(r, this.artifactDir());
    ensure(!before.violations.length, "scope", before.violations.join("; "));
    const attempt: Attempt = {
      id: uid(),
      revision: r.ticket.revision,
      sessionId: `session-${uid().replaceAll("-", "")}`,
      startedAt: now(),
      marker: uid(),
      processes: [],
      receipt: false,
      cleanExit: false,
    };
    const dir = join(this.home, "runs", attempt.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const local = workflow(this.home, dir);
    const policy = policyPatch(dir);
    // Snapshot patches before launch; caller edits cannot change an already admitted attempt.
    const patches = r.ticket.execution.patches.map((p, i) => {
      const target = join(
        dir,
        `user-${i}.patch${p.endsWith(".json") ? ".json" : ".yml"}`,
      );
      immutable(target, readFileSync(p));
      return target;
    });
    if (local.patch) patches.push(local.patch);
    patches.push(policy);
    const instruction =
      r.state === "changes_requested"
        ? canonical(r.reviews.at(-1))
        : canonical(r.continuations.at(-1) ?? {});
    const queued = (r.instructions ?? []).filter(
      (i) => i.status === "queued" && i.revision === r.ticket.revision,
    );
    const deliveryExample = {
      schemaVersion: 2,
      ticketId: id,
      revision: r.ticket.revision,
      attemptId: attempt.id,
      outcome: "submitted",
      summary: "Describe the actual changes",
      evidence: r.ticket.acceptance.map((a) => ({
        acceptanceId: a.id,
        evidence: "Describe evidence",
      })),
      commands: [
        {
          command: "The command actually executed",
          result: "Its actual exit status and result",
        },
      ],
      notRun: [],
      blockers: [],
    };
    const prompt = `${workerRole}\n\n${local.context}\n\nAssignment:\n${canonical(r.ticket)}\n\nReview / continuation:\n${instruction}\n\nAdditional execution instructions within assigned scope:\n${queued.map((i) => i.text).join("\n\n")}\n\nCurrent snapshot: ${before.digest}\n\nYour final response must be ONLY a JSON delivery document matching this shape (no fences):\n${JSON.stringify(deliveryExample)}\nUse outcome blocked and blockers for unresolved issues. Do not write the delivery into the checkout.`;
    immutable(
      join(dir, "input.json"),
      canonical({
        ticket: r.ticket,
        attempt,
        before: before.digest,
        workflow: local.evidence,
        promptHash: hash(prompt),
      }),
    );
    this.store.update(id, "attempt.started", (record) => {
      this.idle(record);
      ensure(
        record.ticket.revision === r.ticket.revision,
        "revision_conflict",
        "Revision changed before launch",
      );
      record.attempts.push(attempt);
      for (const i of record.instructions ?? [])
        if (queued.some((q) => q.id === i.id)) {
          i.status = "sending";
          i.attemptId = attempt.id;
        }
      record.activeOperation = attempt.id;
      record.state = "running";
      delete record.error;
    });
    const abort = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        const result = await this.options.runtime.execute(
          {
            ticket: r.ticket,
            attemptId: attempt.id,
            sessionId: attempt.sessionId,
            worktree: r.worktree,
            harnessHome: join(dir, "harness-home"),
            patches,
            prompt,
            dshBin: this.options.dshBin,
          },
          dir,
          attempt.marker,
          abort.signal,
          (message) => {
            if (message.type === "notification")
              this.store.transaction(() => {
                this.store.event(id, "harness.notification", {
                  ...message.notification,
                  attemptId: attempt.id,
                });
                const { method, params } = message.notification;
                if (
                  method === "session.event" &&
                  params.sessionId === attempt.sessionId
                ) {
                  const event = params.event as {
                    type?: string;
                    data?: { reason?: { kind?: string } };
                  };
                  if (
                    event.type === "agent/inbox/spliced" ||
                    event.type === "turn/end"
                  ) {
                    const record = this.store.get(id);
                    const current = this.current(record);
                    if (event.type === "agent/inbox/spliced")
                      current.receipt = true;
                    if (event.type === "agent/inbox/spliced")
                      for (const i of record.instructions ?? [])
                        if (queued.some((q) => q.id === i.id))
                          i.status = "received";
                    if (event.type === "turn/end")
                      current.finishReason = event.data?.reason?.kind;
                    this.store.save(record, "attempt.observed");
                  }
                }
              });
          },
          (processes) => {
            if (
              canonical(this.current(this.store.get(id, false)).processes) ===
              canonical(processes)
            )
              return;
            this.store.update(id, "attempt.processes", (record) => {
              this.current(record).processes = processes;
            });
          },
        );
        let snapshot: Attempt["snapshot"];
        let snapshotError: unknown;
        try {
          snapshot = capture(this.store.get(id), this.artifactDir());
        } catch (error) {
          snapshotError = error;
        }
        this.store.update(id, "attempt.settled", (record) => {
          const a = this.current(record);
          a.endedAt = now();
          a.receipt = result.receipt;
          a.finishReason = result.finishReason;
          a.termination = result.termination;
          a.cleanExit = result.cleanExit;
          a.error = result.error;
          for (const i of record.instructions ?? [])
            if (queued.some((q) => q.id === i.id) && i.status === "sending") {
              i.status = result.receipt ? "received" : "uncertain";
            }
          if (result.cleanExit) delete record.activeOperation;
          a.snapshot = snapshot;
          if (snapshotError)
            a.error = `${a.error ?? ""} Snapshot: ${String(snapshotError)}`;
          try {
            a.delivery = deliverySchema.parse(
              deliveryDocument(result.finalResponse ?? ""),
            );
            ensure(
              a.delivery.ticketId === id &&
                a.delivery.revision === record.ticket.revision &&
                a.delivery.attemptId === a.id,
              "delivery_binding",
              "Delivery belongs to another attempt",
            );
            const ids = new Set(a.delivery.evidence.map((e) => e.acceptanceId));
            ensure(
              record.ticket.acceptance.every((ac) => ids.has(ac.id)),
              "delivery_evidence",
              "Missing acceptance evidence",
            );
          } catch (error) {
            delete a.delivery;
            a.error = `${a.error ?? ""} Delivery: ${String(error)}`;
          }
          const complete =
            result.termination === "completed" &&
            result.finishReason === "completed" &&
            result.receipt &&
            result.cleanExit &&
            a.snapshot &&
            !a.snapshot.violations.length &&
            a.delivery;
          record.state = complete
            ? a.delivery!.outcome === "blocked" || a.delivery!.blockers.length
              ? "blocked"
              : "awaiting_review"
            : "interrupted";
          if (a.snapshot?.violations.length) {
            record.state = "blocked";
            a.error = a.snapshot.violations.join("; ");
          }
          record.error = a.error;
        });
      } catch (error) {
        this.store.update(id, "attempt.failed", (record) => {
          record.state = "interrupted";
          record.error = String(error);
          this.current(record).error = String(error);
        });
      } finally {
        this.operations.delete(id);
      }
    });
    this.operations.set(id, { abort, done });
    return this.status(id);
  }
  async cancel(id: string) {
    const active = this.operations.get(id);
    ensure(
      active,
      "not_running",
      "No live operation in this service; use recovery for an interrupted attempt",
    );
    active.abort.abort();
    await active.done;
    return this.status(id);
  }
  verify(id: string) {
    ensure(
      this.operations.size < this.capacity,
      "capacity",
      "Worker capacity reached",
    );
    const r = this.store.get(id);
    this.idle(r);
    ensure(
      r.state === "awaiting_review",
      "state",
      "Verification requires awaiting_review",
    );
    const a = this.current(r);
    const before = capture(r, this.artifactDir());
    ensure(
      a.snapshot?.digest === before.digest,
      "stale_snapshot",
      "Worktree changed since delivery",
    );
    const verification: Verification = {
      id: uid(),
      attemptId: a.id,
      revision: r.ticket.revision,
      startedAt: now(),
      before: before.digest,
      passed: false,
      commands: [],
      marker: uid(),
      processes: [],
      cleanExit: false,
    };
    this.store.update(id, "verification.started", (record) => {
      this.idle(record);
      record.activeOperation = verification.id;
      record.verifications.push(verification);
    });
    const abort = new AbortController();
    // A failure before the first command awaits cleanup must still release
    // the operation registered below.
    const done = Promise.resolve().then(async () => {
      try {
        for (const cmd of r.ticket.verification) {
          if (abort.signal.aborted) break;
          const cwd = realpathSync(resolve(r.worktree, cmd.cwd));
          ensure(
            inside(r.worktree, cwd),
            "verification_cwd",
            "Verifier cwd escapes worktree",
          );
          const stop = () => {
            void terminate(verification.marker, verification.processes).catch(
              () => {},
            );
          };
          abort.signal.addEventListener("abort", stop, { once: true });
          try {
            const result = await execute(
              cmd.args,
              cwd,
              cmd.timeoutSeconds,
              verification.marker,
              (processes) => {
                if (canonical(verification.processes) === canonical(processes))
                  return;
                verification.processes = processes;
                this.store.update(id, "verification.processes", (record) => {
                  record.verifications.at(-1)!.processes = processes;
                });
              },
            );
            verification.commands.push(result);
            this.store.update(id, "verification.command", (record) => {
              record.verifications.at(-1)!.commands = [
                ...verification.commands,
              ];
            });
            if (result.exitCode !== 0 || result.timedOut) break;
          } finally {
            abort.signal.removeEventListener("abort", stop);
          }
        }
        verification.after = capture(
          this.store.get(id),
          this.artifactDir(),
        ).digest;
        verification.cleanExit = true;
        verification.endedAt = now();
        verification.passed =
          !abort.signal.aborted &&
          verification.commands.length === r.ticket.verification.length &&
          verification.commands.every((c) => c.exitCode === 0 && !c.timedOut) &&
          verification.before === verification.after;
        this.store.update(id, "verification.settled", (record) => {
          record.verifications[record.verifications.length - 1] = verification;
          delete record.activeOperation;
          if (verification.before !== verification.after) {
            record.state = "blocked";
            record.error =
              "Verification changed the delivered snapshot; new attempt required";
          }
        });
      } catch (error) {
        this.store.update(id, "verification.failed", (record) => {
          record.state = "interrupted";
          record.interruptedOperation = "verification";
          record.error = String(error);
          const failed = record.verifications.find(
            (v) => v.id === verification.id,
          )!;
          failed.error = String(error);
          failed.endedAt = now();
          failed.passed = false;
        });
      } finally {
        this.operations.delete(id);
      }
    });
    this.operations.set(id, { abort, done });
    return this.status(id);
  }
  review(input: unknown) {
    const review = reviewSchema.parse(input);
    const r = this.store.get(review.ticketId);
    const snapshot = capture(r, this.artifactDir());
    this.store.transaction(() => {
      this.idle(r);
      ensure(
        r.state === "awaiting_review",
        "state",
        "Review requires awaiting_review",
      );
      const a = this.current(r);
      ensure(
        review.revision === r.ticket.revision && review.attemptId === a.id,
        "review_binding",
        "Review does not match current attempt",
      );
      ensure(
        a.snapshot?.digest === review.snapshotDigest &&
          snapshot.digest === review.snapshotDigest,
        "stale_snapshot",
        "Review snapshot is stale",
      );
      if (review.verdict === "accept") {
        ensure(
          !snapshot.violations.length &&
            a.cleanExit &&
            a.delivery?.outcome === "submitted",
          "review_evidence",
          "Delivery cannot be accepted",
        );
        const verification = r.verifications.findLast(
          (v) => v.attemptId === a.id && v.revision === r.ticket.revision,
        );
        ensure(
          verification?.passed &&
            verification.cleanExit &&
            verification.before === snapshot.digest &&
            verification.after === snapshot.digest,
          "verification_required",
          "Independent controller verification of this snapshot must pass",
        );
      }
      r.reviews.push(review);
      r.state =
        review.verdict === "accept"
          ? "accepted"
          : review.verdict === "request_changes"
            ? "changes_requested"
            : "blocked";
      this.store.save(r, "review.recorded", review);
    });
    return this.view(r);
  }
  recovery(id: string) {
    const r = this.store.get(id);
    const snapshot = capture(r);
    const uncertain = [
      ...r.attempts.filter((a) => !a.cleanExit),
      ...r.verifications.filter((v) => !v.cleanExit),
    ];
    const processes = uncertain.flatMap((a) => discover(a.marker, a.processes));
    return {
      ticketId: id,
      revision: r.ticket.revision,
      attemptId: r.attempts.at(-1)?.id,
      snapshotDigest: snapshot.digest,
      state: r.state,
      processes,
      canRecover: !this.operations.has(id),
      instructionRequired: true,
    };
  }
  async recover(input: unknown) {
    const c = continuationSchema.parse(input);
    const r = this.store.get(c.ticketId);
    ensure(
      !this.operations.has(c.ticketId),
      "active_operation",
      "Cannot recover a live operation",
    );
    ensure(
      ["blocked", "interrupted"].includes(r.state),
      "state",
      "Recovery requires blocked or interrupted",
    );
    const a = this.current(r);
    ensure(
      c.revision === r.ticket.revision && c.attemptId === a.id,
      "continuation_binding",
      "Continuation does not match current attempt",
    );
    ensure(
      capture(r).digest === c.snapshotDigest,
      "stale_snapshot",
      "Continuation snapshot is stale",
    );
    const recoveryId = "recovery:" + uid();
    this.store.update(c.ticketId, "recovery.started", (record) => {
      record.activeOperation = recoveryId;
    });
    const abort = new AbortController();
    // Register the operation before recovery can settle, including the fast
    // path where every process has already exited and no cleanup is awaited.
    const work = Promise.resolve().then(async () => {
      try {
        for (const op of [
          ...r.attempts.filter((x) => !x.cleanExit),
          ...r.verifications.filter((x) => !x.cleanExit),
        ])
          ensure(
            !(await terminate(op.marker, op.processes)).length,
            "process_cleanup",
            "Unaccounted writer remains",
          );
        const current = this.store.get(c.ticketId);
        ensure(
          current.activeOperation === recoveryId,
          "recovery_owner",
          "Recovery ownership changed",
        );
        ensure(
          capture(current, this.artifactDir()).digest === c.snapshotDigest,
          "stale_snapshot",
          "Snapshot changed during recovery",
        );
        this.store.update(c.ticketId, "ticket.recovered", (record) => {
          for (const op of [...record.attempts, ...record.verifications]) {
            op.cleanExit = true;
            op.processes = [];
          }
          delete record.activeOperation;
          record.continuations.push(c);
          const delivered = record.attempts.at(-1);
          const resumeVerification =
            record.interruptedOperation === "verification" &&
            delivered?.revision === record.ticket.revision &&
            delivered.receipt &&
            delivered.finishReason === "completed" &&
            delivered.termination === "completed" &&
            delivered.delivery?.outcome === "submitted" &&
            !delivered.delivery.blockers.length &&
            delivered.snapshot?.digest === c.snapshotDigest &&
            !delivered.snapshot.violations.length;
          record.state = resumeVerification ? "awaiting_review" : "ready";
          delete record.interruptedOperation;
          delete record.error;
        });
        return this.status(c.ticketId);
      } catch (error) {
        this.store.update(c.ticketId, "recovery.failed", (record) => {
          record.activeOperation = "uncertain:" + uid();
          record.error = String(error);
        });
        throw error;
      } finally {
        this.operations.delete(c.ticketId);
      }
    });
    this.operations.set(c.ticketId, {
      abort,
      done: work.then(
        () => {},
        () => {},
      ),
    });
    return work;
  }
  async wait(id: string) {
    await this.operations.get(id)?.done;
    return this.status(id);
  }
  async close() {
    this.closing = true;
    for (const op of this.operations.values()) op.abort.abort();
    await Promise.all([...this.operations.values()].map((op) => op.done));
    await this.snapshotReader.close();
    this.store.close();
    this.lock.close();
  }
}
