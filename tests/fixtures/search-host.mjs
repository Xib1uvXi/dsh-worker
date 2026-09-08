// Deterministic crash fixture. It drives the real model-facing tool and public subprocess service.
import { Context } from "@deepseek-ai/cordis";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Fs from "@deepseek-ai/dsh-fs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import * as Coding from "../../dist/coding-plugin.js";
const [workspace, indexDirectory, tgrep] = process.argv.slice(2);
const ctx = new Context();
await ctx.plugin(Subprocess);
await ctx.plugin(Fs, { cwd: workspace });
await ctx.plugin(SystemPrompt);
await ctx.plugin(Tools);
await ctx.plugin(Coding, {
  workspace,
  indexDirectory,
  tgrep,
  indexed: false,
  search: "tgrep",
  servers: {},
  guidance: "Test fixture",
});
try {
  await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: "crash-query",
    name: "grep",
    arguments: { pattern: "needle" },
    agent: { session: { header: { cwd: workspace } } },
  });
} finally {
  await ctx.fiber.dispose();
}
