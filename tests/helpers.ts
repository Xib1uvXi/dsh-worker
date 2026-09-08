import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ticketSchema } from "../packages/contracts/src/index.js";
import type {
  RuntimeAdapter,
  RuntimeOutcome,
} from "../packages/runtime/src/adapter.js";
import type { RunnerRequest } from "../packages/runtime/src/runner.js";
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-worker-test-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "source.txt"), "baseline\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"], {
    stdio: "ignore",
  });
  const baseCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const ticket = ticketSchema.parse({
    schemaVersion: 2,
    ticketId: "TEST-1",
    revision: 1,
    title: "A durable task",
    targetRepo: repo,
    baseCommit,
    objective: "Change source.txt to implemented",
    scope: { paths: ["source.txt", "new.txt", "link"] },
    acceptance: [{ id: "AC1", description: "source.txt contains implemented" }],
    verification: [
      {
        args: [
          process.execPath,
          "-e",
          "if(require('fs').readFileSync('source.txt','utf8')!=='implemented\\n')process.exit(1)",
        ],
      },
    ],
    execution: {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      envRequired: [],
      timeoutSeconds: 10,
    },
  });
  return { root, repo, ticket, home: join(root, "home") };
}
export function delivery(request: RunnerRequest) {
  return {
    schemaVersion: 2,
    ticketId: request.ticket.ticketId,
    revision: request.ticket.revision,
    attemptId: request.attemptId,
    outcome: "submitted",
    summary: "Implemented source change",
    evidence: [{ acceptanceId: "AC1", evidence: "Changed source.txt" }],
    commands: [],
    notRun: [],
    blockers: [],
  };
}
export class FakeRuntime implements RuntimeAdapter {
  count = 0;
  handler?: (
    request: RunnerRequest,
    signal: AbortSignal,
  ) => Promise<Partial<RuntimeOutcome>>;
  async execute(
    request: RunnerRequest,
    _dir: string,
    _marker: string,
    signal: AbortSignal,
  ) {
    this.count++;
    writeFileSync(join(request.worktree, "source.txt"), "implemented\n");
    const extra = await this.handler?.(request, signal);
    return {
      receipt: true,
      finishReason: "completed",
      finalResponse: JSON.stringify(delivery(request)),
      cleanExit: true,
      termination: "completed",
      ...extra,
    };
  }
}
