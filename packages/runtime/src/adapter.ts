import { fork } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type {
  ProcessIdentity,
  ProviderError,
} from "../../contracts/src/index.js";
import { atomic, delay, ensure } from "../../shared/src/util.js";
import {
  discover,
  discoverAsync,
  identity,
  terminate,
} from "../../shared/src/process.js";
import { redactor } from "../../shared/src/redaction.js";
import {
  credentialNames,
  credentialPatch,
  taskEnvironment,
} from "./credentials.js";
import type { RunnerRequest, RunnerMessage } from "./runner.js";
export interface RuntimeOutcome {
  providerError?: ProviderError;
  receipt: boolean;
  finishReason?: string;
  finalResponse?: string;
  error?: string;
  cleanExit: boolean;
  termination: string;
}
export interface RuntimeAdapter {
  instruct?(attemptId: string, id: string, text: string): Promise<string>;
  execute(
    request: RunnerRequest,
    dir: string,
    marker: string,
    signal: AbortSignal,
    onMessage: (m: RunnerMessage) => void,
    onProcesses: (p: ProcessIdentity[]) => void,
  ): Promise<RuntimeOutcome>;
}
export class SdkRuntime implements RuntimeAdapter {
  private senders = new Map<
    string,
    (id: string, text: string) => Promise<string>
  >();
  async instruct(attemptId: string, id: string, text: string) {
    const send = this.senders.get(attemptId);
    ensure(
      send,
      "runtime_unavailable",
      "Runtime is no longer accepting instructions",
    );
    return send(id, text);
  }
  constructor(
    readonly runnerPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../../dist/runner.js"
          : "./runner.js",
        import.meta.url,
      ),
    ),
  ) {}
  async execute(
    request: RunnerRequest,
    dir: string,
    marker: string,
    signal: AbortSignal,
    onMessage: (m: RunnerMessage) => void,
    onProcesses: (p: ProcessIdentity[]) => void,
  ): Promise<RuntimeOutcome> {
    const requestFile = join(dir, "request.json");
    const secrets = redactor([
      ...request.ticket.execution.envRequired,
      ...credentialNames(request.ticket.execution),
    ]);
    const credentials = credentialPatch(request.ticket.execution, dir);
    const launchRequest = credentials
      ? {
          ...request,
          patches: [
            ...request.patches.slice(0, -1),
            credentials,
            ...request.patches.slice(-1),
          ],
        }
      : request;
    atomic(requestFile, JSON.stringify(launchRequest));
    const env = taskEnvironment(request.ticket.execution, marker);
    const child = fork(this.runnerPath, ["--runner", requestFile], {
      cwd: request.worktree,
      env,
      detached: true,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const pending = new Map<
      string,
      {
        resolve: (id: string) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    this.senders.set(
      request.attemptId,
      (id, text) =>
        new Promise((resolve, reject) => {
          if (!child.connected) {
            reject(new Error("Runtime disconnected"));
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error("Instruction receipt timed out; delivery is uncertain"),
            );
          }, 15000);
          pending.set(id, { resolve, reject, timer });
          child.send({ type: "instruction", id, text }, (error) => {
            if (error) {
              clearTimeout(timer);
              pending.delete(id);
              reject(error);
            }
          });
        }),
    );
    let known: ProcessIdentity[] = [];
    let scanError: unknown;
    let outcome: Extract<RunnerMessage, { type: "outcome" }> | undefined;
    let termination = "completed";
    let started = false;
    let rootObserved = false;
    const scan = () => {
      try {
        if (child.pid && !rootObserved) {
          const p = identity(child.pid);
          if (p) {
            known.push(p);
            rootObserved = true;
          }
        }
        known = discover(marker, known);
        onProcesses(known);
      } catch (error) {
        scanError = error;
      }
    };
    const log = (data: string) =>
      appendFileSync(join(dir, "stderr.log"), data, { mode: 0o600 });
    const stderr = secrets.stream(log);
    const stdout = secrets.stream(log);
    child.stderr?.on("data", (data: Buffer) => stderr.write(data));
    child.stdout?.on("data", (data: Buffer) => stdout.write(data));
    child.stderr?.once("end", () => stderr.end());
    child.stdout?.once("end", () => stdout.end());
    const cancel = () => {
      termination = "cancelled";
      if (child.connected) child.send("cancel");
    };
    signal.addEventListener("abort", cancel, { once: true });
    let scanning: Promise<void> | undefined;
    const interval = setInterval(() => {
      if (scanning) return;
      scanning = discoverAsync(marker, known)
        .then((processes) => {
          known = processes;
          onProcesses(known);
        })
        .catch((error) => {
          scanError = error;
        })
        .finally(() => {
          scanning = undefined;
        });
    }, 500);
    let killing = false;
    let cancelledAt: number | undefined;
    const deadline = request.deadlineAt
      ? Date.parse(request.deadlineAt)
      : Date.now() + request.ticket.execution.timeoutSeconds * 1000;
    const watchdog = setInterval(() => {
      if (Date.now() > deadline && termination === "completed") {
        termination = "timeout";
        if (child.connected) child.send("cancel");
      }
      if (termination !== "completed" || scanError) {
        cancelledAt ??= Date.now();
        if (Date.now() - cancelledAt > 4000 && !killing) {
          killing = true;
          void terminate(marker, known).catch((error) => {
            scanError = error;
          });
        }
      }
    }, 100);
    child.on("message", (raw: RunnerMessage) => {
      const value = secrets.value(raw);
      try {
        if (value.type === "instruction-result") {
          const item = pending.get(value.id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(value.id);
            if (value.messageId) item.resolve(value.messageId);
            else
              item.reject(
                new Error(value.error ?? "Missing instruction receipt"),
              );
          }
        }
        if (value.type === "ready" && !started) {
          scan();
          ensure(
            !scanError && known.some((p) => p.pid === child.pid),
            "process_identity",
            "Cannot prove runner ownership",
          );
          started = true;
          if (signal.aborted) cancel();
          else child.send("start");
        }
        if (value.type === "outcome") outcome = value;
        if (value.type === "notification")
          appendFileSync(
            join(dir, "events.jsonl"),
            JSON.stringify(value.notification) + "\n",
            { mode: 0o600 },
          );
        onMessage(value);
      } catch (error) {
        scanError = error;
        cancel();
      }
    });
    let code: number | null = null;
    let spawnError: unknown;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      spawnError = error;
    } finally {
      this.senders.delete(request.attemptId);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(
          new Error(
            "Runtime exited before instruction receipt; delivery is uncertain",
          ),
        );
      }
      pending.clear();
      clearInterval(interval);
      clearInterval(watchdog);
      signal.removeEventListener("abort", cancel);
    }
    await scanning;
    await delay(20);
    let survivors: ProcessIdentity[] = [];
    try {
      survivors = await terminate(marker, known);
      onProcesses(survivors);
    } catch (error) {
      scanError = error;
    }
    if (!scanError && !survivors.length)
      rmSync(join(dir, "credentials"), { recursive: true, force: true });
    return secrets.value({
      receipt: outcome?.receipt ?? false,
      finishReason: outcome?.finishReason,
      providerError: outcome?.providerError,
      finalResponse: outcome?.finalResponse,
      error:
        outcome?.error ??
        (scanError
          ? String(scanError)
          : spawnError
            ? String(spawnError)
            : code !== 0
              ? `Runner exit ${code}`
              : undefined),
      cleanExit: !scanError && !survivors.length && outcome?.closed === true,
      termination:
        termination !== "completed"
          ? termination
          : !outcome || code !== 0 || outcome.error
            ? "error"
            : "completed",
    });
  }
}
