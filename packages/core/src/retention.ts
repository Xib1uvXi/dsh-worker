import {
  existsSync,
  readFileSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { alive } from "../../shared/src/process.js";
import { join } from "node:path";
import type { TicketRecord } from "../../contracts/src/index.js";

// Only scratch Harness homes of old, clean attempts are disposable. Tickets,
// journal, snapshots, raw runner events and admission inputs remain evidence.
export function pruneEphemeral(
  home: string,
  records: TicketRecord[],
  days: number,
) {
  const cutoff = Date.now() - days * 86400000;
  const removed: string[] = [];
  for (const record of records) {
    if (record.activeOperation) continue;
    for (const attempt of record.attempts) {
      if (
        record.pendingAnswer?.attemptId === attempt.id ||
        (record.state === "blocked" &&
          record.attempts.at(-1)?.id === attempt.id &&
          attempt.delivery?.outcome === "blocked") ||
        !attempt.cleanExit ||
        !attempt.endedAt ||
        Date.parse(attempt.endedAt) >= cutoff
      )
        continue;
      const path = join(home, "runs", attempt.id, "harness-home");
      if (!existsSync(path)) continue;
      // Do not traverse a substituted directory outside the controller home.
      const run = join(home, "runs", attempt.id);
      if (
        lstatSync(join(home, "runs")).isSymbolicLink() ||
        lstatSync(run).isSymbolicLink() ||
        lstatSync(path).isSymbolicLink()
      )
        continue;
      rmSync(path, { recursive: true });
      removed.push(path);
    }
  }
  const doctor = join(home, "doctor");
  if (existsSync(doctor) && !lstatSync(doctor).isSymbolicLink()) {
    for (const name of readdirSync(doctor)) {
      const path = join(doctor, name);
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mtimeMs >= cutoff
      )
        continue;
      try {
        const owner = JSON.parse(
          readFileSync(join(path, "owner.json"), "utf8"),
        );
        if (
          !Number.isInteger(owner.pid) ||
          typeof owner.start !== "string" ||
          alive(owner)
        )
          continue;
      } catch {
        continue;
      }
      rmSync(path, { recursive: true });
      removed.push(path);
    }
  }
  return { removed, retentionDays: days, evidenceRetained: true };
}
