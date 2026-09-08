import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import type {
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

// Extend the public provider, preserving its range ownership and disposal.
// Explicit env merges after the upstream ambient DSH_* scrub.
function owned<T extends { env?: NodeJS.ProcessEnv }>(spec: T): T {
  const marker = process.env.DSH_WORKER_PROCESS_TOKEN;
  return marker
    ? { ...spec, env: { ...spec.env, DSH_WORKER_PROCESS_TOKEN: marker } }
    : spec;
}
export default class OwnedSubprocess extends LocalSubprocess {
  override spawn(spec: SubprocessSpawnSpec) {
    return super.spawn(owned(spec));
  }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec) {
    return super.spawnTerminal(owned(spec));
  }
}
