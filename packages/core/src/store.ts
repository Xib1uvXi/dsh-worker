import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  JournalEvent,
  TicketRecord,
  Snapshot,
} from "../../contracts/src/index.js";
import { ensure, now, canonical } from "../../shared/src/util.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "worker.sqlite"));
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    ensure(
      version.user_version === 0 || version.user_version === 2,
      "database_version",
      "Unsupported controller database version; use a separate v2 home",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (digest TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, ticket_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_ticket_seq ON journal(ticket_id,seq);
      PRAGMA user_version=2;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private hydrate(record: TicketRecord, details: boolean) {
    if (details)
      for (const a of record.attempts)
        if (a.snapshot?.detailsOmitted) {
          const row = this.db
            .prepare("SELECT data FROM snapshots WHERE digest=?")
            .get(a.snapshot.digest) as { data: string } | undefined;
          ensure(row, "snapshot_missing", "Snapshot evidence is missing");
          a.snapshot = JSON.parse(row.data) as Snapshot;
        }
    return record;
  }
  list(details = true): TicketRecord[] {
    return (
      this.db.prepare("SELECT data FROM tickets ORDER BY id").all() as {
        data: string;
      }[]
    ).map((r) => this.hydrate(JSON.parse(r.data) as TicketRecord, details));
  }
  get(id: string, details = true): TicketRecord {
    const row = this.db
      .prepare("SELECT data FROM tickets WHERE id=?")
      .get(id) as { data: string } | undefined;
    ensure(row, "not_found", `Unknown ticket ${id}`);
    return this.hydrate(JSON.parse(row.data) as TicketRecord, details);
  }
  has(id: string) {
    return !!this.db.prepare("SELECT 1 FROM tickets WHERE id=?").get(id);
  }
  save(record: TicketRecord, type: string, data: unknown = {}) {
    record.updatedAt = now();
    const compact = {
      ...record,
      attempts: record.attempts.map((a) => {
        const snapshot = a.snapshot;
        if (!snapshot || snapshot.detailsOmitted) return a;
        if (
          !this.db
            .prepare("SELECT 1 FROM snapshots WHERE digest=?")
            .get(snapshot.digest)
        )
          this.db
            .prepare("INSERT INTO snapshots VALUES (?,?)")
            .run(snapshot.digest, JSON.stringify(snapshot));
        return {
          ...a,
          snapshot: {
            ...snapshot,
            files: [],
            diff: "",
            indexDiff: undefined,
            detailsOmitted: true,
          },
        };
      }),
    };
    this.db
      .prepare(
        "INSERT INTO tickets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.ticket.ticketId, JSON.stringify(compact));
    this.event(record.ticket.ticketId, type, data);
  }
  revision(record: TicketRecord) {
    const old = this.db
      .prepare("SELECT data FROM revisions WHERE id=? AND revision=?")
      .get(record.ticket.ticketId, record.ticket.revision) as
      | { data: string }
      | undefined;
    const serialized = canonical(record.ticket);
    ensure(
      !old || old.data === serialized,
      "revision_conflict",
      "A ticket revision is immutable",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO revisions VALUES (?,?,?)")
      .run(record.ticket.ticketId, record.ticket.revision, serialized);
  }
  update<T>(id: string, type: string, fn: (record: TicketRecord) => T): T {
    return this.transaction(() => {
      const r = this.get(id, false);
      const result = fn(r);
      this.save(r, type);
      return result;
    });
  }
  event(ticketId: string, type: string, data: unknown) {
    const result = this.db
      .prepare("INSERT INTO journal(time,ticket_id,type,data) VALUES(?,?,?,?)")
      .run(now(), ticketId, type, JSON.stringify(data));
    return Number(result.lastInsertRowid);
  }
  trajectoryEvents(after: number, limit: number, ticketId: string) {
    return this.events(after, limit, ticketId, true);
  }
  controlEvents(
    after: number,
    limit: number,
    ticketId: string,
  ): JournalEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, time, ticket_id AS ticketId, type, data FROM journal WHERE seq>? AND ticket_id=? AND type!='harness.notification' AND type NOT LIKE '%.processes' ORDER BY seq LIMIT ?",
      )
      .all(after, ticketId, limit) as {
      seq: number;
      time: string;
      ticketId: string;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  events(
    after = 0,
    limit = 200,
    ticketId?: string,
    visible = false,
  ): JournalEvent[] {
    const rows = (
      ticketId
        ? this.db
            .prepare(
              `SELECT * FROM journal WHERE seq>? AND ticket_id=? ${visible ? "AND type NOT LIKE '%.processes'" : ""} ORDER BY seq LIMIT ?`,
            )
            .all(after, ticketId, limit)
        : this.db
            .prepare("SELECT * FROM journal WHERE seq>? ORDER BY seq LIMIT ?")
            .all(after, limit)
    ) as {
      seq: number;
      time: string;
      ticket_id: string;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      time: r.time,
      ticketId: r.ticket_id,
      type: r.type,
      data: JSON.parse(r.data),
    }));
  }
  close() {
    this.db.close();
  }
}

// Pure transport projection, separate from Store.update's raw legacy reads.
export function compactRecord(record: TicketRecord): TicketRecord {
  return {
    ...record,
    attempts: record.attempts.map((a) =>
      a.snapshot
        ? {
            ...a,
            snapshot: {
              ...a.snapshot,
              files: [],
              diff: "",
              indexDiff: undefined,
              detailsOmitted: true,
            },
          }
        : a,
    ),
  };
}
