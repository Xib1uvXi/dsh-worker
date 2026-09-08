import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-subprocess";
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import {
  parseGrepArgs,
  parseGrepMatches,
  toWorkdirRelative,
  type GrepMatch,
} from "@deepseek-ai/dsh-tool-fs-search";

export interface SearchConfig {
  tgrep: string;
  workspace: string;
  indexDirectory: string;
  indexed: boolean;
}
/** One attempt owns this index. Queries serialize rebuilds and never contact a watcher daemon. */
export class TgrepSearch {
  private fingerprint?: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private ctx: Context,
    private config: SearchConfig,
  ) {
    this.config = { ...config, workspace: realpathSync(config.workspace) };
  }
  private async run(args: string[], signal: AbortSignal, emptyAllowed = false) {
    signal.throwIfAborted();
    const handle = this.ctx.subprocess.spawn({
      argv: [this.config.tgrep, "--no-config", ...args],
      cwd: this.config.workspace,
      // The public subprocess seam scrubs ambient DSH_* values. An explicit
      // override keeps even a reparented search discoverable after host SIGKILL.
      ...(process.env.DSH_WORKER_PROCESS_TOKEN
        ? {
            env: {
              DSH_WORKER_PROCESS_TOKEN: process.env.DSH_WORKER_PROCESS_TOKEN,
            },
          }
        : {}),
      signal,
      graceMs: 2000,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 20_000_000 },
        stderr: { maxBytes: 65536 },
      },
    });
    const outcome = await handle.done;
    signal.throwIfAborted();
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    if (!stdout || stdout.lossy || !stderr)
      throw new Error(
        "TGREP_OUTPUT_OVERFLOW: narrow the pattern or search path",
      );
    if (outcome.exitCode !== 0 && !(emptyAllowed && outcome.exitCode === 1))
      throw new Error(`TGREP_FAILED (${outcome.exitCode}): ${stderr.text}`);
    return stdout.text;
  }
  private async current(signal: AbortSignal) {
    const files = (
      await this.run(
        ["--files", "--no-index", "--no-max-filesize", "-0", "."],
        signal,
      )
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const digest = createHash("sha256");
    for (const file of files) {
      signal.throwIfAborted();
      const stat = await lstat(resolve(this.config.workspace, file), {
        bigint: true,
      });
      digest.update(
        JSON.stringify([
          file,
          String(stat.ino),
          String(stat.size),
          String(stat.mode),
          String(stat.mtimeNs),
          String(stat.ctimeNs),
        ]),
      );
    }
    return digest.digest("hex");
  }
  search(
    args: { pattern: string; path?: string; include?: string },
    exec: Pick<ToolExecution, "signal">,
  ): Promise<{ matches: GrepMatch[]; mode: string }> {
    const query = this.queue.then(() => this.searchOnce(args, exec.signal));
    this.queue = query.catch(() => {});
    return query;
  }
  private async searchOnce(
    args: { pattern: string; path?: string; include?: string },
    signal: AbortSignal,
  ) {
    const input = parseGrepArgs(args);
    const target = await realpath(
      resolve(this.config.workspace, input.path ?? "."),
    );
    const rel = relative(this.config.workspace, target);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error(
        "TGREP_PATH: search must stay inside the attempt workspace",
      );
    const query = [
      "--json",
      "--no-max-filesize",
      `--regexp=${input.pattern}`,
      ...(input.include ? [`--glob=${input.include}`] : []),
      "--",
      target,
    ];
    let mode = "live";
    let stdout: string;
    if (
      this.config.indexed &&
      !input.include &&
      target === this.config.workspace
    ) {
      let before: string | undefined;
      try {
        before = await this.current(signal);
      } catch (error) {
        if (signal.aborted) throw error;
      }
      if (before) {
        try {
          if (this.fingerprint !== before) {
            this.fingerprint = undefined;
            await this.run(
              [
                "index",
                ".",
                "--no-max-filesize",
                "--index-path",
                this.config.indexDirectory,
              ],
              signal,
            );
            if ((await this.current(signal)) === before)
              this.fingerprint = before;
          }
          if (this.fingerprint === before) {
            stdout = await this.run(
              ["--index-path", this.config.indexDirectory, ...query],
              signal,
              true,
            );
            if ((await this.current(signal)) === before) {
              mode = "index";
              return {
                matches: parseGrepMatches(stdout).map((m) => ({
                  ...m,
                  path: toWorkdirRelative(m.path, this.config.workspace),
                })),
                mode,
              };
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      this.fingerprint = undefined;
    }
    // Filtered/explicit paths use live traversal so ignored files named explicitly remain searchable.
    stdout = await this.run(["--no-index", ...query], signal, true);
    return {
      matches: parseGrepMatches(stdout).map((m) => ({
        ...m,
        path: toWorkdirRelative(m.path, this.config.workspace),
      })),
      mode,
    };
  }
}
