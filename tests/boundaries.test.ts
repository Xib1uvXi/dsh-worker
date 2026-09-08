import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
it("keeps internal package dependencies in the documented direction", () => {
  const allowed: Record<string, string[]> = {
    contracts: [],
    shared: ["contracts"],
    runtime: ["shared", "contracts"],
    core: ["runtime", "shared", "contracts"],
    server: ["core", "runtime", "shared", "contracts"],
    cli: ["server", "runtime", "shared", "contracts"],
    web: ["contracts"],
  };
  const violations: string[] = [];
  for (const [area, dependencies] of Object.entries(allowed)) {
    const root = resolve("packages", area);
    for (const name of readdirSync(root, { recursive: true }) as string[]) {
      if (!name.endsWith(".ts")) continue;
      const path = join(root, name);
      for (const match of readFileSync(path, "utf8").matchAll(
        /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g,
      )) {
        if (!match[1]!.startsWith(".")) continue;
        const target = relative(
          resolve("packages"),
          resolve(dirname(path), match[1]!),
        ).split("/")[0]!;
        if (
          target === ".." &&
          area === "runtime" &&
          match[1]!.endsWith("package.json")
        )
          continue;
        if (target !== area && !dependencies.includes(target))
          violations.push(`${area}/${name} -> ${target}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
