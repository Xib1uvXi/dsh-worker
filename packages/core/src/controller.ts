import { ReviewCoordinator } from "./review-coordinator.js";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Attempt,
  Action,
  Overview,
  TicketRecord,
  TicketView,
  Verification,
  VerificationBaseline,
  CommandRun,
  CancellationGuard,
  Command,
} from "../../contracts/src/index.js";
import {
  actionSchema,
  cancellationGuardSchema,
  boundDelivery,
  ticketSchema,
  reviewSchema,
  continuationSchema,
} from "../../contracts/src/index.js";
import { executeCommand } from "../../runtime/src/commands.js";
import { credentialNames } from "../../runtime/src/credentials.js";
import { redactor } from "../../shared/src/redaction.js";
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
} from "../../shared/src/util.js";
import {
  capture,
  checkOwnership,
  createWorktree,
  createCheckoutBaseline,
  validateRepo,
} from "./git.js";
import { cleanEnv, discover, terminate } from "../../shared/src/process.js";
import type { RuntimeAdapter } from "../../runtime/src/adapter.js";
import { policyPatch, workflow, workerRole } from "../../runtime/src/policy.js";
import { deliveryDocument } from "../../runtime/src/delivery.js";
import {
  failureReport,
  instructionText,
  observeConsumption,
} from "./attempt-feedback.js";
import { buildInfo } from "../../shared/src/build.js";

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
  readonly reviewCoordinator: ReviewCoordinator;
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
      this.reviewCoordinator = new ReviewCoordinator({
        store: this.store,
        home: this.home,
        capacity: this.capacity,
        dispatchEnabled: this.dispatchEnabled,
        runtime: options.runtime,
        dshBin: options.dshBin,
        activeCount: () => this.activeCount(),
        run: (id) => this.run(id),
        verify: (id) => this.verify(id),
        wait: (id) => this.wait(id),
      });
      // Startup fences incomplete operations. It never sends or retries a prompt.
      for (const r of this.store.list())
        if (
          r.activeOperation &&
          !this.reviewCoordinator.owns(r.activeOperation)
        )
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
  private activeCount() {
    return new Set([
      ...this.operations.keys(),
      ...this.store
        .list(false)
        .filter((r) => r.activeOperation)
        .map((r) => r.ticket.ticketId),
    ]).size;
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
      build: buildInfo,
      active:
        this.operations.size +
        this.reviewCoordinator.runs().filter((r) => r.slotHeld).length,
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
    input: Exclude<
      Action,
      {
        action:
          | "prune"
          | "review-pool"
          | "request-review"
          | "cancel-review"
          | "recover-review"
          | "schedule"
          | "cancel-scheduled";
      }
    >,
  ): Promise<TicketView>;
  async action(input: unknown): Promise<unknown>;
  async action(input: unknown) {
    ensure(!this.closing, "shutting_down", "Controller is shutting down");
    const command = actionSchema.parse(input);
    switch (command.action) {
      case "review-pool":
        return this.reviewCoordinator.configure(command.pool);
      case "request-review":
        return this.reviewCoordinator.request(command.request);
      case "cancel-review":
        return this.reviewCoordinator.cancel(command.runId);
      case "recover-review":
        return this.reviewCoordinator.recover(command.runId);
      case "schedule":
        return this.reviewCoordinator.schedule(
          command.requestId,
          command.ticketId,
          command.kind,
        );
      case "cancel-scheduled":
        return this.reviewCoordinator.cancelScheduled(command.requestId);
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
        return this.cancel(command.ticketId, command.ifUnconsumed);
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
    ensure(
      !r.pendingDelivery && !(running && attempt?.deliveryOnlyFrom),
      "delivery_only",
      "Delivery-only recovery does not accept implementation instructions; use an explicit restart for further changes",
    );
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
          instructionText(command.instructionId, command.instruction),
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
            i.receivedAt = now();
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
    this.reviewCoordinator.validateTicket({ ticket });
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
            canonical(ticketSchema.parse(existing.ticket)) ===
              canonical(ticket),
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
        verificationBaselines: existing?.verificationBaselines ?? [],
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
    this.reviewCoordinator.beforeOperation(id, "run");
    ensure(
      this.dispatchEnabled,
      "dispatch_disabled",
      "Dispatch is disabled. Start the service with --enable-dispatch after development acceptance.",
    );
    ensure(
      this.activeCount() < this.capacity,
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
    cleanEnv([
      ...r.ticket.execution.envRequired,
      ...credentialNames(r.ticket.execution),
    ]);
    const before = capture(r, this.artifactDir());
    ensure(!before.violations.length, "scope", before.violations.join("; "));
    const answer = r.pendingAnswer;
    const deliveryOnly = r.pendingDelivery;
    if (deliveryOnly) {
      const prior = this.current(r);
      ensure(
        prior.id === deliveryOnly.attemptId &&
          prior.revision === r.ticket.revision &&
          before.digest === deliveryOnly.snapshotDigest,
        "continuation_binding",
        "Delivery-only recovery no longer matches the frozen snapshot",
      );
      ensure(
        prior.cleanExit && !discover(prior.marker, prior.processes).length,
        "process_cleanup",
        "Previous delivery still has a writer",
      );
    }
    const previous = answer ? this.current(r) : undefined;
    if (answer) {
      ensure(
        previous?.id === answer.attemptId &&
          previous.revision === r.ticket.revision &&
          before.digest === answer.snapshotDigest,
        "continuation_binding",
        "Answer no longer matches the blocked delivery",
      );
      ensure(
        previous.cleanExit &&
          !discover(previous.marker, previous.processes).length,
        "process_cleanup",
        "Previous session still has a writer",
      );
      ensure(
        existsSync(
          join(this.home, "runs", previous.id, "harness-home", "sessions"),
        ),
        "session_missing",
        "Previous session history is unavailable",
      );
    }
    const secrets = redactor([
      ...r.ticket.execution.envRequired,
      ...credentialNames(r.ticket.execution),
    ]);
    const attempt: Attempt = {
      deliveryOnlyFrom: deliveryOnly
        ? {
            attemptId: deliveryOnly.attemptId,
            snapshotDigest: deliveryOnly.snapshotDigest,
          }
        : undefined,
      controllerBuild: buildInfo,
      id: uid(),
      revision: r.ticket.revision,
      sessionId: previous?.sessionId ?? `session-${uid().replaceAll("-", "")}`,
      resumedFrom: previous?.id,
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
    const workspace = canonical({
      workingDirectory: r.worktree,
      primaryRepository: r.ticket.targetRepo,
      baseCommit: r.ticket.baseCommit,
    });
    const prompt = `${workerRole}\n\nExecution workspace (controller-owned):\n${workspace}\nRead, edit and run assignment commands in workingDirectory. Resolve assignment-relative source, test and document paths there. The ticket targetRepo is the primary repository reference, not your execution checkout; preserve it. Read the worktree files before editing them.\n\n${local.context}\n\nAssignment:\n${canonical(r.ticket)}\n\nHistorical review / continuation (its attemptId is NOT the current delivery binding):\n${instruction}\n\nAdditional execution instructions within assigned scope:\n${queued.map((i) => i.text).join("\n\n")}\n\nCurrent snapshot: ${before.digest}\n\nDelivery field types: notRun and blockers are string[] (for example ["Live provider check was not run"]), never object arrays. Use [] when empty. Commands are {command: string, result: string}[]; evidence is {acceptanceId: string, evidence: string}[]. Provide exactly ONE evidence entry for EACH assigned acceptance ID, with no missing or duplicate IDs; combine findings for the same criterion into that entry. Copy ticketId, revision and attemptId ONLY from the current delivery example below. Preserve true command exit codes; do not infer success from tail/grep/awk pipeline exit status. Use focused regressions while correcting known issues, then run the required full gates once the changes settle; retain output for counting instead of rerunning checks only to summarize them.\n\nYour final response must be ONLY a JSON delivery document matching this shape (no fences):\n${JSON.stringify(deliveryExample)}\nUse outcome blocked and blockers for unresolved issues. Do not write the delivery into the checkout.`;
    let runtimePrompt = answer
      ? `Answer to the previous blocker:\n${answer.instruction}\n\n${prompt}`
      : prompt;
    if (deliveryOnly)
      runtimePrompt = `DELIVERY-ONLY RECOVERY of attempt ${deliveryOnly.attemptId}, frozen snapshot ${deliveryOnly.snapshotDigest}. Do not edit source or repeat implementation/tests. Report only existing evidence, explicitly attributing reused commands to that earlier attempt; do not claim new execution. Missing evidence stays in notRun/blockers. Source changes invalidate this repair. The current delivery binding is in the example at the end, not in this historical reference.\n\n${runtimePrompt}`;
    immutable(
      join(dir, "input.json"),
      canonical({
        ticket: r.ticket,
        attempt,
        before: before.digest,
        workflow: local.evidence,
        promptHash: hash(runtimePrompt),
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
      delete record.pendingAnswer;
      delete record.pendingDelivery;
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
    let runtimeEntered = false;
    const done = Promise.resolve().then(async () => {
      try {
        if (!(await this.prepareEnvironment(id, attempt, abort.signal))) return;
        if (answer)
          ensure(
            capture(this.store.get(id)).digest === answer.snapshotDigest,
            "stale_snapshot",
            "Setup changed the answered snapshot",
          );
        if (deliveryOnly)
          ensure(
            capture(this.store.get(id)).digest === deliveryOnly.snapshotDigest,
            "stale_snapshot",
            "Setup changed the delivery-only snapshot",
          );
        attempt.deadlineAt = new Date(
          Date.now() + r.ticket.execution.timeoutSeconds * 1000,
        ).toISOString();
        runtimePrompt = `Execution deadline: ${attempt.deadlineAt}. Finish work and return a delivery before this deadline; preserve an incomplete result as blocked with precise remaining work. Additional instructions do not extend the deadline.\n\n${runtimePrompt}`;
        immutable(
          join(dir, "execution.json"),
          canonical({
            deadlineAt: attempt.deadlineAt,
            promptHash: hash(runtimePrompt),
            controllerBuild: buildInfo,
          }),
        );
        this.store.update(id, "execution.started", (record) => {
          this.current(record).deadlineAt = attempt.deadlineAt;
        });
        runtimeEntered = true;
        const result = secrets.value(
          await this.options.runtime.execute(
            {
              ticket: r.ticket,
              attemptId: attempt.id,
              sessionId: attempt.sessionId,
              worktree: r.worktree,
              harnessHome: join(dir, "harness-home"),
              controllerHome: this.home,
              patches,
              prompt: runtimePrompt,
              deadlineAt: attempt.deadlineAt,
              resumeFromHome: previous
                ? join(this.home, "runs", previous.id, "harness-home")
                : undefined,
              dshBin: this.options.dshBin,
            },
            dir,
            attempt.marker,
            abort.signal,
            (message) => {
              if (message.type === "stats")
                this.store.event(id, "harness.notification", {
                  method: "session.event",
                  params: {
                    sessionId: message.sessionId,
                    event: {
                      type: "worker/stats",
                      data: { stats: message.stats },
                    },
                  },
                  attemptId: attempt.id,
                });
              if (message.type === "notification")
                this.store.transaction(() => {
                  const notification = secrets.value(message.notification);
                  const eventSeq = this.store.event(
                    id,
                    "harness.notification",
                    {
                      ...notification,
                      attemptId: attempt.id,
                    },
                  );
                  const { method, params } = notification;
                  if (
                    method === "session.event" &&
                    params.sessionId === attempt.sessionId
                  ) {
                    const event = params.event as {
                      type?: string;
                      data?: {
                        turn?: number;
                        id?: string;
                        content?: { type?: string; text?: string }[];
                        reason?: {
                          kind?: string;
                          error?: { code?: string; message?: string };
                        };
                      };
                    };
                    if (
                      [
                        "agent/inbox/spliced",
                        "turn/start",
                        "turn/end",
                        "user/message",
                      ].includes(event.type ?? "")
                    ) {
                      const record = this.store.get(id, false);
                      const current = this.current(record);
                      const observedAt = now();
                      let changed = false;
                      if (event.type === "agent/inbox/spliced") {
                        current.receipt = true;
                        for (const i of record.instructions ?? [])
                          if (queued.some((q) => q.id === i.id)) {
                            i.status = "received";
                            i.receivedAt ??= observedAt;
                          }
                        changed = true;
                      }
                      if (
                        event.type === "turn/start" &&
                        Number.isInteger(event.data?.turn)
                      ) {
                        current.turn = event.data!.turn;
                        delete current.failures;
                        changed = true;
                      }
                      if (event.type === "turn/end") {
                        current.finishReason = event.data?.reason?.kind;
                        const cause = event.data?.reason?.error;
                        if (
                          current.finishReason === "error" &&
                          typeof cause?.message === "string"
                        )
                          current.failures = {
                            primary: "provider",
                            provider: {
                              message: cause.message,
                              ...(typeof cause.code === "string"
                                ? { code: cause.code }
                                : {}),
                            },
                          };
                        changed = true;
                      }
                      const consumed =
                        event.type === "user/message" &&
                        observeConsumption(
                          record.instructions ?? [],
                          current,
                          event.data ?? {},
                          observedAt,
                          eventSeq,
                          runtimePrompt,
                          new Set(queued.map((i) => i.id)),
                        );
                      if (consumed || changed)
                        this.store.save(
                          record,
                          consumed
                            ? "instruction.consumed"
                            : "attempt.observed",
                        );
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
          ),
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
          a.finishReason = result.finishReason ?? a.finishReason;
          a.termination = result.termination;
          a.cleanExit = result.cleanExit;
          a.error = result.error;
          for (const i of record.instructions ?? [])
            if (queued.some((q) => q.id === i.id) && i.status === "sending") {
              i.status = result.receipt ? "received" : "uncertain";
            }
          if (result.cleanExit) delete record.activeOperation;
          a.snapshot = snapshot;
          let deliveryError: string | undefined;
          // Missing final text is expected after cancellation/provider failure.
          // Validate delivery only after a normally completed model turn.
          if (
            result.termination === "completed" &&
            result.finishReason === "completed"
          ) {
            try {
              a.delivery = secrets.value(
                boundDelivery(
                  deliveryDocument(result.finalResponse ?? ""),
                  record.ticket,
                  a.id,
                ),
              );
            } catch (error) {
              delete a.delivery;
              deliveryError = `Delivery: ${String(error)}`;
            }
          }
          const frozenViolation =
            deliveryOnly && snapshot?.digest !== deliveryOnly.snapshotDigest
              ? "Delivery-only recovery changed the frozen source snapshot; use an explicit restart for implementation"
              : undefined;
          const report = failureReport(
            {
              ...result,
              providerError: result.providerError ?? a.failures?.provider,
            },
            snapshotError
              ? String(snapshotError)
              : (frozenViolation ??
                  (snapshot?.violations.length
                    ? snapshot.violations.join("; ")
                    : undefined)),
            deliveryError,
          );
          a.failures = report.failures;
          a.error = report.error;
          const complete =
            result.termination === "completed" &&
            result.finishReason === "completed" &&
            result.receipt &&
            result.cleanExit &&
            a.snapshot &&
            !a.snapshot.violations.length &&
            a.delivery &&
            !a.failures;
          record.state = complete
            ? a.delivery!.outcome === "blocked" || a.delivery!.blockers.length
              ? "blocked"
              : "awaiting_review"
            : "interrupted";
          if (a.snapshot?.violations.length) {
            record.state = "blocked";
            a.error ??= a.snapshot.violations.join("; ");
          }
          record.error = a.error;
        });
      } catch (error) {
        this.store.update(id, "attempt.failed", (record) => {
          record.state = "interrupted";
          if (!runtimeEntered)
            for (const instruction of record.instructions ?? []) {
              if (
                instruction.attemptId === attempt.id &&
                instruction.status === "sending"
              ) {
                instruction.status = "queued";
                delete instruction.attemptId;
              }
            }
          record.error = secrets.text(String(error));
          this.current(record).error = secrets.text(String(error));
        });
      } finally {
        this.operations.delete(id);
        this.reviewCoordinator.kick();
      }
    });
    this.operations.set(id, { abort, done });
    return this.status(id);
  }
  private async runCommands(
    record: TicketRecord,
    commands: Command[],
    marker: string,
    signal: AbortSignal,
    onProcesses: (processes: Attempt["processes"]) => void,
    onProgress: (run: CommandRun) => void = () => {},
    stopOnFailure = true,
  ): Promise<CommandRun> {
    const run: CommandRun = { startedAt: now(), commands: [], passed: false };
    onProgress(run);
    for (const command of commands) {
      signal.throwIfAborted();
      const result = await executeCommand(
        command,
        record.worktree,
        record.ticket.execution,
        marker,
        signal,
        onProcesses,
      );
      run.commands.push(result);
      onProgress(run);
      if (stopOnFailure && (result.exitCode !== 0 || result.timedOut)) break;
    }
    run.endedAt = now();
    run.passed =
      !signal.aborted &&
      run.commands.length === commands.length &&
      run.commands.every((c) => c.exitCode === 0 && !c.timedOut);
    if (!run.passed)
      run.error = signal.aborted
        ? "Command run cancelled"
        : "Command failed or timed out";
    onProgress(run);
    return run;
  }
  private async prepareEnvironment(
    id: string,
    attempt: Attempt,
    signal: AbortSignal,
  ) {
    const record = this.store.get(id);
    let phase = "setup";
    const onProcesses = (processes: Attempt["processes"]) => {
      if (
        canonical(this.current(this.store.get(id, false)).processes) ===
        canonical(processes)
      )
        return;
      this.store.update(id, `${phase}.processes`, (r) => {
        this.current(r).processes = processes;
      });
    };
    const block = (message: string) => {
      const snapshot = capture(this.store.get(id), this.artifactDir());
      this.store.update(id, "setup.blocked", (r) => {
        const a = this.current(r);
        a.snapshot = snapshot;
        a.endedAt = now();
        a.cleanExit = true;
        a.termination = "setup_failed";
        for (const instruction of r.instructions ?? [])
          if (
            instruction.attemptId === a.id &&
            instruction.status === "sending"
          ) {
            instruction.status = "queued";
            delete instruction.attemptId;
          }
        a.error = message;
        r.error = message;
        r.state = "blocked";
        delete r.activeOperation;
      });
      return false;
    };
    const setup = await this.runCommands(
      record,
      record.ticket.setup ?? [],
      attempt.marker,
      signal,
      onProcesses,
      (run) => {
        this.store.update(id, "attempt.setup", (r) => {
          this.current(r).setup = structuredClone(run);
        });
      },
    );
    signal.throwIfAborted();
    if (!setup.passed) return block(setup.error ?? "Environment setup failed");
    const ready = capture(record, this.artifactDir());
    if (ready.violations.length) return block(ready.violations.join("; "));
    if (
      record.verificationBaselines?.some(
        (b) => b.revision === record.ticket.revision,
      )
    )
      return true;
    const baseline: VerificationBaseline = {
      revision: record.ticket.revision,
      baseCommit: record.ticket.baseCommit,
      worktree: join(
        this.home,
        "baselines",
        `${id}-${record.ticket.revision}-${attempt.id}`,
      ),
      startedAt: now(),
      commands: [],
      passed: false,
      comparable: false,
    };
    const persist = () =>
      this.store.update(id, "verification.baseline", (r) => {
        const baselines = (r.verificationBaselines ??= []);
        const index = baselines.findIndex(
          (b) => b.revision === baseline.revision,
        );
        if (index < 0) baselines.push(structuredClone(baseline));
        else baselines[index] = structuredClone(baseline);
      });
    phase = "baseline";
    persist(); // Reserve this revision's one baseline before any command runs.
    const baseRecord: TicketRecord = {
      ...record,
      worktree: baseline.worktree,
      owner: uid(),
      checkoutBaseline: undefined,
    };
    createWorktree(baseRecord);
    baseRecord.checkoutBaseline = createCheckoutBaseline(
      baseRecord,
      this.artifactDir(),
    );
    baseline.setup = await this.runCommands(
      baseRecord,
      record.ticket.setup ?? [],
      attempt.marker,
      signal,
      onProcesses,
      (run) => {
        baseline.setup = structuredClone(run);
        persist();
      },
    );
    if (!baseline.setup.passed) {
      baseline.error = "Baseline environment setup failed";
      baseline.endedAt = now();
      persist();
      return block(baseline.error);
    }
    baseline.before = capture(baseRecord).digest;
    try {
      await this.runCommands(
        baseRecord,
        record.ticket.verification,
        attempt.marker,
        signal,
        onProcesses,
        (run) => {
          baseline.commands = structuredClone(run.commands);
          baseline.passed = run.passed;
          baseline.endedAt = run.endedAt;
          persist();
        },
        false,
      );
    } catch (error) {
      const owned = this.current(this.store.get(id)).processes;
      ensure(
        !(await terminate(attempt.marker, owned)).length,
        "process_cleanup",
        "Baseline command cleanup remains uncertain",
      );
      onProcesses([]);
      baseline.endedAt = now();
      baseline.error = redactor([
        ...record.ticket.execution.envRequired,
        ...credentialNames(record.ticket.execution),
      ]).text(String(error));
    }
    baseline.after = capture(baseRecord).digest;
    baseline.comparable =
      !signal.aborted &&
      !baseline.error &&
      baseline.commands.length === record.ticket.verification.length &&
      baseline.before === baseline.after;
    if (!baseline.comparable && !baseline.error)
      baseline.error =
        "Baseline incomplete or commands changed its snapshot; comparisons unavailable";
    persist();
    signal.throwIfAborted();
    return true;
  }
  async cancel(id: string, condition?: CancellationGuard) {
    const reviewOperation = this.store.get(id, false).activeOperation;
    if (
      condition === undefined &&
      reviewOperation &&
      this.reviewCoordinator.owns(reviewOperation)
    ) {
      await this.reviewCoordinator.cancel(reviewOperation);
      return this.status(id);
    }
    const guard =
      condition === undefined
        ? undefined
        : cancellationGuardSchema.parse(condition);
    const active = this.operations.get(id);
    if (guard) {
      const r = this.store.get(id, false);
      const attempt = r.attempts.at(-1);
      ensure(
        active &&
          !active.abort.signal.aborted &&
          r.state === "running" &&
          r.ticket.revision === guard.revision &&
          attempt?.id === guard.attemptId &&
          attempt.revision === guard.revision &&
          r.activeOperation === attempt.id &&
          !attempt.endedAt &&
          guard.instructionIds.every((instructionId) => {
            const instruction = r.instructions?.find(
              (i) => i.id === instructionId,
            );
            return (
              instruction?.revision === guard.revision &&
              instruction.attemptId === guard.attemptId &&
              instruction.status === "received" &&
              !!instruction.messageId &&
              !instruction.consumption
            );
          }),
        "cancellation_precondition_failed",
        "Cancellation refused: the bound execution or instruction evidence changed or is uncertain. Refresh the brief and reassess; do not retry unconditionally.",
      );
      // Persist the decision before aborting, without yielding between the check and abort.
      // This checks controller-observed consumption; an unobserved native event may still be in transit.
      this.store.event(id, "cancellation.requested", { ifUnconsumed: guard });
    }
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
    this.reviewCoordinator.beforeOperation(id, "verify");
    ensure(
      this.activeCount() < this.capacity,
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
        if ((r.ticket.setup ?? []).length) {
          verification.setup = await this.runCommands(
            r,
            r.ticket.setup,
            verification.marker,
            abort.signal,
            (processes) => {
              verification.processes = processes;
              this.store.update(id, "verification.processes", (record) => {
                record.verifications.at(-1)!.processes = processes;
              });
            },
            (run) => {
              verification.setup = structuredClone(run);
              this.store.update(id, "verification.setup", (record) => {
                record.verifications.at(-1)!.setup = verification.setup;
              });
            },
          );
          ensure(
            verification.setup.passed,
            "setup_failed",
            verification.setup.error ?? "Verification setup failed",
          );
          ensure(
            capture(r).digest === before.digest,
            "stale_snapshot",
            "Setup changed the delivered snapshot",
          );
        }
        const baseline = r.verificationBaselines?.find(
          (b) => b.revision === r.ticket.revision,
        );
        for (const [index, cmd] of r.ticket.verification.entries()) {
          if (abort.signal.aborted) break;
          const result = await executeCommand(
            cmd,
            r.worktree,
            r.ticket.execution,
            verification.marker,
            abort.signal,
            (processes) => {
              verification.processes = processes;
              this.store.update(id, "verification.processes", (record) => {
                record.verifications.at(-1)!.processes = processes;
              });
            },
          );
          const passed = result.exitCode === 0 && !result.timedOut;
          const base = baseline?.comparable
            ? baseline.commands[index]
            : undefined;
          verification.commands.push({
            ...result,
            comparison: passed
              ? "pass"
              : base
                ? base.exitCode === 0 && !base.timedOut
                  ? "regressed"
                  : "pre-existing"
                : "fail",
          });
          this.store.update(id, "verification.command", (record) => {
            record.verifications.at(-1)!.commands = [...verification.commands];
          });
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
        this.reviewCoordinator.kick();
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
      this.reviewCoordinator.validateAcceptance(review, r);
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
    const reviewOp = this.store.get(c.ticketId, false).activeOperation;
    ensure(
      !reviewOp || !this.reviewCoordinator.owns(reviewOp),
      "review_recovery_required",
      "Use recover-review to account for the independent reviewer first",
    );
    const r = this.store.get(c.ticketId);
    ensure(
      !this.operations.has(c.ticketId),
      "active_operation",
      "Cannot recover a live operation",
    );
    ensure(
      ["blocked", "interrupted"].includes(r.state) ||
        (c.kind === "restart" && r.state === "ready" && !!r.pendingDelivery),
      "state",
      "Recovery requires blocked or interrupted, or an explicit restart of pending delivery-only recovery",
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
    if (c.kind === "answer") {
      ensure(
        r.state === "blocked" &&
          a.revision === r.ticket.revision &&
          a.cleanExit &&
          a.receipt &&
          a.finishReason === "completed" &&
          a.termination === "completed" &&
          a.delivery?.outcome === "blocked" &&
          a.snapshot?.digest === c.snapshotDigest,
        "answer_state",
        "Answers require an unchanged, cleanly blocked delivery on the current revision",
      );
      ensure(
        !(r.instructions ?? []).some(
          (i) =>
            i.attemptId === a.id && ["sending", "uncertain"].includes(i.status),
        ),
        "answer_uncertain",
        "Resolve uncertain instructions before resuming a session",
      );
      ensure(
        !discover(a.marker, a.processes).length,
        "process_cleanup",
        "Previous session still has a writer",
      );
      ensure(
        existsSync(join(this.home, "runs", a.id, "harness-home", "sessions")),
        "session_missing",
        "Previous session history is unavailable; use a fresh continuation",
      );
    }
    if (c.kind === "delivery") {
      ensure(
        r.state === "interrupted" &&
          a.revision === r.ticket.revision &&
          a.receipt &&
          a.cleanExit &&
          !a.delivery &&
          a.snapshot?.digest === c.snapshotDigest &&
          !a.snapshot.violations.length,
        "delivery_only_state",
        "Delivery-only recovery requires an unchanged, cleanly ended attempt with a missing or invalid delivery",
      );
      ensure(
        !(r.instructions ?? []).some(
          (i) =>
            i.revision === c.revision &&
            (["queued", "sending", "uncertain"].includes(i.status) ||
              (i.attemptId === a.id &&
                i.status === "received" &&
                !i.consumption)),
        ),
        "delivery_only_instructions",
        "Resolve unconsumed or uncertain instructions before delivery-only recovery",
      );
      ensure(
        !discover(a.marker, a.processes).length,
        "process_cleanup",
        "Previous execution still has a writer",
      );
    }
    ensure(
      r.activeOperation || this.activeCount() < this.capacity,
      "capacity",
      "Worker capacity reached; recovery needs an available slot",
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
          if (c.kind === "answer") record.pendingAnswer = c;
          else delete record.pendingAnswer;
          if (c.kind === "delivery") record.pendingDelivery = c;
          else delete record.pendingDelivery;
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
        this.reviewCoordinator.kick();
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
    const op = this.store.get(id, false).activeOperation;
    if (op && this.reviewCoordinator.owns(op))
      await this.reviewCoordinator.wait(op);
    await this.operations.get(id)?.done;
    return this.status(id);
  }
  async close() {
    this.closing = true;
    await this.reviewCoordinator.close();
    for (const op of this.operations.values()) op.abort.abort();
    await Promise.all([...this.operations.values()].map((op) => op.done));
    await this.snapshotReader.close();
    this.store.close();
    this.lock.close();
  }
}
