import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import type { TicketView } from "../../contracts/src/index.js";
import { alive } from "../../shared/src/process.js";
import { workflow } from "../../runtime/src/policy.js";
import { ClientError, WorkerClient } from "./client.js";

export function errorInfo(error: unknown) {
  const e = error as { code?: string; message?: string; outcome?: string };
  return {
    code:
      e?.code ??
      (error instanceof ZodError
        ? "invalid_contract"
        : error instanceof SyntaxError
          ? "invalid_json"
          : "internal"),
    error: e?.message ?? String(error),
    ...(e?.outcome ? { outcome: e.outcome } : {}),
  };
}
export function summary(r: TicketView) {
  const a = r.attempts.filter((a) => a.revision === r.ticket.revision).at(-1);
  const v = r.verifications.filter((v) => v.attemptId === a?.id).at(-1);
  return {
    ticketId: r.ticket.ticketId,
    title: r.ticket.title,
    revision: r.ticket.revision,
    state: r.state,
    archived: !!r.archived,
    stale: r.stale,
    updatedAt: r.updatedAt,
    activeOperation: r.activeOperation ?? null,
    worktree: r.worktree,
    currentError: r.error ?? null,
    snapshotDigest: r.currentSnapshot ?? a?.snapshot?.digest ?? null,
    attempt: a
      ? {
          id: a.id,
          revision: a.revision,
          startedAt: a.startedAt,
          endedAt: a.endedAt ?? null,
          receipt: a.receipt,
          termination: a.termination ?? null,
          finishReason: a.finishReason ?? null,
          cleanExit: a.cleanExit,
          recordedProcesses: a.processes,
        }
      : null,
    verification: v
      ? {
          id: v.id,
          passed: v.passed,
          endedAt: v.endedAt ?? null,
          cleanExit: v.cleanExit,
          error: v.error ?? null,
          before: v.before,
          after: v.after ?? null,
          matchesCurrentSnapshot: r.currentSnapshot
            ? v.after === r.currentSnapshot && v.before === r.currentSnapshot
            : null,
        }
      : null,
    uncertainInstructions: (r.instructions ?? [])
      .filter((i) => i.status === "uncertain")
      .map((i) => i.id),
  };
}
interface Issue {
  source:
    | "task"
    | "execution"
    | "delivery"
    | "scope"
    | "verification"
    | "instruction"
    | "review";
  attemptId?: string;
  revision?: number;
  recordId?: string;
  time?: string;
  message: string;
  command?: string[];
  exitCode?: number | null;
  timedOut?: boolean;
  output?: string;
  outputTruncated?: boolean;
  serviceOutputTruncated?: boolean;
}
export function errors(r: TicketView, attemptId?: string, full = false) {
  if (attemptId && !r.attempts.some((a) => a.id === attemptId))
    throw new ClientError(
      "attempt_not_found",
      "Attempt does not belong to this task.",
    );
  const issues: Issue[] = [];
  if (!attemptId && r.error)
    issues.push({ source: "task", message: r.error, time: r.updatedAt });
  for (const a of r.attempts.filter((a) => !attemptId || a.id === attemptId)) {
    const common = {
      attemptId: a.id,
      revision: a.revision,
      time: a.endedAt ?? a.startedAt,
    };
    if (a.error)
      issues.push({ ...common, source: "execution", message: a.error });
    if (
      a.endedAt &&
      (!a.cleanExit ||
        a.termination !== "completed" ||
        a.finishReason !== "completed")
    )
      issues.push({
        ...common,
        source: "execution",
        message: `Termination: ${a.termination ?? "unknown"}; finish reason: ${a.finishReason ?? "unknown"}; clean exit: ${a.cleanExit}`,
      });
    for (const message of a.delivery?.blockers ?? [])
      issues.push({ ...common, source: "delivery", message });
    for (const message of a.snapshot?.violations ?? [])
      issues.push({ ...common, source: "scope", message });
  }
  for (const v of r.verifications.filter(
    (v) => !attemptId || v.attemptId === attemptId,
  )) {
    if (v.passed) continue;
    if (
      !v.endedAt &&
      !v.error &&
      r.activeOperation === v.id &&
      r.state !== "interrupted"
    )
      continue;
    const common = {
      source: "verification" as const,
      attemptId: v.attemptId,
      revision: v.revision,
      recordId: v.id,
      time: v.endedAt ?? v.startedAt,
    };
    issues.push({
      ...common,
      message:
        v.error ??
        (v.endedAt
          ? `Verification failed; clean exit: ${v.cleanExit}; snapshot unchanged: ${v.before === v.after}`
          : "Verification has no recorded completion; its original cause may be unavailable in this older record."),
    });
    for (const c of v.commands.filter((c) => c.exitCode !== 0 || c.timedOut))
      issues.push({
        ...common,
        message: c.timedOut
          ? "Verification command timed out"
          : "Verification command failed",
        command: c.args,
        exitCode: c.exitCode,
        timedOut: c.timedOut,
        output: full ? c.output : c.output.slice(-4000),
        outputTruncated: !full && c.output.length > 4000,
        serviceOutputTruncated: !!c.outputTruncated,
      });
  }
  for (const i of r.instructions ?? [])
    if (
      (!attemptId || i.attemptId === attemptId) &&
      (i.error || i.status === "uncertain")
    )
      issues.push({
        source: "instruction",
        attemptId: i.attemptId,
        revision: i.revision,
        recordId: i.id,
        time: i.time,
        message:
          i.error ??
          "Instruction receipt is uncertain; do not resend automatically.",
      });
  for (const review of r.reviews.filter(
    (v) => (!attemptId || v.attemptId === attemptId) && v.verdict !== "accept",
  ))
    for (const message of new Set([
      `Review verdict: ${review.verdict}`,
      ...review.findings,
      ...review.spec.findings,
      ...review.standards.findings,
    ]))
      issues.push({
        source: "review",
        attemptId: review.attemptId,
        revision: review.revision,
        message,
      });
  return {
    ticketId: r.ticket.ticketId,
    currentState: r.state,
    scope: attemptId ?? "all-attempts",
    issues,
    count: issues.length,
  };
}
export function diagnose(r: TicketView, home: string) {
  const status = summary(r);
  const next: { reason: string; argv: string[] }[] = [];
  const add = (reason: string, ...args: string[]) =>
    next.push({ reason, argv: ["dsh-worker", ...args, "--home", home] });
  if (r.archived)
    add(
      "Restore this archived task before further execution.",
      "restore",
      r.ticket.ticketId,
    );
  if (r.state === "interrupted" || r.state === "blocked")
    add(
      "Inspect process ownership and the current snapshot before explicitly preparing recovery; this query does not restart work.",
      "recover",
      r.ticket.ticketId,
    );
  else if (r.activeOperation)
    add(
      "An operation is recorded as active. Wait or inspect status; do not start duplicate work.",
      "wait",
      r.ticket.ticketId,
      "--timeout",
      "30",
    );
  else if (r.state === "awaiting_review") {
    if (
      !status.verification?.passed ||
      !status.verification.matchesCurrentSnapshot
    )
      add(
        "Run independent verification of the current snapshot before external review.",
        "verify",
        r.ticket.ticketId,
        "--wait",
      );
    else
      add(
        "Passing verification is available; the external reviewer must inspect the delivery and prepare the review document.",
        "status",
        r.ticket.ticketId,
      );
  } else if (r.state === "changes_requested")
    add(
      "Read the review findings before assigning the bounded rework.",
      "errors",
      r.ticket.ticketId,
    );
  else if (r.state === "ready" && !r.archived)
    add(
      "Task is ready. Check service dispatch and capacity before assigning it.",
      "health",
    );
  if (r.stale)
    add(
      "Accepted content has changed; do not reuse this acceptance for the changed checkout.",
      "status",
      r.ticket.ticketId,
    );
  if (status.uncertainInstructions.length)
    add(
      "An instruction has uncertain delivery. Inspect the CLI or Web trajectory before deciding whether to send anything else.",
      "status",
      r.ticket.ticketId,
    );
  const needsAttention =
    !!r.error ||
    r.stale ||
    ["blocked", "interrupted", "changes_requested"].includes(r.state) ||
    status.uncertainInstructions.length > 0 ||
    !!(
      r.state === "awaiting_review" &&
      status.verification?.endedAt &&
      !status.verification.passed
    );
  return {
    ok: !needsAttention,
    status,
    errors: errors(r),
    nextSteps: next,
    notes: [
      "Diagnostics are read-only and never retry, cancel or recover a task.",
      "Historical errors do not by themselves mean the current task is failing. Recorded processes are not a live liveness probe; use recover ID to inspect interrupted work.",
    ],
  };
}
export async function health(home: string) {
  const checks: {
    name: string;
    status: "pass" | "fail" | "warn";
    code?: string;
    message: string;
  }[] = [];
  let service:
    | {
        url: string;
        capacity: number;
        active: number;
        dispatchEnabled: boolean;
        runtimeVersion: string;
      }
    | undefined;
  let client: WorkerClient | undefined;
  try {
    client = new WorkerClient(home, 3000);
    checks.push({
      name: "discovery",
      status: "pass",
      message: "Local service discovery is valid.",
    });
  } catch (error) {
    checks.push({
      name: "discovery",
      status: "fail",
      code: errorInfo(error).code,
      message: errorInfo(error).error,
    });
  }
  const lock = join(home, "controller.lock");
  if (existsSync(lock)) {
    try {
      const owner = JSON.parse(readFileSync(lock, "utf8"));
      if (
        !Number.isInteger(owner?.pid) ||
        owner.pid <= 0 ||
        typeof owner.start !== "string"
      )
        throw new Error("Malformed service process identity");
      const live = alive(owner);
      checks.push({
        name: "owner",
        status: live ? "pass" : "fail",
        code: live ? undefined : "service_stale",
        message: live
          ? "Service process identity is alive."
          : "Recorded service process is no longer alive. Inspect ownership before restarting.",
      });
    } catch {
      checks.push({
        name: "owner",
        status: "fail",
        code: "service_lock",
        message:
          "Cannot validate service process identity; inspect controller.lock.",
      });
    }
  } else
    checks.push({
      name: "owner",
      status: "warn",
      message:
        "No controller.lock is present; process ownership cannot be confirmed.",
    });
  if (client)
    try {
      const o = await client.overview();
      if (
        !Array.isArray(o?.tickets) ||
        !Number.isInteger(o.capacity) ||
        o.capacity < 1 ||
        !Number.isInteger(o.active) ||
        o.active < 0 ||
        typeof o.dispatchEnabled !== "boolean" ||
        typeof o.runtimeVersion !== "string"
      )
        throw new ClientError(
          "service_response",
          "Response is not a valid Worker service overview.",
        );
      service = {
        url: client.url,
        capacity: o.capacity,
        active: o.active,
        dispatchEnabled: o.dispatchEnabled,
        runtimeVersion: o.runtimeVersion,
      };
      checks.push({
        name: "connection",
        status: "pass",
        message: "Authenticated service request succeeded.",
      });
    } catch (error) {
      checks.push({
        name: "connection",
        status: "fail",
        code: errorInfo(error).code,
        message: errorInfo(error).error,
      });
    }
  try {
    const w = workflow(home);
    checks.push({
      name: "workflow",
      status: w.configPath ? "pass" : "warn",
      message: w.configPath
        ? `${w.skills.length} configured skills; entries: ${w.entrySkills.join(", ") || "none"}.`
        : "No personal engineering skills configured (optional).",
    });
  } catch {
    checks.push({
      name: "workflow",
      status: "fail",
      code: "workflow_invalid",
      message:
        "Workflow configuration is invalid; use workflow with this home for details.",
    });
  }
  return {
    ok: !checks.some((c) => c.status === "fail"),
    home,
    service: service ?? null,
    checks,
    notes: [
      "No model request, credential-value dump, state repair or service startup is performed.",
      "Workflow is resolved from this CLI environment; a service-specific DSH_WORKER_WORKFLOW override must also be supplied here.",
      "Use doctor separately to test SDK/runtime initialization without calling a model.",
    ],
  };
}
