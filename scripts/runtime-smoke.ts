import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { cleanEnv } from "../packages/core/src/process.js";
import { policyPatch } from "../packages/runtime/src/policy.js";
const root = resolve(".scratch/typescript-rebuild/runtime-smoke", randomUUID());
mkdirSync(root, { recursive: true });
const patch = policyPatch(root);
const home = join(root, "harness-home");
const env = { ...cleanEnv([]), DSH_HOME: home };
const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "lib/bin.js",
);
const config = execFileSync(
  process.execPath,
  [cli, "--profile", "sdk", "--patch", patch, "--dump-config"],
  { env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
);
const rows = YAML.parse(config, {
  customTags: [
    { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value },
  ],
}) as { id: string; disabled?: boolean; config?: unknown }[];
function find(id: string) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error("Missing final profile row " + id);
  return row;
}
for (const id of [
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-workflow",
])
  if (find(id).disabled !== true)
    throw new Error("Delegation tool enabled: " + id);
if (
  (find("sdk-jsonrpc-server").config as { maxTokensAsSuccess: boolean })
    .maxTokensAsSuccess !== false
)
  throw new Error("Max tokens mapped to success");
if ((find("approval").config as { policy: string }).policy !== "never")
  throw new Error("Unexpected approval policy");
const harness = new DeepSeekHarness({
  cwd: root,
  processCwd: root,
  dshHome: home,
  profile: "sdk",
  patches: [patch],
  env: cleanEnv([]),
  initializeTimeoutMs: 30000,
});
let initialized: boolean;
try {
  await harness.start();
  initialized = true;
} finally {
  await harness.close();
}
const result = {
  node: process.version,
  sdk: "0.1.3-alpha.2",
  runtime: "0.1.3-alpha.2",
  initialized,
  closed: true,
  delegationToolsDisabled: true,
  maxTokensAsSuccess: false,
  modelCalls: 0,
};
writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
