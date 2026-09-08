import { expect, it } from "vitest";
import { resolve } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { SdkRuntime } from "../packages/runtime/src/adapter.js";
import { trajectory } from "../packages/server/src/trajectory.js";
import { fixture, FakeRuntime } from "./helpers.js";
import { startHttp } from "../packages/server/src/http.js";

it("queues instructions durably, rejects identity conflicts and archived dispatch, and preserves revisions", async () => {
  const f = fixture();
  const runtime = new FakeRuntime();
  let c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  const command = {
    action: "instruct" as const,
    ticketId: f.ticket.ticketId,
    revision: 1,
    instructionId: "instruction-1",
    instruction: "Preserve the baseline newline.",
  };
  try {
    c.prepare(f.ticket);
    await c.action(command);
    await c.action(command);
    expect(c.status(f.ticket.ticketId).instructions).toHaveLength(1);
    await expect(
      c.action({ ...command, instruction: "different" }),
    ).rejects.toThrow(/identity/);
    await c.close();
    c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
    await c.action({
      action: "archive",
      ticketId: f.ticket.ticketId,
      archived: true,
    });
    expect(() => c.run(f.ticket.ticketId)).toThrow(/Restore/);
    await c.action({
      action: "archive",
      ticketId: f.ticket.ticketId,
      archived: false,
    });
    runtime.handler = async (req) => {
      expect(req.prompt).toContain(command.instruction);
      return {};
    };
    c.run(f.ticket.ticketId);
    await c.wait(f.ticket.ticketId);
    expect(c.status(f.ticket.ticketId).instructions?.[0]?.status).toBe(
      "received",
    );
    c.prepare({ ...f.ticket, revision: 2, title: "Updated task" });
    await expect(
      c.action({ ...command, instructionId: "new-id" }),
    ).rejects.toThrow(/revision/);
    expect(c.status(f.ticket.ticketId).attempts).toHaveLength(1);
  } finally {
    await c.close();
  }
});

it("uses the actual SDK prompt API for live instructions, pairs tool events, and replays trajectory after restart", async () => {
  const f = fixture();
  let c = new Controller({
    home: f.home,
    runtime: new SdkRuntime(resolve("dist/runner.js")),
    dispatchEnabled: true,
    dshBin: resolve("tests/fixtures/steering.mjs"),
  });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    await expect
      .poll(() => c.status(f.ticket.ticketId).attempts[0]?.receipt, {
        timeout: 8000,
      })
      .toBe(true);
    const live = trajectory(c.store, f.ticket.ticketId, 0);
    expect(live.agents[0]?.status).toBe("running");
    expect(live.agents[0]?.action).toContain("read_file");
    const command = {
      action: "instruct" as const,
      ticketId: f.ticket.ticketId,
      revision: 1,
      instructionId: "live-1",
      instruction: "Now finish the change.",
    };
    const sent = await c.action(command);
    expect(sent.instructions?.[0]?.messageId).toBe("message-2");
    expect(sent.instructions?.[0]?.status).toBe("received");
    await c.action(command);
    const result = await c.wait(f.ticket.ticketId);
    expect(result.state, result.error).toBe("awaiting_review");
    const events = trajectory(c.store, f.ticket.ticketId, 0);
    expect(
      events.entries.filter((e) => e.callId === "read-1").map((e) => e.kind),
    ).toEqual(["tool/call", "tool/result"]);
    expect(events.agents[0]?.status).toBe("ended");
    await c.close();
    c = new Controller({ home: f.home, runtime: new FakeRuntime() });
    expect(trajectory(c.store, f.ticket.ticketId, 0)).toEqual(events);
  } finally {
    await c.close();
  }
}, 20000);

it("paginates authenticated trajectory without loss, preserves unknown events and source-qualified children", async () => {
  const f = fixture();
  const c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  c.prepare(f.ticket);
  c.run(f.ticket.ticketId);
  await c.wait(f.ticket.ticketId);
  const attempt = c.status(f.ticket.ticketId).attempts[0]!;
  const emit = (method: string, params: unknown) =>
    c.store.event(f.ticket.ticketId, "harness.notification", {
      method,
      params,
      attemptId: attempt.id,
    });
  emit("subagent.started", {
    parentSessionId: attempt.sessionId,
    childSessionId: "child",
  });
  for (let i = 0; i < 205; i++)
    emit("session.event", {
      sessionId: "child",
      event: { type: "future/event", data: { i } },
    });
  const http = await startHttp(c, {
    port: 0,
    token: "secret",
    webDir: resolve("dist/web"),
  });
  try {
    expect(
      (await fetch(`${http.url}/api/tickets/${f.ticket.ticketId}/trajectory`))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(
          `${http.url}/api/tickets/${f.ticket.ticketId}/trajectory?after=-1`,
          { headers: { Authorization: "Bearer secret" } },
        )
      ).status,
    ).toBe(400);
    let cursor = 0;
    const seqs: number[] = [];
    while (true) {
      const page = trajectory(c.store, f.ticket.ticketId, cursor);
      seqs.push(...page.entries.map((e) => e.seq));
      cursor = page.cursor;
      expect(
        page.agents.find((a) => a.sessionId === "child")?.parentSessionId,
      ).toBe(attempt.sessionId);
      if (!page.hasMore) break;
    }
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.length).toBe(
      c.store.trajectoryEvents(0, 1000, f.ticket.ticketId).length,
    );
  } finally {
    await http.close();
    await c.close();
  }
});

it("does not replay an uncertain live instruction, and fences a receipt interrupted by controller restart", async () => {
  const f = fixture();
  const fake = new FakeRuntime();
  let sends = 0;
  fake.handler = async (_req, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { termination: "cancelled" };
  };
  const runtime: import("../packages/runtime/src/adapter.js").RuntimeAdapter = {
    execute: async (req, dir, marker, signal, onMessage) => {
      onMessage({
        type: "notification",
        notification: {
          method: "session.event",
          params: {
            sessionId: req.sessionId,
            event: {
              type: "agent/inbox/spliced",
              data: { inserted: [] },
            } as never,
          },
        },
      });
      return fake.execute(req, dir, marker, signal);
    },
    instruct: async () => {
      sends++;
      throw new Error("Transport lost before receipt");
    },
  };
  let c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    const command = {
      action: "instruct" as const,
      ticketId: f.ticket.ticketId,
      revision: 1,
      instructionId: "uncertain-1",
      instruction: "Check the changed file.",
    };
    const result = await c.action(command);
    expect(result.instructions?.[0]?.status).toBe("uncertain");
    await c.action(command);
    expect(sends).toBe(1);
    await expect(
      c.action({
        action: "archive",
        ticketId: f.ticket.ticketId,
        archived: true,
      }),
    ).rejects.toThrow();
    await c.cancel(f.ticket.ticketId);
    c.store.update(f.ticket.ticketId, "fixture.crash", (r) => {
      r.activeOperation = "lost";
      r.state = "running";
      r.instructions![0]!.status = "sending";
    });
    await c.close();
    c = new Controller({ home: f.home, runtime });
    expect(c.status(f.ticket.ticketId).state).toBe("interrupted");
    expect(c.status(f.ticket.ticketId).instructions?.[0]?.status).toBe(
      "uncertain",
    );
    expect(sends).toBe(1);
  } finally {
    await c.close();
  }
});
