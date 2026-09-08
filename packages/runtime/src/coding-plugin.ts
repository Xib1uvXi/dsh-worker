import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { identity } from "../../shared/src/process.js";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  applyGlobTool,
  formatGrepOutput,
  formatGrepMatches,
  previewLine,
  trySaveFormattedResult,
} from "@deepseek-ai/dsh-tool-fs-search";
import Lsp from "@deepseek-ai/dsh-lsp";
import * as Stdio from "@deepseek-ai/dsh-lsp-stdio";
import * as LspTool from "@deepseek-ai/dsh-tool-lsp";
import type { CodingReport } from "./coding-tools.js";
import { TgrepSearch } from "./tgrep.js";
export const name = "worker-coding-tools";
export const inject = ["tools", "systemPrompt", "subprocess", "fs"];
export async function apply(
  ctx: Context,
  config: CodingReport & { workspace: string; indexDirectory: string },
) {
  ctx.systemPrompt.section({
    name: "worker:feedback",
    order: 90,
    text: config.guidance,
  });
  if (Object.keys(config.servers).length) {
    await ctx.plugin(Lsp);
    const owner = identity(process.pid);
    if (!owner) throw new Error("Cannot identify LSP owner");
    const marker = process.env.DSH_WORKER_PROCESS_TOKEN ?? randomUUID();
    const launcher = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../../dist/lsp-launcher.js"
          : "./lsp-launcher.js",
        import.meta.url,
      ),
    );
    const servers = Object.fromEntries(
      Object.entries(config.servers).map(([key, server]) => [
        key,
        {
          ...server,
          command: process.execPath,
          args: [
            launcher,
            JSON.stringify(owner),
            marker,
            server.command,
            ...server.args,
          ],
        },
      ]),
    );
    await ctx.plugin(Stdio, { servers });
    await ctx.plugin(LspTool, {
      maxLocations: 100,
      maxResultChars: 16000,
      timeoutMs: 60000,
    });
  }
  if (config.search !== "tgrep" || !config.tgrep) return;
  applyGlobTool(ctx, {
    sampleOverCapGlobResults: false,
    maxResults: 100,
    maxMetaBytes: 65536,
    rawOutputMaxBytes: 20_000_000,
    graceMs: 2000,
    stderrMaxBytes: 65536,
    timeoutMs: 30000,
  });
  const search = new TgrepSearch(ctx, { ...config, tgrep: config.tgrep });
  ctx.systemPrompt.section({
    name: "tool:grep",
    order: ctx.systemPrompt.getSectionOrder("TOOL_GREP"),
    text: "Use grep for content search; it runs tgrep with a fresh attempt-local index or live traversal. Use read on matched files before editing. Narrow path or include when results are large.",
  });
  ctx.tools.register(
    defineTool({
      name: "grep",
      description:
        "Search file contents using tgrep regular expressions. Returns file paths and line numbers. Up to 250 matches inline, with a full-result spill when available. Use read for surrounding context.",
      parameters: {
        pattern: { type: "string", required: true },
        path: { type: "string" },
        include: {
          type: "string",
          description: "One positive filename glob, e.g. *.ts",
        },
      },
      timeoutMs: 60000,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            backend: { type: "string", required: true },
            mode: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const result = await search.search(args, exec);
        const matches = result.matches.map((m) => ({
          ...m,
          line: previewLine(m.line, 2000),
        }));
        const spill =
          matches.length > 250
            ? await trySaveFormattedResult(
                ctx,
                exec,
                "tgrep-results.txt",
                formatGrepMatches(matches),
              )
            : undefined;
        const text = formatGrepOutput(
          {
            items: matches.slice(0, 250),
            seen: matches.length,
            kept: Math.min(matches.length, 250),
            truncated: matches.length > 250,
            omitted:
              matches.length > 250
                ? { kind: "exact", count: matches.length - 250 }
                : { kind: "none" },
          },
          spill,
        );
        return { text, backend: "tgrep", mode: result.mode };
      },
      presentCall: (args) => ({
        card: "generic",
        kind: "search",
        title: `tgrep ${args.pattern}`,
      }),
    }),
  );
}
