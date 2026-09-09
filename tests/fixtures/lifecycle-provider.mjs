// Real Harness loop/persistence with a deterministic local response; no provider call.
import { writeFileSync } from "node:fs";
export const name = "lifecycle-provider";
export const inject = ["llm", "credentials", "subprocess"];
export function apply(ctx, config) {
  ctx.on("llm/stream", async function* (options) {
    const credential = await ctx.credentials.resolve("DEEPSEEK_API_KEY");
    if (
      credential?.value !== "fixture-only-provider-secret" ||
      process.env.DEEPSEEK_API_KEY
    )
      throw new Error("Provider credentials not isolated");
    const child = ctx.subprocess.spawn({
      argv: [
        process.execPath,
        "-e",
        "process.exit(process.env.DEEPSEEK_API_KEY ? 1 : 0)",
      ],
      cwd: process.cwd(),
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 1024 },
        stderr: { maxBytes: 1024 },
      },
      graceMs: 500,
    });
    if ((await child.done).exitCode !== 0)
      throw new Error("Credential leaked to tool process");
    const messages = options.messages;
    writeFileSync(config.trace, JSON.stringify(messages));
    const prompts = messages
      .filter((m) => m.role === "user" && m.source.kind === "user")
      .map((m) =>
        m.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
      );
    const input = prompts.at(-1);
    const json = input
      .split("shape (no fences):\n")[1]
      ?.split("\nUse outcome")[0];
    const delivery = JSON.parse(json);
    delivery.commands = [
      { command: "fixture credential check", result: credential.value },
    ];
    const workspace = JSON.parse(
      input
        .split("Execution workspace (controller-owned):\n")[1]
        ?.split("\n")[0],
    );
    if (input.startsWith("Answer to the previous blocker:")) {
      if (
        prompts.length < 2 ||
        !messages.some(
          (m) =>
            m.role === "assistant" &&
            JSON.stringify(m).includes("prior-investigation-7419"),
        )
      )
        throw new Error("Previous conversation missing");
      delivery.summary = "Resumed prior-investigation-7419 with answer";
      writeFileSync(
        workspace.workingDirectory + "/source.txt",
        "implemented\n",
      );
    } else {
      delivery.outcome = "blocked";
      delivery.summary = "prior-investigation-7419";
      delivery.blockers = ["Choose X or Y"];
    }
    const text = JSON.stringify(delivery);
    const split = text.indexOf(credential.value) + "fixture-only".length;
    yield { type: "text-delta", index: 0, text: text.slice(0, split) };
    yield { type: "text-delta", index: 0, text: text.slice(split) };
    yield { type: "finish", reason: { kind: "stop" } };
  });
}
