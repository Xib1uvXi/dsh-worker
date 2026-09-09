import type {
  Attempt,
  AttemptFailures,
  WorkerInstruction,
} from "../../contracts/src/index.js";
import type { RuntimeOutcome } from "../../runtime/src/adapter.js";

export function failureReport(
  result: RuntimeOutcome,
  snapshot?: string,
  delivery?: string,
): { failures?: AttemptFailures; error?: string } {
  const execution =
    result.error ??
    (!result.receipt
      ? "Runtime ended without an execution receipt"
      : result.termination !== "completed" ||
          result.finishReason !== "completed"
        ? `Runtime ended: ${result.termination}; finish reason: ${result.finishReason ?? "unknown"}`
        : undefined);
  const cleanup = !result.cleanExit
    ? "Runtime process cleanup could not be confirmed"
    : undefined;
  const primary =
    result.termination === "cancelled"
      ? "cancelled"
      : result.termination === "timeout"
        ? "timeout"
        : result.providerError
          ? "provider"
          : execution
            ? "execution"
            : cleanup
              ? "cleanup"
              : snapshot
                ? "snapshot"
                : delivery
                  ? "delivery"
                  : undefined;
  if (!primary) return {};
  const messages = {
    cancelled: "Execution cancelled by the controller",
    timeout: "Execution timed out at its deadline",
    provider: result.providerError
      ? `${result.providerError.code ?? "PROVIDER_ERROR"}: ${result.providerError.message}`
      : undefined,
    execution,
    cleanup,
    snapshot,
    delivery,
  };
  return {
    failures: {
      primary,
      execution,
      provider: result.providerError,
      cleanup,
      snapshot,
      delivery,
    },
    error: messages[primary],
  };
}

export function instructionText(id: string, text: string) {
  return `Additional execution instruction ${id} within the assigned scope (external review and delivery contract still apply):\n${text}`;
}

// Called only for the primary session's native user/message event. Admission
// (inbox/spliced) is deliberately not evidence of consumption.
export function observeConsumption(
  instructions: WorkerInstruction[],
  attempt: Attempt,
  data: { id?: string; content?: { type?: string; text?: string }[] },
  time: string,
  eventSeq: number,
  initialPrompt: string,
  queuedIds: Set<string>,
) {
  if (typeof data.id !== "string") return false;
  const text =
    data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("") ?? "";
  let changed = false;
  for (const i of instructions) {
    if (
      i.attemptId !== attempt.id ||
      i.revision !== attempt.revision ||
      i.consumption
    )
      continue;
    if (
      i.messageId
        ? i.messageId === data.id
        : (["sending", "uncertain"].includes(i.status) &&
            text === instructionText(i.id, i.text)) ||
          (queuedIds.has(i.id) && text === initialPrompt)
    ) {
      i.consumption = {
        time,
        messageId: data.id,
        turn: attempt.turn,
        eventSeq,
      };
      changed = true;
    }
  }
  return changed;
}
