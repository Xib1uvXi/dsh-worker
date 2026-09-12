import { expect, it } from "vitest";
import { Controller } from "../packages/core/src/controller.js";
import { evidenceBrief } from "../packages/core/src/evidence.js";
import { fixture, delivery } from "./helpers.js";
import type { RuntimeAdapter } from "../packages/runtime/src/adapter.js";
import type { RunnerMessage } from "../packages/runtime/src/runner.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHttp } from "../packages/server/src/http.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { instructionText } from "../packages/core/src/attempt-feedback.js";

it("preserves a native error even when the runtime loses its final outcome", async () => {
  const f = fixture();
  const runtime: RuntimeAdapter = {
    async execute(request, _dir, _marker, _signal, notify) {
      notify({
        type: "notification",
        notification: {
          method: "session.event",
          params: {
            sessionId: request.sessionId,
            event: {
              type: "turn/end",
              data: {
                reason: {
                  kind: "error",
                  error: {
                    code: "TRANSPORT",
                    message: "Connection failed before runtime exit",
                  },
                },
              },
            },
          },
        },
      } as RunnerMessage);
      writeFileSync(join(request.worktree, "source.txt"), "partial work\n");
      return {
        receipt: true,
        cleanExit: true,
        termination: "error",
        error: "Runtime disconnected",
      };
    },
  };
  const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    const result = await c.wait(f.ticket.ticketId);
    expect(result.error).toBe(
      "TRANSPORT: Connection failed before runtime exit",
    );
    expect(result.attempts[0]?.failures?.execution).toBe(
      "Runtime disconnected",
    );
    expect(result.attempts[0]?.finishReason).toBe("error");
  } finally {
    await c.close();
  }
});

it("separates receipt and consumption, fences sessions, and handles consumption before IPC receipt", async () => {
  const f = fixture();
  let emit!: (type: string, data: unknown, session?: string) => void;
  let finish!: () => void;
  const runtime: RuntimeAdapter = {
    async execute(request, _dir, _marker, _signal, notify) {
      emit = (type, data, session = request.sessionId) =>
        notify({
          type: "notification",
          notification: {
            method: "session.event",
            params: { sessionId: session, event: { type, data } },
          },
        } as RunnerMessage);
      expect(Date.parse(request.deadlineAt!) - Date.now()).toBeGreaterThan(
        8000,
      );
      expect(request.prompt).toContain(request.deadlineAt);
      emit("agent/inbox/spliced", { inserted: [{ id: "initial" }] });
      emit("turn/start", { turn: 1 });
      emit("user/message", {
        id: "initial",
        content: [{ type: "text", text: request.prompt }],
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        receipt: true,
        finishReason: "completed",
        finalResponse: JSON.stringify(delivery(request)),
        cleanExit: true,
        termination: "completed",
      };
    },
    async instruct(_attempt, id, text) {
      if (id === "uncertain") throw new Error("IPC receipt unavailable");
      if (id === "race")
        emit("user/message", {
          id: "native-race",
          content: [{ type: "text", text }],
        });
      return id === "race" ? "native-race" : "native-live";
    },
  };
  let c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  const command = {
    action: "instruct" as const,
    ticketId: f.ticket.ticketId,
    revision: 1,
    instructionId: "queued",
    instruction: "Preserve evidence",
  };
  try {
    c.prepare(f.ticket);
    await c.action(command);
    c.run(f.ticket.ticketId);
    await expect.poll(() => !!finish, { timeout: 10000 }).toBe(true);
    expect(
      c.status(f.ticket.ticketId).instructions?.[0]?.consumption,
    ).toMatchObject({ messageId: "initial", turn: 1 });
    await c.action({ ...command, instructionId: "live" });
    const admitted = evidenceBrief(c.status(f.ticket.ticketId));
    expect(admitted.instructions[1]).toMatchObject({
      status: "received",
      messageId: "native-live",
      unconsumedSeconds: expect.any(Number),
    });
    // Snapshot inspection may take a full second under a loaded test host.
    expect(admitted.instructions[1]!.unconsumedSeconds).toBeGreaterThanOrEqual(
      0,
    );
    expect(admitted.instructions[1]?.consumption).toBeUndefined();
    expect(admitted.execution.remainingSeconds).toBeGreaterThan(0);
    emit("user/message", { id: "native-live" }, "unrelated-session");
    emit("user/message", {
      id: "different-native-message",
      content: [
        { type: "text", text: instructionText("live", command.instruction) },
      ],
    });
    expect(
      c.status(f.ticket.ticketId).instructions?.[1]?.consumption,
    ).toBeUndefined();
    emit("turn/start", { turn: 2 });
    emit("user/message", { id: "native-live" });
    await c.action({ ...command, instructionId: "race" });
    await c.action({ ...command, instructionId: "uncertain" });
    expect(c.status(f.ticket.ticketId).instructions?.[3]?.status).toBe(
      "uncertain",
    );
    emit("user/message", {
      id: "native-after-uncertain",
      content: [
        {
          type: "text",
          text: instructionText("uncertain", command.instruction),
        },
      ],
    });
    const consumed = c.status(f.ticket.ticketId).instructions!;
    expect(consumed[1]?.consumption).toMatchObject({
      messageId: "native-live",
      turn: 2,
    });
    expect(consumed[2]?.consumption).toMatchObject({
      messageId: "native-race",
      turn: 2,
    });
    expect(consumed[2]?.status).toBe("received");
    expect(consumed[3]).toMatchObject({
      status: "uncertain",
      consumption: { messageId: "native-after-uncertain", turn: 2 },
    });
    expect(consumed[3]?.messageId).toBeUndefined();
    const sequence = consumed[2]!.consumption!.eventSeq!;
    expect(c.store.events(sequence - 1, 1)[0]?.type).toBe(
      "harness.notification",
    );
    finish();
    await c.wait(f.ticket.ticketId);
    await c.close();
    c = new Controller({ home: f.home, runtime });
    expect(c.status(f.ticket.ticketId).instructions).toEqual(consumed);
    expect(
      evidenceBrief(c.status(f.ticket.ticketId)).execution.remainingSeconds,
    ).toBeNull();
  } finally {
    finish?.();
    await c.close();
  }
}, 20000);

it("rejects stale unconsumed cancellation decisions without interrupting execution", async () => {
  const f = fixture();
  let emit!: (id: string) => void;
  let aborted = false;
  const runtime: RuntimeAdapter = {
    async execute(request, _dir, _marker, signal, notify) {
      emit = (id) =>
        notify({
          type: "notification",
          notification: {
            method: "session.event",
            params: {
              sessionId: request.sessionId,
              event: { type: "user/message", data: { id } },
            },
          },
        } as RunnerMessage);
      notify({
        type: "notification",
        notification: {
          method: "session.event",
          params: {
            sessionId: request.sessionId,
            event: {
              type: "agent/inbox/spliced",
              data: { inserted: [{ id: "initial" }] },
            },
          },
        },
      } as RunnerMessage);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { receipt: true, cleanExit: true, termination: "cancelled" };
    },
    async instruct(_attempt, id) {
      if (id === "uncertain") throw new Error("Receipt unavailable");
      return `native-${id}`;
    },
  };
  const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  const http = await startHttp(c, {
    port: 0,
    token: "guard-test",
    webDir: resolve("dist/web"),
  });
  writeFileSync(
    join(f.home, "service.json"),
    JSON.stringify({ url: http.url, token: "guard-test" }),
  );
  try {
    c.prepare(f.ticket);
    c.run(f.ticket.ticketId);
    await expect.poll(() => !!emit, { timeout: 10000 }).toBe(true);
    for (const instructionId of [
      "consumed",
      "pending",
      "pending-two",
      "uncertain",
    ])
      await c.action({
        action: "instruct",
        ticketId: f.ticket.ticketId,
        revision: 1,
        instructionId,
        instruction: "Recheck the acceptance evidence",
      });
    const attemptId = c.status(f.ticket.ticketId).attempts.at(-1)!.id;
    const guard = { revision: 1, attemptId, instructionIds: ["consumed"] };
    // This is the recorded incident: consumption arrives after inspection but before cancellation.
    emit("native-consumed");
    const eventsBefore = c.store.events(0, 10000).length;
    for (const ifUnconsumed of [
      guard,
      { ...guard, instructionIds: ["pending", "consumed"] },
      { ...guard, instructionIds: ["missing"] },
      { ...guard, instructionIds: ["uncertain"] },
      { ...guard, instructionIds: ["pending"], revision: 2 },
      { ...guard, instructionIds: ["pending"], attemptId: "stale-attempt" },
    ]) {
      await expect(
        c.action({
          action: "cancel",
          ticketId: f.ticket.ticketId,
          ifUnconsumed,
        }),
      ).rejects.toMatchObject({ code: "cancellation_precondition_failed" });
      expect(aborted).toBe(false);
      expect(c.status(f.ticket.ticketId).state).toBe("running");
    }
    expect(c.store.events(0, 10000)).toHaveLength(eventsBefore);
    const conflict = await fetch(`${http.url}/api/actions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer guard-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "cancel",
        ticketId: f.ticket.ticketId,
        ifUnconsumed: guard,
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "cancellation_precondition_failed" },
    });
    const args = [
      resolve("dist/cli.js"),
      "cancel",
      f.ticket.ticketId,
      "--home",
      f.home,
      "--revision",
      "1",
      "--attempt",
      attemptId,
      "--if-unconsumed",
    ];
    await expect(
      promisify(execFile)(process.execPath, [...args, "consumed"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("cancellation_precondition_failed"),
    });
    expect(aborted).toBe(false);
    const ifUnconsumed = {
      ...guard,
      instructionIds: ["pending", "pending-two"],
    };
    const cancelled = await promisify(execFile)(process.execPath, [
      ...args,
      "pending",
      "--if-unconsumed",
      "pending-two",
    ]);
    expect(JSON.parse(cancelled.stdout).state).toBe("interrupted");
    expect(aborted).toBe(true);
    expect(
      c.store.events(0, 10000).find((e) => e.type === "cancellation.requested")
        ?.data,
    ).toMatchObject({ ifUnconsumed });
    await expect(
      c.cancel(f.ticket.ticketId, ifUnconsumed),
    ).rejects.toMatchObject({ code: "cancellation_precondition_failed" });
  } finally {
    await http.close();
    await c.close();
  }
}, 20000);
