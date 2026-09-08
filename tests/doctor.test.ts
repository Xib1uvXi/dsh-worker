import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

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
