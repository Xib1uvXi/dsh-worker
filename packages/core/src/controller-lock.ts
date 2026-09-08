import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, identity } from "../../shared/src/process.js";
import { ensure } from "../../shared/src/util.js";

// A separate SQLite connection holds an OS-backed lock for the owner's lifetime.
// Never unlink this database: contenders must lock the same inode, including
// while replacing a dead owner's legacy process-identity marker.
export class ControllerLock {
  private readonly db: DatabaseSync;
  private readonly marker: string;
  constructor(home: string) {
    this.marker = join(home, "controller.lock");
    this.db = new DatabaseSync(join(home, "controller-ownership.sqlite"));
    try {
      try {
        this.db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      } catch (error) {
        ensure(
          (error as { errcode?: number }).errcode !== 5,
          "controller_running",
          "A controller already owns this home",
        );
        throw error;
      }
      if (existsSync(this.marker)) {
        const old = JSON.parse(readFileSync(this.marker, "utf8"));
        ensure(
          !alive(old),
          "controller_running",
          "A controller already owns this home",
        );
        unlinkSync(this.marker);
      }
      const own = identity(process.pid);
      ensure(own, "identity", "Cannot identify controller process");
      writeFileSync(this.marker, JSON.stringify(own), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    try {
      unlinkSync(this.marker);
    } finally {
      this.db.close();
    }
  }
}
