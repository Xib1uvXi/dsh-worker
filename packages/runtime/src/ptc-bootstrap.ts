import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

// Runs inside the fresh upstream worker. Programs compose registered tools;
// those tools retain process ownership on the Harness host. This guard covers
// ordinary Node entrypoints, not hostile native code or a security sandbox.
export function installProcessPolicy() {
  const refused = () => {
    throw new Error(
      "Direct process creation is unavailable in worker PTC; use tools.bash or terminal tools for owned execution.",
    );
  };
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ])
    Object.defineProperty(childProcess, name, {
      value: refused,
      configurable: true,
      writable: true,
    });
  Object.defineProperty(workerThreads, "Worker", {
    value: refused,
    configurable: true,
    writable: true,
  });
  syncBuiltinESMExports();
}
