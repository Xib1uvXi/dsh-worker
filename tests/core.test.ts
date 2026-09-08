import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { capture } from "../packages/core/src/git.js";
import { ticketSchema } from "../packages/contracts/src/index.js";
import { fixture, FakeRuntime } from "./helpers.js";
const controllers: Controller[] = [];
function setup(enabled = true) {
  const f = fixture();
  const runtime = new FakeRuntime();
  const c = new Controller({ home: f.home, runtime, dispatchEnabled: enabled });
  controllers.push(c);
  return { ...f, c, runtime };
}
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});
async function submit(s: ReturnType<typeof setup>) {
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  return s.c.wait(s.ticket.ticketId);
}
function review(
  t: ReturnType<Controller["status"]>,
  verdict: "accept" | "request_changes" = "accept",
) {
  return {
    schemaVersion: 2,
    ticketId: t.ticket.ticketId,
    revision: t.ticket.revision,
    attemptId: t.attempts.at(-1)!.id,
    snapshotDigest: t.attempts.at(-1)!.snapshot!.digest,
    spec: { verdict: "pass", findings: [] },
    standards: { verdict: "pass", findings: [] },
    verdict,
    findings: verdict === "accept" ? [] : ["AC1 is incomplete; fix source.txt"],
    reviewer: "External orchestrator",
  };
}
describe("durable control contracts", () => {
  it("prepares isolated work and preserves dirty primary checkout", () => {
    const s = setup();
    writeFileSync(join(s.repo, "source.txt"), "personal");
    const t = s.c.prepare(s.ticket);
    expect(readFileSync(join(s.repo, "source.txt"), "utf8")).toBe("personal");
    expect(readFileSync(join(t.worktree, "source.txt"), "utf8")).toBe(
      "baseline\n",
    );
    expect(s.c.prepare(s.ticket).worktree).toBe(t.worktree);
  });
  it("rejects incomplete scope and path escapes before worktree creation", () => {
    const s = setup();
    expect(() =>
      s.c.prepare({ ...s.ticket, scope: { paths: ["../escape"] } }),
    ).toThrow();
    expect(s.c.store.list()).toHaveLength(0);
    expect(existsSync(join(s.home, "worktrees"))).toBe(false);
  });
  it("keeps revisions immutable and preserves history", () => {
    const s = setup();
    s.c.prepare(s.ticket);
    expect(() => s.c.prepare({ ...s.ticket, title: "mutated" })).toThrow(
      /revision/,
    );
    s.c.prepare({ ...s.ticket, revision: 2, title: "revised" });
    expect(s.c.store.db.prepare("SELECT * FROM revisions").all()).toHaveLength(
      2,
    );
    expect(() => s.c.prepare({ ...s.ticket, revision: 4 })).toThrow(
      /increment/,
    );
  });
  it("dispatch stays disabled during development", () => {
    const s = setup(false);
    s.c.prepare(s.ticket);
    expect(() => s.c.run(s.ticket.ticketId)).toThrow(/disabled/);
    expect(s.runtime.count).toBe(0);
  });
  it("serializes same ticket and allows independent tickets within capacity", async () => {
    const s = setup();
    let release!: () => void;
    s.runtime.handler = () =>
      new Promise((r) => {
        release = () => r({});
      });
    s.c.prepare(s.ticket);
    s.c.run(s.ticket.ticketId);
    expect(() => s.c.run(s.ticket.ticketId)).toThrow(/active/);
    expect(() => s.c.prepare({ ...s.ticket, revision: 2 })).toThrow(/active/);
    release();
    await s.c.wait(s.ticket.ticketId);
    expect(s.runtime.count).toBe(1);
  });
  it.each(["max-tokens", "error", "aborted", undefined])(
    "never promotes %s to awaiting_review",
    async (reason) => {
      const s = setup();
      s.runtime.handler = async () => ({ finishReason: reason });
      const t = await submit(s);
      expect(t.state).toBe("interrupted");
    },
  );
  it("requires receipt, valid bound delivery and clean exit", async () => {
    const s = setup();
    s.runtime.handler = async () => ({
      receipt: false,
      cleanExit: false,
      finalResponse: '{"outcome":"accepted"}',
    });
    const t = await submit(s);
    expect(t.state).toBe("interrupted");
    expect(t.activeOperation).toBeTruthy();
    expect(() => s.c.run(s.ticket.ticketId)).toThrow();
  });
  it("binds verification and review to the exact immutable snapshot", async () => {
    const s = setup();
    let t = await submit(s);
    expect(t.state).toBe("awaiting_review");
    expect(() => s.c.review(review(t))).toThrow(/verification/);
    s.c.verify(s.ticket.ticketId);
    t = await s.c.wait(s.ticket.ticketId);
    expect(t.verifications[0]?.passed).toBe(true);
    const accepted = s.c.review(review(t));
    expect(accepted.state).toBe("accepted");
    writeFileSync(join(t.worktree, "source.txt"), "later change");
    expect(s.c.status(s.ticket.ticketId).stale).toBe(true);
  });
  it("rejects stale review even when earlier verification passed", async () => {
    const s = setup();
    const t = await submit(s);
    s.c.verify(s.ticket.ticketId);
    await s.c.wait(s.ticket.ticketId);
    writeFileSync(join(t.worktree, "source.txt"), "tampered");
    expect(() => s.c.review(review(t))).toThrow(/stale/);
  });
  it("refuses verifier that changes delivered content", async () => {
    const s = setup();
    s.ticket.verification = [
      {
        args: [
          process.execPath,
          "-e",
          "require('fs').writeFileSync('source.txt','test mutation')",
        ],
        cwd: ".",
        timeoutSeconds: 5,
      },
    ];
    await submit(s);
    s.c.verify(s.ticket.ticketId);
    const t = await s.c.wait(s.ticket.ticketId);
    expect(t.verifications[0]?.passed).toBe(false);
    expect(t.state).toBe("blocked");
  });
  it("preserves submit, requested changes, new attempt and external acceptance", async () => {
    const s = setup();
    let t = await submit(s);
    s.c.review(review(t, "request_changes"));
    s.c.run(s.ticket.ticketId);
    t = await s.c.wait(s.ticket.ticketId);
    expect(t.attempts).toHaveLength(2);
    expect(t.attempts[0]?.id).not.toBe(t.attempts[1]?.id);
    s.c.verify(s.ticket.ticketId);
    t = await s.c.wait(s.ticket.ticketId);
    expect(s.c.review(review(t)).state).toBe("accepted");
    expect(
      s.c.store.events(0, 1000).some((e) => e.type === "review.recorded"),
    ).toBe(true);
  });
  it("blocks scope escape and records full binary/untracked/symlink evidence", async () => {
    const s = setup();
    s.runtime.handler = async (request) => {
      writeFileSync(
        join(request.worktree, "outside.bin"),
        Buffer.from([0, 1, 2]),
      );
      symlinkSync("source.txt", join(request.worktree, "link"));
      chmodSync(join(request.worktree, "source.txt"), 0o755);
      return {};
    };
    const t = await submit(s);
    expect(t.state).toBe("blocked");
    const snap = t.attempts[0]!.snapshot!;
    expect(snap.files.find((f) => f.path === "outside.bin")?.size).toBe(3);
    expect(snap.files.find((f) => f.path === "source.txt")?.mode).toBe(
      0o100755,
    );
    expect(snap.files.find((f) => f.path === "link")?.target).toBe(
      "source.txt",
    );
    expect(snap.violations).toContain("Out of scope: outside.bin");
  });
  it("recovery requires matching snapshot and never dispatches", async () => {
    const s = setup();
    s.runtime.handler = async () => ({ termination: "timeout" });
    let t = await submit(s);
    const info = s.c.recovery(s.ticket.ticketId);
    await expect(
      s.c.recover({
        ticketId: s.ticket.ticketId,
        revision: 1,
        attemptId: t.attempts[0]!.id,
        snapshotDigest: "0".repeat(64),
        instruction: "continue",
      }),
    ).rejects.toThrow(/stale/);
    t = await s.c.recover({
      ticketId: s.ticket.ticketId,
      revision: 1,
      attemptId: t.attempts[0]!.id,
      snapshotDigest: info.snapshotDigest,
      instruction: "Review current edits, then continue",
    });
    expect(t.state).toBe("ready");
    expect(s.runtime.count).toBe(1);
  });
  it("journals survive a real SQLite reopen and restart never replays", async () => {
    const s = setup();
    s.c.prepare(s.ticket);
    s.c.store.update(s.ticket.ticketId, "synthetic.crash", (r) => {
      r.activeOperation = "unknown";
      r.state = "running";
    });
    await s.c.close();
    controllers.splice(controllers.indexOf(s.c), 1);
    const reopened = new Controller({
      home: s.home,
      runtime: s.runtime,
      dispatchEnabled: true,
    });
    controllers.push(reopened);
    expect(reopened.status(s.ticket.ticketId).state).toBe("interrupted");
    expect(s.runtime.count).toBe(0);
    expect(reopened.store.events().at(-1)?.type).toBe("execution.interrupted");
  });
  it("detects index-only changes in snapshots", () => {
    const s = setup();
    const t = s.c.prepare(s.ticket);
    const before = capture(t);
    writeFileSync(join(t.worktree, "source.txt"), "different");
    expect(capture(t).digest).not.toBe(before.digest);
  });
});
