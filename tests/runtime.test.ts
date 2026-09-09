import { afterEach, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Controller } from "../packages/core/src/controller.js";
import { SdkRuntime } from "../packages/runtime/src/adapter.js";
import { marked, cleanEnv } from "../packages/shared/src/process.js";
import { fixture } from "./helpers.js";
const controllers: Controller[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});
function setup() {
  const f = fixture();
  const c = new Controller({
    home: f.home,
    runtime: new SdkRuntime(resolve("dist/runner.js")),
    dispatchEnabled: true,
    dshBin: resolve("tests/fixtures/runtime.mjs"),
  });
  controllers.push(c);
  return { ...f, c };
}
it("identifies the actual isolated SDK workspace in the assignment without touching primary edits", async () => {
  const s = setup();
  writeFileSync(join(s.repo, "source.txt"), "preserve primary edits\n");
  s.c.prepare({ ...s.ticket, context: "FIXTURE_EXPECT_WORKSPACE" });
  s.c.run(s.ticket.ticketId);
  const result = await s.c.wait(s.ticket.ticketId);
  expect(result.state, result.error).toBe("awaiting_review");
  expect(readFileSync(join(result.worktree, "source.txt"), "utf8")).toBe(
    "implemented\n",
  );
  expect(readFileSync(join(s.repo, "source.txt"), "utf8")).toBe(
    "preserve primary edits\n",
  );
}, 20000);
it.each([undefined, "deepseek-v4-flash"])(
  "runs the public SDK subprocess with the default or explicit model (%s) and persists raw events",
  async (model) => {
    const s = setup();
    s.c.prepare({
      ...s.ticket,
      context: `FIXTURE_EXPECT_MODEL=${model ?? "deepseek-v4-pro"}`,
      execution: { ...s.ticket.execution, model },
    });
    s.c.run(s.ticket.ticketId);
    const t = await s.c.wait(s.ticket.ticketId);
    expect(t.state, t.error).toBe("awaiting_review");
    expect(t.attempts[0]?.receipt).toBe(true);
    expect(t.attempts[0]?.cleanExit).toBe(true);
    expect(marked(t.attempts[0]!.marker)).toHaveLength(0);
    const events = readFileSync(
      join(s.home, "runs", t.attempts[0]!.id, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("agent/inbox/spliced");
    expect(events).toContain("turn/end");
  },
  20000,
);
it("cancels the owned runtime and detached descendants without a cancel RPC", async () => {
  const s = setup();
  s.ticket.context = "FIXTURE_HANG";
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = s.c.status(s.ticket.ticketId).attempts[0]!;
    if (existsSync(join(s.home, "runs", a.id, "events.jsonl"))) break;
  }
  const t = await s.c.cancel(s.ticket.ticketId);
  expect(t.state).toBe("interrupted");
  expect(t.attempts[0]?.termination).toBe("cancelled");
  expect(marked(t.attempts[0]!.marker)).toHaveLength(0);
}, 20000);
it("enforces an outer deadline on receipt-to-idle waiting", async () => {
  const s = setup();
  s.ticket.context = "FIXTURE_HANG";
  s.ticket.execution.timeoutSeconds = 1;
  s.c.prepare(s.ticket);
  s.c.run(s.ticket.ticketId);
  const t = await s.c.wait(s.ticket.ticketId);
  expect(t.state).toBe("interrupted");
  expect(t.attempts[0]?.termination).toBe("timeout");
  expect(marked(t.attempts[0]!.marker)).toHaveLength(0);
}, 20000);
it("uses an explicit scrubbed environment and rejects reserved config overrides", () => {
  process.env.DSH_HOME = "ambient-home";
  process.env.UNRELATED_SECRET = "secret";
  try {
    const env = cleanEnv([]);
    expect(env.DSH_HOME).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(() => cleanEnv(["NODE_OPTIONS"])).toThrow(/Reserved/);
  } finally {
    delete process.env.DSH_HOME;
    delete process.env.UNRELATED_SECRET;
  }
});
it("decodes verifier stdout and stderr independently across UTF-8 chunks", async () => {
  const { execute } = await import("../packages/shared/src/process.js");
  const { randomUUID } = await import("node:crypto");
  const s = fixture();
  const result = await execute(
    [
      process.execPath,
      "-e",
      `const b=Buffer.from('中文🙂');process.stdout.write(b.subarray(0,4));process.stderr.write('错误');setTimeout(()=>process.stdout.write(b.subarray(4)),80);`,
    ],
    s.repo,
    3,
    randomUUID(),
    () => {},
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).not.toContain("�");
  expect(result.output).toContain("文🙂");
  expect(result.output).toContain("错误");
});
