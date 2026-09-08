import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { ProcessIdentity } from "../../contracts/src/index.js";
import { delay, ensure } from "./util.js";
interface Ps extends ProcessIdentity {
  ppid: number;
}
export function processTable(): Ps[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return output.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]! }] : [];
  });
}
export function identity(pid: number): ProcessIdentity | undefined {
  return processTable().find((p) => p.pid === pid);
}
export function alive(p: ProcessIdentity): boolean {
  return processTable().some((q) => q.pid === p.pid && q.start === p.start);
}
// Environment marker discovers detached/reparented descendants without using SDK private fields.
export function marked(marker: string): ProcessIdentity[] {
  ensure(/^[a-f0-9-]{36}$/.test(marker), "marker", "Invalid process marker");
  const pids = new Set<number>();
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (
          readFileSync(`/proc/${pid}/environ`)
            .toString()
            .split("\0")
            .includes(`DSH_WORKER_PROCESS_TOKEN=${marker}`)
        )
          pids.add(Number(pid));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EACCES" && code !== "ESRCH")
          throw error;
      }
    }
  } else {
    ensure(
      process.platform === "darwin",
      "platform",
      "Process ownership is supported on macOS and Linux",
    );
    const out = execFileSync("ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of out.split("\n"))
      if (line.includes(`DSH_WORKER_PROCESS_TOKEN=${marker}`)) {
        const m = line.match(/^\s*(\d+)\s/);
        if (m) pids.add(Number(m[1]));
      }
  }
  return processTable().filter((p) => pids.has(p.pid) && p.pid !== process.pid);
}
export function discover(
  marker: string,
  known: ProcessIdentity[],
): ProcessIdentity[] {
  const table = processTable();
  const current = table.filter((p) =>
    known.some((q) => q.pid === p.pid && q.start === p.start),
  );
  const found = new Map<number, ProcessIdentity>(
    current.map((p) => [p.pid, p]),
  );
  for (const p of marked(marker)) found.set(p.pid, p);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of table)
      if (found.has(p.ppid) && !found.has(p.pid)) {
        found.set(p.pid, p);
        changed = true;
      }
  }
  return [...found.values()].map(({ pid, start }) => ({ pid, start }));
}
export async function terminate(
  marker: string,
  known: ProcessIdentity[],
): Promise<ProcessIdentity[]> {
  let current = discover(marker, known);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const p of current.reverse())
      if (alive(p)) {
        try {
          process.kill(p.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    for (let n = 0; n < 20; n++) {
      await delay(50);
      current = discover(marker, current);
      if (!current.length) return [];
    }
  }
  return current;
}
export function cleanEnv(
  required: string[],
  marker?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
  ])
    if (process.env[key]) env[key] = process.env[key];
  for (const key of required) {
    ensure(
      !/^(NODE_OPTIONS|NODE_PATH|DSH_HOME|DSH_WORKER_|GIT_|PYTHON)/.test(key),
      "environment_key",
      `Reserved environment key: ${key}`,
    );
    ensure(
      process.env[key]?.trim(),
      "credentials_missing",
      `Missing environment variable: ${key}`,
    );
    env[key] = process.env[key];
  }
  if (marker) env.DSH_WORKER_PROCESS_TOKEN = marker;
  return env;
}
export async function execute(
  args: string[],
  cwd: string,
  seconds: number,
  marker: string,
  onProcesses: (p: ProcessIdentity[]) => void,
) {
  const child = spawn(args[0]!, args.slice(1), {
    cwd,
    env: cleanEnv([], marker),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let outputTruncated = false;
  let timedOut = false;
  let known: ProcessIdentity[] = [];
  const collect = (data: Buffer) => {
    if (output.length + data.toString().length > 1024 * 1024)
      outputTruncated = true;
    output = (output + data.toString()).slice(-1024 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let scanError: unknown;
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
  scan();
  const polling = setInterval(scan, 500);
  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate(marker, known).catch((error) => {
      scanError = error;
    });
  }, seconds * 1000);
  let code: number | null = null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    clearInterval(polling);
    clearTimeout(timeout);
  }
  const remaining = await terminate(marker, known);
  onProcesses(remaining);
  ensure(
    !scanError && !remaining.length,
    "process_cleanup",
    "Could not prove verifier process cleanup",
  );
  return { args, exitCode: code, output, outputTruncated, timedOut };
}
