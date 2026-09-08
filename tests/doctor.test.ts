import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { cleanEnv } from "../packages/shared/src/process.js";
import { policyPatch } from "../packages/runtime/src/policy.js";

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
