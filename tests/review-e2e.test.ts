import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Controller } from "../packages/core/src/controller.js";
import { SdkRuntime } from "../packages/runtime/src/adapter.js";
import { startHttp } from "../packages/server/src/http.js";
import { fixture, FakeRuntime } from "./helpers.js";
import type {
  ReviewStatus,
  TicketView,
} from "../packages/contracts/src/index.js";

it("runs CLI/HTTP/SDK/browser review, adopts evidence, and preserves state across service restart", async () => {
  const f = fixture();
  const runtime = new SdkRuntime(resolve("dist/runner.js"));
  let c = new Controller({
    home: f.home,
    runtime,
    dispatchEnabled: true,
    capacity: 2,
    dshBin: resolve("tests/fixtures/review-runtime.mjs"),
  });
  let http = await startHttp(c, {
    port: 0,
    token: "review-e2e",
    webDir: resolve("dist/web"),
  });
  const discovery = () =>
    writeFileSync(
      join(f.home, "service.json"),
      JSON.stringify({ url: http.url, token: "review-e2e" }),
    );
  discovery();
  const cli = async <T>(args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [
          resolve("dist/cli.js"),
          ...args,
          "--home",
          f.home,
        ])
      ).stdout,
    ) as T;
  const jsonFile = (name: string, data: unknown) => {
    const path = join(f.root, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const pool = {
      poolId: "pool",
      batchId: "batch",
      expectedVersion: 0,
      state: "enabled",
      implementationLimit: 2,
      execution: { ...f.ticket.execution, timeoutSeconds: 30 },
    };
    await cli(["review-pool", "--file", jsonFile("pool.json", pool)]);
    await cli([
      "prepare",
      "--file",
      jsonFile("ticket.json", {
        ...f.ticket,
        reviewPolicy: "worker_then_astra",
        reviewPoolId: "pool",
      }),
    ]);
    const op = await cli<{ state: string }>([
      "schedule",
      f.ticket.ticketId,
      "--kind",
      "run",
      "--request-id",
      "implement",
    ]);
    expect(op.state).toBe("queued");
    await expect
      .poll(() => c.status(f.ticket.ticketId).state, { timeout: 15000 })
      .toBe("awaiting_review");
    await cli([
      "schedule",
      f.ticket.ticketId,
      "--kind",
      "verify",
      "--request-id",
      "verify",
    ]);
    await expect
      .poll(() => c.status(f.ticket.ticketId).verifications.at(-1)?.passed, {
        timeout: 10000,
      })
      .toBe(true);
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(http.url + "/#token=review-e2e");
    await page.getByRole("button", { name: "审查调度", exact: true }).click();
    await page.getByText("pool · enabled", { exact: true }).waitFor();
    await page.getByRole("button", { name: "暂停新增", exact: true }).click();
    await page.getByText("pool · paused", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "关闭审查调度", exact: true })
      .click();
    await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
    await page
      .getByRole("button", { name: "请求独立审查", exact: true })
      .click();
    await expect.poll(() => c.reviewCoordinator.runs().length).toBe(1);
    expect(c.reviewCoordinator.runs()[0]?.state).toBe("queued");
    const cancelledId = c.reviewCoordinator.runs()[0]!.request.requestId;
    await page.locator("#detail").evaluate((d: HTMLDialogElement) => d.close());
    await page.getByRole("button", { name: "审查调度", exact: true }).click();
    await page.getByRole("button", { name: "取消审查", exact: true }).click();
    await expect
      .poll(() => c.reviewCoordinator.runs()[0]?.state)
      .toBe("cancelled");
    await page
      .getByRole("button", { name: "关闭审查调度", exact: true })
      .click();
    await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
    await page
      .getByRole("button", { name: "重新请求独立审查", exact: true })
      .click();
    await expect.poll(() => c.reviewCoordinator.runs().length).toBe(2);
    expect(c.reviewCoordinator.runs()[1]!.request.requestId).not.toBe(
      cancelledId,
    );
    await page.locator("#detail").evaluate((d: HTMLDialogElement) => d.close());
    await page.getByRole("button", { name: "审查调度", exact: true }).click();
    await page.getByRole("button", { name: "恢复调度", exact: true }).click();
    await expect
      .poll(() => c.reviewCoordinator.runs()[1]?.state, { timeout: 15000 })
      .toBe("completed");
    const report = (await cli<ReviewStatus>(["reviews"])).runs[1]!;
    expect(report.slotHeld).toBe(false);
    const pending = await cli<TicketView>(["status", f.ticket.ticketId]);
    expect(pending.state).toBe("awaiting_review");
    await page
      .getByRole("button", { name: "关闭审查调度", exact: true })
      .click();
    await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
    await page
      .getByLabel("独立审查来源", { exact: true })
      .selectOption(`${report.id}:${report.reportDigest}`);
    await page.getByLabel("审查者", { exact: true }).fill("Astra E2E adoption");
    await page.getByRole("button", { name: "验收通过", exact: true }).click();
    await expect.poll(() => c.status(f.ticket.ticketId).state).toBe("accepted");
    expect(errors).toEqual([]);
    await http.close();
    await c.close();
    c = new Controller({
      home: f.home,
      runtime,
      dispatchEnabled: true,
      capacity: 2,
    });
    http = await startHttp(c, {
      port: 0,
      token: "review-e2e",
      webDir: resolve("dist/web"),
    });
    discovery();
    expect((await cli<TicketView>(["status", f.ticket.ticketId])).state).toBe(
      "accepted",
    );
    expect((await cli<ReviewStatus>(["reviews"])).runs[1]?.reportDigest).toBe(
      report.reportDigest,
    );
  } finally {
    await browser.close();
    await http.close();
    await c.close();
  }
}, 45000);

it.each(["cancel", "timeout"])(
  "settles a real SDK review process after %s without acceptance or replay",
  async (mode) => {
    const f = fixture();
    const sdk = new SdkRuntime(resolve("dist/runner.js"));
    const implementation = new FakeRuntime();
    const c = new Controller({
      home: f.home,
      dispatchEnabled: true,
      capacity: 1,
      dshBin: resolve("tests/fixtures/review-runtime.mjs"),
      runtime: {
        execute(request, dir, marker, signal, notify, processes) {
          return request.sessionId.startsWith("review-")
            ? sdk.execute(request, dir, marker, signal, notify, processes)
            : implementation.execute(request, dir, marker, signal);
        },
      },
    });
    const http = await startHttp(c, {
      port: 0,
      token: "cancel-review-e2e",
      webDir: resolve("dist/web"),
    });
    const action = async (body: unknown) => {
      const r = await fetch(http.url + "/api/actions", {
        method: "POST",
        headers: {
          authorization: "Bearer cancel-review-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      return r.json();
    };
    try {
      c.reviewCoordinator.configure({
        poolId: "pool",
        batchId: "batch",
        expectedVersion: 0,
        implementationLimit: 1,
        state: "enabled",
        execution: {
          ...f.ticket.execution,
          timeoutSeconds: mode === "timeout" ? 2 : 30,
        },
        entrySkills: [],
      });
      c.prepare({
        ...f.ticket,
        context: "E2E_STALL",
        reviewPolicy: "worker_then_astra",
        reviewPoolId: "pool",
      });
      c.run(f.ticket.ticketId);
      await c.wait(f.ticket.ticketId);
      const t = c.status(f.ticket.ticketId);
      const a = t.attempts.at(-1)!;
      const run = c.reviewCoordinator.request({
        requestId: "stalled",
        poolId: "pool",
        ticketId: f.ticket.ticketId,
        revision: 1,
        attemptId: a.id,
        snapshotDigest: a.snapshot!.digest,
        mode: "initial",
      });
      await expect
        .poll(() => c.reviewCoordinator.runs()[0]?.processes.length, {
          timeout: 10000,
        })
        .toBeGreaterThan(0);
      expect(c.reviewCoordinator.status().capacityOwned).toBe(1);
      if (mode === "cancel")
        await action({ action: "cancel-review", runId: run.id });
      else
        await expect
          .poll(() => c.reviewCoordinator.runs()[0]?.phase, { timeout: 10000 })
          .toBe("ended");
      expect(c.reviewCoordinator.runs()[0]).toMatchObject({
        state: mode === "cancel" ? "cancelled" : "failed",
        slotHeld: false,
        processes: [],
        phase: "ended",
      });
      expect(c.status(f.ticket.ticketId)).toMatchObject({
        state: "awaiting_review",
      });
      expect(c.reviewCoordinator.request(run.request).id).toBe(run.id);
      expect(c.reviewCoordinator.status().capacityOwned).toBe(0);
    } finally {
      await http.close();
      await c.close();
    }
  },
  30000,
);

it.each(["登记阻塞", "要求返工"])(
  "withdraws and reschedules browser work, then permits %s without a review source",
  async (label) => {
    const f = fixture();
    const c = new Controller({
      home: f.home,
      runtime: new FakeRuntime(),
      dispatchEnabled: true,
      capacity: 1,
    });
    const http = await startHttp(c, {
      port: 0,
      token: "review-web-recovery",
      webDir: resolve("dist/web"),
    });
    const browser = await chromium.launch({ headless: true });
    try {
      c.reviewCoordinator.configure({
        poolId: "pool",
        batchId: "batch",
        expectedVersion: 0,
        implementationLimit: 1,
        state: "paused",
        execution: f.ticket.execution,
        entrySkills: [],
      });
      c.prepare({
        ...f.ticket,
        reviewPolicy: "worker_then_astra",
        reviewPoolId: "pool",
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(http.url + "/#token=review-web-recovery");
      await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
      await page.getByRole("button", { name: "开始实现", exact: true }).click();
      await expect.poll(() => c.reviewCoordinator.operations().length).toBe(1);
      const first = c.reviewCoordinator.operations()[0]!.requestId;
      await page
        .locator("#detail")
        .evaluate((d: HTMLDialogElement) => d.close());
      await page.getByRole("button", { name: "审查调度", exact: true }).click();
      await page
        .getByRole("button", { name: "撤销排队操作", exact: true })
        .click();
      await expect
        .poll(() => c.reviewCoordinator.operations()[0]?.state)
        .toBe("cancelled");
      await page
        .getByRole("button", { name: "关闭审查调度", exact: true })
        .click();
      await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
      await page.getByRole("button", { name: "开始实现", exact: true }).click();
      await expect.poll(() => c.reviewCoordinator.operations().length).toBe(2);
      expect(c.reviewCoordinator.operations()[1]!.requestId).not.toBe(first);
      await page
        .locator("#detail")
        .evaluate((d: HTMLDialogElement) => d.close());
      await page.getByRole("button", { name: "审查调度", exact: true }).click();
      await page.getByRole("button", { name: "恢复调度", exact: true }).click();
      await expect
        .poll(() => c.status(f.ticket.ticketId).state, { timeout: 10000 })
        .toBe("awaiting_review");
      await page
        .getByRole("button", { name: "关闭审查调度", exact: true })
        .click();
      await page.getByText(f.ticket.ticketId, { exact: true }).first().click();
      await page.getByRole("button", { name: "验收通过", exact: true }).click();
      await expect
        .poll(() => page.locator("#detail-error").textContent())
        .toContain("请选择");
      await page
        .getByLabel("审查者", { exact: true })
        .fill("Host evidence disposition");
      await page
        .getByLabel("审查发现", { exact: true })
        .fill("Review unavailable; original criterion remains unresolved");
      await page.getByLabel("Spec 结论", { exact: true }).selectOption("fail");
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect
        .poll(() => c.status(f.ticket.ticketId).state)
        .toBe(label === "登记阻塞" ? "blocked" : "changes_requested");
      expect(
        c.status(f.ticket.ticketId).reviews.at(-1)?.source,
      ).toBeUndefined();
      expect(c.reviewCoordinator.runs()).toHaveLength(0);
    } finally {
      await browser.close();
      await http.close();
      await c.close();
    }
  },
  30000,
);
