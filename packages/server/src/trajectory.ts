import type {
  AgentActivity,
  JournalEvent,
  TicketRecord,
  TrajectoryEntry,
  TrajectoryPage,
  EvidenceQuery,
} from "../../contracts/src/index.js";
import {
  evidenceQuerySchema,
  sessionStatsSchema,
} from "../../contracts/src/index.js";
import { ensure } from "../../shared/src/util.js";
import type { Store } from "../../core/src/store.js";

type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ObjectValue) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");
function printable(v: unknown): string {
  if (typeof v === "string") return v;
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}
function content(v: unknown): string {
  if (!Array.isArray(v)) return printable(v);
  return v
    .map((b) => {
      const block = obj(b);
      if (block.type === "reasoning") return ""; // Do not synthesize or expose hidden reasoning.
      return (
        str(block.text) ||
        (block.type === "tool-call"
          ? `${str(block.name)} ${printable(block.arguments)}`
          : `[${str(block.type)}]`)
      );
    })
    .filter(Boolean)
    .join("\n");
}
export function project(
  event: JournalEvent,
  record: TicketRecord,
): TrajectoryEntry {
  // Apply the observable-preview boundary before any text or raw serialization,
  // including native failed assistant attempts with embedded compact streams.
  const raw: unknown = JSON.parse(
    JSON.stringify(event.data, (key, value) => {
      if (key === "stream") return undefined;
      if (obj(value).type === "reasoning")
        return { type: "reasoning", text: "[omitted]" };
      return value;
    }),
  );
  const outer = obj(raw);
  const notification = obj(outer.notification ?? outer);
  const params = obj(notification.params);
  const native = obj(params.event);
  const data = obj(native.data);
  const message = obj(data.message);
  const blocks = Array.isArray(message.content) ? message.content.map(obj) : [];
  const toolResult = blocks.find((b) => b.type === "tool-result");
  const sessionId =
    str(params.sessionId) || str(params.childSessionId) || undefined;
  const attemptId =
    str(outer.attemptId) ||
    record.attempts.find((a) => a.sessionId === sessionId)?.id;
  const kind =
    event.type === "harness.notification"
      ? str(native.type) || str(notification.method)
      : event.type;
  let text = printable(native.data ?? raw);
  if (kind === "assistant/message") text = content(obj(data.message).content);
  if (kind === "user/message") text = content(data.content);
  if (kind === "tool/call") text = printable(data.arguments);
  if (kind === "tool/result")
    text = toolResult
      ? content(toolResult.content)
      : printable(data.result ?? data.output ?? data);
  return {
    seq: event.seq,
    time: event.time,
    attemptId,
    sessionId,
    kind,
    title:
      (toolResult?.isError === true ? "tool/error" : kind) +
      (kind.startsWith("tool/") && str(data.name)
        ? ` · ${str(data.name)}`
        : ""),
    text,
    callId:
      str(data.callId) ||
      str(toolResult?.toolCallId) ||
      str(obj(message.source).callId) ||
      undefined,
    raw,
  };
}
const caches = new WeakMap<
  Store,
  Map<string, { cursor: number; agents: Map<string, AgentActivity> }>
>();
export function trajectory(
  store: Store,
  id: string,
  after: number,
  activityOnly = false,
  query: EvidenceQuery = {},
): TrajectoryPage {
  const options = evidenceQuerySchema.parse({ ...query, after });
  const record = store.get(id, false);
  ensure(
    !options.attempt || record.attempts.some((a) => a.id === options.attempt),
    "attempt_not_found",
    "Attempt does not belong to this task",
  );
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  let state = cache.get(id);
  if (!state) {
    state = { cursor: 0, agents: new Map() };
    cache.set(id, state);
  }
  for (const a of record.attempts)
    if (!state.agents.has(a.sessionId))
      state.agents.set(a.sessionId, {
        sessionId: a.sessionId,
        attemptId: a.id,
        status: "unknown",
        action: "runtime/waiting",
        updatedAt: a.startedAt,
      });
  while (true) {
    const events = store.events(state.cursor, 500, id);
    for (const e of events) {
      state.cursor = e.seq;
      if (e.type !== "harness.notification") continue;
      const outer = obj(e.data);
      const n = obj(outer.notification ?? outer);
      const p = obj(n.params);
      const entry = project(e, record);
      if (n.method === "subagent.started") {
        const parent = state.agents.get(str(p.parentSessionId));
        if (parent)
          state.agents.set(str(p.childSessionId), {
            sessionId: str(p.childSessionId),
            parentSessionId: parent.sessionId,
            attemptId: parent.attemptId,
            status: "running",
            action: "subagent/started",
            updatedAt: e.time,
          });
      }
      const agent = state.agents.get(entry.sessionId ?? "");
      if (!agent) continue;
      if (entry.kind === "worker/stats") {
        const stats = sessionStatsSchema.safeParse(
          obj(obj(p.event).data).stats,
        );
        if (stats.success) agent.stats = stats.data;
      }
      agent.updatedAt = e.time;
      if (n.method === "session.status") {
        agent.status = p.status === "running" ? "running" : "idle";
        agent.action =
          p.status === "running" ? "runtime/running" : "runtime/idle";
      }
      if (n.method === "subagent.finished") {
        agent.status = "ended";
        agent.action = p.status === "ok" ? "subagent/ended" : "subagent/error";
      }
      if (["tool/call", "step/start", "turn/start"].includes(entry.kind)) {
        agent.status = "running";
        agent.action =
          entry.title +
          (entry.kind === "tool/call" ? ` · ${entry.text.slice(0, 180)}` : "");
      }
      if (entry.kind === "tool/result") agent.action = "tool/received";
      if (entry.kind === "assistant/message")
        agent.action = entry.text.slice(0, 180) || "assistant/replied";
    }
    if (events.length < 500) break;
  }
  const agents = [...state.agents.values()].map((a) => {
    const attempt = record.attempts.find((v) => v.id === a.attemptId)!;
    if (attempt.endedAt)
      return {
        ...a,
        updatedAt: attempt.endedAt,
        status: attempt.cleanExit
          ? ("ended" as const)
          : ("interrupted" as const),
        action: a.parentSessionId
          ? a.status === "ended"
            ? a.action
            : "runtime/closed"
          : attempt.error ||
            attempt.delivery?.summary ||
            attempt.termination ||
            "execution/ended",
      };
    if (record.state === "interrupted")
      return {
        ...a,
        status: "interrupted" as const,
        action: "runtime/interrupted",
      };
    return { ...a };
  });
  const rows = activityOnly
    ? []
    : store.trajectoryEvents(after, options.limit + 1, id);
  const page = rows.slice(0, options.limit);
  return {
    entries: page
      .map((e) => project(e, record))
      .filter(
        (e) =>
          (!options.attempt || e.attemptId === options.attempt) &&
          (!options.kind || e.kind === options.kind),
      ),
    agents: agents.filter(
      (a) => !options.attempt || a.attemptId === options.attempt,
    ),
    cursor: page.at(-1)?.seq ?? after,
    hasMore: rows.length > options.limit,
  };
}
