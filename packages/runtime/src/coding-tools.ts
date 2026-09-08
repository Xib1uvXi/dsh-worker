import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { codingToolsSchema } from "../../contracts/src/index.js";
import { cleanEnv } from "../../shared/src/process.js";
import { atomic, ensure } from "../../shared/src/util.js";
const exec = promisify(execFile);
export const tgrepVersion = "1.0.4";
const releases: Record<string, [string, string]> = {
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "9ef13569d6725bb50497671506c914aaf6602fb0631810c8d100214498497ec8",
  ],
  "darwin-x64": [
    "x86_64-apple-darwin",
    "10c73c378d92c93f81d12706bc02c413c7626c4ed8f178ac0d23abd461bbd643",
  ],
  "linux-arm64": [
    "aarch64-unknown-linux-musl",
    "8df6ab6ab6d859c38df3c6ee39c39bab66165761371a46a325021dd3c25607fb",
  ],
  "linux-x64": [
    "x86_64-unknown-linux-musl",
    "81fd408f619fc1a316ed0618b2d2062b463631bdfd71123050580293817074fb",
  ],
};
export function managedTgrep(home: string) {
  return join(
    home,
    "tools",
    `tgrep-${tgrepVersion}-${process.platform}-${process.arch}`,
    "tgrep",
  );
}
export async function installTgrep(home: string) {
  const release = releases[`${process.platform}-${process.arch}`];
  ensure(
    release,
    "tools_platform",
    "Managed tgrep supports macOS/Linux arm64/x64. Configure an explicit tgrep executable on other platforms.",
  );
  const target = managedTgrep(home);
  if (existsSync(target)) return { path: target, installed: false };
  mkdirSync(join(home, "tools"), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(home, "tools", ".install-"));
  try {
    const url = `https://github.com/microsoft/tgrep/releases/download/v${tgrepVersion}/tgrep-v${tgrepVersion}-${release[0]}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    ensure(
      response.ok && response.body,
      "tools_download",
      `tgrep download failed: ${response.status}`,
    );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      ensure(
        bytes <= 40_000_000,
        "tools_download",
        "tgrep archive exceeds download limit",
      );
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    ensure(
      createHash("sha256").update(archive).digest("hex") === release[1],
      "tools_checksum",
      "tgrep release checksum mismatch",
    );
    const file = join(staging, "archive.tar.gz");
    writeFileSync(file, archive, { mode: 0o600 });
    await exec("tar", ["-xzf", file, "-C", staging, "./tgrep"], {
      timeout: 15000,
      env: cleanEnv([]),
    });
    chmodSync(join(staging, "tgrep"), 0o755);
    const version = await exec(join(staging, "tgrep"), ["--version"], {
      timeout: 5000,
      env: cleanEnv([]),
    });
    ensure(
      version.stdout.trim() === `tgrep ${tgrepVersion}`,
      "tools_version",
      "Unexpected tgrep release version",
    );
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(join(staging, "tgrep"), target);
    return { path: target, installed: true, version: tgrepVersion };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
export function codingConfig(home: string) {
  const file = join(home, "tools.json");
  return codingToolsSchema.parse(
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
  );
}
function executable(command: string, home: string) {
  if (command.includes("/")) return resolve(home, command);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, command))) return resolve(dir, command);
  }
  return command;
}
const mappings = {
  go: { ".go": "go" },
  rust: { ".rs": "rust" },
  typescript: {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
  },
};
export type Language = keyof typeof mappings;
export interface LanguageServer {
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
  configuration?: unknown;
  initializationOptions?: unknown;
}
export interface CodingReport {
  ok: boolean;
  search: "tgrep" | "ripgrep";
  indexed: boolean;
  tgrep?: string;
  languages: Language[];
  servers: Record<string, LanguageServer>;
  checks: { tool: string; command: string; version?: string; error?: string }[];
  guidance: string;
}
export async function inspectCodingTools(
  home: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<CodingReport> {
  const config = codingConfig(home);
  const listing = await exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: workspace,
      env: cleanEnv([]),
      timeout: 15000,
      maxBuffer: 20_000_000,
      signal,
    },
  );
  const files = listing.stdout.split("\0");
  const languages =
    config.languages === "auto"
      ? (Object.keys(mappings) as Language[]).filter((language) =>
          files.some((file) => extname(file) in mappings[language]),
        )
      : config.languages;
  const checks: CodingReport["checks"] = [];
  async function probe(tool: string, command: string, args: string[]) {
    try {
      const result = await exec(command, args, {
        cwd: workspace,
        env: {
          ...cleanEnv(
            [
              "GOPATH",
              "GOROOT",
              "GOWORK",
              "GOFLAGS",
              "GOTOOLCHAIN",
              "GOMODCACHE",
              "GOCACHE",
              "RUSTUP_HOME",
              "RUSTUP_TOOLCHAIN",
              "CARGO_HOME",
              "CARGO_TARGET_DIR",
            ].filter((key) => Boolean(process.env[key])),
          ),
          RUSTUP_AUTO_INSTALL: "0",
        },
        timeout: 10000,
        maxBuffer: 65536,
        signal,
      });
      checks.push({
        tool,
        command,
        version: (result.stdout || result.stderr).trim().slice(0, 1000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      checks.push({
        tool,
        command,
        error: `${String(error).slice(0, 1000)}. Install the executable or configure tools.json; run tools --repo PATH to recheck.`,
      });
    }
  }
  const tgrep =
    config.search === "tgrep"
      ? executable(config.tgrep ?? managedTgrep(home), home)
      : undefined;
  if (tgrep) await probe("tgrep", tgrep, ["--version"]);
  const defaults = {
    go: "gopls",
    rust: "rust-analyzer",
    typescript: join(
      dirname(
        createRequire(import.meta.url).resolve(
          "typescript-language-server/package.json",
        ),
      ),
      "lib/cli.mjs",
    ),
  };
  const servers: Record<string, LanguageServer> = {};
  for (const language of languages) {
    const custom = config.servers[language];
    const command = executable(custom?.command ?? defaults[language], home);
    await probe(language, command, [
      language === "go" ? "version" : "--version",
    ]);
    servers[language] = {
      command,
      args: custom?.args ?? (language === "typescript" ? ["--stdio"] : []),
      extensionToLanguage: mappings[language],
      configuration: custom?.configuration,
      initializationOptions: custom?.initializationOptions,
    };
  }
  const guidance = [
    "Before editing, use repository instructions and the project's lockfile to prepare missing dependencies in this worktree. Do not assume ignored dependencies from the primary checkout are present.",
    "Language servers may still be loading. If a read-only LSP query reports content modified, retry after a brief wait, at most twice. If it remains unavailable, use search/read and report the limitation; empty results never prove no references.",
    "After meaningful changes, run the repository's focused type/lint/test commands, inspect failures and repair them. Report the exact command, relevant file/line or failing test, and checks not run. External controller verification and Spec/Standards review remain required.",
    languages.includes("go")
      ? "Go: check go.mod/go.work and build tags; use project-prescribed go test and go vet checks."
      : "",
    languages.includes("rust")
      ? "Rust: respect rust-toolchain and Cargo features; use project-prescribed cargo check, clippy and focused tests."
      : "",
    languages.includes("typescript")
      ? "TypeScript: install from the lockfile with the project's package manager; use its typecheck, lint and focused tests. Browser tests require the matching installed browser."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ok: checks.every((c) => !c.error),
    search: config.search,
    indexed: config.indexed,
    tgrep,
    languages,
    servers,
    checks,
    guidance,
  };
}
export async function codingPatch(
  home: string,
  workspace: string,
  dir: string,
  signal?: AbortSignal,
) {
  const report = await inspectCodingTools(home, workspace, signal);
  atomic(join(dir, "coding-tools.json"), JSON.stringify(report));
  ensure(
    report.ok,
    "coding_tools",
    `Coding tools preflight failed. Run dsh-worker tools install --home DIR for tgrep; inspect dsh-worker tools --home DIR --repo PATH. ${report.checks
      .filter((c) => c.error)
      .map((c) => `${c.tool}: ${c.error}`)
      .join("; ")}`,
  );
  const path = join(dir, "coding.patch.json");
  const plugin = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../../dist/coding-plugin.js"
        : "./coding-plugin.js",
      import.meta.url,
    ),
  );
  atomic(
    path,
    JSON.stringify([
      ...(report.search === "tgrep"
        ? [{ id: "tool-fs-search", disabled: true }]
        : []),
      {
        insert: [
          {
            id: "worker-coding-tools",
            name: plugin,
            config: {
              ...report,
              indexDirectory: join(dir, "search-index"),
              workspace: realpathSync(workspace),
            },
          },
        ],
      },
    ]),
  );
  return path;
}
