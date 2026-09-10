import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Controller } from "../packages/core/src/controller.js";
import { startHttp } from "../packages/server/src/http.js";
import { fixture, FakeRuntime } from "./helpers.js";
it("scopes workspace metrics to the archive selection before search and status filters", async () => {
  const f = fixture();
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  const ticket = c.prepare(f.ticket);
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    // Reproduce a current accepted task alongside an archived interruption.
    const tickets = [
      { ...ticket, state: "accepted", archived: false, stale: false },
      { ...ticket, state: "interrupted", archived: true, stale: false },
    ];
    await page.route("**/api/overview", async (route) => {
      const response = await route.fetch();
      const overview = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        json: {
          ...overview,
          tickets: tickets.map((t, i) => ({
            ...t,
            ticket: { ...t.ticket, ticketId: `METRIC-${i}` },
          })),
        },
      });
    });
    const metrics = () =>
      page.locator("#metrics .metric-number").allTextContents();
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await expect.poll(metrics).toEqual(["0", "0", "0", "1"]);
    expect(await page.locator("#task-count").textContent()).toBe("1 个任务");

    await page.getByLabel("归档筛选", { exact: true }).selectOption("archived");
    await expect.poll(metrics).toEqual(["0", "0", "1", "0"]);
    expect(await page.locator(".task .task-id").allTextContents()).toEqual([
      "METRIC-1",
    ]);
    await page.getByLabel("归档筛选", { exact: true }).selectOption("all");
    await expect.poll(metrics).toEqual(["0", "0", "1", "1"]);
    expect(await page.locator("#task-count").textContent()).toBe("2 个任务");

    // All counters share the scope, including expired acceptance evidence.
    tickets.push(
      { ...ticket, state: "running", archived: false, stale: false },
      { ...ticket, state: "awaiting_review", archived: true, stale: false },
      { ...ticket, state: "accepted", archived: false, stale: true },
      { ...ticket, state: "accepted", archived: true, stale: false },
    );
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(metrics).toEqual(["1", "1", "2", "2"]);
    await page.getByLabel("归档筛选", { exact: true }).selectOption("archived");
    await expect.poll(metrics).toEqual(["0", "1", "1", "1"]);
    await page.getByLabel("归档筛选", { exact: true }).selectOption("active");
    await expect.poll(metrics).toEqual(["1", "0", "1", "1"]);

    await page
      .getByLabel("筛选状态", { exact: true })
      .selectOption("attention");
    expect(await page.locator(".task .task-id").allTextContents()).toEqual([
      "METRIC-4",
    ]);
    await page.getByLabel("搜索任务", { exact: true }).fill("no matching task");
    await expect.poll(() => page.locator(".task").count()).toBe(0);
    expect(await metrics()).toEqual(["1", "0", "1", "1"]);
    await page.getByRole("button", { name: "看板", exact: true }).click();
    expect(await metrics()).toEqual(["1", "0", "1", "1"]);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);

it("lets the user explicitly restart a pending delivery-only recovery from the Web", async () => {
  const f = fixture();
  const runtime = new FakeRuntime();
  runtime.handler = async () => ({ finalResponse: "Missing delivery" });
  const c = new Controller({ home: f.home, runtime, dispatchEnabled: true });
  c.prepare(f.ticket);
  c.run(f.ticket.ticketId);
  const failed = await c.wait(f.ticket.ticketId);
  await c.recover({
    kind: "delivery",
    ticketId: f.ticket.ticketId,
    revision: 1,
    attemptId: failed.attempts[0]!.id,
    snapshotDigest: failed.currentSnapshot,
    instruction: "Only report existing evidence",
  });
  writeFileSync(join(failed.worktree, "source.txt"), "external change\n");
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.locator(".task").click();
    const kind = page.getByLabel("续作方式", { exact: true });
    await expect
      .poll(() => kind.locator("option").allTextContents())
      .toEqual(["新会话继续"]);
    await page
      .getByLabel("续作要求", { exact: true })
      .fill("Continue from the inspected external change");
    await page
      .getByRole("button", { name: "检查恢复条件", exact: true })
      .click();
    await page.getByRole("button", { name: "登记续作", exact: true }).click();
    await expect
      .poll(() => c.status(f.ticket.ticketId).pendingDelivery)
      .toBeUndefined();
    expect(c.status(f.ticket.ticketId).state).toBe("ready");
    expect(runtime.count).toBe(1);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);
it("preserves the next instruction draft while the previous receipt is pending", async () => {
  const f = fixture();
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  c.prepare(f.ticket);
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route("**/api/actions", async (route) => {
      const response = await route.fetch();
      entered();
      await barrier;
      await route.fulfill({ response });
    });
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.locator(".task").click();
    const input = page.getByLabel("追加自然语言指令", { exact: true });
    await input.fill("First instruction");
    await page
      .getByRole("button", { name: "保存执行指令", exact: true })
      .click();
    await requested;
    await input.fill("Second unsent instruction");
    release();
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "保存执行指令", exact: true })
          .isEnabled(),
      )
      .toBe(true);
    expect(await input.inputValue()).toBe("Second unsent instruction");
    expect(
      c.store.get(f.ticket.ticketId).instructions?.map((i) => i.text),
    ).toEqual(["First instruction"]);
  } finally {
    release();
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);
it("keeps the latest selected task when detail responses arrive out of order", async () => {
  const f = fixture();
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  c.prepare({ ...f.ticket, ticketId: "RACE-A", title: "Task A" });
  c.prepare({ ...f.ticket, ticketId: "RACE-B", title: "Task B" });
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route("**/api/tickets/RACE-A", async (route) => {
      const response = await route.fetch();
      entered();
      await barrier;
      await route.fulfill({ response });
    });
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.locator(".task").filter({ hasText: "Task A" }).click();
    await requested;
    await page.locator(".task").filter({ hasText: "Task B" }).click();
    await page.getByRole("heading", { name: "Task B", exact: true }).waitFor();
    const completed = page.waitForResponse("**/api/tickets/RACE-A");
    release();
    await completed;
    // A polling refresh must also keep B even when both tasks share state/version.
    await page.waitForTimeout(3500);
    expect(await page.locator("#detail-title").textContent()).toBe("Task B");
    expect(await page.locator("#detail-body").textContent()).toContain(
      '"ticketId": "RACE-B"',
    );
  } finally {
    release();
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);
it("desktop UI creates, verifies and reviews using the same typed controller", async () => {
  const f = fixture();
  const c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.getByRole("button", { name: "＋ 新建任务" }).click();
    expect(await page.locator("[name=model]").inputValue()).toBe(
      "deepseek-v4-pro",
    );
    await page.locator("[name=ticketId]").fill(f.ticket.ticketId);
    await page.locator("[name=title]").fill("实现可审查的代码变更");
    await page.locator("[name=targetRepo]").fill(f.ticket.targetRepo);
    await page.locator("[name=baseCommit]").fill(f.ticket.baseCommit);
    await page.locator("[name=objective]").fill(f.ticket.objective);
    await page.locator("[name=paths]").fill("source.txt");
    await page
      .locator("[name=acceptance]")
      .fill(f.ticket.acceptance[0]!.description);
    await page.getByText("高级派工单", { exact: true }).click();
    await page.locator("#ticket-json").fill(JSON.stringify(f.ticket));
    await page.getByRole("button", { name: "准备工作目录" }).click();
    await page.locator("#create").waitFor({ state: "hidden" });
    await page.locator(".task").first().click();
    await page.getByRole("button", { name: "开始实现", exact: true }).click();
    await c.wait(f.ticket.ticketId);
    // The already-open dialog must load full evidence when overview changes.
    await page
      .getByText("代码差异", { exact: true })
      .waitFor({ state: "attached" });
    await page.getByText(/^第 1 次执行/).click();
    await page.getByText("代码差异", { exact: true }).click();
    await page.getByText("+implemented", { exact: false }).waitFor();
    expect(await page.locator("#detail-body").textContent()).toContain(
      '"path": "source.txt"',
    );
    await page.getByRole("button", { name: "运行独立验证" }).click();
    await c.wait(f.ticket.ticketId);
    await page.getByRole("button", { name: "刷新详情", exact: true }).click();
    await page
      .getByLabel("审查者", { exact: true })
      .fill("Browser acceptance reviewer");
    await page.getByRole("button", { name: "验收通过", exact: true }).click();
    await page
      .getByText("验收通过 · 合并情况未记录", { exact: true })
      .waitFor();
    expect(c.status(f.ticket.ticketId).state).toBe("accepted");
    // Keep the detail open: polling must display and clear freshness changes.
    const worktree = c.status(f.ticket.ticketId).worktree;
    writeFileSync(join(worktree, "source.txt"), "changed after acceptance\n");
    await page
      .getByText("工作目录已变化，原验收证据过期", { exact: false })
      .waitFor({ timeout: 10000 });
    writeFileSync(join(worktree, "source.txt"), "implemented\n");
    await page
      .getByText("工作目录已变化，原验收证据过期", { exact: false })
      .waitFor({ state: "hidden", timeout: 10000 });

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    mkdirSync(".scratch/typescript-rebuild/browser", { recursive: true });
    await page.screenshot({
      path: ".scratch/typescript-rebuild/browser/desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "看板", exact: true }).click();
    expect(await page.locator(".board-column").count()).toBe(5);
    await page.getByRole("button", { name: "列表", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel("搜索任务", { exact: true }).fill("does-not-exist");
    await page.getByText("没有匹配的任务", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 30000);

it("desktop natural-language entry, live agent trajectory, revision editing and archive work together", async () => {
  const f = fixture();
  f.ticket.execution.timeoutSeconds = 60;
  const { SdkRuntime } = await import("../packages/runtime/src/adapter.js");
  const c = new Controller({
    home: f.home,
    runtime: new SdkRuntime(resolve("dist/runner.js")),
    dispatchEnabled: true,
    dshBin: resolve("tests/fixtures/steering.mjs"),
  });
  const http = await startHttp(c, {
    port: 0,
    token: "c".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(http.url + "/#token=" + "c".repeat(64));
    await page.getByLabel("你希望 Worker 完成什么？").fill(f.ticket.objective);
    await page
      .getByRole("button", { name: "用这条指令创建任务", exact: true })
      .click();
    expect(await page.locator("[name=objective]").inputValue()).toBe(
      f.ticket.objective,
    );
    await page.locator("[name=ticketId]").fill(f.ticket.ticketId);
    await page.locator("[name=targetRepo]").fill(f.ticket.targetRepo);
    await page.locator("[name=baseCommit]").fill(f.ticket.baseCommit);
    await page.locator("[name=paths]").fill("source.txt");
    await page
      .locator("[name=acceptance]")
      .fill(f.ticket.acceptance[0]!.description);
    await page.getByText("高级派工单", { exact: true }).click();
    await page.locator("#ticket-json").fill(JSON.stringify(f.ticket));
    await page
      .getByRole("button", { name: "准备工作目录", exact: true })
      .click();
    await page.locator("#create").waitFor({ state: "hidden" });
    await page.locator(".task").first().click();
    await page
      .getByLabel("追加自然语言指令", { exact: true })
      .fill("Keep the change small.");
    await page
      .getByRole("button", { name: "保存执行指令", exact: true })
      .click();
    await page.getByText("等待下次执行 · 版本 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "开始实现", exact: true }).click();
    await page
      .locator(".trajectory .tool-event summary")
      .filter({ hasText: "调用工具 · read_file" })
      .waitFor();
    await page
      .locator(".trajectory .tool-event summary")
      .filter({ hasText: "调用工具 · read_file" })
      .click();
    await page
      .locator(".trajectory .tool-event[open] > pre")
      .filter({ hasText: "source.txt" })
      .first()
      .waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#agent-cards .agent-card.running").waitFor();
    expect(await page.locator("#agent-cards").innerText()).toContain(
      "read_file",
    );
    mkdirSync(".scratch/web-control/browser", { recursive: true });
    await page.screenshot({
      path: ".scratch/web-control/browser/agents.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "查看执行", exact: true }).click();
    await page
      .getByLabel("追加自然语言指令", { exact: true })
      .fill("Now finish the implementation.");
    await page
      .getByRole("button", { name: "发送到当前执行", exact: true })
      .click();
    await page.getByText("等待外部审查与验收", { exact: true }).waitFor();
    await page.getByLabel("轨迹类型", { exact: true }).selectOption("tool/");
    await page
      .locator(".trajectory summary")
      .filter({ hasText: "工具结果" })
      .first()
      .click();
    await page
      .locator(".trajectory pre")
      .filter({ hasText: "baseline" })
      .first()
      .waitFor();
    await page.screenshot({
      path: ".scratch/web-control/browser/trajectory.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "编辑任务版本", exact: true })
      .click();
    await page.locator("[name=title]").fill("Updated from the Web");
    await page
      .getByRole("button", { name: "准备工作目录", exact: true })
      .click();
    await page.locator("#create").waitFor({ state: "hidden" });
    expect(c.status(f.ticket.ticketId).ticket.revision).toBe(2);
    await page.getByRole("button", { name: "归档任务", exact: true }).click();
    await page
      .getByRole("button", { name: "恢复到任务列表", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.getByLabel("归档筛选", { exact: true }).selectOption("archived");
    await page.locator(".task").first().click();
    await page
      .getByRole("button", { name: "恢复到任务列表", exact: true })
      .click();
    await page.getByRole("button", { name: "归档任务", exact: true }).waitFor();
    expect(c.status(f.ticket.ticketId).archived).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 40000);

it("keeps grouped task navigation, collapsed sections and board navigation usable in the compact desktop layout", async () => {
  const f = fixture();
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  const items = [
    ["WORK-21", "实现任务执行轨迹与事件回放", "running"],
    ["WORK-22", "支持运行中追加自然语言指令", "running"],
    ["WORK-23", "优化工作空间的任务筛选体验", "ready"],
    ["WORK-24", "补充异常断线后的恢复验证", "ready"],
    ["WORK-25", "完善工具调用结果的关联展示", "awaiting_review"],
    ["WORK-26", "调整任务详情与审查信息布局", "awaiting_review"],
    ["WORK-27", "检查执行进程的回收记录", "blocked"],
    ["WORK-28", "共享前后端任务数据类型", "accepted"],
    ["WORK-29", "提供任务归档与恢复入口", "accepted"],
    ["WORK-30", "验证事件游标的连续性", "accepted"],
    ["WORK-31", "支持本地工作目录隔离", "accepted"],
    ["WORK-32", "接入 Harness SDK 生命周期", "accepted"],
  ] as const;
  // Display fixtures exercise all visual states; they are not real worker deliveries.
  for (const [ticketId, title, state] of items) {
    c.prepare({ ...f.ticket, ticketId, title, project: "dsh-worker" });
    c.store.update(ticketId, "fixture.display-state", (r) => {
      r.state = state;
    });
  }
  const http = await startHttp(c, {
    port: 0,
    token: "visual-fixture",
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    await page.goto(http.url + "/#token=visual-fixture");
    const visualErrors: string[] = [];
    page.on("pageerror", (e) => visualErrors.push(e.message));
    await page
      .locator(".task-group")
      .first()
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          String(error) +
            "\n" +
            JSON.stringify(visualErrors) +
            "\n" +
            (await page.locator("body").innerText()),
        );
      });
    expect(await page.locator(".task").count()).toBe(12);
    await page.locator(".group-heading").filter({ hasText: "已验收" }).click();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    expect(
      await page
        .locator(".group-heading")
        .filter({ hasText: "已验收" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await page.locator(".group-heading").filter({ hasText: "已验收" }).click();
    mkdirSync(".scratch/linear-ui/browser", { recursive: true });
    await page.screenshot({
      path: ".scratch/linear-ui/browser/workspace.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "看板", exact: true }).click();
    expect(await page.locator(".board-column").count()).toBe(5);
    expect(await page.locator(".task").count()).toBe(12);
    await page.screenshot({
      path: ".scratch/linear-ui/browser/board.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await page.locator(".task").filter({ hasText: "WORK-23" }).click();
    await page
      .getByRole("button", { name: "编辑任务版本", exact: true })
      .waitFor();
    await page.getByLabel("追加自然语言指令", { exact: true }).waitFor();
    await page.screenshot({
      path: ".scratch/linear-ui/browser/detail.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "会话记录", exact: true }).click();
    await page.getByText("尚未连接会话来源。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "任务工作台", exact: true }).click();
    await page.getByLabel("你希望 Worker 完成什么？").waitFor();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 30000);

it("remembers Dashboard authentication across browser sessions and same-home server restarts", async () => {
  const f = fixture();
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  const start = async (port: number) => {
    const child = spawn(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "serve",
        "--port",
        String(port),
        "--home",
        f.home,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const stop = async () => {
      child.kill("SIGTERM");
      await exited;
    };
    try {
      await expect
        .poll(() => existsSync(join(f.home, "service.json")), { timeout: 8000 })
        .toBe(true);
      return {
        child,
        stop,
        service: JSON.parse(
          readFileSync(join(f.home, "service.json"), "utf8"),
        ) as { url: string; token: string },
      };
    } catch (e) {
      await stop();
      throw e;
    }
  };
  let service = await start(0);
  const browser = await chromium.launch({ headless: true });
  try {
    let context = await browser.newContext();
    let page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(service.service.url);
    await page.getByText("连接失败，保留上次结果", { exact: false }).waitFor();
    expect(await page.locator("#connection").innerText()).toContain(
      "完整登录链接",
    );
    await page.goto(service.service.url + "/#token=" + service.service.token);
    await page.getByText("准备好下一项工作", { exact: true }).waitFor();
    expect(new URL(page.url()).hash).toBe("");
    const storage = await context.storageState();
    const old = service.service;
    await context.close();
    await service.stop();
    service = await start(Number(new URL(old.url).port));
    expect(service.service.token).toBe(old.token);
    context = await browser.newContext({ storageState: storage });
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(old.url);
    await page.getByText("准备好下一项工作", { exact: true }).waitFor();
    expect(await page.locator("#login").isHidden()).toBe(true);
    // Explicit replacement links must take precedence over stale persisted credentials.
    await page.evaluate(() => localStorage.setItem("worker-token", "obsolete"));
    await page.goto(old.url + "/#token=" + old.token);
    await page.getByText("准备好下一项工作", { exact: true }).waitFor();
  } finally {
    await browser.close();
    await service.stop();
  }
}, 25000);

it("shows whole-session timing and distinguishes missing measurements in agent cards", async () => {
  const f = fixture();
  const c = new Controller({
    home: f.home,
    runtime: new FakeRuntime(),
    dispatchEnabled: true,
  });
  c.prepare(f.ticket);
  c.run(f.ticket.ticketId);
  await c.wait(f.ticket.ticketId);
  const a = c.status(f.ticket.ticketId).attempts[0]!;
  c.store.event(f.ticket.ticketId, "harness.notification", {
    attemptId: a.id,
    method: "session.event",
    params: {
      sessionId: a.sessionId,
      event: {
        type: "worker/stats",
        data: {
          stats: {
            turns: 1,
            steps: 3,
            llmMs: 2500,
            toolMs: 4000,
            ttftMs: 0,
            ttftSteps: 0,
            decodeMs: 0,
            decodeTokens: 0,
          },
        },
      },
    },
  });
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.locator(".task").click();
    await expect
      .poll(() =>
        page.locator(".trajectory-panel .agent-card").first().textContent(),
      )
      .toContain(
        "3 步 · 模型 2.5s · 工具 4.0s · 首 token 未记录 · 解码 未记录",
      );
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);

it("editing a legacy custom-provider ticket preserves its empty credential requirements", async () => {
  const f = fixture();
  f.ticket.execution.provider = "custom-provider";
  const c = new Controller({ home: f.home, runtime: new FakeRuntime() });
  c.prepare(f.ticket);
  c.store.db
    .prepare(
      "UPDATE tickets SET data=json_remove(data, '$.ticket.execution.credentialEnv') WHERE id=?",
    )
    .run(f.ticket.ticketId);
  const http = await startHttp(c, {
    port: 0,
    token: "b".repeat(64),
    webDir: resolve("dist/web"),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(http.url + "/#token=" + "b".repeat(64));
    await page.locator(".task").click();
    await page
      .getByRole("button", { name: "编辑任务版本", exact: true })
      .click();
    await page.locator("[name=title]").fill("Updated legacy title");
    await page
      .getByRole("button", { name: "准备工作目录", exact: true })
      .click();
    await page.locator("#create").waitFor({ state: "hidden" });
    const edited = c.status(f.ticket.ticketId).ticket;
    expect(edited.revision).toBe(2);
    expect(edited.execution.provider).toBe("custom-provider");
    expect(edited.execution.credentialEnv).toEqual([]);
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 15000);
