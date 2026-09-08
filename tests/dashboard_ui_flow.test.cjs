/* Node behavioral tests for the dashboard client (U2-U8).

Runs app.js in a Node VM with a controllable fetch and a small fake DOM that
records event listeners (so we can dispatch clicks/input) and class/attribute
state (so we can assert the layout toggle and aria-pressed). Assertions observe
rendered *behavior* (labels, titles, disclosure collapse, filter/layout state,
error/stale indicators, out-of-order polling), not incidental source words.

Run: node tests/dashboard_ui_flow.test.cjs
*/
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "src", "dsh_worker", "dashboard", "web", "app.js");
const source = fs.readFileSync(APP_JS, "utf8");

/* ------------------------------------------------------------- fake DOM */

function makeHarness(fetchImpl, storage) {
  const activeElementRef = { current: null };
  const nodes = new Map();
  const intervals = [];
  const store = storage || {};

  // `children` is an array-like HTMLCollection (numeric keys + length) with no
  // Array methods, so app.js must not call `.forEach`/`.filter` on it — the
  // R1 regression relies on this fidelity to real browsers.
  function makeElement(tag) {
    const tagName = String(tag || "div").toUpperCase();
    const el = {
      tagName,
      children: { length: 0 },
      hidden: true,
      style: {},
      attrs: {},
      classes: new Set(),
      listeners: {},
      _text: "",
      open: false,
      value: "",
      type: "",
      scrollTop: 0,
      selectedIndex: -1,
      parentNode: null,
      _isRoot: false,
    };
    Object.defineProperty(el, "textContent", {
      get() { return el._text; },
      set(v) {
        el._text = String(v == null ? "" : v);
        const kids = el.children;
        for (let i = 0; i < kids.length; i++) kids[i].parentNode = null;
        el.children = { length: 0 };
        if (el.tagName === "SELECT") el.selectedIndex = -1;
      },
    });
    // Model real <select> semantics: assigning `.value` selects the first option
    // with a matching value; with no match, selectedIndex becomes -1 and `.value`
    // reads back "" (the bug R3 guards against). Non-select inputs keep a plain
    // string value.
    if (tagName === "SELECT") {
      Object.defineProperty(el, "value", {
        get() {
          const i = el.selectedIndex;
          return (i >= 0 && i < el.children.length) ? el.children[i].value : "";
        },
        set(v) {
          const want = String(v == null ? "" : v);
          for (let i = 0; i < el.children.length; i++) {
            if (el.children[i].value === want) { el.selectedIndex = i; return; }
          }
          el.selectedIndex = -1;
        },
      });
    }
    Object.defineProperty(el, "className", {
      get() { return Array.from(el.classes).join(" "); },
      set(v) { el.classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(el, "isConnected", {
      get() {
        let n = el;
        while (n) {
          if (n._isRoot) return true;
          n = n.parentNode;
        }
        return false;
      },
    });
    el.appendChild = function (n) {
      n.parentNode = el;
      el.children[el.children.length] = n;
      el.children.length += 1;
      return n;
    };
    el.setAttribute = function (k, v) { el.attrs[k] = String(v); };
    el.getAttribute = function (k) { return k in el.attrs ? el.attrs[k] : null; };
    el.addEventListener = function (type, fn) {
      (el.listeners[type] || (el.listeners[type] = [])).push(fn);
    };
    el.dispatch = function (type, ev) {
      const e = ev || { target: el, preventDefault() {}, key: "" };
      (el.listeners[type] || []).forEach((fn) => fn(e));
    };
    el.classList = {
      add(...cs) { cs.forEach((c) => el.classes.add(c)); },
      remove(...cs) { cs.forEach((c) => el.classes.delete(c)); },
      contains(c) { return el.classes.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !el.classes.has(c) : !!force;
        if (want) el.classes.add(c); else el.classes.delete(c);
        return want;
      },
    };
    el.showModal = function () {};
    el.close = function () { el.dispatch("close"); };
    // Focus is a no-op on a detached element (real browser semantics).
    el.focus = function () { if (el.isConnected) activeElementRef.current = el; };
    return el;
  }

  const document = {
    get activeElement() { return activeElementRef.current; },
    set activeElement(v) { activeElementRef.current = v; },
    querySelector(sel) {
      if (!nodes.has(sel)) {
        // #project-filter is a <select> so it gets real option-based `.value`
        // semantics; every other queried node is a plain element.
        const el = makeElement(sel === "#project-filter" ? "select" : undefined);
        el._isRoot = true;
        nodes.set(sel, el);
      }
      return nodes.get(sel);
    },
    createElement: makeElement,
  };
  const context = {
    document,
    Date,
    console,
    localStorage: {
      getItem(k) { return k in store ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
    },
    setInterval(fn) { intervals.push(fn); },
    fetch: fetchImpl,
  };
  function run() {
    vm.runInNewContext(source, context);
  }
  return { document, run, intervals, context };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function okJson(data) {
  return { ok: true, json: () => Promise.resolve(data) };
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

function childArr(el) {
  const kids = el && el.children;
  const out = [];
  for (let i = 0; kids && i < kids.length; i++) out.push(kids[i]);
  return out;
}

function collectText(el) {
  if (!el) return "";
  let out = el.textContent || "";
  childArr(el).forEach((c) => { out += collectText(c); });
  return out;
}

function findTags(root, tagName) {
  const out = [];
  (function walk(n) {
    childArr(n).forEach((c) => {
      if (c.tagName === String(tagName).toUpperCase()) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

function findDisclosure(root, key) {
  return findTags(root, "details").find((d) => d.getAttribute("data-disc-key") === key) || null;
}

function firstChildWithTag(root, tagName) {
  const found = findTags(root, tagName);
  return found[0] || null;
}

function taskObj(id, objective, overrides) {
  return Object.assign({
    id, ticket_id: id, revision: 1, state: "ready", objective,
    repo: "", base_commit: "", created_at: null, updated_at: null,
    attempt_count: 0, last_finish_reason: null, history_truncated: false,
    verification: null, review: null, source: "controller",
  }, overrides || {});
}

function summaryObj(counts) {
  return { counts: Object.assign({ tasks: 0, by_state: {}, agents: 0, subagents: 0 }, counts || {}), sources: {} };
}

function agentNode(id, overrides) {
  return Object.assign({
    id, session_id: id, source: "home-1", source_label: "harness-home",
    parent_id: null, children_ids: [], origin: null, delegation_depth: 0,
    created_at: null, title: null, mode: null, label: null, cache_version: null,
    liveness: "unknown", observed_state: "unknown", last_observed_at: null,
    cache_error: null, is_root: true, in_cycle: false, is_subagent: false,
  }, overrides || {});
}

/* Load a fixed snapshot, run one poll, and return the harness. */
async function loadSnapshot({ summary, tasks, agents }) {
  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summary));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson(agents));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();
  return harness;
}

function cardAt(harness, col) {
  return harness.document.querySelector('[data-body="' + col + '"]').children[0];
}

function findCardByToken(harness, token) {
  const cols = ["waiting", "running", "review", "attention", "completed"];
  for (let c = 0; c < cols.length; c++) {
    const body = harness.document.querySelector('[data-body="' + cols[c] + '"]');
    const kids = body.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute("data-token") === token) return kids[i];
    }
  }
  return null;
}

/* The fake DOM does not model the static HTML tree, so the board's column
   bodies are reached individually rather than through #board. */
function boardText(harness) {
  const cols = ["waiting", "running", "review", "attention", "completed"];
  let out = "";
  for (let c = 0; c < cols.length; c++) {
    out += collectText(harness.document.querySelector('[data-body="' + cols[c] + '"]'));
  }
  return out;
}

function cardTitleParts(card) {
  const main = childArr(card).find((c) => c.className === "task-main");
  const h = childArr(main).find((c) => c.className === "card-title");
  return {
    name: childArr(h).find((c) => c.className === "card-title-name"),
    id: childArr(h).find((c) => String(c.className || "").indexOf("card-ticket-id") >= 0),
  };
}

function cardDuration(card) {
  const spans = findTags(card, "span");
  for (let i = 0; i < spans.length; i++) {
    const t = spans[i].textContent || "";
    if (/^(已运行|最近运行|尚未运行|运行时长未知)/.test(t)) return t;
  }
  return null;
}

function setSearch(harness, q) {
  const input = harness.document.querySelector("#search");
  input.value = q;
  input.dispatch("input", { target: { value: q } });
}

function selectProject(harness, value) {
  const sel = harness.document.querySelector("#project-filter");
  sel.value = value;
  sel.dispatch("change", { target: { value } });
}

/* A harness whose per-endpoint responses can be swapped between polls. */
function makeMutableHarness() {
  const responses = {};
  const harness = makeHarness((url) => {
    if (!(url in responses)) return Promise.reject(new Error("unexpected " + url));
    return Promise.resolve(responses[url]);
  });
  return {
    harness,
    set(url, data) { responses[url] = okJson(data); },
    fail(url) { responses[url] = Promise.reject(new Error(url + " failed")); },
  };
}

/* ----------------------------------------------------------------- tests */

async function testFailedAgentsFetch() {
  const harness = makeHarness((url) => {
    if (url === "/api/agents") return Promise.reject(new Error("agents unavailable"));
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks: [], truncated: false, partial: false }));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();

  const agentsErrorHidden = harness.document.querySelector("#agents-error").hidden;
  const indicator = harness.document.querySelector("#refresh-indicator").textContent;
  if (agentsErrorHidden !== false) throw new Error("agents error panel must be visible, got hidden=" + agentsErrorHidden);
  if (indicator.indexOf("更新失败") !== 0) throw new Error("refresh indicator must show failure, got: " + indicator);
  return { agents_error_hidden: agentsErrorHidden, refresh_indicator: indicator };
}

async function testOutOfOrderPoll() {
  const deferreds = [];
  const harness = makeHarness((url) => {
    const d = deferred();
    d.url = url;
    deferreds.push(d);
    return d.promise;
  });
  harness.run();           // poll #1 -> deferreds[0..2]
  harness.intervals[0]();  // poll #2 -> deferreds[3..5]
  await flush();

  // Resolve poll #2 (newer) first, then poll #1 (older).
  deferreds[3].resolve(okJson(summaryObj({ tasks: 2 })));
  deferreds[4].resolve(okJson({ tasks: [taskObj("T2", "obj2")], truncated: false, partial: false }));
  deferreds[5].resolve(okJson({ forests: [], truncated: false }));
  await flush();

  deferreds[0].resolve(okJson(summaryObj({ tasks: 1 })));
  deferreds[1].resolve(okJson({ tasks: [taskObj("T1", "obj1")], truncated: false, partial: false }));
  deferreds[2].resolve(okJson({ forests: [], truncated: false }));
  await flush();

  const summaryText = harness.document.querySelector("#workspace-summary").textContent;
  const boardText = collectText(harness.document.querySelector('[data-body="waiting"]'));
  if (summaryText.indexOf("任务 2") < 0) throw new Error("newer summary replaced by older; summary=" + summaryText);
  if (summaryText.indexOf("任务 1") >= 0) throw new Error("older summary leaked in; summary=" + summaryText);
  if (boardText.indexOf("obj2") < 0) throw new Error("newer task list lost; board=" + boardText);
  if (boardText.indexOf("obj1") >= 0) throw new Error("older task leaked in; board=" + boardText);
  return { summary: summaryText };
}

async function testShortTitle() {
  const tasks = [
    taskObj("T-IMP", "Implement normalize_label(value) for labels"),
    taskObj("T-ZH", "让任务与执行记录清楚易读"),
    taskObj("T-PROMPT", "You are a helpful coding assistant that reviews changes"),
    taskObj("T-HEAD", "# Frontend redesign assignment"),
  ];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 4 }), tasks, agents: { forests: [], truncated: false } });

  const waiting = harness.document.querySelector('[data-body="waiting"]');
  const cards = waiting.children;
  const nameOf = (idx) => cardTitleParts(cards[idx]).name.textContent;
  const idOf = (idx) => cardTitleParts(cards[idx]).id.textContent;

  if (nameOf(0) !== "实现 normalize_label") throw new Error("Implement lead not translated; got: " + nameOf(0));
  if (nameOf(1) !== "让任务与执行记录清楚易读") throw new Error("Chinese objective altered; got: " + nameOf(1));
  if (nameOf(2) !== "未命名任务") throw new Error("prompt-like title not neutralized; got: " + nameOf(2));
  if (nameOf(3) !== "未命名任务") throw new Error("# heading title not neutralized; got: " + nameOf(3));
  // The ticket id is always visible and complete, on its own span in the heading.
  if (idOf(0) !== " · T-IMP") throw new Error("ticket id missing for T-IMP: " + idOf(0));
  if (idOf(2) !== " · T-PROMPT") throw new Error("ticket id missing for T-PROMPT: " + idOf(2));
  if (idOf(3) !== " · T-HEAD") throw new Error("ticket id missing for T-HEAD: " + idOf(3));
  return { titles: [nameOf(0), nameOf(1), nameOf(2), nameOf(3)] };
}

async function testStateCardsAndSummary() {
  const tasks = [
    taskObj("T1", "a", { state: "running" }),
    taskObj("T2", "b", { state: "awaiting_review" }),
    taskObj("T3", "c", { state: "changes_requested" }),
    taskObj("T4", "d", { state: "blocked" }),
    taskObj("T5", "e", { state: "interrupted" }),
    taskObj("T6", "f", { state: "accepted" }),
  ];
  const by_state = { running: 1, awaiting_review: 1, changes_requested: 1, blocked: 1, interrupted: 1, accepted: 1 };
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 6, by_state, agents: 29, subagents: 3 }),
    tasks, agents: { forests: [], truncated: false },
  });

  const counts = harness.document.querySelector("#counts");
  const statCards = childArr(counts).filter((c) => c.className === "stat-card");
  if (statCards.length !== 4) throw new Error("expected 4 stat cards, got " + statCards.length);

  function statValue(card) {
    return childArr(card).find((c) => c.className === "stat-value").textContent;
  }
  function statLabel(card) {
    return childArr(card).find((c) => c.className === "stat-label").textContent;
  }
  const labels = statCards.map(statLabel).join("|");
  if (labels !== "进行中|待审查|需处理|已验收") throw new Error("stat labels wrong: " + labels);

  // 需处理 = changes_requested + blocked + interrupted = 3
  const attention = statCards.find((c) => statLabel(c) === "需处理");
  if (statValue(attention) !== "3") throw new Error("需处理 should be 3, got " + statValue(attention));

  const workspace = harness.document.querySelector("#workspace-summary").textContent;
  if (workspace.indexOf("任务 6") < 0) throw new Error("workspace summary missing task total: " + workspace);
  if (workspace.indexOf("会话记录 29") < 0) throw new Error("workspace summary missing session records: " + workspace);
  if (workspace.indexOf("子Agent记录 3") < 0) throw new Error("workspace summary missing subagent records: " + workspace);

  return { labels, workspace };
}

async function testUnknownStateNotReady() {
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 1 }),
    tasks: [taskObj("T1", "objective", { state: "mystery_state" })],
    agents: { forests: [], truncated: false },
  });
  const card = cardAt(harness, "waiting");
  const text = collectText(card);
  if (text.indexOf("未知状态") < 0) throw new Error("unknown state not labelled 未知状态: " + text);
  if (text.indexOf("待指派") >= 0) throw new Error("unknown state mislabelled as ready/待指派: " + text);
  return { text };
}

async function testAcceptedDetailNotMerged() {
  const tasks = [taskObj("T1", "objective", { id: "opaque-token", state: "accepted", revision: 1, base_commit: "abc123" })];
  const detail = {
    id: "opaque-token", ticket_id: "T1", revision: 1, state: "accepted",
    objective: "objective", repo: "repo", base_commit: "abc123",
    created_at: null, updated_at: null, blocked_reason: null, superseded: false,
    attempt_count: 1, review_count: 1, verification_count: 1,
    current_attempt_id: null, last_finish_reason: "completed",
    attempts: [{ attempt_id: "att-1", revision: 1, session_id: "sess-1", phase: "ended", finish_reason: "completed", started_at: null, ended_at: null }],
    reviews: [{ review_id: "rev-1", revision: 1, attempt_id: "att-1", verdict: "accept", finding_count: 0, created_at: null }],
    verifications: [{ verification_id: "ver-1", revision: 1, attempt_id: "att-1", passed: true, created_at: null }],
    history_truncated: false,
    agents: { nodes: [], roots: [], source_status: "unavailable", root_missing: false },
  };

  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    if (url === "/api/tasks/opaque-token") return Promise.resolve(okJson(detail));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();

  const card = cardAt(harness, "completed");
  card.dispatch("click");
  await flush();

  const bodyText = collectText(harness.document.querySelector("#detail-body"));
  if (bodyText.indexOf("验收通过") < 0) throw new Error("accepted detail missing 验收通过: " + bodyText);
  if (bodyText.indexOf("合并情况未记录") < 0 && bodyText.indexOf("未在此记录") < 0) {
    throw new Error("accepted detail missing 合并情况未记录 note: " + bodyText);
  }
  if (bodyText.indexOf("已合并") >= 0 || bodyText.toLowerCase().indexOf("merged") >= 0) {
    throw new Error("accepted detail falsely claims merged: " + bodyText);
  }
  return { body: bodyText.slice(0, 200) };
}

async function testLayoutToggle() {
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 1 }),
    tasks: [taskObj("T1", "obj", { state: "running" })],
    agents: { forests: [], truncated: false },
  });

  const board = harness.document.querySelector("#board");
  const listBtn = harness.document.querySelector("#layout-list");
  const boardBtn = harness.document.querySelector("#layout-board");

  if (!board.classList.contains("is-list")) throw new Error("board should default to is-list");
  if (board.classList.contains("is-board")) throw new Error("board should not be is-board initially");
  if (listBtn.getAttribute("aria-pressed") !== "true") throw new Error("list button aria-pressed should be true, got " + listBtn.getAttribute("aria-pressed"));

  boardBtn.dispatch("click");
  if (!board.classList.contains("is-board")) throw new Error("board should switch to is-board");
  if (board.classList.contains("is-list")) throw new Error("board should drop is-list after board toggle");
  if (boardBtn.getAttribute("aria-pressed") !== "true") throw new Error("board button aria-pressed should be true");
  if (listBtn.getAttribute("aria-pressed") !== "false") throw new Error("list button aria-pressed should be false");

  listBtn.dispatch("click");
  if (!board.classList.contains("is-list")) throw new Error("board should return to is-list");
  return { ok: true };
}

async function testEmptyColumnsFlagged() {
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 1 }),
    tasks: [taskObj("T1", "obj", { state: "running" })],
    agents: { forests: [], truncated: false },
  });

  const running = harness.document.querySelector('[data-column="running"]');
  const waiting = harness.document.querySelector('[data-column="waiting"]');
  if (running.classList.contains("is-empty")) throw new Error("running column with a task must not be is-empty");
  if (!waiting.classList.contains("is-empty")) throw new Error("empty waiting column must be is-empty");
  return { ok: true };
}

async function testNoHtmlInjection() {
  const payload = 'Implement <script>alert(1)</script> feature <img src=x onerror=alert(2)>';
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 1 }),
    tasks: [taskObj("T1", payload, { state: "ready" })],
    agents: { forests: [], truncated: false },
  });

  const card = cardAt(harness, "waiting");
  const text = collectText(card);
  if (text.indexOf("<script>alert(1)</script>") < 0) throw new Error("script text not preserved as text: " + text);
  if (findTags(card, "script").length > 0) throw new Error("script element created (HTML injection)");
  if (findTags(card, "img").length > 0) throw new Error("img element created (HTML injection)");
  return { ok: true };
}

async function testSessionRecordsNoteAndCollapse() {
  const forest = {
    forests: [{
      source: "home-1", label: "harness-home",
      nodes: [
        agentNode("a", { session_id: "sess-aaa-bbb-ccc", title: "You are a helpful assistant", is_root: true }),
      ],
      roots: ["a"], orphans: [], cycles: [],
    }],
    truncated: false, partial: false,
  };

  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 0, agents: 1 }),
    tasks: [], agents: forest,
  });

  // Switch to execution-records view to see the truthful subtitle.
  harness.document.querySelector("#nav-agents").dispatch("click");
  const sub = harness.document.querySelector("#view-sub").textContent;
  const title = harness.document.querySelector("#view-title").textContent;
  if (title !== "执行记录") throw new Error("agents view title should be 执行记录, got " + title);
  if (sub.indexOf("会话记录不代表当前在线") < 0) throw new Error("subtitle missing liveness note: " + sub);

  const forestBox = harness.document.querySelector("#agents-forest");
  const card = forestBox.children[0];
  const details = card.children[0];
  if (details.tagName !== "DETAILS") throw new Error("forest group must be a collapsed details element");
  if (details.open !== false) throw new Error("forest group must be collapsed by default");

  const text = collectText(forestBox);
  if (text.indexOf("执行会话 sess-aaa") < 0) throw new Error("prompt-like session title not neutralized: " + text);
  if (text.indexOf("You are a helpful assistant") >= 0) throw new Error("raw prompt title dominates: " + text);
  if (text.indexOf("存活状态 未知") >= 0) throw new Error("fake liveness badge present: " + text);
  if (text.indexOf("会话 ID：sess-aaa-bbb-ccc") < 0) throw new Error("full session id missing from technical details: " + text);

  return { sub, title };
}

function agentKindLabels(forestBox) {
  const nodes = findTags(forestBox, "div").filter((d) =>
    String(d.className || "").split(/\s+/).includes("agent-node"));
  return nodes.map((n) => {
    const row = childArr(n)[0];
    return childArr(row)[0].textContent;
  });
}

/* R2: an orphan (parent recorded outside the source) must read 父级缺失, never
  独立会话; subagent/fork/independent must each get their accurate label. */
async function testOrphanSessionNotIndependent() {
  const forest = {
    forests: [{
      source: "home-1", label: "harness-home",
      nodes: [
        agentNode("orphan", { session_id: "sess-orphan", parent_id: null, is_root: true, title: "orphan work" }),
        agentNode("sub", { session_id: "sess-sub", parent_id: "orphan", origin: "subagent", is_subagent: true }),
        agentNode("fork", { session_id: "sess-fork", parent_id: "orphan" }),
        agentNode("indep", { session_id: "sess-indep", parent_id: null, is_root: true, title: "standalone" }),
      ],
      roots: ["orphan", "indep"],
      orphans: ["sess-orphan"], cycles: [],
    }],
    truncated: false, partial: false,
  };

  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 0, agents: 4 }),
    tasks: [], agents: forest,
  });

  const forestBox = harness.document.querySelector("#agents-forest");
  const kinds = agentKindLabels(forestBox).sort();
  const expected = ["子Agent", "分支会话", "父级缺失", "独立会话"].sort();
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
    throw new Error("session kinds wrong (orphan must not be independent): " + JSON.stringify(kinds));
  }
  const text = collectText(forestBox);
  if (text.indexOf("父级不在当前来源") < 0) throw new Error("orphan explanation missing: " + text);
  return { kinds };
}

/* R3: source diagnostics / forest / nested session disclosures must keep their
   expanded (or collapsed) state across polling, and focused elements are
   restored by stable identity. */
async function testPollPreservesDisclosureState() {
  const summary = {
    counts: { tasks: 0, by_state: {}, agents: 1, subagents: 0 },
    sources: {
      controller: { key: "controller", label: "控制器", status: "error", error: "连接失败" },
      harness: [{ key: "home-1", label: "harness-home", status: "partial", truncated: true }],
    },
  };
  const agents = {
    forests: [{
      source: "home-1", label: "harness-home",
      nodes: [agentNode("a", { session_id: "sess-aaa", title: "task one" })],
      roots: ["a"], orphans: [], cycles: [],
    }],
    truncated: false, partial: false,
  };

  const harness = await loadSnapshot({ summary, tasks: [], agents });

  const sourceList = harness.document.querySelector("#source-status-list");
  const forestBox = harness.document.querySelector("#agents-forest");

  const sourceDet = findDisclosure(sourceList, "source:controller");
  const forestDet = findDisclosure(forestBox, "forest:home-1");
  const sessionDet = findDisclosure(forestBox, "session:a");
  if (!sourceDet) throw new Error("source diagnostic disclosure missing");
  if (!forestDet) throw new Error("forest disclosure missing");
  if (!sessionDet) throw new Error("session technical disclosure missing");

  sourceDet.open = true;
  forestDet.open = true;
  sessionDet.open = true;

  harness.intervals[0](); // poll #2 rebuilds sources + forest
  await flush();

  const sourceDet2 = findDisclosure(harness.document.querySelector("#source-status-list"), "source:controller");
  const forestDet2 = findDisclosure(harness.document.querySelector("#agents-forest"), "forest:home-1");
  const sessionDet2 = findDisclosure(harness.document.querySelector("#agents-forest"), "session:a");
  if (!sourceDet2 || sourceDet2.open !== true) throw new Error("source diagnostic open state lost after poll");
  if (!forestDet2 || forestDet2.open !== true) throw new Error("forest disclosure open state lost after poll");
  if (!sessionDet2 || sessionDet2.open !== true) throw new Error("session technical open state lost after poll");

  // User-closed sections must not be auto-reopened by the next poll.
  forestDet2.open = false;
  harness.intervals[0]();
  await flush();
  const forestDet3 = findDisclosure(harness.document.querySelector("#agents-forest"), "forest:home-1");
  if (forestDet3.open !== false) throw new Error("user-closed forest disclosure was auto-reopened");

  return { ok: true };
}

/* R3/R4: focus inside a disclosure is restored to the matching (new) summary
   after a poll rebuilds the container. */
async function testPollPreservesFocusedDisclosure() {
  const agents = {
    forests: [{
      source: "home-1", label: "harness-home",
      nodes: [agentNode("a", { session_id: "sess-aaa", title: "task one" })],
      roots: ["a"], orphans: [], cycles: [],
    }],
    truncated: false, partial: false,
  };
  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 0, agents: 1 }),
    tasks: [], agents,
  });

  const forestBox = harness.document.querySelector("#agents-forest");
  const forestDet = findDisclosure(forestBox, "forest:home-1");
  const summaryEl = childArr(forestDet).find((c) => c.tagName === "SUMMARY");
  summaryEl.focus();

  harness.intervals[0](); // poll #2 rebuilds forest
  await flush();

  const active = harness.document.activeElement;
  if (!active) throw new Error("focus was not preserved across poll");
  if (active.tagName !== "SUMMARY") throw new Error("focus not on a summary: " + active.tagName);
  const forestDet2 = findDisclosure(harness.document.querySelector("#agents-forest"), "forest:home-1");
  if (active !== childArr(forestDet2).find((c) => c.tagName === "SUMMARY")) {
    throw new Error("focus restored to the wrong summary element");
  }
  return { ok: true };
}

/* R4: closing the dialog focuses the current (post-rebuild) task button by
   stable token, never a detached old button; falls back to search otherwise. */
async function testCloseDetailFocusesConnectedButton() {
  const tasks = [taskObj("opaque-token", "obj", { id: "opaque-token", state: "ready", ticket_id: "T1" })];
  const detail = {
    id: "opaque-token", ticket_id: "T1", revision: 1, state: "ready",
    objective: "obj", repo: "", base_commit: "",
    created_at: null, updated_at: null, blocked_reason: null, superseded: false,
    attempt_count: 0, last_finish_reason: null,
    attempts: [], reviews: [], verifications: [], history_truncated: false,
    agents: { nodes: [], roots: [], source_status: "unavailable", root_missing: false },
  };
  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    if (url === "/api/tasks/opaque-token") return Promise.resolve(okJson(detail));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();

  const originalCard = cardAt(harness, "waiting");
  originalCard.dispatch("click");
  await flush();

  harness.intervals[0](); // poll #2 rebuilds board, detaching the original card
  await flush();

  harness.document.querySelector("#task-detail").dispatch("close");

  const active = harness.document.activeElement;
  if (!active) throw new Error("no focused element after close");
  if (active === originalCard) throw new Error("focus landed on detached task button");
  if (active.getAttribute("data-token") !== "opaque-token") {
    throw new Error("focus not restored to matching task button: " + active.getAttribute("data-token"));
  }
  if (active.isConnected !== true) throw new Error("focused element is not connected");
  return { ok: true };
}

/* R5: exactly one layout button is visually active, matching aria-pressed, and
   the initial HTML is-active on the list button is cleared on switch. */
async function testLayoutButtonActiveSync() {
  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks: [taskObj("T1", "obj", { state: "running" })], truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    return Promise.reject(new Error("unexpected " + url));
  });
  // Shared contract: HTML ships the list button with is-active initially.
  harness.document.querySelector("#layout-list").classList.add("is-active");
  harness.run();
  await flush();

  const listBtn = harness.document.querySelector("#layout-list");
  const boardBtn = harness.document.querySelector("#layout-board");
  if (!listBtn.classList.contains("is-active")) throw new Error("list button should start is-active");
  if (boardBtn.classList.contains("is-active")) throw new Error("board button should not start is-active");

  boardBtn.dispatch("click");
  if (listBtn.classList.contains("is-active")) throw new Error("list is-active not cleared after board selected");
  if (!boardBtn.classList.contains("is-active")) throw new Error("board is-active not set after board selected");
  if (boardBtn.getAttribute("aria-pressed") !== "true") throw new Error("board aria-pressed should be true");
  if (listBtn.getAttribute("aria-pressed") !== "false") throw new Error("list aria-pressed should be false");

  listBtn.dispatch("click");
  if (!listBtn.classList.contains("is-active")) throw new Error("list is-active not restored");
  if (boardBtn.classList.contains("is-active")) throw new Error("board is-active not cleared after list selected");
  return { ok: true };
}

/* R1 + R3: the detail dialog renders all disclosure sections (proving the
   HTMLCollection-safe traversal works) and preserves nested open/closed state
   across polling. */
async function testDetailDisclosurePreservedAcrossPoll() {
  const tasks = [taskObj("opaque-token", "objective", { id: "opaque-token", state: "ready", ticket_id: "T1" })];
  const detail = {
    id: "opaque-token", ticket_id: "T1", revision: 1, state: "ready",
    objective: "objective", repo: "repo", base_commit: "abc123",
    created_at: null, updated_at: null, blocked_reason: null, superseded: false,
    attempt_count: 1, last_finish_reason: "completed",
    attempts: [{ attempt_id: "att-1", revision: 1, session_id: "sess-1", phase: "ended", finish_reason: "completed", started_at: null, ended_at: null }],
    reviews: [], verifications: [], history_truncated: false,
    agents: { nodes: [], roots: [], source_status: "unavailable", root_missing: false },
  };
  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    if (url === "/api/tasks/opaque-token") return Promise.resolve(okJson(detail));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();

  cardAt(harness, "waiting").dispatch("click");
  await flush();

  const body = harness.document.querySelector("#detail-body");
  for (const key of ["disc-objective", "disc-attempts", "disc-reviews", "disc-technical", "disc-sessions"]) {
    if (!findDisclosure(body, key)) throw new Error("detail disclosure missing: " + key);
  }
  const nestedAttempt = findDisclosure(body, "attempt:att-1");
  if (!nestedAttempt) throw new Error("nested attempt technical disclosure missing");

  const attemptsDet = findDisclosure(body, "disc-attempts");
  attemptsDet.open = true;
  nestedAttempt.open = true;

  harness.intervals[0](); // poll #2 re-renders detail
  await flush();

  const body2 = harness.document.querySelector("#detail-body");
  const attemptsDet2 = findDisclosure(body2, "disc-attempts");
  const nestedAttempt2 = findDisclosure(body2, "attempt:att-1");
  const objectiveDet2 = findDisclosure(body2, "disc-objective");
  if (!attemptsDet2 || attemptsDet2.open !== true) throw new Error("执行历史 disclosure lost after poll");
  if (!nestedAttempt2 || nestedAttempt2.open !== true) throw new Error("nested attempt disclosure lost after poll");
  if (!objectiveDet2 || objectiveDet2.open !== false) throw new Error("closed 原始目标 disclosure was auto-reopened");

  return { ok: true };
}

/* R2-residual: orphan membership must use own-key lookup, never inherited
   Object.prototype members. A session whose id is toString/constructor/__proto__
   with an empty orphan set must still read 独立会话, never 父级缺失. */
async function testOrphanMembershipPrototypeSafe() {
  const forest = {
    forests: [{
      source: "home-1", label: "harness-home",
      nodes: [
        agentNode("n-tostring", { session_id: "toString", parent_id: null, is_root: true, title: "standalone toString" }),
        agentNode("n-constructor", { session_id: "constructor", parent_id: null, is_root: true, title: "standalone constructor" }),
        agentNode("n-proto", { session_id: "__proto__", parent_id: null, is_root: true, title: "standalone proto" }),
      ],
      roots: ["n-tostring", "n-constructor", "n-proto"], orphans: [], cycles: [],
    }],
    truncated: false, partial: false,
  };

  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 0, agents: 3 }),
    tasks: [], agents: forest,
  });

  const forestBox = harness.document.querySelector("#agents-forest");
  const kinds = agentKindLabels(forestBox).sort();
  if (kinds.length !== 3) throw new Error("expected 3 session labels, got " + JSON.stringify(kinds));
  for (const k of kinds) {
    if (k !== "独立会话") throw new Error("prototype-named session mislabelled (want all 独立会话): " + JSON.stringify(kinds));
  }
  const text = collectText(forestBox);
  if (text.indexOf("父级缺失") >= 0) throw new Error("prototype-named session falsely flagged as orphan: " + text);
  return { kinds };
}

/* R3-residual: session disclosure keys are source-qualified. Two forests from
   different sources may share a raw session_id; opening/closing/focus must stay
   independent across sources and never leak state across a poll rebuild. */
async function testDuplicateSessionIdAcrossSources() {
  const agents = {
    forests: [
      {
        source: "home-1", label: "harness-home",
        nodes: [agentNode("a1", { session_id: "sess-dup", title: "first home" })],
        roots: ["a1"], orphans: [], cycles: [],
      },
      {
        source: "home-2", label: "other-home",
        nodes: [agentNode("a2", { session_id: "sess-dup", title: "second home" })],
        roots: ["a2"], orphans: [], cycles: [],
      },
    ],
    truncated: false, partial: false,
  };

  const harness = await loadSnapshot({
    summary: summaryObj({ tasks: 0, agents: 2 }),
    tasks: [], agents,
  });

  const forestBox = harness.document.querySelector("#agents-forest");
  const detA = findDisclosure(forestBox, "session:a1");
  const detB = findDisclosure(forestBox, "session:a2");
  if (!detA || !detB) throw new Error("session disclosures missing across sources");
  if (detA.getAttribute("data-disc-key") === detB.getAttribute("data-disc-key")) {
    throw new Error("session disclosure keys collide across sources sharing a session_id");
  }

  // Open A, leave B closed.
  detA.open = true;
  detB.open = false;

  harness.intervals[0](); // poll rebuilds forests
  await flush();

  const forestBox2 = harness.document.querySelector("#agents-forest");
  const detA2 = findDisclosure(forestBox2, "session:a1");
  const detB2 = findDisclosure(forestBox2, "session:a2");
  if (!detA2 || detA2.open !== true) throw new Error("source A open state lost after poll");
  if (!detB2 || detB2.open !== false) throw new Error("source B session auto-opened across sources");

  // Focus B's summary; after a poll the focus must stay on B, not move to A.
  const bSummary = childArr(detB2).find((c) => c.tagName === "SUMMARY");
  bSummary.focus();
  harness.intervals[0]();
  await flush();

  const active = harness.document.activeElement;
  const forestBox3 = harness.document.querySelector("#agents-forest");
  const detB3 = findDisclosure(forestBox3, "session:a2");
  if (!active || active.tagName !== "SUMMARY") throw new Error("focus lost after poll");
  if (active !== childArr(detB3).find((c) => c.tagName === "SUMMARY")) {
    throw new Error("focus moved to source A instead of staying on source B");
  }
  if (detB3.open !== false) throw new Error("source B session auto-opened by focus restore");
  return { ok: true };
}

/* U5-integration: the detail overview must carry the existing detail-grid class
   so CSS lays out each label above its value instead of running them together. */
async function testDetailOverviewGridClass() {
  const tasks = [taskObj("opaque-token", "objective", { id: "opaque-token", state: "ready", ticket_id: "T1" })];
  const detail = {
    id: "opaque-token", ticket_id: "T1", revision: 1, state: "ready",
    objective: "objective", repo: "repo", base_commit: "abc123",
    created_at: null, updated_at: null, blocked_reason: null, superseded: false,
    attempt_count: 0, last_finish_reason: null,
    attempts: [], reviews: [], verifications: [], history_truncated: false,
    agents: { nodes: [], roots: [], source_status: "unavailable", root_missing: false },
  };
  const harness = makeHarness((url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 1 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    if (url === "/api/tasks/opaque-token") return Promise.resolve(okJson(detail));
    return Promise.reject(new Error("unexpected " + url));
  });
  harness.run();
  await flush();

  cardAt(harness, "waiting").dispatch("click");
  await flush();

  const body = harness.document.querySelector("#detail-body");
  const overview = childArr(body)[0];
  if (!overview) throw new Error("detail overview missing");
  const cls = String(overview.className || "").split(/\s+/);
  if (!cls.includes("detail-grid")) throw new Error("detail overview missing detail-grid class: " + overview.className);
  if (!cls.includes("detail-overview")) throw new Error("detail overview missing detail-overview class: " + overview.className);
  // The overview must still render its kv pairs (label + value).
  if (collectText(overview).indexOf("状态") < 0) throw new Error("overview missing 状态 field");
  return { ok: true };
}

/* M3: explicit issue title takes precedence (never machine-translated), the
   ticket id is always visible and complete next to it. */
async function testExplicitTitleAndNumber() {
  const tasks = [
    taskObj("BOARD-101", "some objective", { title: "  Add   board metadata  ", state: "ready" }),
  ];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 1 }), tasks, agents: { forests: [], truncated: false } });
  const card = cardAt(harness, "waiting");
  const parts = cardTitleParts(card);
  if (!parts.name || parts.name.textContent !== "Add board metadata") {
    throw new Error("explicit title not whitespace-normalized (and must not be translated): " + (parts.name && parts.name.textContent));
  }
  if (!parts.id || parts.id.textContent !== " · BOARD-101") {
    throw new Error("ticket id missing/incorrect in title: " + (parts.id && parts.id.textContent));
  }
  return { name: parts.name.textContent, id: parts.id.textContent };
}

/* M3: all four duration modes, hours/days for long durations, and invalid
   elapsed must never clamp to zero. */
async function testDurationModes() {
  const tasks = [
    taskObj("T-RUN", "a", { state: "running", execution: { state: "running", started_at: "2024-01-01T00:00:00Z", ended_at: null, elapsed_seconds: 754 } }),
    taskObj("T-FIN", "b", { state: "accepted", execution: { state: "finished", started_at: "2024-01-01T00:00:00Z", ended_at: "2024-01-01T00:12:34Z", elapsed_seconds: 754 } }),
    taskObj("T-NEW", "c", { state: "ready", execution: { state: "not_started", started_at: null, ended_at: null, elapsed_seconds: null } }),
    taskObj("T-UNK", "d", { state: "blocked", execution: { state: "unknown", started_at: null, ended_at: null, elapsed_seconds: null } }),
    taskObj("T-LONG", "e", { state: "accepted", execution: { state: "finished", started_at: "2024-01-01T00:00:00Z", ended_at: "2024-01-03T00:00:00Z", elapsed_seconds: 90061 } }),
    taskObj("T-BAD", "f", { state: "accepted", execution: { state: "finished", started_at: "x", ended_at: "y", elapsed_seconds: -5 } }),
  ];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 6 }), tasks, agents: { forests: [], truncated: false } });

  const d = (token) => cardDuration(findCardByToken(harness, token));
  if (d("T-RUN") !== "已运行 12分34秒") throw new Error("running duration wrong: " + d("T-RUN"));
  if (d("T-FIN") !== "最近运行 12分34秒") throw new Error("finished duration wrong: " + d("T-FIN"));
  if (d("T-NEW") !== "尚未运行") throw new Error("not_started duration wrong: " + d("T-NEW"));
  if (d("T-UNK") !== "运行时长未知") throw new Error("unknown duration wrong: " + d("T-UNK"));
  if (d("T-LONG") !== "最近运行 1天1小时1分1秒") throw new Error("long duration wrong: " + d("T-LONG"));
  if (d("T-BAD") !== "运行时长未知") throw new Error("invalid elapsed must not clamp to zero: " + d("T-BAD"));
  return { long: d("T-LONG") };
}

/* R1: elapsed_seconds must be an actual finite nonnegative number. null/false/
   ""/[]/numeric-strings are not numbers and must NOT fabricate 0 seconds in
   either running or finished; a genuine 0 is still a valid nonnegative value. */
async function testDurationRejectsFabricatedZero() {
  const notNumbers = [null, false, "", [], "60"];
  const mk = (token, state, exState, elapsed) => taskObj(token, "x", {
    state,
    execution: { state: exState, started_at: null, ended_at: null, elapsed_seconds: elapsed },
  });
  const tasks = [];
  notNumbers.forEach((v, i) => {
    tasks.push(mk("RUN-" + i, "running", "running", v));
    tasks.push(mk("FIN-" + i, "accepted", "finished", v));
  });
  tasks.push(mk("RUN-ZERO", "running", "running", 0));
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: tasks.length }), tasks, agents: { forests: [], truncated: false } });

  for (let i = 0; i < notNumbers.length; i++) {
    const rd = cardDuration(findCardByToken(harness, "RUN-" + i));
    const fd = cardDuration(findCardByToken(harness, "FIN-" + i));
    if (rd !== "运行时长未知") throw new Error("running fabricated zero for " + JSON.stringify(notNumbers[i]) + ": " + rd);
    if (fd !== "运行时长未知") throw new Error("finished fabricated zero for " + JSON.stringify(notNumbers[i]) + ": " + fd);
  }
  const zero = cardDuration(findCardByToken(harness, "RUN-ZERO"));
  if (zero !== "已运行 0秒") throw new Error("valid numeric 0 must render 0秒, got: " + zero);
  return { ok: true };
}

/* M3: running duration updates on each poll; finished stays 最近运行 (never a
   live 已运行). */
async function testPollUpdatesRunningDuration() {
  const mkRun = (elapsed) => taskObj("T-RUN", "a", { state: "running", execution: { state: "running", started_at: "2024-01-01T00:00:00Z", ended_at: null, elapsed_seconds: elapsed } });
  const mh = makeMutableHarness();
  mh.set("/api/summary", summaryObj({ tasks: 1 }));
  mh.set("/api/tasks", { tasks: [mkRun(60)], truncated: false, partial: false });
  mh.set("/api/agents", { forests: [], truncated: false });
  mh.harness.run();
  await flush();

  if (cardDuration(findCardByToken(mh.harness, "T-RUN")) !== "已运行 1分") {
    throw new Error("initial running duration wrong: " + cardDuration(findCardByToken(mh.harness, "T-RUN")));
  }

  mh.set("/api/tasks", { tasks: [mkRun(125)], truncated: false, partial: false });
  mh.harness.intervals[0]();
  await flush();
  const updatedRunning = cardDuration(findCardByToken(mh.harness, "T-RUN"));
  if (updatedRunning !== "已运行 2分5秒") throw new Error("running duration not updated on poll: " + updatedRunning);

  const finTask = taskObj("T-FIN", "b", { state: "accepted", execution: { state: "finished", started_at: "2024-01-01T00:00:00Z", ended_at: "2024-01-01T00:10:00Z", elapsed_seconds: 600 } });
  mh.set("/api/tasks", { tasks: [finTask], truncated: false, partial: false });
  mh.harness.intervals[0]();
  await flush();
  const finished = cardDuration(findCardByToken(mh.harness, "T-FIN"));
  if (finished !== "最近运行 10分") throw new Error("finished duration wrong: " + finished);
  if (finished.indexOf("已运行") >= 0) throw new Error("finished task must not read 已运行: " + finished);
  return { running: updatedRunning, finished };
}

/* M3: equal project names are disambiguated by id suffix; filtering is by id
   (never name); the four summary counts and task total follow the selection. */
async function testProjectCollisionFilterCount() {
  const tasks = [
    taskObj("P1-A", "a", { state: "running", project: { id: "named:team", name: "看板" } }),
    taskObj("P1-B", "b", { state: "awaiting_review", project: { id: "named:team", name: "看板" } }),
    taskObj("P2-A", "c", { state: "accepted", project: { id: "named:team-other", name: "看板" } }),
  ];
  const by_state = { running: 1, awaiting_review: 1, accepted: 1 };
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 3, by_state, agents: 5, subagents: 1 }), tasks, agents: { forests: [], truncated: false } });

  const sel = harness.document.querySelector("#project-filter");
  const options = childArr(sel);
  if (options.length !== 3) throw new Error("expected 3 project options (all + 2), got " + options.length);

  const labels = options.map((o) => o.textContent);
  if (new Set(labels).size !== labels.length) throw new Error("project options not distinguishable: " + labels.join("|"));
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].indexOf("·") < 0) throw new Error("colliding project option missing id suffix: " + labels[i]);
  }
  const values = options.map((o) => o.value);
  if (new Set(values).size !== values.length) throw new Error("project option values not distinct: " + values.join("|"));

  selectProject(harness, "named:team");
  await flush();

  const visible = boardText(harness);
  if (visible.indexOf("P1-A") < 0 || visible.indexOf("P1-B") < 0) throw new Error("selected project tasks missing: " + visible);
  if (visible.indexOf("P2-A") >= 0) throw new Error("same-name other project leaked into filter: " + visible);

  const counts = harness.document.querySelector("#counts");
  const statCards = childArr(counts).filter((c) => c.className === "stat-card");
  const statLabel = (card) => childArr(card).find((c) => c.className === "stat-label").textContent;
  const statValue = (card) => childArr(card).find((c) => c.className === "stat-value").textContent;
  const val = (label) => statValue(statCards.find((c) => statLabel(c) === label));
  if (val("进行中") !== "1") throw new Error("进行中 count should be 1 for project");
  if (val("待审查") !== "1") throw new Error("待审查 count should be 1 for project");
  if (val("已验收") !== "0") throw new Error("已验收 count should be 0 (accepted belongs to other project)");

  const workspace = harness.document.querySelector("#workspace-summary").textContent;
  if (workspace.indexOf("任务 2") < 0) throw new Error("workspace task count not scoped to project: " + workspace);
  if (workspace.indexOf("全局会话记录 5") < 0) throw new Error("session counts not marked global under a project: " + workspace);
  return { labels, workspace };
}

/* R2: same-name projects whose ids share a trailing suffix must still get
   unique labels (never two identical "Name · shared"). Disambiguation uses the
   human id without the named: prefix, growing the prefix until distinct. */
async function testProjectSameSuffixDisambiguation() {
  const tasks = [
    taskObj("A1", "a", { state: "running", project: { id: "named:team-alpha-shared", name: "Same" } }),
    taskObj("A2", "b", { state: "ready", project: { id: "named:team-beta-shared", name: "Same" } }),
  ];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 2 }), tasks, agents: { forests: [], truncated: false } });

  const sel = harness.document.querySelector("#project-filter");
  const labels = childArr(sel).slice(1).map((o) => o.textContent); // skip 全部项目
  if (labels.length !== 2) throw new Error("expected 2 project options, got " + labels.length);
  if (labels[0] === labels[1]) throw new Error("same-name projects not disambiguated: " + labels.join("|"));
  for (const l of labels) {
    if (l.indexOf("named:") >= 0) throw new Error("label leaked the named: prefix: " + l);
    if (l.indexOf("·") < 0) throw new Error("colliding label missing disambiguator: " + l);
  }
  // Cards must show the same disambiguated labels as the options.
  const board = boardText(harness);
  for (const l of labels) {
    if (board.indexOf(l) < 0) throw new Error("card label not matching option (" + l + "): " + board);
  }
  return { labels };
}

/* M3: project selection persists with the existing preferences and restores
   the filter (and the filtered board) across a reload. */
async function testProjectFilterPersistence() {
  const tasks = [
    taskObj("T1", "a", { project: { id: "named:p1", name: "项目一" } }),
    taskObj("T2", "b", { project: { id: "named:p2", name: "项目二" } }),
  ];
  const makeFetch = () => (url) => {
    if (url === "/api/summary") return Promise.resolve(okJson(summaryObj({ tasks: 2 })));
    if (url === "/api/tasks") return Promise.resolve(okJson({ tasks, truncated: false, partial: false }));
    if (url === "/api/agents") return Promise.resolve(okJson({ forests: [], truncated: false }));
    return Promise.reject(new Error("unexpected " + url));
  };

  const store = {};
  const h1 = makeHarness(makeFetch(), store);
  h1.run();
  await flush();
  selectProject(h1, "named:p1");
  await flush();

  const saved = JSON.parse(store["dsh-dashboard-ui"]);
  if (saved.projectFilter !== "named:p1") throw new Error("project filter not persisted: " + JSON.stringify(saved));

  const h2 = makeHarness(makeFetch(), store);
  h2.run();
  await flush();

  const sel = h2.document.querySelector("#project-filter");
  if (sel.value !== "named:p1") throw new Error("project filter not restored: " + sel.value);
  const visible = boardText(h2);
  if (visible.indexOf("T1") < 0) throw new Error("selected project task missing after restore");
  if (visible.indexOf("T2") >= 0) throw new Error("unselected project task leaked after restore");
  return { saved: saved.projectFilter };
}

/* M3: a selected project stays visible/preserved across transient failures and
   across successful polls that no longer contain it (with an explicit hint). */
async function testProjectFilterUnavailableRetained() {
  const mh = makeMutableHarness();
  mh.set("/api/summary", summaryObj({ tasks: 1 }));
  mh.set("/api/tasks", { tasks: [taskObj("T1", "a", { project: { id: "named:p1", name: "项目一" } })], truncated: false, partial: false });
  mh.set("/api/agents", { forests: [], truncated: false });
  mh.harness.run();
  await flush();

  selectProject(mh.harness, "named:p1");
  await flush();

  mh.fail("/api/tasks");
  mh.harness.intervals[0]();
  await flush();
  let sel = mh.harness.document.querySelector("#project-filter");
  if (sel.value !== "named:p1") throw new Error("selection lost on transient failure: " + sel.value);

  mh.set("/api/tasks", { tasks: [taskObj("T2", "b", { project: { id: "named:p2", name: "项目二" } })], truncated: false, partial: false });
  mh.harness.intervals[0]();
  await flush();

  sel = mh.harness.document.querySelector("#project-filter");
  const values = childArr(sel).map((o) => o.value);
  if (values.indexOf("named:p1") < 0) throw new Error("selected unavailable project option removed");
  if (sel.value !== "named:p1") throw new Error("selection silently turned off: " + sel.value);
  const retained = childArr(sel).find((o) => o.value === "named:p1");
  if (retained.textContent.indexOf("暂无任务") < 0) throw new Error("retained option missing hint: " + retained.textContent);

  const empty = mh.harness.document.querySelector("#tasks-empty");
  if (empty.hidden !== false) throw new Error("empty state should be visible for unavailable project");
  if (collectText(empty).indexOf("所选项目当前没有匹配的任务") < 0) throw new Error("missing project empty hint: " + collectText(empty));
  return { retainedLabel: retained.textContent };
}

/* R3: a saved project selection must survive a reload whose FIRST /api/tasks
   poll fails. The boot code must seed a placeholder option (with the saved
   label) before assigning .value, so the select stays selected instead of
   falling back to selectedIndex=-1/value=""; recovery then reconciles. */
async function testProjectFilterSavedSelectionFirstFailure() {
  const store = {
    "dsh-dashboard-ui": JSON.stringify({
      view: "tasks", layout: "list", projectFilter: "named:alpha",
      projectNames: { "named:alpha": "项目一" },
    }),
  };
  const responses = {};
  const fetchImpl = (url) => {
    if (!(url in responses)) return Promise.reject(new Error("unexpected " + url));
    return Promise.resolve(responses[url]);
  };
  responses["/api/summary"] = okJson(summaryObj({ tasks: 1 }));
  responses["/api/agents"] = okJson({ forests: [], truncated: false });
  responses["/api/tasks"] = Promise.reject(new Error("503 first load"));

  const harness = makeHarness(fetchImpl, store);
  harness.run();
  await flush();

  const sel = harness.document.querySelector("#project-filter");
  if (sel.selectedIndex < 0) throw new Error("saved project selection dropped (selectedIndex -1) on first failure");
  if (sel.value !== "named:alpha") throw new Error("saved project selection lost on first failure: " + JSON.stringify(sel.value));
  const labels = childArr(sel).map((o) => o.textContent).join("|");
  if (labels.indexOf("项目一") < 0) throw new Error("saved project label missing from options: " + labels);

  // Recovery: a later poll succeeds but no longer contains the saved project.
  responses["/api/tasks"] = okJson({
    tasks: [taskObj("T2", "b", { project: { id: "named:beta", name: "项目二" } })],
    truncated: false, partial: false,
  });
  harness.intervals[0]();
  await flush();

  if (sel.value !== "named:alpha") throw new Error("selection lost after recovery: " + sel.value);
  const retained = childArr(sel).find((o) => o.value === "named:alpha");
  if (!retained || retained.textContent.indexOf("暂无任务") < 0) {
    throw new Error("retained option missing hint: " + (retained && retained.textContent));
  }
  return { selected: sel.value, retainedLabel: retained.textContent };
}

/* M3: search covers the explicit title, ticket id, project name and existing
   objective/repo, and stays composable with clearing. */
async function testSearchTitleAndProject() {
  const tasks = [
    taskObj("T1", "build the thing", { title: "Login form", project: { id: "named:auth", name: "认证系统" } }),
    taskObj("T2", "other work", { title: "Logout flow", project: { id: "named:billing", name: "计费平台" } }),
  ];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 2 }), tasks, agents: { forests: [], truncated: false } });

  setSearch(harness, "Login");
  let visible = boardText(harness);
  if (visible.indexOf("Login form") < 0) throw new Error("title search missed: " + visible);
  if (visible.indexOf("Logout") >= 0) throw new Error("title search overmatched: " + visible);

  setSearch(harness, "认证");
  visible = boardText(harness);
  if (visible.indexOf("Login form") < 0) throw new Error("project-name search missed: " + visible);
  if (visible.indexOf("Logout") >= 0) throw new Error("project-name search overmatched: " + visible);

  setSearch(harness, "");
  visible = boardText(harness);
  if (visible.indexOf("Logout flow") < 0) throw new Error("clearing search should restore all: " + visible);
  return { ok: true };
}

/* M3: a long title never hides or truncates the ticket id, which stays its own
   fully visible element in the heading. */
async function testLongTitleIdVisible() {
  const longTitle = "很长的标题".repeat(40); // 200 chars
  const tasks = [taskObj("BOARD-2024", "obj", { title: longTitle, state: "ready" })];
  const harness = await loadSnapshot({ summary: summaryObj({ tasks: 1 }), tasks, agents: { forests: [], truncated: false } });
  const card = cardAt(harness, "waiting");
  const parts = cardTitleParts(card);
  if (!parts.name || parts.name.textContent !== longTitle) throw new Error("explicit long title not preserved");
  if (!parts.id || parts.id.textContent !== " · BOARD-2024") throw new Error("ticket id not fully visible: " + (parts.id && parts.id.textContent));
  return { ok: true };
}

/* ------------------------------------------------------------------ main */

(async function main() {
  const tests = {
    failed_fetch: testFailedAgentsFetch,
    out_of_order: testOutOfOrderPoll,
    short_title: testShortTitle,
    state_cards: testStateCardsAndSummary,
    unknown_state: testUnknownStateNotReady,
    accepted_detail: testAcceptedDetailNotMerged,
    layout_toggle: testLayoutToggle,
    empty_columns: testEmptyColumnsFlagged,
    no_html_injection: testNoHtmlInjection,
    session_records: testSessionRecordsNoteAndCollapse,
    orphan_session: testOrphanSessionNotIndependent,
    orphan_membership: testOrphanMembershipPrototypeSafe,
    poll_disclosures: testPollPreservesDisclosureState,
    poll_focus: testPollPreservesFocusedDisclosure,
    close_focus: testCloseDetailFocusesConnectedButton,
    layout_active: testLayoutButtonActiveSync,
    detail_disclosures: testDetailDisclosurePreservedAcrossPoll,
    duplicate_session_id: testDuplicateSessionIdAcrossSources,
    detail_overview_grid: testDetailOverviewGridClass,
    explicit_title: testExplicitTitleAndNumber,
    duration_modes: testDurationModes,
    duration_rejects_fabricated_zero: testDurationRejectsFabricatedZero,
    poll_running_duration: testPollUpdatesRunningDuration,
    project_collision: testProjectCollisionFilterCount,
    project_same_suffix: testProjectSameSuffixDisambiguation,
    project_persistence: testProjectFilterPersistence,
    project_unavailable: testProjectFilterUnavailableRetained,
    project_saved_first_failure: testProjectFilterSavedSelectionFirstFailure,
    search_title_project: testSearchTitleAndProject,
    long_title_id: testLongTitleIdVisible,
  };

  const results = {};
  for (const [name, fn] of Object.entries(tests)) {
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = { error: e && e.message ? e.message : String(e) };
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const failed = Object.values(results).some((r) => r && r.error);
  process.exit(failed ? 1 : 0);
})();
