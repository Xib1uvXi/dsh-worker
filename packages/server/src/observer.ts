import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { z } from "zod";
import type { SessionSummary } from "../../contracts/src/index.js";
import { ensure } from "../../shared/src/util.js";
const headerSchema = z.object({
  type: z.literal("session"),
  version: z.number().int().min(0).max(2),
  id: z.string().min(1).max(1000),
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  parentSession: z.string().optional(),
  origin: z.string().optional(),
  isSeeded: z.boolean().optional(),
  seedLength: z.number().int().nonnegative().optional(),
  delegationDepth: z.number().int().nonnegative().optional(),
});
export function encodeSegment(raw: string) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    out += /[A-Za-z0-9._-]/.test(c)
      ? c
      : `~${raw.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}
async function firstLine(path: string) {
  ensure(
    lstatSync(path).isFile(),
    "session_file",
    "Session file must be regular",
  );
  const input = createReadStream(path, {
    highWaterMark: 4096,
    end: 1024 * 1024 - 1,
  });
  const decoder = path.endsWith(".zstd")
    ? createZstdDecompress({ chunkSize: 4096 })
    : undefined;
  // pipe() does not propagate source errors to the stream we iterate.
  if (decoder) input.on("error", (error) => decoder.destroy(error));
  const stream = decoder ? input.pipe(decoder) : input;
  let data = Buffer.alloc(0);
  const timeout = setTimeout(
    () => stream.destroy(new Error("Session header deadline exceeded")),
    2000,
  );
  try {
    for await (const chunk of stream) {
      data = Buffer.concat([data, Buffer.from(chunk)]);
      const index = data.indexOf(10);
      if (index >= 0) {
        ensure(index <= 65536, "session_header", "Header exceeds 64 KiB");
        return data.subarray(0, index).toString();
      }
      ensure(data.length <= 65536, "session_header", "Header exceeds 64 KiB");
    }
    throw new Error("Incomplete session header");
  } finally {
    clearTimeout(timeout);
    input.destroy();
    decoder?.destroy();
  }
}
export async function sessions(homes: string[]) {
  const deadline = Date.now() + 5000;
  const found: SessionSummary[] = [];
  const diagnostics: string[] = [];
  let scanned = 0;
  for (const home of homes) {
    const root = join(home, "sessions");
    if (!existsSync(root)) continue;
    try {
      const projects = readdirSync(root, { withFileTypes: true }).filter((p) =>
        p.isDirectory(),
      );
      if (projects.length > 256)
        diagnostics.push(`${home}: project inventory truncated`);
      for (const project of projects.slice(0, 256)) {
        const dirs = readdirSync(join(root, project.name), {
          withFileTypes: true,
        }).filter((p) => p.isDirectory());
        for (const entry of dirs) {
          if (++scanned > 1024 || Date.now() > deadline) {
            diagnostics.push(
              "Session inventory truncated at its entry/time budget",
            );
            return { sessions: found, diagnostics };
          }
          const dir = join(root, project.name, entry.name);
          try {
            const candidates = readdirSync(dir)
              .flatMap((name) => {
                const m = name.match(
                  /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/,
                );
                return m
                  ? [{ name, version: Number(m[1] ?? 0), compressed: !!m[2] }]
                  : [];
              })
              .sort(
                (a, b) =>
                  b.version - a.version ||
                  Number(a.compressed) - Number(b.compressed),
              );
            const selected = candidates[0];
            ensure(
              selected,
              "session_missing",
              "No canonical session artifact",
            );
            ensure(
              selected.version <= 2,
              "session_version",
              `Unsupported highest generation ${selected.version}`,
            );
            const header = headerSchema.parse(
              JSON.parse(await firstLine(join(dir, selected.name))),
            );
            ensure(
              header.version === selected.version,
              "session_version",
              "Filename and header generation mismatch",
            );
            ensure(
              encodeSegment(header.id) === entry.name,
              "session_identity",
              "Directory and header identity mismatch",
            );
            ensure(
              !found.some((s) => s.source === home && s.id === header.id),
              "session_duplicate",
              "Duplicate session identity in one source",
            );
            found.push({
              source: home,
              id: header.id,
              parent: header.parentSession,
              origin: header.origin === "subagent" ? "subagent" : undefined,
              cwd: header.cwd,
              format: header.version,
              liveness: "unknown",
            });
          } catch (error) {
            diagnostics.push(`${entry.name}: ${String(error)}`);
          }
        }
      }
    } catch (error) {
      diagnostics.push(`${home}: ${String(error)}`);
    }
  }
  for (const s of found) {
    if (
      s.parent &&
      !found.some((p) => p.source === s.source && p.id === s.parent)
    )
      diagnostics.push(`${s.id}: parent session unavailable`);
    const seen = new Set<string>();
    let node: SessionSummary | undefined = s;
    while (node) {
      if (seen.has(node.id)) {
        diagnostics.push(`${s.id}: parent cycle`);
        break;
      }
      seen.add(node.id);
      const parent: string | undefined = node.parent;
      node = parent
        ? found.find((p) => p.source === s.source && p.id === parent)
        : undefined;
    }
  }
  return { sessions: found, diagnostics };
}
