import type { Context } from "@deepseek-ai/cordis";
import type { AgentRegistry, CreateAgentOptions } from "@deepseek-ai/dsh-agent";

export const name = "worker-session-resume";
export const inject = ["agents", "sessionPersistence"];

// The released SDK calls agents.create for its first prompt. Cordis exposes
// service-read interception, so adapt that one public call to agents.resume.
// The SDK still owns the returned handle, prompt protocol and shutdown.
export function apply(ctx: Context, config: { sessionId: string }) {
  ctx.on("internal/get", (_caller, service, _error, next) => {
    const value: unknown = next();
    if (service !== "agents") return value;
    const registry = value as AgentRegistry;
    return new Proxy(registry, {
      get(target, key, receiver) {
        if (key !== "create")
          return Reflect.get(target, key, receiver) as unknown;
        return (options: CreateAgentOptions) =>
          String(options.sessionId) === config.sessionId
            ? target.resume({
                resumeSessionId: options.sessionId,
                agentOptions: options.agentOptions,
                signal: options.signal,
                setup: options.setup,
              })
            : target.create(options);
      },
    });
  });
  ctx.provide("workerResumeReady", true);
}
