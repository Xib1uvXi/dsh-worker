import type {
  CommandResult,
  CommandRun,
  EvidenceBrief,
  TicketView,
} from "../../contracts/src/index.js";
import {
  instructionBriefs,
  executionBrief,
} from "../../contracts/src/feedback.js";

const commandBrief = (command: CommandResult) => {
  const { output, outputTruncated, ...rest } = command;
  return {
    ...rest,
    outputTail: output.slice(-4000),
    outputTruncated: output.length > 4000,
    serviceOutputTruncated: !!outputTruncated,
  };
};
const runBrief = (run: CommandRun) => ({
  ...run,
  commands: run.commands.map(commandBrief),
});
// A read-only projection: claims and recorded decisions never become new evidence.
export function evidenceBrief(r: TicketView): EvidenceBrief {
  const t = r.ticket;
  const a = r.attempts.filter((a) => a.revision === t.revision).at(-1);
  const v = a
    ? r.verifications
        .filter((v) => v.attemptId === a.id && v.revision === t.revision)
        .at(-1)
    : undefined;
  const baseline = r.verificationBaselines?.find(
    (b) => b.revision === t.revision,
  );
  const delivered = a?.snapshot?.digest ?? null;
  const current = r.currentSnapshot ?? null;
  const matches = (
    before: string,
    after: string | undefined,
    digest: string | null,
  ) => (digest ? before === digest && after === digest : null);
  const review =
    a && delivered
      ? r.reviews
          .filter(
            (review) =>
              review.revision === t.revision &&
              review.attemptId === a.id &&
              review.snapshotDigest === delivered,
          )
          .at(-1)
      : undefined;
  return {
    schemaVersion: 2,
    instructions: instructionBriefs(r),
    execution: executionBrief(r),
    ticket: {
      ticketId: t.ticketId,
      revision: t.revision,
      title: t.title,
      objective: t.objective,
      targetRepo: t.targetRepo,
      baseCommit: t.baseCommit,
      scope: t.scope,
      outOfScope: t.outOfScope,
      acceptance: t.acceptance,
    },
    state: r.state,
    worktree: r.worktree,
    archived: !!r.archived,
    activeOperation: r.activeOperation ?? null,
    error: r.error ?? null,
    binding: {
      attemptId: a?.id ?? null,
      deliveredSnapshot: delivered,
      currentSnapshot: current,
      matchesDeliveredSnapshot:
        current && delivered ? current === delivered : null,
      snapshotCheckedAt: r.snapshotCheckedAt ?? null,
      snapshotMaxAgeMs: r.snapshotMaxAgeMs ?? null,
    },
    attempt: a
      ? {
          id: a.id,
          resumedFrom: a.resumedFrom,
          setup: a.setup ? runBrief(a.setup) : undefined,
          revision: a.revision,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          receipt: a.receipt,
          finishReason: a.finishReason,
          termination: a.termination,
          cleanExit: a.cleanExit,
          error: a.error,
          failures: a.failures,
          deadlineAt: a.deadlineAt,
          turn: a.turn,
          controllerBuild: a.controllerBuild,
          deliveryOnlyFrom: a.deliveryOnlyFrom,
        }
      : null,
    workerReport: a?.delivery ?? null,
    changes: {
      paths: a?.snapshot?.changedPaths ?? null,
      violations: a?.snapshot?.violations ?? [],
    },
    baseline: baseline
      ? {
          ...baseline,
          commands: baseline.commands.map(commandBrief),
          setup: baseline.setup ? runBrief(baseline.setup) : undefined,
        }
      : null,
    verification: v
      ? {
          id: v.id,
          attemptId: v.attemptId,
          revision: v.revision,
          startedAt: v.startedAt,
          endedAt: v.endedAt,
          before: v.before,
          after: v.after,
          passed: v.passed,
          cleanExit: v.cleanExit,
          error: v.error,
          matchesDeliveredSnapshot: matches(v.before, v.after, delivered),
          matchesCurrentSnapshot: matches(v.before, v.after, current),
          commands: v.commands.map((c) => ({
            comparison: c.comparison,
            confinement: c.confinement,
            args: c.args,
            exitCode: c.exitCode,
            timedOut: c.timedOut,
            outputTail: c.output.slice(-4000),
            outputTruncated: c.output.length > 4000,
            serviceOutputTruncated: !!c.outputTruncated,
          })),
        }
      : null,
    review: review ?? null,
    uncertainInstructions: (r.instructions ?? [])
      .filter((i) => i.revision === t.revision && i.status === "uncertain")
      .map((i) => i.id),
    notes: [
      "Worker report is a claim; verification and external review are separate recorded evidence.",
      "Snapshot freshness is a bounded display observation, not a new verification or acceptance. Null means not observed.",
      "Accepted does not mean integrated or released. Use status for full history, diffs, file hashes and stored command output; artifact retrieves snapshot bytes.",
    ],
  };
}
