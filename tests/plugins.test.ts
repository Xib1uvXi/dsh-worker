import { afterEach, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { pluginsSchema } from "../packages/contracts/src/index.js";
import {
  inspectPlugins,
  pluginsPatch,
} from "../packages/runtime/src/plugins.js";
import { policyPatch } from "../packages/runtime/src/policy.js";
import OwnedCodeRuntime from "../packages/runtime/src/owned-code-runtime.js";
import { cleanEnv, marked } from "../packages/shared/src/process.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const f = fixture();
  roots.push(f.root);
  return f;
}

it("validates plugin configuration, environment references and complete ticket overrides without starting servers", async () => {
  const f = setup();
  writeFileSync(
    join(f.home, "plugins.json"),
    JSON.stringify({
      terminal: true,
      mcp: [
        { name: "bad", transport: "stdio", command: "/no-such-executable" },
      ],
    }),
  );
  expect(inspectPlugins(f.home).ok).toBe(false);
  expect(inspectPlugins(f.home, pluginsSchema.parse({}))).toMatchObject({
    ok: true,
    config: { terminal: false, mcp: [] },
  });
  expect(() =>
    pluginsSchema.parse({
      mcp: [
        {
          name: "x",
          transport: "stdio",
          command: "node",
          env: { NODE_OPTIONS: "SOME_VALUE" },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    pluginsSchema.parse({
      mcp: [
        {
          name: "x",
          transport: "streamable-http",
          url: "https://user:pass@example.com/mcp",
        },
      ],
    }),
  ).toThrow();
  expect(() => pluginsSchema.parse({ unknown: true })).toThrow();
  const hook = join(f.home, "hooks.json");
  writeFileSync(hook, JSON.stringify({ hooks: {} }));
  const dir = join(f.home, "run");
  mkdirSync(dir);
  const path = await pluginsPatch(
    f.home,
    f.repo,
    dir,
    pluginsSchema.parse({
      hooks: [{ kind: "codex", configPath: "hooks.json" }],
    }),
  );
  writeFileSync(hook, "changed later");
  expect(
    JSON.parse(readFileSync(join(dir, "hooks-codex.json"), "utf8")),
  ).toEqual({ hooks: {} });
  expect(readFileSync(path, "utf8")).toContain("workerCapabilitiesReady");
});

it.each([
  "inventory",
  "mcp",
  "terminal",
  "stats",
  "ptc",
  "cancel-ptc",
  "hooks-codex",
  "hooks-claude-code",
])(
  "executes released SDK capability composition: %s",
  async (scenario) => {
    const f = setup();
    const dir = join(f.home, "run");
    mkdirSync(dir);
    const marker = randomUUID();
    const hookPath = join(f.home, "hooks.json");
    writeFileSync(
      hookPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^bash$",
              hooks: [
                {
                  type: "command",
                  command: "printf fixture-hook-denied >&2; exit 2",
                },
              ],
            },
          ],
        },
      }),
    );
    const selection = pluginsSchema.parse({
      hooks: scenario.startsWith("hooks-")
        ? [{ kind: scenario.slice(6), configPath: hookPath }]
        : [],
      terminal: scenario === "terminal",
      ptc: scenario.includes("ptc") ? "both" : "off",
      mcp:
        scenario === "mcp"
          ? [
              {
                name: "fixture",
                transport: "stdio",
                command: process.execPath,
                args: [
                  resolve("tests/fixtures/mcp-server.mjs"),
                  join(dir, "mcp-pid.json"),
                ],
                env: { FIXTURE_TOKEN: "WORKER_MCP_TEST_TOKEN" },
              },
            ]
          : [],
    });
    process.env.WORKER_MCP_TEST_TOKEN = "fixture-only";
    const patch = await pluginsPatch(f.home, f.repo, dir, selection);
    const probe = join(dir, "probe.json");
    const output = join(dir, "result.json");
    writeFileSync(
      probe,
      JSON.stringify([
        {
          insert: [
            {
              id: "probe",
              name: resolve("tests/fixtures/capability-probe.mjs"),
              config: { scenario, output, workspace: f.repo },
            },
          ],
        },
      ]),
    );
    const harness = new DeepSeekHarness({
      cwd: f.repo,
      processCwd: f.repo,
      dshHome: join(dir, "harness"),
      profile: "sdk",
      patches: [patch, probe, policyPatch(dir)],
      env: cleanEnv(["WORKER_MCP_TEST_TOKEN"], marker),
      initializeTimeoutMs: 30000,
    });
    try {
      await harness.start();
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result.error).toBeUndefined();
      for (const forbidden of [
        "ralph",
        "workflow",
        "subagent",
        "subagent_fork",
        "send_message",
        "list_agents",
      ])
        expect(result.tools).not.toContain(forbidden);
      if (scenario === "mcp") {
        expect(result.echo.isError, JSON.stringify(result.echo)).toBe(false);
        expect(JSON.stringify(result.echo)).toContain("hello");
        expect(JSON.stringify(result.echo)).toContain('credential\\":true');
        expect(result.failure.isError).toBe(true);
        expect(
          JSON.parse(readFileSync(join(dir, "mcp-pid.json"), "utf8")).marker,
        ).toBe(marker);
        expect(readFileSync(patch, "utf8")).not.toContain("fixture-only");
      }
      if (scenario === "terminal") {
        expect(result.open.isError, JSON.stringify(result.open)).toBe(false);
        expect(JSON.stringify(result.read)).toContain("state=retained");
        expect(JSON.stringify(result.read), JSON.stringify(result)).toContain(
          marker,
        );
        expect(result.foreign.isError).toBe(true);
        expect(result.close.isError).toBe(false);
      }
      if (scenario === "ptc") {
        expect(result.ptc.isError, JSON.stringify(result.ptc)).toBe(false);
        expect(JSON.stringify(result.ptc)).toContain("worker-ptc");
      }
      if (scenario.startsWith("hooks-")) {
        expect(result.hook.isError).toBe(true);
        expect(JSON.stringify(result.hook)).toContain("fixture-hook-denied");
      }
      if (scenario === "cancel-ptc")
        expect(result.cancelled.isError).toBe(true);
      if (scenario === "stats")
        expect(result.stats.at(-1).data.stats).toMatchObject({
          steps: 1,
          turns: 1,
        });
    } finally {
      await harness.close();
      delete process.env.WORKER_MCP_TEST_TOKEN;
    }
    expect(marked(marker)).toEqual([]);
  },
  45000,
);

it.each(["spawn", "execFile", "fork", "spawnSync"])(
  "rejects direct PTC process creation through %s",
  async (method) => {
    const ctx = new Context();
    await ctx.plugin(OwnedCodeRuntime, {
      computeMs: 1000,
      maxWallMs: 1500,
      maxOutputBytes: 4096,
    });
    try {
      const result = await ctx.codeRuntime.run({
        program: `const cp = await import('node:child_process'); return cp.${method}('never-executed');`,
        bindings: [],
      });
      expect(result.error?.message).toContain("use tools.bash or terminal");
    } finally {
      await ctx.fiber.dispose();
    }
  },
);

it.each(["terminal", "mcp"])(
  "recovers marked %s children after the Harness host is hard-killed",
  async (kind) => {
    const f = setup();
    const dir = join(f.home, "run");
    mkdirSync(dir);
    const marker = randomUUID();
    const patch = await pluginsPatch(
      f.home,
      f.repo,
      dir,
      pluginsSchema.parse({
        terminal: kind === "terminal",
        mcp:
          kind === "mcp"
            ? [
                {
                  name: "fixture",
                  transport: "stdio",
                  command: process.execPath,
                  args: [resolve("tests/fixtures/mcp-server.mjs")],
                },
              ]
            : [],
      }),
    );
    const output = join(dir, "crash.json");
    const probe = join(dir, "probe.json");
    writeFileSync(
      probe,
      JSON.stringify([
        {
          insert: [
            {
              id: "probe",
              name: resolve("tests/fixtures/capability-probe.mjs"),
              config: { scenario: `crash-${kind}`, output, workspace: f.repo },
            },
          ],
        },
      ]),
    );
    const harness = new DeepSeekHarness({
      cwd: f.repo,
      processCwd: f.repo,
      dshHome: join(dir, "harness"),
      profile: "sdk",
      patches: [patch, probe, policyPatch(dir)],
      env: cleanEnv([], marker),
      initializeTimeoutMs: 15000,
    });
    const started = harness.start().catch((error: unknown) => error);
    const { existsSync } = await import("node:fs");
    const { terminate } = await import("../packages/shared/src/process.js");
    try {
      await expect
        .poll(() => existsSync(output), { timeout: 10000 })
        .toBe(true);
      const { pid } = JSON.parse(readFileSync(output, "utf8"));
      process.kill(pid, "SIGKILL");
      await started;
      expect(await terminate(marker, [])).toEqual([]);
      expect(marked(marker)).toEqual([]);
    } finally {
      await harness.close().catch(() => {});
      await terminate(marker, []);
    }
  },
  25000,
);

it("uses authenticated Streamable HTTP MCP and does not persist header secrets", async () => {
  const f = setup();
  const dir = join(f.home, "run");
  mkdirSync(dir);
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const urlFile = join(dir, "url");
  const server = spawn(
    process.execPath,
    [resolve("tests/fixtures/mcp-http.mjs"), urlFile],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => server.once("exit", r));
  process.env.WORKER_HTTP_TOKEN = "Bearer fixture-only";
  let harness: DeepSeekHarness | undefined;
  try {
    await expect.poll(() => existsSync(urlFile), { timeout: 5000 }).toBe(true);
    const patch = await pluginsPatch(
      f.home,
      f.repo,
      dir,
      pluginsSchema.parse({
        mcp: [
          {
            name: "fixture",
            transport: "streamable-http",
            url: readFileSync(urlFile, "utf8"),
            headerEnv: { Authorization: "WORKER_HTTP_TOKEN" },
          },
        ],
      }),
    );
    const output = join(dir, "result.json");
    const probe = join(dir, "probe.json");
    writeFileSync(
      probe,
      JSON.stringify([
        {
          insert: [
            {
              id: "probe",
              name: resolve("tests/fixtures/capability-probe.mjs"),
              config: { scenario: "http", output, workspace: f.repo },
            },
          ],
        },
      ]),
    );
    harness = new DeepSeekHarness({
      cwd: f.repo,
      processCwd: f.repo,
      dshHome: join(dir, "harness"),
      profile: "sdk",
      patches: [patch, probe, policyPatch(dir)],
      env: cleanEnv(["WORKER_HTTP_TOKEN"]),
      initializeTimeoutMs: 15000,
    });
    await harness.start();
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.error).toBeUndefined();
    expect(result.echo.isError).toBe(false);
    expect(JSON.stringify(result.echo)).toContain("hello");
    expect(result.failure.isError).toBe(true);
    expect(readFileSync(patch, "utf8")).not.toContain("Bearer fixture-only");
  } finally {
    await harness?.close();
    server.kill("SIGTERM");
    await exited;
    delete process.env.WORKER_HTTP_TOKEN;
  }
}, 25000);

it("refuses SDK readiness when a configured MCP server cannot initialize", async () => {
  const f = setup();
  const dir = join(f.home, "run");
  mkdirSync(dir);
  const patch = await pluginsPatch(
    f.home,
    f.repo,
    dir,
    pluginsSchema.parse({
      mcp: [
        {
          name: "broken",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", "process.exit(2)"],
        },
      ],
    }),
  );
  const marker = randomUUID();
  const harness = new DeepSeekHarness({
    cwd: f.repo,
    processCwd: f.repo,
    dshHome: join(dir, "harness"),
    profile: "sdk",
    patches: [patch, policyPatch(dir)],
    env: cleanEnv([], marker),
    initializeTimeoutMs: 5000,
  });
  try {
    await expect(harness.start()).rejects.toThrow();
  } finally {
    await harness.close();
  }
  expect(marked(marker)).toEqual([]);
}, 12000);
