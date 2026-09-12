import {
  actionSchema,
  ticketSchema,
  executionBrief,
  instructionBriefs,
} from "../../contracts/src/index.js";
import { mountTrajectory, agentCard } from "./trajectory.js";
import type {
  Action,
  Overview,
  TicketView,
  Ticket,
  Review,
  Continuation,
  JournalEvent,
  SessionSummary,
  TrajectoryPage,
} from "../../contracts/src/index.js";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const states: Record<string, string> = {
  ready: "待开始",
  running: "实现中",
  awaiting_review: "待审查",
  changes_requested: "需修改",
  accepted: "已验收",
  blocked: "阻塞",
  interrupted: "中断",
};
const next: Record<string, string> = {
  ready: "等待调度",
  running: "Worker 正在实现",
  awaiting_review: "等待外部审查与验收",
  changes_requested: "等待按审查意见返工",
  accepted: "验收通过 · 合并情况未记录",
  blocked: "需处理阻塞",
  interrupted: "需核对退出并恢复",
};
let token =
  new URLSearchParams(location.hash.slice(1)).get("token") ??
  localStorage.getItem("worker-token") ??
  sessionStorage.getItem("worker-token") ??
  "";
if (token) {
  localStorage.setItem("worker-token", token);
  sessionStorage.setItem("worker-token", token);
  history.replaceState(null, "", location.pathname);
}
let overview: Overview | undefined;
let selected: string | undefined;
let detailRequest = 0;
let generation = 0;
let cursor = 0;
let lastSeq = 0;
let connected = false;
let layout = localStorage.getItem("worker-layout") ?? "list";
const collapsedGroups = new Set<string>();
let detailVersion = "";
let editingTicket: Ticket | undefined;
function openCreate(ticket?: Ticket) {
  editingTicket = ticket;
  const form = $<HTMLFormElement>("create-form");
  form.reset();
  $<HTMLTextAreaElement>("ticket-json").value = "";
  $("create-error").textContent = "";
  document
    .querySelector<HTMLDetailsElement>("#ticket-json")!
    .closest("details")!.open = false;
  for (const name of ["ticketId", "targetRepo", "baseCommit"])
    (form.elements.namedItem(name) as HTMLInputElement).readOnly = !!ticket;
  if (ticket) {
    const fields = {
      ticketId: ticket.ticketId,
      title: ticket.title,
      targetRepo: ticket.targetRepo,
      baseCommit: ticket.baseCommit,
      objective: ticket.objective,
      paths: ticket.scope.paths.join("\n"),
      acceptance: ticket.acceptance.map((a) => a.description).join("\n"),
      setup: JSON.stringify(ticket.setup ?? []),
      verification: JSON.stringify(ticket.verification[0]!.args),
      provider: ticket.execution.provider,
      model: ticket.execution.model,
    };
    for (const [name, value] of Object.entries(fields))
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
  }
  form.querySelector("h2")!.textContent = ticket
    ? `编辑任务 · 版本 ${ticket.revision + 1}`
    : "准备新任务";
  $<HTMLDialogElement>("create").showModal();
}
const instructionDrafts = new Map<string, { id: string; text: string }>();
const instructionPending = new Set<string>();
function version(t: TicketView) {
  return JSON.stringify([
    t.ticket.ticketId,
    t.ticket.revision,
    t.state,
    t.activeOperation,
    t.archived,
    t.stale,
    t.currentSnapshot,
    t.error,
    t.instructions?.map((i) => [i.id, i.status, i.consumption]),
    t.attempts.at(-1)?.receipt,
    t.attempts.at(-1)?.deadlineAt,
  ]);
}
let activityBusy = false;
function updateFeedback(node: HTMLElement, ticket: TicketView) {
  const execution = executionBrief(ticket);
  const pending = instructionBriefs(ticket).filter(
    (i) => !i.consumption && i.attemptId === ticket.attempts.at(-1)?.id,
  );
  node.textContent = [
    execution.deadlineAt
      ? `执行截止：${execution.deadlineAt}${execution.remainingSeconds !== null ? `（剩余 ${execution.remainingSeconds} 秒）` : ""}`
      : "",
    pending.length
      ? `${pending.length} 条指令尚无消费证据，最长等待 ${Math.max(...pending.map((i) => i.unconsumedSeconds ?? 0))} 秒`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
async function refreshActivity() {
  if (activityBusy || !overview) return;
  activityBusy = true;
  try {
    for (const node of document.querySelectorAll<HTMLElement>(
      "[data-execution-feedback]",
    )) {
      const ticket = overview.tickets.find(
        (t) => t.ticket.ticketId === node.dataset.executionFeedback,
      );
      if (ticket) updateFeedback(node, ticket);
    }
    const active = overview.tickets.filter((t) => t.activeOperation);
    const pages = await Promise.all(
      active.map((t) =>
        request<TrajectoryPage>(
          `/api/tickets/${encodeURIComponent(t.ticket.ticketId)}/activity`,
        ),
      ),
    );
    $("agent-cards").replaceChildren(
      ...pages.flatMap((p, i) =>
        p.agents
          .filter((a) => a.attemptId === active[i]!.attempts.at(-1)?.id)
          .map((a) => {
            const card = agentCard(a);
            card.prepend(el("h3", active[i]!.ticket.title));
            card.append(
              button("查看执行", async () =>
                showDetail(active[i]!.ticket.ticketId),
              ),
            );
            return card;
          }),
      ),
    );
    if (!active.length)
      $("agent-cards").append(el("p", "当前没有正在执行的 Agent。", "subtle"));
  } catch {
    $("agent-cards").replaceChildren(
      el("p", "无法更新 Agent 动态，请检查连接。", "warning"),
    );
  } finally {
    activityBusy = false;
  }
}
async function request<T>(path: string, action?: Action): Promise<T> {
  const response = await fetch(path, {
    method: action ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(action ? { "Content-Type": "application/json" } : {}),
    },
    body: action ? JSON.stringify(actionSchema.parse(action)) : undefined,
  });
  const value = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) {
    if (response.status === 401) {
      $("login").hidden = false;
      throw new Error(
        "尚未登录或令牌已失效。请打开服务启动时打印的完整登录链接，或输入连接令牌。",
      );
    }
    throw new Error(value.error?.message ?? `HTTP ${response.status}`);
  }
  return value;
}
function connection(message: string, error = false) {
  $("connection").textContent = message;
  $("connection").classList.toggle("error", error);
}
let overviewRequest: Promise<void> | undefined;
function refresh(): Promise<void> {
  // A journal replay can contain hundreds of events. Share one in-flight read
  // so repeated refreshes cannot starve the initial render or flood the server.
  overviewRequest ??= loadOverview().finally(() => {
    overviewRequest = undefined;
  });
  return overviewRequest;
}
async function loadOverview() {
  const n = ++generation;
  try {
    const data = await request<Overview>("/api/overview");
    if (n !== generation) return;
    overview = data;
    $("login").hidden = true;
    render();
    void refreshActivity();
    const current = data.tickets.find((t) => t.ticket.ticketId === selected);
    if (
      current &&
      $<HTMLDialogElement>("detail").open &&
      detailVersion !== version(current)
    ) {
      const full = await request<TicketView>(
        `/api/tickets/${encodeURIComponent(current.ticket.ticketId)}`,
      );
      if (
        selected !== current.ticket.ticketId ||
        !$<HTMLDialogElement>("detail").open ||
        n !== generation
      )
        return;
      const drafts = [
        ...$("detail-body").querySelectorAll<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >("input,textarea,select"),
      ].map((n) => [n.getAttribute("aria-label"), n.value]);
      renderDetail(full);
      for (const [label, value] of drafts)
        if (label) {
          const input = [
            ...$("detail-body").querySelectorAll<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            >("input,textarea,select"),
          ].find((n) => n.getAttribute("aria-label") === label);
          if (input) input.value = value ?? "";
        }
    }
    connection(
      `${data.active} / ${data.capacity} 个执行槽位 · ${data.dispatchEnabled ? "可接收调度" : "指派尚未启用"} · 服务 ${data.build?.version ?? "未知构建"} ${data.build?.sourceDigest?.slice(0, 12) ?? ""} · 已更新 ${new Date().toLocaleTimeString()}`,
    );
  } catch (error) {
    if (n === generation)
      connection(`连接失败，保留上次结果 · ${String(error)}`, true);
  }
}
function render() {
  if (!overview) return;
  const archived = $<HTMLSelectElement>("archive-filter").value;
  // Metrics and navigation share the selected archive scope. Search and status
  // narrow the list without changing the workspace summary.
  const tickets = overview.tickets.filter(
    (t) =>
      archived === "all" || Boolean(t.archived) === (archived === "archived"),
  );
  const counts = [
    ["实现中", tickets.filter((t) => t.state === "running").length],
    ["待审查", tickets.filter((t) => t.state === "awaiting_review").length],
    [
      "需处理",
      tickets.filter(
        (t) =>
          ["blocked", "interrupted", "changes_requested"].includes(t.state) ||
          t.stale,
      ).length,
    ],
    [
      "已验收",
      tickets.filter((t) => t.state === "accepted" && !t.stale).length,
    ],
  ];
  $("metrics").replaceChildren(
    ...counts.map(([label, value]) => {
      const card = el("div", undefined, "metric");
      card.append(
        el("div", String(label), "metric-label"),
        el("div", String(value), "metric-number"),
      );
      return card;
    }),
  );
  const search = $<HTMLInputElement>("search").value.toLowerCase();
  const filter = $<HTMLSelectElement>("filter").value;
  const visible = tickets.filter(
    (t) =>
      `${t.ticket.title} ${t.ticket.objective} ${t.ticket.project ?? ""} ${t.ticket.ticketId}`
        .toLowerCase()
        .includes(search) &&
      (filter === "all" ||
        filter === t.state ||
        (filter === "attention" &&
          (["blocked", "interrupted", "changes_requested"].includes(t.state) ||
            t.stale))),
  );
  $("task-count").textContent = `${visible.length} 个任务`;
  $("tasks").replaceChildren(
    ...visible.map((t) => {
      const button = el("button", undefined, "task");
      button.title = `${t.ticket.objective}\n${next[t.state]}`;
      button.dataset.state = t.state;
      const main = el("div", undefined, "task-main");
      main.append(
        el("h3", t.ticket.title),
        el("p", t.ticket.objective),
        el(
          "small",
          `${t.ticket.project ?? t.ticket.targetRepo.split("/").at(-1)} · ${t.ticket.ticketId} · ${next[t.state] ?? t.state}`,
        ),
      );
      button.append(
        el("span", t.ticket.ticketId, "task-id"),
        el(
          "span",
          t.state === "accepted"
            ? "✓"
            : t.state === "running"
              ? "◐"
              : t.state === "ready"
                ? "○"
                : "◌",
          `status-icon ${t.state}`,
        ),
        main,
        el(
          "span",
          t.ticket.project ?? t.ticket.targetRepo.split("/").at(-1),
          "project-label",
        ),
        el(
          "span",
          t.stale ? "验收已过期" : (states[t.state] ?? t.state),
          `state ${t.state}`,
        ),
      );
      button.onclick = () => showDetail(t.ticket.ticketId);
      return button;
    }),
  );
  $("tasks").classList.toggle("is-board", layout === "board");
  $("layout-list").setAttribute("aria-pressed", String(layout === "list"));
  $("layout-board").setAttribute("aria-pressed", String(layout === "board"));
  if (visible.length) {
    const cards = [...$("tasks").children];
    const groups: [string, string[]][] = [
      ["实现中", ["running"]],
      ["待开始", ["ready"]],
      ["待审查", ["awaiting_review"]],
      ["需处理", ["blocked", "interrupted", "changes_requested"]],
      ["已验收", ["accepted"]],
    ];
    $("tasks").replaceChildren(
      ...groups
        .filter(
          ([, states]) =>
            layout === "board" || visible.some((t) => states.includes(t.state)),
        )
        .map(([label, states]) => {
          const column = el(
            "section",
            undefined,
            layout === "board" ? "board-column" : "task-group",
          );
          const count = visible.filter((t) => states.includes(t.state)).length;
          const heading = el("button", undefined, "group-heading");
          heading.type = "button";
          heading.setAttribute(
            "aria-expanded",
            String(!collapsedGroups.has(label)),
          );
          heading.append(
            el("span", "⌄", "group-chevron"),
            el("span", "●", `group-dot ${states[0]}`),
            el("span", label),
            el("span", String(count), "group-count"),
          );
          const rows = el("div", undefined, "group-rows");
          rows.hidden = collapsedGroups.has(label);
          heading.onclick = () => {
            rows.hidden = !rows.hidden;
            if (rows.hidden) collapsedGroups.add(label);
            else collapsedGroups.delete(label);
            heading.setAttribute("aria-expanded", String(!rows.hidden));
          };
          column.append(heading, rows);
          visible.forEach((t, i) => {
            if (states.includes(t.state)) rows.append(cards[i]!);
          });
          return column;
        }),
    );
  }
  if (!visible.length) {
    const empty = el("div", undefined, "empty");
    empty.append(
      el(
        "strong",
        overview.tickets.length ? "没有匹配的任务" : "准备好下一项工作",
      ),
      el(
        "span",
        overview.tickets.length
          ? "调整搜索或状态筛选。"
          : "创建一份明确的派工单，或由高级模型通过 CLI + Skill 调度。",
      ),
    );
    $("tasks").append(empty);
  }
}
async function act(action: Action) {
  try {
    const data = await request<TicketView>("/api/actions", action);
    await refresh();
    if (selected === data.ticket.ticketId) renderDetail(data);
    return data;
  } catch (error) {
    const existing = $("detail-error");
    if (existing) existing.textContent = String(error);
    else connection(String(error), true);
    throw error;
  }
}
async function showDetail(id: string) {
  selected = id;
  const requestId = ++detailRequest;
  try {
    const t = await request<TicketView>(
      `/api/tickets/${encodeURIComponent(id)}`,
    );
    if (requestId !== detailRequest || selected !== id) return;
    renderDetail(t);
    $<HTMLDialogElement>("detail").showModal();
  } catch (error) {
    if (requestId === detailRequest) connection(String(error), true);
  }
}
function disclosure(title: string, text: string) {
  const d = el("details");
  d.append(el("summary", title), el("pre", text));
  return d;
}
function button(
  label: string,
  action: () => Promise<unknown>,
  disabled = false,
) {
  const b = el("button", label);
  b.disabled = disabled;
  b.onclick = () => {
    b.disabled = true;
    void action()
      .catch((error) => {
        const target = $("detail-error");
        if (target) target.textContent = String(error);
        else connection(String(error), true);
      })
      .finally(() => {
        b.disabled = disabled;
      });
  };
  return b;
}
function renderDetail(t: TicketView) {
  if (selected !== t.ticket.ticketId) return;
  detailVersion = version(t);
  $("detail-title").textContent = t.ticket.title;
  const body = $("detail-body");
  body.replaceChildren();
  body.append(
    el("p", next[t.state] ?? t.state),
    el("span", states[t.state] ?? t.state, `state ${t.state}`),
  );
  if (t.stale)
    body.append(el("p", "工作目录已变化，原验收证据过期。", "warning"));
  if (t.error) body.append(el("p", t.error, "warning"));
  body.append(el("p", t.ticket.objective));
  const management = el("div", undefined, "actions");
  management.append(
    button(
      "编辑任务版本",
      async () => {
        openCreate(t.ticket);
      },
      !!t.activeOperation,
    ),
  );
  management.append(
    button(
      t.archived ? "恢复到任务列表" : "归档任务",
      () =>
        act({
          action: "archive",
          ticketId: t.ticket.ticketId,
          archived: !t.archived,
        }),
      !!t.activeOperation,
    ),
  );
  body.append(management);
  const composer = el("section", undefined, "composer");
  composer.append(
    el("h3", "给 Worker 下达指令"),
    el(
      "p",
      t.state === "running"
        ? "追加指令会在当前执行的下一回合处理，不会打断当前工具步骤。回执只表示入队，消费记录不代表理解、实现或验证通过。"
        : "追加到下一次执行；范围与验收的变化请使用编辑任务版本。",
      "subtle",
    ),
  );
  const input = el("textarea");
  input.rows = 3;
  input.setAttribute("aria-label", "追加自然语言指令");
  input.placeholder = "补充实现要求、纠正方向，或说明接下来应检查什么…";
  const draftKey = `${t.ticket.ticketId}:${t.ticket.revision}`;
  input.value = instructionDrafts.get(draftKey)?.text ?? "";
  input.oninput = () => {
    instructionDrafts.set(draftKey, {
      id: crypto.randomUUID(),
      text: input.value,
    });
  };
  composer.append(
    input,
    button(
      t.state === "running" ? "加入下一回合" : "保存执行指令",
      async () => {
        const draft = instructionDrafts.get(draftKey) ?? {
          id: crypto.randomUUID(),
          text: input.value,
        };
        instructionDrafts.set(draftKey, draft);
        instructionPending.add(draftKey);
        try {
          const updated = await request<TicketView>("/api/actions", {
            action: "instruct",
            ticketId: t.ticket.ticketId,
            instructionId: draft.id,
            revision: t.ticket.revision,
            instruction: draft.text,
          });
          if (instructionDrafts.get(draftKey)?.id === draft.id)
            instructionDrafts.delete(draftKey);
          instructionPending.delete(draftKey);
          if (selected === t.ticket.ticketId) renderDetail(updated);
          await refresh();
          return updated;
        } finally {
          instructionPending.delete(draftKey);
        }
      },
      instructionPending.has(draftKey) ||
        !!t.archived ||
        !["ready", "changes_requested", "running"].includes(t.state),
    ),
  );
  const instructionStates = {
    queued: "等待下次执行",
    sending: "等待回执",
    received: "已接收，未记录消费",
    uncertain: "回执不确定，请核对轨迹",
  };
  for (const i of t.instructions ?? [])
    composer.append(
      disclosure(
        `${i.consumption ? `已进入执行轮次 ${i.consumption.turn ?? ""}` : instructionStates[i.status]} · 版本 ${i.revision}${i.status === "uncertain" && i.consumption ? " · 回执仍不确定" : ""}`,
        `${i.text}\n${i.messageId ?? ""}\n${i.consumption ? `消费时间：${i.consumption.time}；不代表已完成。` : "接收回执不代表指令已进入执行轮次。"}\n${i.error ?? ""}`,
      ),
    );
  const feedback = el("p", undefined, "subtle");
  feedback.dataset.executionFeedback = t.ticket.ticketId;
  composer.append(feedback);
  updateFeedback(feedback, t);
  body.append(composer);
  const trajectoryHost = el("section", undefined, "trajectory-panel");
  body.append(trajectoryHost);
  mountTrajectory(trajectoryHost, t.ticket.ticketId, request);
  const criteria = el("ul");
  for (const a of t.ticket.acceptance)
    criteria.append(el("li", `${a.id} · ${a.description}`));
  body.insertBefore(criteria, management);
  const error = el("p", undefined, "error-text");
  error.id = "detail-error";
  error.setAttribute("role", "alert");
  body.append(error);
  const actions = el("div", undefined, "actions");
  actions.append(
    button("刷新详情", async () => {
      renderDetail(
        await request<TicketView>(
          `/api/tickets/${encodeURIComponent(t.ticket.ticketId)}`,
        ),
      );
    }),
  );
  if (["ready", "changes_requested"].includes(t.state))
    actions.append(
      button(
        t.state === "ready" ? "开始实现" : "开始返工",
        () => act({ action: "run", ticketId: t.ticket.ticketId }),
        !overview?.dispatchEnabled || !!t.activeOperation || !!t.archived,
      ),
    );
  if (t.activeOperation && t.state !== "interrupted")
    actions.append(
      button("停止执行", () =>
        act({ action: "cancel", ticketId: t.ticket.ticketId }),
      ),
    );
  if (t.state === "awaiting_review")
    actions.append(
      button(
        "运行独立验证",
        () => act({ action: "verify", ticketId: t.ticket.ticketId }),
        !!t.activeOperation,
      ),
    );
  body.insertBefore(actions, management);
  if (t.state === "awaiting_review" && !t.activeOperation) {
    const form = el("div", undefined, "review-form");
    form.append(
      el("h3", "外部审查意见"),
      el(
        "p",
        "验收需要当前快照的独立验证通过。此决定不执行提交或合并。",
        "subtle",
      ),
    );
    const reviewer = el("input");
    reviewer.placeholder = "审查者名称";
    reviewer.setAttribute("aria-label", "审查者");
    const findings = el("textarea");
    findings.placeholder = "发现、违反的要求及修复条件（返工或阻塞必填）";
    findings.setAttribute("aria-label", "审查发现");
    form.append(reviewer, findings);
    const spec = el("select");
    spec.setAttribute("aria-label", "Spec 结论");
    spec.append(
      new Option("Spec · 通过", "pass"),
      new Option("Spec · 不通过", "fail"),
    );
    const standards = el("select");
    standards.setAttribute("aria-label", "Standards 结论");
    standards.append(
      new Option("Standards · 通过", "pass"),
      new Option("Standards · 不通过", "fail"),
    );
    form.append(spec, standards);
    const reviewActions = el("div", undefined, "actions");
    for (const [label, verdict] of [
      ["验收通过", "accept"],
      ["要求返工", "request_changes"],
      ["登记阻塞", "blocked"],
    ] as const)
      reviewActions.append(
        button(label, async () => {
          const attempt = t.attempts.at(-1)!;
          const review: Review = {
            schemaVersion: 2,
            ticketId: t.ticket.ticketId,
            revision: t.ticket.revision,
            attemptId: attempt.id,
            snapshotDigest: attempt.snapshot!.digest,
            reviewer: reviewer.value,
            spec: { verdict: spec.value as "pass" | "fail", findings: [] },
            standards: {
              verdict: standards.value as "pass" | "fail",
              findings: [],
            },
            verdict,
            findings: findings.value.split("\n").filter(Boolean),
          };
          return act({ action: "review", review });
        }),
      );
    form.append(reviewActions);
    body.append(form);
  }
  if (
    (["blocked", "interrupted"].includes(t.state) ||
      (t.state === "ready" && t.pendingDelivery)) &&
    t.attempts.length
  ) {
    const form = el("div", undefined, "review-form");
    form.append(
      el("h3", "检查并登记续作"),
      el(
        "p",
        "先核对原执行与当前变更。登记续作会清理仍属于此执行的进程，并返回待开始；不会自动重发。",
        "subtle",
      ),
    );
    const instruction = el("textarea");
    instruction.placeholder = "说明如何处理不确定结果，以及接下来完成什么";
    instruction.setAttribute("aria-label", "续作要求");
    const report = el("pre");
    const kind = el("select");
    kind.setAttribute("aria-label", "续作方式");
    for (const [value, label] of [
      ["restart", "新会话继续"],
      ["answer", "回答阻塞问题并恢复会话"],
      ["delivery", "仅补交付报告，保持源码快照"],
    ]) {
      if (t.state === "ready" && value !== "restart") continue;
      const option = el("option", label);
      option.value = value!;
      kind.append(option);
    }
    let recovery: Omit<Continuation, "instruction" | "kind"> | undefined;
    form.append(
      kind,
      instruction,
      button("检查恢复条件", async () => {
        recovery = await request(
          `/api/tickets/${encodeURIComponent(t.ticket.ticketId)}/recovery`,
        );
        report.textContent = JSON.stringify(recovery, null, 2);
      }),
      report,
      button("登记续作", async () => {
        if (!recovery) throw new Error("请先检查恢复条件");
        return act({
          action: "recover",
          continuation: {
            kind: kind.value as Continuation["kind"],
            ticketId: t.ticket.ticketId,
            revision: t.ticket.revision,
            attemptId: recovery.attemptId,
            snapshotDigest: recovery.snapshotDigest,
            instruction: instruction.value,
          },
        });
      }),
    );
    body.append(form);
  }
  for (const [i, a] of t.attempts.entries()) {
    const section = el("details");
    section.append(
      el(
        "summary",
        `第 ${i + 1} 次执行 · ${a.failures?.primary ?? a.termination ?? a.finishReason ?? "执行中"}`,
      ),
    );
    section.append(el("p", a.delivery?.summary ?? a.error ?? "尚未交付"));
    if (a.failures)
      section.append(
        disclosure("终止原因与各阶段错误", JSON.stringify(a.failures, null, 2)),
      );
    if (a.delivery)
      section.append(
        disclosure("交付与验收证据", JSON.stringify(a.delivery, null, 2)),
      );
    if (a.snapshot)
      section.append(
        disclosure(
          "代码差异",
          a.snapshot.diff || "没有已跟踪文件差异；新增文件见清单",
        ),
        disclosure("完整文件清单", JSON.stringify(a.snapshot.files, null, 2)),
        disclosure("暂存区差异", a.snapshot.indexDiff || "暂存区无变化"),
      );
    if (a.snapshot) {
      const files = el("details");
      files.append(el("summary", "查看变更文件内容"));
      for (const file of a.snapshot.files.filter((f) =>
        a.snapshot!.changedPaths?.includes(f.path),
      )) {
        const entry = el("details");
        entry.append(
          el("summary", `${file.path} · ${file.kind} · ${file.size} B`),
        );
        const preview = el(
          "pre",
          file.kind === "deleted" ? "已删除" : "展开后加载对应快照中的内容",
        );
        entry.append(preview);
        let loaded = false;
        entry.ontoggle = () => {
          if (!entry.open || loaded || !file.hash) return;
          loaded = true;
          void fetch(`/api/artifacts/${file.hash}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then(async (response) => {
              if (!response.ok) throw new Error("无法读取或验证文件快照");
              const bytes = new Uint8Array(await response.arrayBuffer());
              preview.textContent = bytes.includes(0)
                ? "二进制文件，请下载审阅。"
                : new TextDecoder().decode(bytes.subarray(0, 65536)) +
                  (bytes.length > 65536
                    ? "\n…预览已截断，请下载完整文件。"
                    : "");
              entry.append(
                button("下载快照文件", async () => {
                  const url = URL.createObjectURL(new Blob([bytes]));
                  const link = el("a");
                  link.href = url;
                  link.download = file.path.split("/").at(-1)!;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }),
              );
            })
            .catch((error) => {
              preview.textContent = String(error);
              loaded = false;
            });
        };
        files.append(entry);
      }
      section.append(files);
    }
    section.append(
      disclosure(
        "执行技术信息",
        JSON.stringify(
          { ...a, snapshot: undefined, delivery: undefined },
          null,
          2,
        ),
      ),
    );
    body.append(section);
  }
  if (t.verificationBaselines?.length)
    body.append(
      disclosure("验证基线", JSON.stringify(t.verificationBaselines, null, 2)),
    );
  if (t.verifications.length)
    body.append(
      disclosure("独立验证记录", JSON.stringify(t.verifications, null, 2)),
    );
  if (t.reviews.length)
    body.append(disclosure("审查记录", JSON.stringify(t.reviews, null, 2)));
  body.append(
    disclosure(
      "派工单与工作目录",
      JSON.stringify(
        {
          ticket: t.ticket,
          worktree: t.worktree,
          currentSnapshot: t.currentSnapshot,
        },
        null,
        2,
      ),
    ),
  );
}
$("close-detail").onclick = () => $<HTMLDialogElement>("detail").close();
$("detail").addEventListener("close", () => {
  selected = undefined;
  detailRequest++;
});
$("close-create").onclick = () => $<HTMLDialogElement>("create").close();
$("new-task").onclick = () => {
  openCreate();
};
$("instruction-create").onclick = () => {
  const instruction = $<HTMLTextAreaElement>(
    "natural-instruction",
  ).value.trim();
  if (!instruction) {
    $<HTMLTextAreaElement>("natural-instruction").focus();
    return;
  }
  const form = $<HTMLFormElement>("create-form");
  openCreate();
  (form.elements.namedItem("objective") as HTMLTextAreaElement).value =
    instruction;
  (form.elements.namedItem("title") as HTMLInputElement).value =
    instruction.slice(0, 100);
  (form.elements.namedItem("ticketId") as HTMLInputElement).value =
    `TASK-${Date.now()}`;
  $<HTMLDialogElement>("create").showModal();
};
$("refresh").onclick = () => {
  void refresh();
};
$("search").oninput = render;
$("filter").onchange = render;
$("archive-filter").onchange = render;
$("connect").onclick = () => {
  token = $<HTMLInputElement>("token").value.trim();
  localStorage.setItem("worker-token", token);
  sessionStorage.setItem("worker-token", token);
  void refresh();
};
// Opening an authenticated link in an already-open tab may only change its
// fragment. Consume it without requiring a full page reload.
window.addEventListener("hashchange", () => {
  const nextToken = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!nextToken) return;
  token = nextToken;
  localStorage.setItem("worker-token", token);
  sessionStorage.setItem("worker-token", token);
  history.replaceState(null, "", location.pathname);
  void refresh();
  void stream();
});
$("create-form").onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const raw = $<HTMLTextAreaElement>("ticket-json").value;
      const data = new FormData($<HTMLFormElement>("create-form"));
      const get = (name: string) => String(data.get(name) ?? "");
      const ticket = ticketSchema.parse(
        raw.trim()
          ? JSON.parse(raw)
          : {
              ...editingTicket,
              schemaVersion: 2,
              ticketId: get("ticketId"),
              revision: editingTicket ? editingTicket.revision + 1 : 1,
              title: get("title"),
              targetRepo: get("targetRepo"),
              baseCommit: get("baseCommit"),
              objective: get("objective"),
              scope: {
                ...editingTicket?.scope,
                paths: get("paths").split("\n").filter(Boolean),
              },
              acceptance: get("acceptance")
                .split("\n")
                .filter(Boolean)
                .map((description, i) => ({
                  id: editingTicket?.acceptance[i]?.id ?? `AC${i + 1}`,
                  description,
                })),
              setup: JSON.parse(get("setup") || "[]"),
              verification: [
                {
                  ...editingTicket?.verification[0],
                  args: JSON.parse(get("verification")),
                },
                ...(editingTicket?.verification.slice(1) ?? []),
              ],
              execution: {
                ...editingTicket?.execution,
                provider: get("provider"),
                model: get("model"),
                envRequired: editingTicket?.execution.envRequired ?? [],
                credentialEnv: editingTicket
                  ? (editingTicket.execution.credentialEnv ?? [])
                  : ["DEEPSEEK_API_KEY"],
              },
            },
      );
      await act({ action: "prepare", ticket });
      $<HTMLDialogElement>("create").close();
    } catch (error) {
      $("create-error").textContent = String(error);
    }
  })();
};
$("nav-tasks").onclick = () => {
  $("tasks-view").hidden = false;
  $("sessions-view").hidden = true;
  $("metrics").hidden = false;
  $("page-title").textContent = "任务工作台";
  $("nav-tasks").classList.add("active");
  $("nav-sessions").classList.remove("active");
};
$("nav-sessions").onclick = () => {
  $("tasks-view").hidden = true;
  $("sessions-view").hidden = false;
  $("metrics").hidden = true;
  $("page-title").textContent = "会话记录";
  $("nav-sessions").classList.add("active");
  $("nav-tasks").classList.remove("active");
  void request<{ sessions: SessionSummary[]; diagnostics: string[] }>(
    "/api/sessions",
  )
    .then((result) => {
      $("sessions").replaceChildren(
        ...result.sessions.map((s) =>
          el("p", `${s.id} · ${s.origin ?? "独立会话"} · 运行情况未知`),
        ),
        ...result.diagnostics.map((d) => el("p", d, "warning")),
      );
      if (!result.sessions.length)
        $("sessions").append(el("p", "尚未连接会话来源。"));
    })
    .catch((error) => connection(String(error), true));
};
async function stream() {
  if (connected || !token) return;
  connected = true;
  try {
    const response = await fetch(`/api/events?after=${cursor}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
    });
    if (!response.ok || !response.body) throw new Error("事件连接失败");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const event = JSON.parse(line.slice(6)) as JournalEvent;
          cursor = event.seq;
          if (lastSeq !== cursor) {
            lastSeq = cursor;
            if (
              !event.type.endsWith(".processes") &&
              event.type !== "harness.notification"
            )
              void refresh();
          }
        }
      }
    }
  } catch {
  } finally {
    connected = false;
  }
}
setInterval(() => {
  void refresh();
  void stream();
}, 3000);
void refresh();
void stream();

for (const kind of ["list", "board"])
  $("layout-" + kind).onclick = () => {
    layout = kind;
    localStorage.setItem("worker-layout", kind);
    render();
  };
