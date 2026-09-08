import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import type {
  FileEntry,
  Snapshot,
  Ticket,
  TicketRecord,
} from "../../contracts/src/index.js";
import { ensure, hash, canonical, immutable, inside } from "./util.js";

export function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export const gitText = (cwd: string, args: string[]) =>
  git(cwd, args).toString().trim();
export function validateRepo(ticket: Ticket) {
  ensure(
    ticket.targetRepo === realpathSync(ticket.targetRepo),
    "repository_path",
    "targetRepo must be a canonical absolute repository path",
  );
  ensure(
    gitText(ticket.targetRepo, ["rev-parse", "--show-toplevel"]) ===
      ticket.targetRepo,
    "repository_root",
    "targetRepo must be the Git root",
  );
  ensure(
    gitText(ticket.targetRepo, [
      "rev-parse",
      `${ticket.baseCommit}^{commit}`,
    ]) === ticket.baseCommit,
    "base_commit",
    "Base must resolve to an exact commit",
  );
}
export function checkOwnership(record: TicketRecord) {
  ensure(
    existsSync(record.worktree),
    "worktree_missing",
    "Owned worktree is missing",
  );
  ensure(
    realpathSync(record.worktree) === record.worktree,
    "worktree_path",
    "Worktree path changed",
  );
  const common = realpathSync(
    gitText(record.worktree, ["rev-parse", "--git-common-dir"]).startsWith("/")
      ? gitText(record.worktree, ["rev-parse", "--git-common-dir"])
      : resolve(
          record.worktree,
          gitText(record.worktree, ["rev-parse", "--git-common-dir"]),
        ),
  );
  const expected = realpathSync(
    resolve(
      record.ticket.targetRepo,
      gitText(record.ticket.targetRepo, ["rev-parse", "--git-common-dir"]),
    ),
  );
  ensure(
    common === expected,
    "worktree_owner",
    "Worktree belongs to another repository",
  );
  const gitDir = gitText(record.worktree, ["rev-parse", "--absolute-git-dir"]);
  ensure(
    existsSync(join(gitDir, "dsh-worker-owner")) &&
      readFileSync(join(gitDir, "dsh-worker-owner"), "utf8") === record.owner,
    "worktree_owner",
    "Worktree ownership marker is missing or mismatched",
  );
}
export function createWorktree(record: TicketRecord) {
  if (existsSync(record.worktree)) {
    checkOwnership(record);
    return;
  }
  const branch = `feature/dsh-worker-${record.ticket.ticketId}-${record.owner.slice(0, 8)}`;
  ensure(
    !gitText(record.ticket.targetRepo, ["branch", "--list", branch]),
    "branch_exists",
    "Refusing to reuse an unowned branch",
  );
  mkdirSync(dirname(record.worktree), { recursive: true, mode: 0o700 });
  git(record.ticket.targetRepo, [
    "worktree",
    "add",
    "-b",
    branch,
    record.worktree,
    record.ticket.baseCommit,
  ]);
  immutable(
    join(
      gitText(record.worktree, ["rev-parse", "--absolute-git-dir"]),
      "dsh-worker-owner",
    ),
    record.owner,
  );
}
function match(path: string, prefix: string) {
  const p = prefix.replace(/\/$/, "");
  return p === "." || path === p || path.startsWith(p + "/");
}
export function capture(record: TicketRecord, artifacts?: string): Snapshot {
  checkOwnership(record);
  const cwd = record.worktree;
  const head = gitText(cwd, ["rev-parse", "HEAD"]);
  const baseline = new Map<string, string>();
  for (const item of git(cwd, ["ls-tree", "-r", "-z", record.ticket.baseCommit])
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const separator = item.indexOf("\t");
    const meta = item.slice(0, separator);
    const path = item.slice(separator + 1);
    ensure(meta && path, "git_output", "Invalid Git tree");
    baseline.set(path, meta.split(" ")[0]!);
  }
  const tracked = git(cwd, ["ls-files", "-z", "--cached"])
    .toString()
    .split("\0")
    .filter(Boolean);
  // Git-ignored build products are not deliverables; all other untracked paths are included.
  const others = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])
    .toString()
    .split("\0")
    .filter(Boolean);
  const names = [
    ...new Set([...baseline.keys(), ...tracked, ...others]),
  ].sort();
  const files: FileEntry[] = [];
  const violations: string[] = [];
  for (const path of names) {
    ensure(
      inside(cwd, join(cwd, path)),
      "snapshot_path",
      "Git returned an unsafe path",
    );
    // A parent symlink must never cause the collector to read outside the checkout.
    let parent = dirname(join(cwd, path));
    while (parent !== cwd) {
      if (existsSync(parent))
        ensure(
          !lstatSync(parent).isSymbolicLink(),
          "snapshot_symlink",
          `Symlink ancestor of ${path}`,
        );
      parent = dirname(parent);
    }
    let stat;
    try {
      stat = lstatSync(join(cwd, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let entry: FileEntry;
    if (!stat) entry = { path, kind: "deleted", mode: 0, hash: null, size: 0 };
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(join(cwd, path));
      entry = {
        path,
        kind: "symlink",
        mode: 0o120000,
        hash: hash(target),
        size: Buffer.byteLength(target),
        target,
      };
      if (!inside(cwd, resolve(dirname(join(cwd, path)), target)))
        violations.push(`Symlink escapes worktree: ${path}`);
      if (artifacts) immutable(join(artifacts, "blobs", entry.hash!), target);
    } else if (stat.isFile()) {
      ensure(
        stat.size <= 32 * 1024 * 1024,
        "snapshot_size",
        `File exceeds 32 MiB evidence limit: ${path}`,
      );
      const data = readFileSync(join(cwd, path));
      entry = {
        path,
        kind: "file",
        mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
        hash: hash(data),
        size: data.length,
      };
      if (artifacts) immutable(join(artifacts, "blobs", entry.hash!), data);
    } else {
      violations.push(`Unsupported file or submodule: ${path}`);
      entry = { path, kind: "file", mode: stat.mode, hash: null, size: 0 };
    }
    files.push(entry);
  }
  const changes = new Set(
    [
      ...git(cwd, ["diff", "--name-only", "-z", record.ticket.baseCommit])
        .toString()
        .split("\0"),
      ...others,
      ...git(cwd, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        record.ticket.baseCommit,
      ])
        .toString()
        .split("\0"),
    ].filter(Boolean),
  );
  for (const path of changes)
    if (
      !record.ticket.scope.paths.some((p) => match(path, p)) ||
      record.ticket.scope.exclude.some((p) => match(path, p))
    )
      violations.push(`Out of scope: ${path}`);
  if (head !== record.ticket.baseCommit)
    violations.push("HEAD changed from the assigned base");
  const indexHash = hash(git(cwd, ["ls-files", "--stage", "-z"]));
  const diff = git(cwd, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    record.ticket.baseCommit,
    "--",
  ]).toString();
  const content = {
    baseCommit: record.ticket.baseCommit,
    head,
    indexHash,
    indexDiff: git(cwd, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      record.ticket.baseCommit,
      "--",
    ]).toString(),
    files,
    changedPaths: [...changes].sort(),
    diff,
    violations,
  };
  const snapshot = { ...content, digest: hash(canonical(content)) };
  if (artifacts)
    immutable(
      join(artifacts, "snapshots", `${snapshot.digest}.json`),
      canonical(snapshot),
    );
  return snapshot;
}
