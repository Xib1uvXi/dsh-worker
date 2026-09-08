import { z } from "zod";

const argument = z.string().refine((v) => !v.includes("\0"));
const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .refine(
    (v) => !/^(NODE_OPTIONS|NODE_PATH|DSH_|GIT_|PYTHON)/.test(v),
    "Reserved environment variable",
  );
const environment = z.record(envName, envName).default({});
const common = {
  name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
};
export const mcpServerSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...common,
      transport: z.literal("stdio"),
      command: argument.refine((v) => v.length > 0),
      args: z.array(argument).default([]),
      env: environment,
    })
    .strict(),
  z
    .object({
      ...common,
      transport: z.literal("streamable-http"),
      url: z
        .string()
        .url()
        .refine((v) => {
          const u = new URL(v);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        }, "Use an HTTP(S) endpoint without credentials, query or fragment"),
      headerEnv: z
        .record(z.string().regex(/^[A-Za-z0-9-]+$/), envName)
        .default({}),
    })
    .strict(),
]);
export const pluginsSchema = z
  .object({
    schemaVersion: z.literal(2).default(2),
    terminal: z.boolean().default(false),
    stats: z.boolean().default(true),
    ptc: z.enum(["off", "both", "ptc"]).default("off"),
    mcp: z.array(mcpServerSchema).max(16).default([]),
    hooks: z
      .array(
        z
          .object({
            kind: z.enum(["codex", "claude-code"]),
            configPath: z.string().min(1),
          })
          .strict(),
      )
      .max(2)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.mcp.map((v) => v.name)).size !== value.mcp.length)
      ctx.addIssue({
        code: "custom",
        message: "MCP server names must be unique",
      });
    if (new Set(value.hooks.map((v) => v.kind)).size !== value.hooks.length)
      ctx.addIssue({ code: "custom", message: "Hook kinds must be unique" });
  });
export type PluginSelection = z.infer<typeof pluginsSchema>;
export const sessionStatsSchema = z
  .object({
    turns: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    llmMs: z.number().finite().nonnegative(),
    toolMs: z.number().finite().nonnegative(),
    ttftMs: z.number().finite().nonnegative(),
    ttftSteps: z.number().int().nonnegative(),
    decodeMs: z.number().finite().nonnegative(),
    decodeTokens: z.number().finite().nonnegative(),
  })
  .strict();
export type SessionStats = z.infer<typeof sessionStatsSchema>;
