import type {
  TrajectoryPage,
  TrajectoryEntry,
  AgentActivity,
} from "../../contracts/src/index.js";
type Read = <T>(path: string) => Promise<T>;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
const labels: Record<AgentActivity["status"], string> = {
  running: "运行中",
  idle: "空闲",
  ended: "已结束",
  interrupted: "中断",
  unknown: "等待事件",
};
export function agentCard(a: AgentActivity) {
  const card = node("div");
  card.className = `agent-card ${a.status}`;
  card.append(
    node(
      "strong",
      `${a.parentSessionId ? "↳ 子 Agent" : "◈ Worker"} · ${labels[a.status]}`,
    ),
    node("p", a.action),
    node(
      "small",
      `${a.sessionId} · ${new Date(a.updatedAt).toLocaleTimeString()}`,
    ),
  );
  card.title = a.parentSessionId ? `父会话 ${a.parentSessionId}` : a.attemptId;
  return card;
}
export function mountTrajectory(
  host: HTMLElement,
  ticketId: string,
  read: Read,
) {
  const heading = node("h3", "执行轨迹");
  const hint = node(
    "p",
    "按实际事件记录消息、工具调用与结果。收到指令不等于完成执行。",
  );
  hint.className = "subtle";
  const agents = node("div");
  agents.className = "agent-grid";
  const toolbar = node("div");
  toolbar.className = "toolbar";
  const attempt = node("select");
  attempt.setAttribute("aria-label", "轨迹执行轮次");
  attempt.append(new Option("全部执行", ""));
  const session = node("select");
  session.setAttribute("aria-label", "轨迹 Agent");
  session.append(new Option("全部 Agent", ""));
  const filter = node("select");
  filter.setAttribute("aria-label", "轨迹类型");
  for (const [label, value] of [
    ["全部事件", ""],
    ["工具调用与结果", "tool/"],
    ["Agent 回复", "assistant/message"],
    ["用户消息", "user/message"],
    ["执行轮次", "turn/"],
  ])
    filter.append(new Option(label, value));
  const search = node("input");
  search.placeholder = "搜索轨迹内容";
  search.setAttribute("aria-label", "搜索轨迹");
  const status = node("p");
  status.setAttribute("role", "status");
  status.className = "subtle";
  const timeline = node("div");
  timeline.className = "trajectory-map";
  timeline.setAttribute("aria-label", "事件顺序概览");
  const list = node("div");
  list.className = "trajectory";
  const more = node("button", "加载后续轨迹");
  const restart = node("button", "从头查看轨迹");
  restart.type = "button";
  more.type = "button";
  more.hidden = true;
  toolbar.append(attempt, session, filter, search, restart);
  host.append(heading, hint, agents, toolbar, status, timeline, list, more);
  let cursor = 0;
  let busy = false;
  let hasMore = false;
  let total = 0;
  const entries: TrajectoryEntry[] = [];
  const knownAttempts = new Set<string>();
  const knownSessions = new Set<string>();
  const expanded = new Set<number>();
  const render = () => {
    const selected = entries.filter(
      (e) =>
        (!attempt.value || e.attemptId === attempt.value) &&
        (!session.value || e.sessionId === session.value) &&
        e.kind.startsWith(filter.value) &&
        `${e.title} ${e.text}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    );
    const visible = selected.slice(-300);
    list.replaceChildren(
      ...visible.map((e) => {
        const d = node("details");
        d.dataset.seq = String(e.seq);
        d.open = expanded.has(e.seq);
        const s = node(
          "summary",
          `${new Date(e.time).toLocaleTimeString()} · ${e.title}${e.callId ? ` · ${e.callId}` : ""}`,
        );
        const meta = node(
          "small",
          `${e.attemptId ?? "控制服务"}${e.sessionId ? ` / ${e.sessionId}` : ""} · #${e.seq}`,
        );
        const text = node(
          "pre",
          e.text.slice(0, 64000) +
            (e.text.length > 64000 ? "\n…显示已截断，可查看原始事件。" : ""),
        );
        const raw = node("details");
        raw.append(
          node("summary", "原始事件"),
          node("pre", JSON.stringify(e.raw, null, 2)),
        );
        d.className = e.kind.startsWith("tool/")
          ? "tool-event"
          : "message-event";
        d.append(s, meta, text, raw);
        d.ontoggle = () => {
          if (d.open) expanded.add(e.seq);
          else expanded.delete(e.seq);
        };
        return d;
      }),
    );
    if (!visible.length)
      list.append(node("p", "暂无匹配轨迹；等待运行时事件。"));
    timeline.replaceChildren(
      ...visible.map((e) => {
        const b = node(
          "button",
          e.kind.startsWith("tool/")
            ? "◆"
            : e.kind.startsWith("turn/")
              ? "│"
              : "●",
        );
        b.title = `${e.seq} · ${e.title}`;
        b.setAttribute("aria-label", b.title);
        b.onclick = () => {
          const target = list.querySelector<HTMLDetailsElement>(
            `[data-seq="${e.seq}"]`,
          );
          if (target) {
            target.open = true;
            target.scrollIntoView({ block: "nearest" });
          }
        };
        return b;
      }),
    );
    status.textContent = `已读取 ${total} 条事件 · 当前窗口显示 ${visible.length} 条${total > entries.length ? "（窗口保留 300 条，较早内容可从头查看）" : ""}${hasMore ? " · 尚有后续记录" : " · 已到当前轨迹末尾"}`;
  };
  for (const input of [attempt, session, filter, search])
    input.oninput = render;
  const load = async () => {
    if (busy || !host.isConnected) return;
    busy = true;
    try {
      const page = await read<TrajectoryPage>(
        `/api/tickets/${encodeURIComponent(ticketId)}/trajectory?after=${cursor}`,
      );
      if (!host.isConnected) return;
      for (const e of page.entries) if (e.seq > cursor) entries.push(e);
      total += page.entries.length;
      if (entries.length > 300) entries.splice(0, entries.length - 300);
      for (const seq of expanded)
        if (!entries.some((e) => e.seq === seq)) expanded.delete(seq);
      cursor = page.cursor;
      hasMore = page.hasMore;
      more.hidden = !hasMore;
      for (const a of page.agents) {
        if (!knownAttempts.has(a.attemptId)) {
          knownAttempts.add(a.attemptId);
          attempt.append(
            new Option(
              `执行 ${knownAttempts.size} · ${a.attemptId.slice(0, 8)}`,
              a.attemptId,
            ),
          );
        }
        if (!knownSessions.has(a.sessionId)) {
          knownSessions.add(a.sessionId);
          session.append(
            new Option(
              `${a.parentSessionId ? "子 Agent" : "Worker"} · ${a.sessionId}`,
              a.sessionId,
            ),
          );
        }
      }
      agents.replaceChildren(...page.agents.map(agentCard));
      if (!page.agents.length) agents.append(node("p", "尚未开始执行。"));
      if (page.entries.length || !entries.length) render();
    } catch (error) {
      status.textContent = `轨迹连接失败，保留已加载内容 · ${String(error)}`;
    } finally {
      busy = false;
    }
  };
  more.onclick = () => {
    void load();
  };
  restart.onclick = () => {
    if (busy) return;
    cursor = 0;
    total = 0;
    entries.length = 0;
    expanded.clear();
    void load();
  };
  const timer = setInterval(() => {
    if (!host.isConnected || host.closest("dialog")?.open === false) {
      clearInterval(timer);
      return;
    }
    if (!hasMore) void load();
    else
      void read<TrajectoryPage>(
        `/api/tickets/${encodeURIComponent(ticketId)}/activity`,
      )
        .then((p) => {
          if (host.isConnected)
            agents.replaceChildren(...p.agents.map(agentCard));
        })
        .catch(() => {
          status.textContent = "Agent 动态连接中断，显示上次观测状态";
        });
  }, 1000);
  void load();
}
