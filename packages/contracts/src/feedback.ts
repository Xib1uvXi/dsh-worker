import type { TicketView, InstructionBrief } from "./index.js";

export function instructionBriefs(
  r: TicketView,
  timestamp = Date.now(),
): InstructionBrief[] {
  return (r.instructions ?? [])
    .filter((i) => i.revision === r.ticket.revision)
    .map(({ text: _text, ...i }) => {
      const attempt = r.attempts.find((a) => a.id === i.attemptId);
      return {
        ...i,
        unconsumedSeconds: i.consumption
          ? null
          : Math.max(
              0,
              Math.floor(
                ((attempt?.endedAt ? Date.parse(attempt.endedAt) : timestamp) -
                  Date.parse(i.time)) /
                  1000,
              ),
            ),
      };
    });
}
export function executionBrief(r: TicketView, timestamp = Date.now()) {
  const attempt = r.attempts
    .filter((a) => a.revision === r.ticket.revision)
    .at(-1);
  return {
    deadlineAt: attempt?.deadlineAt ?? null,
    remainingSeconds:
      attempt?.deadlineAt && !attempt.endedAt
        ? Math.max(
            0,
            Math.ceil((Date.parse(attempt.deadlineAt) - timestamp) / 1000),
          )
        : null,
  };
}
