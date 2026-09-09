import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionConfig } from "../../contracts/src/index.js";
import { atomic } from "../../shared/src/util.js";
import { cleanEnv } from "../../shared/src/process.js";

export function credentialNames(execution: ExecutionConfig) {
  // Preserve existing DeepSeek tickets while removing the provider key from tooling.
  return [
    ...new Set([
      ...(execution.credentialEnv ?? []),
      ...execution.envRequired.filter((name) => name === "DEEPSEEK_API_KEY"),
    ]),
  ];
}

export function taskEnvironment(execution: ExecutionConfig, marker?: string) {
  const credentials = new Set(credentialNames(execution));
  return cleanEnv(
    execution.envRequired.filter((name) => !credentials.has(name)),
    marker,
  );
}

export function credentialPatch(execution: ExecutionConfig, dir: string) {
  const names = credentialNames(execution);
  if (!names.length) return undefined;
  const env = cleanEnv(names);
  const privateDir = join(dir, "credentials");
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const path = join(privateDir, "provider.json");
  // JSON is valid YAML. The public credentials provider reads this store without
  // exporting its values into the runtime or any tool subprocess environment.
  atomic(
    path,
    JSON.stringify({
      version: 1,
      refs: Object.fromEntries(names.map((name) => [name, env[name]])),
      records: {},
    }),
  );
  const patch = join(dir, "credentials.patch.json");
  atomic(
    patch,
    JSON.stringify([{ id: "credentials", config: { path, watch: false } }]),
  );
  return patch;
}
