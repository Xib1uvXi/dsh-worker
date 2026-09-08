// Public stdio command wrapper: preserve controller ownership after the LSP host scrubs DSH_*.
// It also stops the server when its exact Harness owner disappears (including SIGKILL).
import { spawn } from "node:child_process";
import { alive } from "../../shared/src/process.js";
import type { ProcessIdentity } from "../../contracts/src/index.js";
const [ownerText, marker, command, ...args] = process.argv.slice(2);
if (!ownerText || !marker || !command || !/^[a-f0-9-]{36}$/.test(marker))
  throw new Error("Invalid LSP ownership arguments");
const owner = JSON.parse(ownerText) as ProcessIdentity;
if (
  !Number.isSafeInteger(owner.pid) ||
  typeof owner.start !== "string" ||
  !alive(owner)
)
  throw new Error("LSP owner is no longer alive");
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    RUSTUP_AUTO_INSTALL: "0",
    DSH_WORKER_PROCESS_TOKEN: marker,
  },
});
let killing = false;
let escalation: ReturnType<typeof setTimeout> | undefined;
function stop() {
  if (killing) return;
  killing = true;
  child.kill("SIGTERM");
  escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
}
const timer = setInterval(() => {
  try {
    if (!alive(owner)) stop();
  } catch {
    stop();
  }
}, 500);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, stop);
child.once("error", (error) => {
  console.error(String(error));
  clearInterval(timer);
  if (escalation) clearTimeout(escalation);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearInterval(timer);
  if (escalation) clearTimeout(escalation);
  process.exitCode = code ?? 1;
});
