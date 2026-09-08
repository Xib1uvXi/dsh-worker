import type {
  AgentActivity,
  JournalEvent,
  TicketRecord,
  TrajectoryEntry,
  TrajectoryPage,
} from "../../contracts/src/index.js";
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
const titles: Record<string, string> = {
  "turn/start": "开始执行轮次",
  "turn/end": "轮次结束",
  "step/start": "模型正在处理",
  "step/end": "模型步骤结束",
  "user/message": "用户 / 上下文消息",
  "assistant/message": "Agent 回复",
  "tool/call": "调用工具",
  "tool/result": "工具结果",
  "agent/inbox/spliced": "指令队列变更",
  "compaction/start": "压缩上下文",
  "compaction/end": "上下文压缩结束",
  "llm/retry": "模型请求重试",
  "llm/retry-started": "开始重试",
};
export function project(
  event: JournalEvent,
  record: TicketRecord,
): TrajectoryEntry {
  const outer = obj(event.data);
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
  let text = printable(native.data ?? event.data);
  if (kind === "assistant/message") text = content(obj(data.message).content);
  if (kind === "user/message") text = content(data.content);
  if (kind === "tool/call") text = printable(data.arguments);
  if (kind === "tool/result")
    text = toolResult
      ? content(toolResult.content)
      : printable(data.result ?? data.output ?? data);
  // Raw events are already durable locally; preview does not expose reasoning blocks.
  const raw = JSON.parse(
    JSON.stringify(event.data, (key, value) => {
      if (key === "stream") return undefined;
      if (obj(value).type === "reasoning")
        return { type: "reasoning", text: "[省略]" };
      return value;
    }),
  );
  return {
    seq: event.seq,
    time: event.time,
    attemptId,
    sessionId,
    kind,
    title:
      (toolResult?.isError === true ? "工具执行失败" : (titles[kind] ?? kind)) +
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
): TrajectoryPage {
  const record = store.get(id);
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
        action: "等待运行时事件",
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
            action: "子 Agent 已启动",
            updatedAt: e.time,
          });
      }
      const agent = state.agents.get(entry.sessionId ?? "");
      if (!agent) continue;
      agent.updatedAt = e.time;
      if (n.method === "session.status") {
        agent.status = p.status === "running" ? "running" : "idle";
        agent.action = p.status === "running" ? "正在执行" : "等待后续指令";
      }
      if (n.method === "subagent.finished") {
        agent.status = "ended";
        agent.action =
          p.status === "ok" ? "子 Agent 已结束" : "子 Agent 执行失败";
      }
      if (["tool/call", "step/start", "turn/start"].includes(entry.kind)) {
        agent.status = "running";
        agent.action =
          entry.title +
          (entry.kind === "tool/call" ? ` · ${entry.text.slice(0, 180)}` : "");
      }
      if (entry.kind === "tool/result") agent.action = "已收到工具结果";
      if (entry.kind === "assistant/message")
        agent.action = entry.text.slice(0, 180) || "Agent 已回复";
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
            : "所属执行已结束，运行时已关闭"
          : attempt.error ||
            attempt.delivery?.summary ||
            attempt.termination ||
            "执行已结束",
      };
    if (record.state === "interrupted")
      return {
        ...a,
        status: "interrupted" as const,
        action: "连接中断，需核对执行状态",
      };
    return { ...a };
  });
  const rows = activityOnly ? [] : store.trajectoryEvents(after, 101, id);
  return {
    entries: rows.slice(0, 100).map((e) => project(e, record)),
    agents,
    cursor: rows.slice(0, 100).at(-1)?.seq ?? after,
    hasMore: rows.length > 100,
  };
}
