import { createHash } from "node:crypto";
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
import {
  ensure,
  hash,
  canonical,
  immutable,
  inside,
} from "../../shared/src/util.js";

export function git(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
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
    resolve(
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
    return false;
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
  return true;
}
function match(path: string, prefix: string) {
  const p = prefix.replace(/\/$/, "");
  return p === "." || path === p || path.startsWith(p + "/");
}
export type FileCache = Map<
  string,
  { stamp: string; entry: FileEntry; objectId: string }
>;
function blobId(data: Buffer | string, algorithm: string) {
  return createHash(algorithm)
    .update(`blob ${Buffer.byteLength(data)}\0`)
    .update(data)
    .digest("hex");
}

interface BaseFile {
  mode: number;
  objectId: string;
}
const convertedBlobCache = new Map<string, string>();
function checkoutBaseline(
  cwd: string,
  base: string,
  files: Map<string, BaseFile>,
  algorithm: string,
) {
  const regular = [...files].filter(
    ([, file]) => file.mode === 0o100644 || file.mode === 0o100755,
  );
  if (!regular.length) return;
  const attributes = git(
    cwd,
    [
      "check-attr",
      `--source=${base}`,
      "--stdin",
      "-z",
      "text",
      "eol",
      "filter",
      "ident",
      "working-tree-encoding",
      "crlf",
    ],
    Buffer.from(regular.map(([path]) => path + "\0").join("")),
  )
    .toString()
    .split("\0");
  const converted = new Set<string>();
  const attrs = new Map<string, string[]>();
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    const path = attributes[i]!;
    const values = attrs.get(path) ?? [];
    values.push(attributes[i + 2]!);
    attrs.set(path, values);
    if (!["unspecified", "unset"].includes(attributes[i + 2]!))
      converted.add(path);
  }
  const autocrlf = gitText(cwd, [
    "config",
    "--get",
    "--default",
    "false",
    "core.autocrlf",
  ]).toLowerCase();
  if (!["false", "no", "off", "0", "input"].includes(autocrlf))
    for (const [path] of regular) converted.add(path);
  if (!converted.size) return;
  const eol = gitText(cwd, [
    "config",
    "--get",
    "--default",
    "native",
    "core.eol",
  ]);
  for (const [path, file] of regular) {
    if (!converted.has(path)) continue;
    const values = attrs.get(path)!;
    // Built-in conversions depend on immutable content/attributes and these
    // settings. External smudge filters can depend on other files or programs,
    // so never reuse their results. The cache contains only blob identifiers.
    const external = !["unspecified", "unset"].includes(values[2]!);
    const key = canonical([algorithm, file.objectId, values, autocrlf, eol]);
    let convertedId = external ? undefined : convertedBlobCache.get(key);
    if (!convertedId) {
      // Use committed attributes, not the current .gitattributes or the current
      // file's clean filter. Older Git batch headers report the original size
      // even after filters expand the content, so read each converted blob whole.
      const content = git(cwd, [
        `--attr-source=${base}`,
        "cat-file",
        "--filters",
        `--path=${path}`,
        file.objectId,
      ]);
      convertedId = blobId(content, algorithm);
      if (!external) {
        if (convertedBlobCache.size > 100000) convertedBlobCache.clear();
        convertedBlobCache.set(key, convertedId);
      }
    }
    file.objectId = convertedId;
  }
}
function baseTree(cwd: string, base: string) {
  const baseline = new Map<string, BaseFile>();
  const objectFormat = gitText(cwd, ["rev-parse", "--show-object-format"]);
  for (const item of git(cwd, ["ls-tree", "-r", "-z", base])
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const separator = item.indexOf("\t");
    const meta = item.slice(0, separator);
    const path = item.slice(separator + 1);
    ensure(meta && path, "git_output", "Invalid Git tree");
    const [mode, , objectId] = meta.split(/\s+/);
    baseline.set(path, {
      mode: parseInt(mode!, 8),
      objectId: objectId!,
    });
  }
  return { files: baseline, objectFormat };
}

export function createCheckoutBaseline(
  record: TicketRecord,
  artifacts: string,
) {
  checkOwnership(record);
  const { files, objectFormat } = baseTree(
    record.worktree,
    record.ticket.baseCommit,
  );
  const original = new Map(
    [...files].map(([path, file]) => [path, file.objectId]),
  );
  checkoutBaseline(
    record.worktree,
    record.ticket.baseCommit,
    files,
    objectFormat,
  );
  const overrides = [...files]
    .filter(([path, file]) => original.get(path) !== file.objectId)
    .map(([path, file]) => [path, file.objectId]);
  const content = canonical({
    baseCommit: record.ticket.baseCommit,
    owner: record.owner,
    overrides,
  });
  const digest = hash(content);
  const path = join(artifacts, "baselines", `${digest}.json`);
  immutable(path, content);
  return { path, digest };
}

// --raw -z keeps unusual paths unambiguous; the patch follows a double NUL.
// Read both together so Git computes each worktree/index diff only once.
function readDiff(
  cwd: string,
  base: string,
  filterOverrides: string[],
  cached = false,
) {
  const output = git(cwd, [
    ...filterOverrides,
    "diff",
    ...(cached ? ["--cached"] : []),
    "--raw",
    "-z",
    "--patch",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
  ]);
  if (!output.length) return { paths: [] as string[], patch: "" };
  const separator = output.indexOf(Buffer.from([0, 0]));
  ensure(separator >= 0, "git_output", "Missing raw/patch separator");
  const fields = output.subarray(0, separator).toString().split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; ) {
    const header = fields[i++]!;
    ensure(
      /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [A-Z]\d*$/.test(header),
      "git_output",
      "Invalid raw diff entry",
    );
    const status = header.split(" ").at(-1)!;
    const source = fields[i++];
    // --name-only reports the destination for copies and renames.
    const path = /^[RC]/.test(status) ? fields[i++] : source;
    ensure(source && path, "git_output", "Missing raw diff path");
    paths.push(path);
  }
  return { paths, patch: output.subarray(separator + 2).toString() };
}

export function capture(
  record: TicketRecord,
  artifacts?: string,
  cache?: FileCache,
): Snapshot {
  checkOwnership(record);
  const cwd = record.worktree;
  const head = gitText(cwd, ["rev-parse", "HEAD"]);
  const { files: baseline, objectFormat } = baseTree(
    cwd,
    record.ticket.baseCommit,
  );
  const reference = record.checkoutBaseline;
  if (reference) {
    const content = readFileSync(reference.path);
    ensure(
      hash(content) === reference.digest,
      "baseline_integrity",
      "Checkout baseline evidence changed",
    );
    const expected = JSON.parse(content.toString()) as {
      baseCommit: string;
      owner: string;
      overrides: [string, string][];
    };
    ensure(
      expected.baseCommit === record.ticket.baseCommit &&
        expected.owner === record.owner,
      "baseline_owner",
      "Checkout baseline belongs to another assignment",
    );
    for (const [path, objectId] of expected.overrides) {
      const file = baseline.get(path);
      ensure(
        file,
        "baseline_path",
        "Checkout baseline contains an unknown path",
      );
      file.objectId = objectId;
    }
  }
  // Legacy records have no trustworthy admission-time conversion evidence.
  // Compare their raw committed bytes; never bless edits by sampling current
  // files or executing potentially changed conversion definitions on a read.
  const index = git(cwd, ["ls-files", "--stage", "-z"]);
  const tracked = index
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  // Git-ignored build products are not deliverables; all other untracked paths are included.
  const others = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])
    .toString()
    .split("\0")
    .filter(Boolean);
  // --no-textconv does not disable clean or long-running process filters.
  // Override every effective external filter only for these read commands;
  // admission-time checkout conversion remains unchanged.
  const filterOverrides = [
    ...new Set(
      git(cwd, ["config", "--null", "--name-only", "--list"])
        .toString()
        .split("\0"),
    ),
  ]
    .filter((key) => /^filter\..+\.(clean|smudge|process|required)$/.test(key))
    .flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
  const working = readDiff(cwd, record.ticket.baseCommit, filterOverrides);
  const staged = readDiff(cwd, record.ticket.baseCommit, filterOverrides, true);
  // Working patches compare raw Git blobs without external filters. Scope is
  // determined below from actual bytes against the admitted checkout baseline,
  // so legitimate smudge conversions are not classified as user edits.
  const changes = new Set([...others, ...staged.paths]);
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
      stat = lstatSync(join(cwd, path), { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let entry: FileEntry;
    let objectId: string | undefined;
    let data: Buffer | string | undefined;
    if (!stat) entry = { path, kind: "deleted", mode: 0, hash: null, size: 0 };
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(join(cwd, path));
      data = target;
      objectId = blobId(data, objectFormat);
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
    } else if (stat.isFile()) {
      ensure(
        stat.size <= 32 * 1024 * 1024,
        "snapshot_size",
        `File exceeds 32 MiB evidence limit: ${path}`,
      );
      const absolute = join(cwd, path);
      const stamp = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const cached = cache?.get(absolute);
      if (!artifacts && cached?.stamp === stamp) {
        entry = cached.entry;
        objectId = cached.objectId;
      } else {
        data = readFileSync(absolute);
        objectId = blobId(data, objectFormat);
        entry = {
          path,
          kind: "file",
          mode: Number(stat.mode) & 0o111 ? 0o100755 : 0o100644,
          hash: hash(data),
          size: data.length,
        };
        if (cache) {
          if (cache.size > 100000) cache.clear();
          cache.set(absolute, { stamp, entry, objectId });
        }
      }
    } else {
      violations.push(`Unsupported file or submodule: ${path}`);
      entry = {
        path,
        kind: "file",
        mode: Number(stat.mode),
        hash: null,
        size: 0,
      };
    }
    const base = baseline.get(path);
    // Compare the actual bytes and executable mode against the assigned Git
    // tree, independently of index flags, filters, and core.fileMode.
    if (!base || base.objectId !== objectId || base.mode !== entry.mode)
      changes.add(path);
    if (artifacts && changes.has(path) && data !== undefined && entry.hash)
      immutable(join(artifacts, "blobs", entry.hash), data);
    files.push(entry);
  }
  for (const path of changes)
    if (
      !record.ticket.scope.paths.some((p) => match(path, p)) ||
      record.ticket.scope.exclude.some((p) => match(path, p))
    )
      violations.push(`Out of scope: ${path}`);
  if (head !== record.ticket.baseCommit)
    violations.push("HEAD changed from the assigned base");
  const indexHash = hash(index);
  const content = {
    baselineDigest: reference?.digest,
    baseCommit: record.ticket.baseCommit,
    head,
    indexHash,
    indexDiff: staged.patch,
    files,
    changedPaths: [...changes].sort(),
    diff: working.patch,
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
