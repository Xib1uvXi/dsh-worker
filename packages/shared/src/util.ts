import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
export class WorkerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function ensure(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new WorkerError(code, message);
}
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" ||
    (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel))
  );
}
export function atomic(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${uid()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
const checkedArtifacts = new Map<string, { stamp: string; digest: string }>();
function artifactStamp(path: string) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
export function immutable(path: string, data: string | Buffer) {
  const digest = hash(data);
  if (existsSync(path)) {
    const stamp = artifactStamp(path);
    const checked = checkedArtifacts.get(path);
    if (checked?.stamp === stamp && checked.digest === digest) return;
    ensure(
      hash(readFileSync(path)) === digest,
      "artifact_conflict",
      `Immutable artifact changed: ${path}`,
    );
    if (checkedArtifacts.size > 4096) checkedArtifacts.clear();
    checkedArtifacts.set(path, { stamp, digest });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (checkedArtifacts.size > 4096) checkedArtifacts.clear();
  checkedArtifacts.set(path, { stamp: artifactStamp(path), digest });
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
