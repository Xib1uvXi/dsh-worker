// Exercise the real SDK loop and persistence without a network provider call.
import { appendFileSync } from "node:fs";
export const name = "migration-provider";
export const inject = ["llm"];
export function apply(ctx, config) {
  ctx.on("llm/stream", async function* (options) {
    appendFileSync(config.trace, "prompt\n");
    const text = (role) =>
      options.messages
        .filter((message) => message.role === role)
        .map((message) => JSON.stringify(message.content))
        .join("\n");
    if (
      !text("user").includes("Investigate migration-anchor-7419") ||
      !text("assistant").includes("Blocked: choose X or Y") ||
      !text("user").includes("Choose X and continue")
    ) {
      throw new Error(
        "Migration lost prior context or the continuation answer",
      );
    }
    yield {
      type: "text-delta",
      index: 0,
      text: "Continued migration-anchor-7419 with X",
    };
    yield { type: "finish", reason: { kind: "stop" } };
  });
}
