import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { cleanEnv } from "../packages/shared/src/process.js";
import { policyPatch } from "../packages/runtime/src/policy.js";
import { fixture } from "./helpers.js";

it.each(["stdio", "streamable-http"])(
  "doctor forwards configured %s MCP credential references",
  async (transport) => {
    const f = fixture();
    const urlFile = join(f.root, "url");
    const server =
      transport === "streamable-http"
        ? spawn(
            process.execPath,
            [resolve("tests/fixtures/mcp-http.mjs"), urlFile],
            { stdio: "ignore" },
          )
        : undefined;
    const exited = server && new Promise((done) => server.once("exit", done));
    try {
      if (server)
        await expect
          .poll(() => existsSync(urlFile), { timeout: 5000 })
          .toBe(true);
      writeFileSync(
        join(f.home, "plugins.json"),
        JSON.stringify({
          mcp: [
            transport === "stdio"
              ? {
                  name: "fixture",
                  transport,
                  command: process.execPath,
                  args: [resolve("tests/fixtures/mcp-server.mjs")],
                  env: { FIXTURE_TOKEN: "WORKER_DOCTOR_TOKEN" },
                }
              : {
                  name: "fixture",
                  transport,
                  url: readFileSync(urlFile, "utf8"),
                  headerEnv: { Authorization: "WORKER_DOCTOR_TOKEN" },
                },
          ],
        }),
      );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [resolve("dist/cli.js"), "doctor", "--home", f.home, "--repo", f.repo],
        {
          env: {
            ...cleanEnv([]),
            WORKER_DOCTOR_TOKEN:
              transport === "stdio" ? "fixture-only" : "Bearer fixture-only",
          },
          timeout: 40000,
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        initialized: true,
        closed: true,
        modelCalls: 0,
      });
      expect(stdout).not.toContain("fixture-only");
      expect(readdirSync(join(f.home, "doctor"))).toEqual([]);
    } finally {
      server?.kill();
      if (exited) await exited;
      rmSync(f.root, { recursive: true, force: true });
    }
  },
  45000,
);

it("the resolved SDK profile disables delegation and max-token success", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-profile-test-"));
  try {
    const sdk = createRequire(
      createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sdk-client"),
    );
    const launcher = join(
      dirname(sdk.resolve("@deepseek-ai/dsh/package.json")),
      "lib/bin.js",
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        launcher,
        "--profile",
        "sdk",
        "--patch",
        policyPatch(home),
        "--dump-config",
      ],
      {
        env: { ...cleanEnv([]), DSH_HOME: home },
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const rows = YAML.parse(stdout, {
      customTags: [
        { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value },
      ],
    }) as {
      id: string;
      disabled?: boolean;
      config?: Record<string, unknown>;
    }[];
    for (const id of [
      "tool-subagent",
      "tool-subagent-fork",
      "tool-subagent-control",
      "tool-subagent-list-agents",
      "tool-workflow",
      "tool-ralph",
    ])
      expect(rows.find((row) => row.id === id)?.disabled, id).toBe(true);
    expect(
      rows.find((row) => row.id === "sdk-jsonrpc-server")?.config
        ?.maxTokensAsSuccess,
    ).toBe(false);
    expect(rows.find((row) => row.id === "approval")?.config?.policy).toBe(
      "never",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 35000);

it("doctor initializes and closes the released Harness without a model request", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-doctor-test-"));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/cli.js"), "doctor", "--home", home],
    {
      cwd: home,
      timeout: 40000,
    },
  );
  expect(JSON.parse(stdout)).toMatchObject({
    initialized: true,
    closed: true,
    modelCalls: 0,
    dispatchEnabled: false,
  });
  expect(readdirSync(join(home, "doctor"))).toEqual([]);
}, 45000);
