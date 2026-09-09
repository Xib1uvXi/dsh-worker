import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { capture } from "../packages/core/src/git.js";
import { fixture, FakeRuntime } from "./helpers.js";
const controllers: Controller[] = [];
it.each(["clean", "process"])(
  "snapshot polling never executes a configured %s filter",
  (kind) => {
    const s = setup();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", s.repo, ...args], { encoding: "utf8" });
    writeFileSync(join(s.repo, ".gitattributes"), "source.txt filter=probe\n");
    git("add", ".gitattributes");
    git("commit", "-m", "filter attribute");
    s.ticket.baseCommit = git("rev-parse", "HEAD").trim();
    const prepared = s.c.prepare(s.ticket);
    const counter = join(s.root, "filter-called");
    const program = join(s.root, "filter.sh");
    writeFileSync(
      program,
      `printf called >> '${counter}'\n${kind === "clean" ? "cat" : "exit 1"}\n`,
    );
    git("config", `filter.probe.${kind}`, `sh '${program}'`);
    git("config", "filter.probe.required", "true");
    writeFileSync(join(prepared.worktree, "source.txt"), "edited\n");
    const before = s.c.store.events(0, 1000);
    s.c.status(s.ticket.ticketId);
    const snapshot = capture(prepared);
    expect(snapshot.changedPaths).toContain("source.txt");
    expect(snapshot.diff).toContain("+edited");
    expect(existsSync(counter)).toBe(false);
    expect(s.c.store.events(0, 1000)).toEqual(before);
  },
);
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
  it("releases capacity when a runtime throws before returning a promise", async () => {
    const s = setup();
    s.runtime.execute = () => {
      throw new Error("synchronous admission failure");
    };
    s.c.prepare(s.ticket);
    s.c.run(s.ticket.ticketId);
    const t = await s.c.wait(s.ticket.ticketId);
    expect(t.state).toBe("interrupted");
    expect(s.c.recovery(s.ticket.ticketId).canRecover).toBe(true);
  });
  it("refuses acceptance after a newer verification fails on unchanged content", async () => {
    const s = setup();
    const gate = join(s.root, "verification-gate");
    writeFileSync(gate, "pass");
    s.ticket.verification = [
      {
        args: [
          process.execPath,
          "-e",
          `process.exit(require('fs').readFileSync(${JSON.stringify(gate)}, 'utf8') === 'pass' ? 0 : 1)`,
        ],
        cwd: ".",
        timeoutSeconds: 5,
      },
    ];
    await submit(s);
    s.c.verify(s.ticket.ticketId);
    let t = await s.c.wait(s.ticket.ticketId);
    expect(t.verifications.at(-1)?.passed).toBe(true);
    writeFileSync(gate, "fail");
    s.c.verify(s.ticket.ticketId);
    t = await s.c.wait(s.ticket.ticketId);
    expect(t.verifications.at(-1)?.passed).toBe(false);
    expect(() => s.c.review(review(t))).toThrow(/verification/);
    writeFileSync(gate, "pass");
    s.c.verify(s.ticket.ticketId);
    t = await s.c.wait(s.ticket.ticketId);
    expect(s.c.review(review(t)).state).toBe("accepted");
  });
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
    await expect
      .poll(() => typeof release, { timeout: 10000 })
      .toBe("function");
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

it.each(["assume-unchanged", "skip-worktree", "filemode"])(
  "blocks an out-of-scope change hidden by Git %s",
  async (mode) => {
    const f = fixture();
    writeFileSync(join(f.repo, "protected.txt"), "protected baseline\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" });
    git("add", ".");
    git("commit", "-m", "protected baseline");
    f.ticket.baseCommit = git("rev-parse", "HEAD").trim();
    const runtime = new FakeRuntime();
    runtime.handler = async (request) => {
      if (mode === "filemode") {
        execFileSync("git", [
          "-C",
          request.worktree,
          "config",
          "core.fileMode",
          "false",
        ]);
        chmodSync(join(request.worktree, "protected.txt"), 0o755);
      } else {
        execFileSync("git", [
          "-C",
          request.worktree,
          "update-index",
          "--" + mode,
          "protected.txt",
        ]);
        writeFileSync(
          join(request.worktree, "protected.txt"),
          "hidden change\n",
        );
      }
      return {};
    };
    const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
    controllers.push(c);
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    const t = await c.wait(f.ticket.ticketId);
    const snapshot = t.attempts[0]!.snapshot!;
    expect(snapshot.changedPaths).toContain("protected.txt");
    expect(snapshot.violations).toContain("Out of scope: protected.txt");
    expect(t.state).toBe("blocked");
    expect(() => c.verify(f.ticket.ticketId)).toThrow();
    const protectedFile = snapshot.files.find(
      (file) => file.path === "protected.txt",
    )!;
    expect(
      readFileSync(
        join(f.home, "artifacts", "blobs", protectedFile.hash!),
        "utf8",
      ),
    ).toBe(mode === "filemode" ? "protected baseline\n" : "hidden change\n");
  },
);

it.each([
  "crlf",
  "crlf-to-lf",
  "smudge",
  "edited-attributes",
  "smudge-config",
  "smudge-program",
])(
  "accepts a clean %s checkout but blocks hidden edits to its converted file",
  async (conversion) => {
    const f = fixture();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" });
    const filtered = !conversion.startsWith("crlf");
    const smudgeProgram = join(f.root, "smudge.sh");
    writeFileSync(
      join(f.repo, ".gitattributes"),
      filtered
        ? "protected.txt filter=fixture\n"
        : "protected.txt text eol=crlf\n",
    );
    writeFileSync(join(f.repo, "protected.txt"), "base\n");
    if (filtered) {
      writeFileSync(smudgeProgram, "sed s/base/checked-out/g\n");
      git(
        "config",
        "filter.fixture.smudge",
        conversion === "smudge-program"
          ? `sh '${smudgeProgram}'`
          : "sed s/base/checked-out/g",
      );
      // A clean filter that erases differences must not suppress scope checks.
      git("config", "filter.fixture.clean", "printf 'base\\n'");
      git("config", "filter.spoof.smudge", "printf 'hidden change\\n'");
      git("config", "filter.spoof.clean", "printf 'base\\n'");
    }
    git("add", ".");
    git("commit", "-m", "checkout conversion");
    f.ticket.baseCommit = git("rev-parse", "HEAD").trim();
    f.ticket.scope.paths.push(".gitattributes");
    const runtime = new FakeRuntime();
    runtime.handler = async (request) => {
      execFileSync("git", [
        "-C",
        request.worktree,
        "update-index",
        "--assume-unchanged",
        "protected.txt",
      ]);
      if (conversion === "smudge-config")
        execFileSync("git", [
          "-C",
          request.worktree,
          "config",
          "filter.fixture.smudge",
          "printf 'hidden change\\n'",
        ]);
      if (conversion === "smudge-program")
        writeFileSync(
          smudgeProgram,
          "cat >/dev/null; printf 'hidden change\\n'\n",
        );
      if (conversion === "edited-attributes")
        writeFileSync(
          join(request.worktree, ".gitattributes"),
          "protected.txt filter=spoof\n",
        );
      writeFileSync(
        join(request.worktree, "protected.txt"),
        conversion === "crlf-to-lf" ? "base\n" : "hidden change\n",
      );
      return {};
    };
    const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
    controllers.push(c);
    const prepared = c.prepare(f.ticket);
    expect(prepared.state).toBe("ready");
    expect(
      execFileSync("git", ["-C", prepared.worktree, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
    expect(readFileSync(join(prepared.worktree, "protected.txt"), "utf8")).toBe(
      filtered ? "checked-out\n" : "base\r\n",
    );
    c.run(f.ticket.ticketId);
    const t = await c.wait(f.ticket.ticketId);
    expect(t.state).toBe("blocked");
    expect(t.attempts[0]!.snapshot!.violations).toContain(
      "Out of scope: protected.txt",
    );
    if (conversion === "smudge-config") {
      const reference = t.checkoutBaseline!;
      await c.close();
      controllers.splice(controllers.indexOf(c), 1);
      const reopened = new Controller({ home: f.home, runtime });
      controllers.push(reopened);
      const persisted = reopened.store.get(f.ticket.ticketId);
      expect(persisted.checkoutBaseline).toEqual(reference);
      const cache = new Map();
      expect(capture(persisted, undefined, cache).violations).toContain(
        "Out of scope: protected.txt",
      );
      expect(capture(persisted, undefined, cache).violations).toContain(
        "Out of scope: protected.txt",
      );
      writeFileSync(reference.path, "{}");
      expect(() => capture(persisted)).toThrow(/baseline evidence changed/);
    }
  },
);
