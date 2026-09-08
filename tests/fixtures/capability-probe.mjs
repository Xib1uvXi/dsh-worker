import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
export const name = "capability-probe";
export const inject = [
  "workerCapabilitiesReady",
  "agents",
  "tools",
  "sessions",
  "subprocess",
];
export async function apply(ctx, config) {
  const result = {
    subprocess: ctx.subprocess.constructor.name,
    marker: process.env.DSH_WORKER_PROCESS_TOKEN,
    tools: ctx.tools.schemas().map((t) => t.name),
  };
  let owner;
  let other;
  const call = (
    name,
    args,
    agent = owner?.agent,
    signal = new AbortController().signal,
  ) =>
    ctx.tools.execute({
      name,
      arguments: args,
      agent,
      signal,
      callId: randomUUID(),
    });
  try {
    owner = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: config.workspace },
      agentOptions: { provider: "deepseek-official", model: "deepseek-v4-pro" },
    });
    if (config.scenario === "mcp" || config.scenario === "http") {
      result.echo = await call("mcp__fixture__echo", { text: "hello" });
      result.failure = await call("mcp__fixture__fail", {});
    }
    if (
      config.scenario === "terminal" ||
      config.scenario === "crash-terminal"
    ) {
      other = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: config.workspace },
      });
      result.open = await call("terminal_open", { type: "shell" });
      const sessionId = result.open.value.sessionId;
      if (config.scenario === "crash-terminal") {
        writeFileSync(
          config.output,
          JSON.stringify({ pid: process.pid, open: result.open }),
        );
        await new Promise(() => {});
      }
      result.send = await call("terminal_send", {
        sessionId,
        text: "export WORKER_TEST_STATE=retained",
      });
      result.read = await call("terminal_send", {
        sessionId,
        text: 'printf \'state=%s marker=%s\\n\' "$WORKER_TEST_STATE" "$DSH_WORKER_PROCESS_TOKEN"',
      });
      result.foreign = await call("terminal_read", { sessionId }, other.agent);
      result.close = await call("terminal_close", { sessionId });
    }
    if (config.scenario === "ptc")
      result.ptc = await call("run_code", {
        code: "const a = await tools.bash({command:'printf worker-ptc',description:'Probe'}); return a;",
        description: "Local integration probe",
      });
    if (config.scenario === "cancel-ptc") {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 500);
      try {
        result.cancelled = await call(
          "run_code",
          {
            code: "return await tools.bash({command:'sleep 30',description:'Cancellation probe'});",
            description: "Cancel probe",
          },
          owner.agent,
          abort.signal,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (config.scenario === "crash-mcp") {
      writeFileSync(config.output, JSON.stringify({ pid: process.pid }));
      await new Promise(() => {});
    }
    if (config.scenario.startsWith("hooks-"))
      result.hook = await call("bash", {
        command: "printf hook-should-not-run",
        description: "Hook test",
      });
    if (config.scenario === "stats") {
      const session = owner.agent.session;
      session.append("step/start", { turn: 1, step: 1 });
      session.append("step/end", { turn: 1, step: 1 });
      await new Promise((r) => setTimeout(r, 20));
      await ctx.parallel("session/flush", session);
      result.stats = session
        .snapshotEvents()
        .filter((e) => e.type === "worker/stats");
    }
  } catch (error) {
    result.error = String(error);
  } finally {
    await other?.dispose();
    await owner?.dispose();
    writeFileSync(config.output, JSON.stringify(result));
  }
}
