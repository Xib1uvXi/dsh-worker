import { Context } from "@deepseek-ai/cordis";
import LocalSandbox from "@deepseek-ai/dsh-sandbox-local";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Command,
  ExecutionConfig,
  ProcessIdentity,
} from "../../contracts/src/index.js";
import { execute } from "../../shared/src/process.js";
import { redactor } from "../../shared/src/redaction.js";
import { ensure, inside } from "../../shared/src/util.js";
import { credentialNames, taskEnvironment } from "./credentials.js";

export async function executeCommand(
  command: Command,
  worktree: string,
  execution: ExecutionConfig,
  marker: string,
  signal: AbortSignal,
  onProcesses: (processes: ProcessIdentity[]) => void,
) {
  const root = realpathSync(worktree);
  const cwd = realpathSync(resolve(root, command.cwd));
  ensure(inside(root, cwd), "verification_cwd", "Command cwd escapes worktree");
  const redact = redactor([
    ...execution.envRequired,
    ...credentialNames(execution),
  ]);
  const ctx = new Context();
  try {
    await ctx.plugin(LocalSandbox, {});
    const sandbox = ctx.sandbox;
    const confined = sandbox.confine(command.args, {
      mode: "workspace-write",
      workspaceRoot: root,
    });
    const result = await execute(
      command.args,
      cwd,
      command.timeoutSeconds,
      marker,
      onProcesses,
      {
        argv: confined.argv,
        env: taskEnvironment(execution, marker),
        redact,
        signal,
      },
    );
    return {
      ...redact.value(result),
      confinement: {
        mode: "workspace-write" as const,
        enforcement: confined.enforcement,
      },
    };
  } catch (error) {
    if (error instanceof Error) error.message = redact.text(error.message);
    throw error;
  } finally {
    await ctx.fiber.dispose();
  }
}
