import { afterEach, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Controller } from "../packages/core/src/controller.js";
import { capture } from "../packages/core/src/git.js";
import { fixture, FakeRuntime } from "./helpers.js";
import { delivery } from "./helpers.js";
import { workflow } from "../packages/runtime/src/policy.js";
import { startHttp } from "../packages/server/src/http.js";
const controllers: Controller[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});
function setup() {
  const f = fixture();
  const runtime = new FakeRuntime();
  const c = new Controller({
    home: f.home,
    runtime,
    dispatchEnabled: true,
    capacity: 2,
  });
  controllers.push(c);
  return { ...f, c, runtime };
}
it("allows two independent attempts, rejects capacity overflow, preserves both completions", async () => {
  const s = setup();
  const releases: (() => void)[] = [];
  s.runtime.handler = () =>
    new Promise((resolve) => releases.push(() => resolve({})));
  for (const id of ["A", "B", "C"]) s.c.prepare({ ...s.ticket, ticketId: id });
  s.c.run("A");
  s.c.run("B");
  expect(() => s.c.run("C")).toThrow(/capacity/);
  await expect.poll(() => releases.length).toBe(2);
  for (const release of releases) release();
  await Promise.all([s.c.wait("A"), s.c.wait("B")]);
  expect(s.c.status("A").state).toBe("awaiting_review");
  expect(s.c.status("B").state).toBe("awaiting_review");
  expect(s.runtime.count).toBe(2);
});
it("rejects a delivery bound to an earlier attempt even with completed and idle", async () => {
  const s = setup();
  s.runtime.handler = async (request) => ({
    finalResponse: JSON.stringify({
      ...delivery(request),
      attemptId: "wrong-attempt",
    }),
  });
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  expect((await s.c.wait(s.ticket.ticketId)).state).toBe("interrupted");
});
it("releases recovery capacity when malformed delivery already exited cleanly", async () => {
  const s = setup();
  s.runtime.handler = async () => ({ finalResponse: "No structured delivery" });
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const failed = await s.c.wait(s.ticket.ticketId);
  expect(failed.state).toBe("interrupted");
  expect(failed.attempts[0]!.cleanExit).toBe(true);
  await s.c.recover({
    ticketId: s.ticket.ticketId,
    revision: 1,
    attemptId: failed.attempts[0]!.id,
    snapshotDigest: failed.currentSnapshot,
    instruction: "Return the required structured delivery",
  });
  expect(s.c.overview().active).toBe(0);
  s.runtime.handler = undefined;
  s.c.run(s.ticket.ticketId);
  expect((await s.c.wait(s.ticket.ticketId)).state).toBe("awaiting_review");
  expect(s.c.overview().active).toBe(0);
});
it("includes staged index-only content and unusual filenames in snapshot identity", () => {
  const s = setup();
  s.ticket.scope.paths = ["."];
  const t = s.c.prepare(s.ticket);
  const before = capture(t);
  writeFileSync(join(t.worktree, "source.txt"), "staged");
  execFileSync("git", ["-C", t.worktree, "add", "source.txt"]);
  writeFileSync(join(t.worktree, "source.txt"), "baseline\n");
  const after = capture(t);
  expect(after.files).toEqual(before.files);
  expect(after.indexHash).not.toBe(before.indexHash);
  expect(after.digest).not.toBe(before.digest);
  writeFileSync(join(t.worktree, "unicode\t文\n.txt"), "untracked");
  expect(capture(t).files.some((f) => f.path === "unicode\t文\n.txt")).toBe(
    true,
  );
});
it.each(["rename", "copy", "unmerged", "binary"])(
  "preserves exact Git patch evidence for %s changes",
  (kind) => {
    const s = setup();
    s.ticket.scope.paths = ["."];
    const t = s.c.prepare(s.ticket);
    const git = (args: string[], input?: string) =>
      execFileSync(
        "git",
        ["-C", t.worktree, "-c", "core.quotePath=false", ...args],
        { input },
      );
    const unusual = "colon:\t文\n.txt";
    if (kind === "rename") git(["mv", "source.txt", unusual]);
    else if (kind === "copy") {
      git(["config", "diff.renames", "copies"]);
      writeFileSync(join(t.worktree, unusual), "baseline\n");
      writeFileSync(join(t.worktree, "source.txt"), "changed\n");
      git(["add", "."]);
    } else if (kind === "unmerged") {
      const stages = ["baseline\n", "ours\n", "theirs\n"].map((value) =>
        git(["hash-object", "-w", "--stdin"], value).toString().trim(),
      );
      git(
        ["update-index", "--index-info"],
        stages.map((oid, i) => `100644 ${oid} ${i + 1}\tsource.txt\n`).join(""),
      );
      writeFileSync(join(t.worktree, "source.txt"), "conflict\n");
    } else {
      writeFileSync(join(t.worktree, "source.txt"), Buffer.from([0, 255, 10]));
      git(["add", "."]);
      writeFileSync(join(t.worktree, "source.txt"), Buffer.from([0, 255, 20]));
    }
    const snapshot = capture(t);
    for (const cached of [false, true]) {
      const flags = cached ? ["--cached"] : [];
      const patch = git([
        "diff",
        ...flags,
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        t.ticket.baseCommit,
        "--",
      ]).toString();
      expect(cached ? snapshot.indexDiff : snapshot.diff).toBe(patch);
      const names = git([
        "diff",
        ...flags,
        "--name-only",
        "-z",
        t.ticket.baseCommit,
      ])
        .toString()
        .split("\0")
        .filter(Boolean);
      for (const path of names) expect(snapshot.changedPaths).toContain(path);
    }
    expect(snapshot.violations).toEqual([]);
  },
);
it("does not read content outside the checkout through a symlink", () => {
  const s = setup();
  s.ticket.scope.paths = ["."];
  const t = s.c.prepare(s.ticket);
  symlinkSync("/etc/passwd", join(t.worktree, "link"));
  const snapshot = capture(t);
  expect(snapshot.files.find((f) => f.path === "link")?.target).toBe(
    "/etc/passwd",
  );
  expect(snapshot.violations).toContain("Symlink escapes worktree: link");
});
it("requires actual passing verification rather than a worker test claim", async () => {
  const s = setup();
  s.ticket.verification = [
    {
      args: [process.execPath, "-e", "process.exit(7)"],
      cwd: ".",
      timeoutSeconds: 3,
    },
  ];
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  await s.c.wait(s.ticket.ticketId);
  s.c.verify(s.ticket.ticketId);
  const t = await s.c.wait(s.ticket.ticketId);
  expect(t.verifications[0]?.passed).toBe(false);
  expect(t.verifications[0]?.commands[0]?.exitCode).toBe(7);
});
it("refuses overlapping verification, revision changes, and process cancellation releases reservation", async () => {
  const s = setup();
  s.ticket.verification = [
    {
      args: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: ".",
      timeoutSeconds: 5,
    },
  ];
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  await s.c.wait(s.ticket.ticketId);
  s.c.verify(s.ticket.ticketId);
  expect(() => s.c.verify(s.ticket.ticketId)).toThrow(/active/);
  expect(() => s.c.prepare({ ...s.ticket, revision: 2 })).toThrow(/active/);
  const t = await s.c.cancel(s.ticket.ticketId);
  expect(t.activeOperation).toBeUndefined();
  expect(t.verifications[0]?.passed).toBe(false);
});
it("returns only hash-verified immutable artifact bytes", async () => {
  const s = setup();
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const t = await s.c.wait(s.ticket.ticketId);
  const file = t.attempts[0]!.snapshot!.files.find(
    (f) => f.path === "source.txt",
  )!;
  const http = await startHttp(s.c, {
    port: 0,
    token: "c".repeat(64),
    webDir: resolve("dist/web"),
  });
  const headers = { Authorization: `Bearer ${"c".repeat(64)}` };
  try {
    let r = await fetch(http.url + `/api/artifacts/${file.hash}`, { headers });
    expect(await r.text()).toBe("implemented\n");
    writeFileSync(join(s.c.home, "artifacts", "blobs", file.hash!), "tampered");
    r = await fetch(http.url + `/api/artifacts/${file.hash}`, { headers });
    expect(r.status).toBe(400);
  } finally {
    await http.close();
  }
});
it("keeps workflow opt-in and rejects an explicitly missing configuration", () => {
  const s = setup();
  expect(workflow(s.home).context).toBe("");
  const old = process.env.DSH_WORKER_WORKFLOW;
  process.env.DSH_WORKER_WORKFLOW = join(s.home, "missing.json");
  try {
    expect(() => s.c.prepare(s.ticket)).toThrow(/missing/);
    expect(s.c.store.list()).toHaveLength(0);
  } finally {
    if (old === undefined) delete process.env.DSH_WORKER_WORKFLOW;
    else process.env.DSH_WORKER_WORKFLOW = old;
  }
});
it("detects and exposes an out-of-scope index-only change", () => {
  const s = setup();
  s.ticket.scope.paths = ["new.txt"];
  const t = s.c.prepare(s.ticket);
  writeFileSync(join(t.worktree, "source.txt"), "hidden staged content");
  execFileSync("git", ["-C", t.worktree, "add", "source.txt"]);
  writeFileSync(join(t.worktree, "source.txt"), "baseline\n");
  const snapshot = capture(t);
  expect(snapshot.violations).toContain("Out of scope: source.txt");
  expect(snapshot.indexDiff).toContain("hidden staged content");
});
it("recovers interrupted verification to the unchanged delivery without another model attempt", async () => {
  const s = setup();
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const delivered = await s.c.wait(s.ticket.ticketId);
  s.c.store.update(s.ticket.ticketId, "synthetic.verifier-crash", (r) => {
    r.activeOperation = "verify-crash";
    r.verifications.push({
      id: "verify-crash",
      attemptId: delivered.attempts[0]!.id,
      revision: 1,
      startedAt: new Date().toISOString(),
      before: delivered.currentSnapshot!,
      passed: false,
      cleanExit: false,
      processes: [],
      marker: delivered.attempts[0]!.marker,
      commands: [],
    });
  });
  await s.c.close();
  controllers.splice(controllers.indexOf(s.c), 1);
  const reopened = new Controller({
    home: s.home,
    runtime: s.runtime,
    dispatchEnabled: true,
  });
  controllers.push(reopened);
  expect(reopened.status(s.ticket.ticketId).interruptedOperation).toBe(
    "verification",
  );
  const info = reopened.recovery(s.ticket.ticketId);
  const recovered = await reopened.recover({
    ticketId: s.ticket.ticketId,
    revision: 1,
    attemptId: delivered.attempts[0]!.id,
    snapshotDigest: info.snapshotDigest,
    instruction: "Rerun verification",
  });
  expect(recovered.state).toBe("awaiting_review");
  expect(recovered.verifications[0]?.passed).toBe(false);
  reopened.verify(s.ticket.ticketId);
  expect(
    (await reopened.wait(s.ticket.ticketId)).verifications.at(-1)?.passed,
  ).toBe(true);
  expect(s.runtime.count).toBe(1);
});
it("keeps snapshot details out of ticket rewrites and summary polling while retaining exact evidence", async () => {
  const s = setup();
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const full = await s.c.wait(s.ticket.ticketId);
  const row = s.c.store.db.prepare("SELECT data FROM tickets").get() as {
    data: string;
  };
  expect(JSON.parse(row.data).attempts[0].snapshot.detailsOmitted).toBe(true);
  expect(JSON.parse(row.data).attempts[0].snapshot.files).toEqual([]);
  expect(s.c.store.get(s.ticket.ticketId).attempts[0]?.snapshot).toEqual(
    full.attempts[0]?.snapshot,
  );
  const before = s.c.store.events().length;
  const compact = await s.c.pollStatus(s.ticket.ticketId);
  expect(compact.attempts[0]?.snapshot?.files).toEqual([]);
  expect(compact.currentSnapshot).toBe(full.currentSnapshot);
  expect(s.c.store.events().length).toBe(before);
});
it("compacts legacy inline snapshots without losing evidence on the next state write", async () => {
  const s = setup();
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const full = await s.c.wait(s.ticket.ticketId);
  s.c.store.db
    .prepare("UPDATE tickets SET data=? WHERE id=?")
    .run(JSON.stringify(full), s.ticket.ticketId);
  s.c.store.db.exec("DELETE FROM snapshots");
  expect(
    (await s.c.pollStatus(s.ticket.ticketId)).attempts[0]?.snapshot?.files,
  ).toEqual([]);
  expect(s.c.store.get(s.ticket.ticketId).attempts[0]?.snapshot).toEqual(
    full.attempts[0]?.snapshot,
  );
  s.c.store.update(s.ticket.ticketId, "ticket.archived", (r) => {
    r.archived = true;
  });
  expect(s.c.store.get(s.ticket.ticketId).attempts[0]?.snapshot).toEqual(
    full.attempts[0]?.snapshot,
  );
});
