import { build } from "esbuild";
import { mkdir, copyFile, chmod, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: {
    cli: "packages/cli/src/main.ts",
    "snapshot-worker": "packages/core/src/snapshot-worker.ts",
    runner: "packages/runtime/src/runner.ts",
    index: "packages/index.ts",
    contracts: "packages/contracts/src/index.ts",
    plugin: "packages/server/src/plugin.ts",
    http: "packages/server/src/http.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: true,
});
await build({
  entryPoints: ["packages/web/src/app.ts"],
  outfile: "dist/web/app.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  minify: true,
  sourcemap: true,
});
await copyFile("packages/web/index.html", "dist/web/index.html");
await copyFile("packages/web/style.css", "dist/web/style.css");
await chmod("dist/cli.js", 0o755);
