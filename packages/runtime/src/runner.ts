import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type {
  DeepSeekHarnessOptions,
  HarnessNotification,
} from "@deepseek-ai/dsh-sdk-client";
import { readFileSync, cpSync, existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { codingPatch } from "./coding-tools.js";
import { atomic, ensure } from "../../shared/src/util.js";
import { runtimeFile } from "./plugins.js";
import { pluginsPatch } from "./plugins.js";
import { sessionStatsSchema } from "../../contracts/src/index.js";
import type { SessionStats } from "../../contracts/src/index.js";
import type { Ticket } from "../../contracts/src/index.js";
export interface RunnerRequest {
  resumeFromHome?: string;
  ticket: Ticket;
  attemptId: string;
  sessionId: string;
  worktree: string;
  harnessHome: string;
  controllerHome?: string;
  patches: string[];
  prompt: string;
  dshBin?: string;
}
export type RunnerMessage =
  | { type: "stats"; sessionId: string; stats: SessionStats }
  | {
      type: "instruction-result";
      id: string;
      messageId?: string;
      error?: string;
    }
  | { type: "notification"; notification: HarnessNotification }
  | { type: "ready" }
  | {
      type: "outcome";
      receipt: boolean;
      finishReason?: string;
      finalResponse?: string;
      error?: string;
      closed: boolean;
    };
export async function runHarness(
  request: RunnerRequest,
  send: (message: RunnerMessage) => void,
  signal?: AbortSignal,
  listen?: (handler: (id: string, text: string) => Promise<void>) => () => void,
) {
  let patches = request.patches;
  if (request.controllerHome) {
    try {
      const coding = await codingPatch(
        request.controllerHome,
        request.worktree,
        dirname(request.harnessHome),
        signal,
      );
      const capabilities = await pluginsPatch(
        request.controllerHome,
        request.worktree,
        dirname(request.harnessHome),
        request.ticket.execution.plugins,
      );
      // Keep the immutable worker policy last, after user and coding extensions.
      patches = [
        ...patches.slice(0, -1),
        coding,
        capabilities,
        ...patches.slice(-1),
      ];
    } catch (error) {
      send({
        type: "outcome",
        receipt: false,
        error: String(error),
        closed: true,
      });
      return;
    }
  }
  if (request.resumeFromHome) {
    try {
      const source = join(request.resumeFromHome, "sessions");
      ensure(
        existsSync(source) && !lstatSync(source).isSymbolicLink(),
        "session_missing",
        "Previous session history is unavailable; use an explicit fresh continuation",
      );
      cpSync(source, join(request.harnessHome, "sessions"), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (path) => {
          ensure(
            !lstatSync(path).isSymbolicLink(),
            "session_path",
            "Session history must not contain symlinks",
          );
          return true;
        },
      });
      const patch = join(dirname(request.harnessHome), "resume.patch.json");
      atomic(
        patch,
        JSON.stringify([
          {
            insert: [
              {
                id: "worker-session-resume",
                name: runtimeFile("resume-plugin"),
                config: { sessionId: request.sessionId },
              },
            ],
          },
          {
            id: "sdk-jsonrpc-server",
            inject: [
              "sdkAppStartup",
              "loader",
              "workerCapabilitiesReady",
              "workerResumeReady",
            ],
          },
        ]),
      );
      patches = [...patches.slice(0, -1), patch, ...patches.slice(-1)];
    } catch (error) {
      send({
        type: "outcome",
        receipt: false,
        error: String(error),
        closed: true,
      });
      return;
    }
  }
  const options: DeepSeekHarnessOptions = {
    cwd: request.worktree,
    processCwd: request.worktree,
    dshHome: request.harnessHome,
    profile: "sdk",
    patches,
    provider: request.ticket.execution.provider,
    model: request.ticket.execution.model,
    env: process.env,
    initializeTimeoutMs: 30000,
    disposeEofGraceMs: 2000,
    disposeGraceMs: 1000,
    ...(request.dshBin ? { dshBin: request.dshBin } : {}),
    ...(request.ticket.execution.maxTokens
      ? { maxTokens: request.ticket.execution.maxTokens }
      : {}),
    ...(request.ticket.execution.reasoningEffort
      ? {
          reasoningEffort: request.ticket.execution
            .reasoningEffort as DeepSeekHarnessOptions["reasoningEffort"],
        }
      : {}),
  };
  const harness = new DeepSeekHarness(options);
  let previousStats = "";
  const publishStats = () => {
    try {
      const content = readFileSync(
        join(dirname(request.harnessHome), "stats.json"),
        "utf8",
      );
      if (content === previousStats) return;
      const observations = JSON.parse(content) as Record<string, unknown>;
      for (const [sessionId, value] of Object.entries(observations)) {
        const stats = sessionStatsSchema.parse(value);
        send({ type: "stats", sessionId, stats });
      }
      previousStats = content;
    } catch {
      /* Optional telemetry never changes execution or acceptance. */
    }
  };
  const statsTimer = setInterval(publishStats, 500);
  let receipt = false;
  let finishReason: string | undefined;
  let finalResponse: string | undefined;
  let error: string | undefined;
  let closed = false;
  let accepting = false;
  const unlisten = listen?.(async (id, text) => {
    if (!accepting || signal?.aborted) {
      send({
        type: "instruction-result",
        id,
        error: "Runtime is not accepting instructions",
      });
      return;
    }
    try {
      const messageId = await harness.client.prompt(request.sessionId, [
        { type: "text", text },
      ]);
      send({ type: "instruction-result", id, messageId });
    } catch (error) {
      send({ type: "instruction-result", id, error: String(error) });
    }
  });
  const abort = () => {
    void harness.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("Cancelled before initialization");
    const result = await harness.run(request.prompt, {
      sessionId: request.sessionId,
      onNotification: (notification) => {
        send({ type: "notification", notification });
        if (
          notification.method === "session.event" &&
          notification.params.sessionId === request.sessionId
        ) {
          const event = notification.params.event as {
            type?: string;
            data?: { reason?: { kind?: string } };
          };
          if (event.type === "agent/inbox/spliced") {
            receipt = true;
            accepting = true;
          }
          if (event.type === "turn/end")
            finishReason = event.data?.reason?.kind;
        }
      },
    });
    finalResponse = result.finalResponse;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    accepting = false;
    unlisten?.();
    signal?.removeEventListener("abort", abort);
    try {
      await harness.close();
      closed = true;
    } catch (e) {
      error = `${error ?? ""}\nCleanup: ${String(e)}`;
    }
  }
  clearInterval(statsTimer);
  publishStats();
  send({
    type: "outcome",
    receipt,
    finishReason,
    finalResponse,
    error,
    closed,
  });
}
// This process owns the SDK. The parent durably records its identity before permitting launch.
if (process.argv.includes("--runner")) {
  const request = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--runner") + 1]!, "utf8"),
  ) as RunnerRequest;
  const aborter = new AbortController();
  let started = false;
  process.on("message", (message) => {
    if (message === "cancel") aborter.abort();
    if (message === "start" && !started) {
      started = true;
      void runHarness(
        request,
        (m) => process.send?.(m),
        aborter.signal,
        (handler) => {
          const receive = (m: unknown) => {
            if (
              m &&
              typeof m === "object" &&
              "type" in m &&
              m.type === "instruction" &&
              "id" in m &&
              typeof m.id === "string" &&
              "text" in m &&
              typeof m.text === "string"
            )
              void handler(m.id, m.text);
          };
          process.on("message", receive);
          return () => {
            process.off("message", receive);
          };
        },
      ).finally(() => {
        process.disconnect?.();
      });
    }
  });
  process.on("disconnect", () => {
    aborter.abort();
    if (!started) process.exit(1);
  });
  process.send?.({ type: "ready" });
}
