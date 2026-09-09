import { build } from "esbuild";
import {
  mkdir,
  copyFile,
  chmod,
  rm,
  readdir,
  readFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const inputs = [
  "package.json",
  "package-lock.json",
  ...(await readdir(".")).filter((p) => /^tsconfig.*\.json$/.test(p)),
];
for (const dir of ["packages", "scripts"])
  for (const file of await readdir(dir, { recursive: true }))
    if (/\.(ts|js|html|css)$/.test(file)) inputs.push(`${dir}/${file}`);
const digest = createHash("sha256");
for (const file of inputs.sort()) {
  digest
    .update(file)
    .update("\0")
    .update(await readFile(file))
    .update("\0");
}
let commit: string | null = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* Packed source may have no Git metadata. */
}
const buildInfo = {
  version: JSON.parse(await readFile("package.json", "utf8")).version as string,
  commit,
  sourceDigest: digest.digest("hex"),
  builtAt: new Date().toISOString(),
};
await rm("dist", { recursive: true, force: true });
await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: {
    cli: "packages/cli/src/main.ts",
    "snapshot-worker": "packages/core/src/snapshot-worker.ts",
    runner: "packages/runtime/src/runner.ts",
    "resume-plugin": "packages/runtime/src/resume-plugin.ts",
    "lsp-launcher": "packages/runtime/src/lsp-launcher.ts",
    "coding-plugin": "packages/runtime/src/coding-plugin.ts",
    "capability-plugin": "packages/runtime/src/capability-plugin.ts",
    "owned-subprocess": "packages/runtime/src/owned-subprocess.ts",
    "ptc-bootstrap": "packages/runtime/src/ptc-bootstrap.ts",
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
  define: { __WORKER_BUILD__: JSON.stringify(buildInfo) },
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
