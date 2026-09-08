import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
const rules = async (text: string, filePath: string) =>
  (await eslint.lintText(text, { filePath })).flatMap((r) =>
    r.messages.map((message) => message.ruleId),
  );

it("detects unused variables and unhandled promises in TypeScript", async () => {
  expect(
    await rules(
      "const unused = 1; Promise.resolve(1); export {};",
      "packages/shared/src/util.ts",
    ),
  ).toEqual(
    expect.arrayContaining([
      "@typescript-eslint/no-unused-vars",
      "@typescript-eslint/no-floating-promises",
    ]),
  );
});

it("detects async callbacks in synchronous contracts and non-Promise awaits", async () => {
  expect(
    await rules(
      "setTimeout(async () => { await 1; }, 1); export {};",
      "packages/shared/src/process.ts",
    ),
  ).toEqual(
    expect.arrayContaining([
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/await-thenable",
    ]),
  );
});

it("rejects Node globals and imports in browser modules", async () => {
  expect(
    await rules(
      'import fs from "node:fs"; import path from "path"; process.cwd(); console.log(fs, path);',
      "packages/web/src/labels.ts",
    ),
  ).toEqual(
    expect.arrayContaining(["no-restricted-globals", "no-restricted-imports"]),
  );
});

it("checks JS fixtures and config while ignoring generated and personal files", async () => {
  expect(
    await rules("const unused = 1;", "tests/fixtures/runtime.mjs"),
  ).toContain("no-unused-vars");
  expect(await rules("const unused = 1;", "eslint.config.mjs")).toContain(
    "no-unused-vars",
  );
  for (const path of [
    "dist/cli.js",
    ".scratch/probe.ts",
    "coverage/report.js",
    "node_modules/example/index.js",
  ])
    expect(await eslint.isPathIgnored(path)).toBe(true);
  expect(
    await rules(
      "export const ready = Promise.resolve(1);",
      "packages/shared/src/util.ts",
    ),
  ).toEqual([]);
});

it("can apply safe lint fixes", async () => {
  const fixer = new ESLint({ fix: true });
  const [result] = await fixer.lintText("let count = 1; export { count };", {
    filePath: "packages/shared/src/util.ts",
  });
  expect(result?.output).toContain("const count");
  expect(result?.errorCount).toBe(0);
});

it.each(["node:fs", "fs", "node:fs/promises", "fs/promises"])(
  "rejects both static and dynamic browser imports of %s",
  async (module) => {
    expect(
      await rules(
        `import fs from ${JSON.stringify(module)}; console.log(fs);`,
        "packages/web/src/labels.ts",
      ),
    ).toContain("no-restricted-imports");
    expect(
      await rules(
        `void import(${JSON.stringify(module)});`,
        "packages/web/src/labels.ts",
      ),
    ).toContain("no-restricted-syntax");
  },
);
