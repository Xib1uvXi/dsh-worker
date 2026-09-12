/** Explicit opt-in real-provider acceptance. Creates only disposable repositories/homes. */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { Controller } from "../packages/core/src/controller.js";
import {
  SdkRuntime,
  type RuntimeAdapter,
} from "../packages/runtime/src/adapter.js";
import { startHttp } from "../packages/server/src/http.js";
import { WorkerClient } from "../packages/cli/src/client.js";
import {
  ticketSchema,
  type ReviewRun,
  type ReviewStatus,
} from "../packages/contracts/src/index.js";
import { ensure } from "../packages/shared/src/util.js";

ensure(
  process.argv.includes("--real-provider"),
  "opt_in",
  "Pass --real-provider to authorize this live scenario",
);
ensure(
  process.env.DEEPSEEK_API_KEY,
  "credential",
  "DEEPSEEK_API_KEY must already be available; it will not be printed",
);
const output = resolve(
  process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
    ".scratch/two-level-review/live",
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(tmpdir(), "dsh-review-live-"));
const repo = join(root, "repo");
const home = join(root, "home");
mkdirSync(repo);
mkdirSync(home);
writeFileSync(
  join(home, "tools.json"),
  JSON.stringify({ search: "ripgrep", languages: [] }),
);
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git("init", "-q");
git("config", "user.name", "Review acceptance fixture");
git("config", "user.email", "fixture@example.invalid");
writeFileSync(
  join(repo, "package.json"),
  JSON.stringify({
    type: "module",
    scripts: {
      lint: "node --check sample.mjs && node --check owned.mjs",
      test: "node --test *.test.mjs",
      build: "node --check sample.mjs && node --check owned.mjs",
    },
  }),
);
writeFileSync(
  join(repo, "sample.mjs"),
  "export function validateSample(sample, expectedDigest) { return false; }\n",
);
writeFileSync(
  join(repo, "owned.mjs"),
  "export function ownsResource(name, runId) { return false; }\n",
);
writeFileSync(
  join(repo, "sample.test.mjs"),
  `import assert from 'node:assert/strict';import {validateSample} from './sample.mjs';
const good={status:200,points:3,digest:'abc'};assert.equal(validateSample(good,'abc'),true);
for(const change of [{status:500},{status:200.5},{points:0},{points:-1},{points:1.5},{digest:'wrong'}])assert.equal(validateSample({...good,...change},'abc'),false);
assert.equal(validateSample({...good,status:299},'abc'),true);\n`,
);
writeFileSync(
  join(repo, "owned.test.mjs"),
  `import assert from 'node:assert/strict';import {ownsResource} from './owned.mjs';
assert.equal(ownsResource('job-12-db','job-12'),true);for(const name of ['job-123-db','job-12-db-old','other-db','job-12-cache'])assert.equal(ownsResource(name,'job-12'),false);\n`,
);
git("add", ".");
git("commit", "-qm", "Explicit acceptance fixtures");
const base = git("rev-parse", "HEAD");
const runtime = new SdkRuntime(resolve("dist/runner.js"));
let controller = new Controller({
  home,
  runtime,
  dispatchEnabled: true,
  capacity: 4,
});
let server = await startHttp(controller, {
  port: 0,
  token: "isolated-live-fixture",
  webDir: resolve("dist/web"),
});
const discover = () =>
  writeFileSync(
    join(home, "service.json"),
    JSON.stringify({ url: server.url, token: "isolated-live-fixture" }),
  );
discover();
let client = new WorkerClient(home, 30000);
const execution = {
  provider: "deepseek-official",
  model: "deepseek-flash",
  timeoutSeconds: 600,
  patches: [],
  envRequired: [],
  credentialEnv: ["DEEPSEEK_API_KEY"],
};
const events: unknown[] = [];
let peakReviewOwned = 0;
const record = (phase: string, data: unknown) => {
  events.push({ time: new Date().toISOString(), phase, data });
  writeFileSync(
    join(output, "progress.json"),
    JSON.stringify({ root, home, repo, peakReviewOwned, events }, null, 2),
    { mode: 0o600 },
  );
  console.log(phase);
};
async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  seconds = 660,
) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    "Live scenario deadline exceeded; retained evidence in " + output,
  );
}
async function reviewsDone(ids: string[]) {
  return until(
    async () => {
      const status = await client.request<ReviewStatus>("/api/reviews");
      peakReviewOwned = Math.max(
        peakReviewOwned,
        status.pools.reduce((n, p) => n + p.reviewOwned, 0),
      );
      return status.runs.filter((r) => ids.includes(r.id));
    },
    (runs) =>
      runs.length === ids.length &&
      runs.every(
        (r) => !r.slotHeld && r.state !== "queued" && r.state !== "running",
      ),
  );
}
const ticket = (id: string, file: string, objective: string) =>
  ticketSchema.parse({
    schemaVersion: 2,
    ticketId: id,
    revision: 1,
    title: objective,
    targetRepo: repo,
    baseCommit: base,
    objective,
    scope: { paths: [file] },
    acceptance: [{ id: "AC1", description: objective }],
    context:
      "Implement only the assigned module. Read the prewritten tests and run the named verification. Do not edit tests, package.json or other modules. Both pass and reject paths are required. Return the requested bound JSON delivery.",
    verification: [
      { args: [process.execPath, "--test", file.replace(".mjs", ".test.mjs")] },
    ],
    execution,
    reviewPolicy: "worker_then_astra",
    reviewPoolId: "live",
  });
const tickets = [
  ticket(
    "LIVE-SAMPLE",
    "sample.mjs",
    "validateSample returns true exactly when status is an integer from 200 through 299, points is a positive integer, and digest equals expectedDigest; otherwise false.",
  ),
  ticket(
    "LIVE-OWNED",
    "owned.mjs",
    "ownsResource(name, runId) returns true exactly when name equals runId + '-db'. Similar prefixes or suffixes and other resources must return false. Never manipulate actual containers.",
  ),
];
try {
  await client.action({
    action: "review-pool",
    pool: {
      poolId: "live",
      batchId: "live-batch",
      expectedVersion: 0,
      implementationLimit: 2,
      state: "enabled",
      execution,
      entrySkills: [],
    },
  });
  for (const t of tickets) {
    await client.action({ action: "prepare", ticket: t });
    await client.action({
      action: "schedule",
      requestId: `implement-${t.ticketId}`,
      ticketId: t.ticketId,
      kind: "run",
    });
  }
  record("real implementations dispatched", {
    tickets: tickets.map((t) => t.ticketId),
  });
  for (const t of tickets) {
    const result = await until(
      () => client.status(t.ticketId),
      (r) => r.attempts.length > 0 && !r.activeOperation,
    );
    record("implementation finished", {
      ticket: t.ticketId,
      state: result.state,
      error: result.error,
    });
    ensure(
      result.state === "awaiting_review",
      "live_implementation",
      `${t.ticketId}: ${result.error ?? result.state}`,
    );
    await client.action({
      action: "schedule",
      requestId: `verify-${t.ticketId}`,
      ticketId: t.ticketId,
      kind: "verify",
    });
  }
  const reviewIds: string[] = [];
  for (const t of tickets) {
    const result = await until(
      () => client.status(t.ticketId),
      (r) => !!r.verifications.at(-1)?.endedAt && !r.activeOperation,
    );
    ensure(
      result.verifications.at(-1)?.passed,
      "live_verification",
      `Verification failed: ${t.ticketId}`,
    );
    const a = result.attempts.at(-1)!;
    const run = await client.request<ReviewRun>("/api/actions", {
      action: "request-review",
      request: {
        requestId: `review-${t.ticketId}`,
        poolId: "live",
        ticketId: t.ticketId,
        revision: 1,
        attemptId: a.id,
        snapshotDigest: a.snapshot!.digest,
        mode: "initial",
      },
    });
    reviewIds.push(run.id);
  }
  record("real independent reviews dispatched", { reviewIds });
  const reports = await reviewsDone(reviewIds);
  for (const run of reports) {
    record("review completed", run);
    ensure(
      run.state === "completed" && run.report?.recommendation === "pass",
      "live_review",
      run.error ?? JSON.stringify(run.report),
    );
    await client.action({
      action: "review",
      review: {
        schemaVersion: 2,
        ticketId: run.request.ticketId,
        revision: 1,
        attemptId: run.request.attemptId,
        snapshotDigest: run.request.snapshotDigest,
        spec: { verdict: "pass", findings: [] },
        standards: { verdict: "pass", findings: [] },
        verdict: "accept",
        findings: [],
        reviewer:
          "Real E2E evidence adoption; final Astra review remains separate",
        source: { runId: run.id, reportDigest: run.reportDigest! },
      },
    });
  }
  ensure(
    peakReviewOwned === 2,
    "live_scaling",
    "Expected two concurrent independent review owners",
  );
  const candidate = join(root, "candidate");
  execFileSync("git", ["clone", "--no-hardlinks", repo, candidate], {
    stdio: "ignore",
  });
  for (const t of tickets) {
    const r = await client.status(t.ticketId);
    copyFileSync(
      join(r.worktree, t.scope.paths[0]!),
      join(candidate, t.scope.paths[0]!),
    );
  }
  for (const gate of ["lint", "test", "build"]) {
    const out = execFileSync("npm", ["run", gate], {
      cwd: candidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(output, `candidate-${gate}.log`), out);
  }
  record("integrated candidate gates passed", {
    candidate,
    base,
    files: Object.fromEntries(
      tickets.map((t) => [
        t.scope.paths[0],
        createHash("sha256")
          .update(readFileSync(join(candidate, t.scope.paths[0]!)))
          .digest("hex"),
      ]),
    ),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url + "/#token=isolated-live-fixture");
    await page.getByRole("button", { name: "审查调度", exact: true }).click();
    await page.getByText("live · enabled", { exact: true }).waitFor();
    await page.screenshot({
      path: join(output, "review-dashboard.png"),
      fullPage: true,
    });
    ensure(!errors.length, "browser", errors.join(";"));
  } finally {
    await browser.close();
  }
  await server.close();
  await controller.close();
  controller = new Controller({
    home,
    runtime,
    dispatchEnabled: true,
    capacity: 4,
  });
  server = await startHttp(controller, {
    port: 0,
    token: "isolated-live-fixture",
    webDir: resolve("dist/web"),
  });
  discover();
  client = new WorkerClient(home);
  for (const t of tickets)
    ensure(
      (await client.status(t.ticketId)).state === "accepted",
      "restart",
      "Acceptance did not survive restart",
    );
  // A deterministic admission adapter preserves KNOWN broken source. Only the reviewer is real in this negative probe.
  await server.close();
  await controller.close();
  let seededOnce = false;
  const seeded: RuntimeAdapter = {
    async execute(req, ...args) {
      if (req.sessionId.startsWith("review-") || seededOnce)
        return runtime.execute(req, ...args);
      seededOnce = true;
      writeFileSync(
        join(req.worktree, "sample.mjs"),
        "export function validateSample(s, expectedDigest) { return s.status === 200; }\\n".replace(
          "\\n",
          "\n",
        ),
      );
      return {
        receipt: true,
        cleanExit: true,
        finishReason: "completed",
        termination: "completed",
        finalResponse: JSON.stringify({
          schemaVersion: 2,
          ticketId: req.ticket.ticketId,
          revision: req.ticket.revision,
          attemptId: req.attemptId,
          outcome: "submitted",
          summary: "Implemented status-based sample validation",
          evidence: [
            {
              acceptanceId: "AC1",
              evidence:
                "Updated sample.mjs; inspect the source and actual checks against AC1",
            },
          ],
          commands: [],
          notRun: ["Only the configured verification is claimed"],
          blockers: [],
        }),
      };
    },
  };
  controller = new Controller({
    home,
    runtime: seeded,
    dispatchEnabled: true,
    capacity: 4,
  });
  server = await startHttp(controller, {
    port: 0,
    token: "isolated-live-fixture",
    webDir: resolve("dist/web"),
  });
  discover();
  client = new WorkerClient(home);
  const negative = {
    ...tickets[0]!,
    ticketId: "LIVE-NEGATIVE",
    verification: [
      {
        args: [process.execPath, "--check", "sample.mjs"],
        cwd: ".",
        timeoutSeconds: 30,
      },
    ],
  };
  await client.action({ action: "prepare", ticket: negative });
  await client.action({ action: "run", ticketId: negative.ticketId });
  await until(
    () => client.status(negative.ticketId),
    (r) => r.attempts.length > 0 && !r.activeOperation,
  );
  await client.action({ action: "verify", ticketId: negative.ticketId });
  const bad = await until(
    () => client.status(negative.ticketId),
    (r) => !!r.verifications.at(-1)?.endedAt && !r.activeOperation,
  );
  ensure(
    bad.verifications.at(-1)?.passed,
    "negative_verification",
    "The negative snapshot must pass configured syntax verification",
  );
  const a = bad.attempts.at(-1)!;
  const neg = await client.request<ReviewRun>("/api/actions", {
    action: "request-review",
    request: {
      requestId: "known-defect",
      ticketId: negative.ticketId,
      poolId: "live",
      revision: 1,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      mode: "initial",
    },
  });
  const rejected = (await reviewsDone([neg.id]))[0]!;
  record("real reviewer negative probe", rejected);
  ensure(
    rejected.state === "completed" &&
      rejected.report?.recommendation === "request_changes" &&
      rejected.report.findings.some((f) => f.blocking),
    "negative_probe",
    `No valid blocking report: ${rejected.state}; ${rejected.error ?? JSON.stringify(rejected.report)}`,
  );
  await client.action({
    action: "review",
    review: {
      schemaVersion: 2,
      ticketId: negative.ticketId,
      revision: 1,
      attemptId: a.id,
      snapshotDigest: a.snapshot!.digest,
      spec: {
        verdict: rejected.report!.spec.verdict === "pass" ? "pass" : "fail",
        findings:
          rejected.report!.spec.verdict === "pass"
            ? []
            : [rejected.report!.spec.rationale],
      },
      standards: {
        verdict:
          rejected.report!.standards.verdict === "pass" ? "pass" : "fail",
        findings:
          rejected.report!.standards.verdict === "pass"
            ? []
            : [rejected.report!.standards.rationale],
      },
      verdict: "request_changes",
      findings: rejected.report!.findings.map((f) => f.evidence),
      reviewer: "Host adopted real negative report",
      notes: [
        `Spec: ${rejected.report!.spec.rationale}`,
        `Standards: ${rejected.report!.standards.rationale}`,
      ],
      source: { runId: rejected.id, reportDigest: rejected.reportDigest! },
    },
  });
  await client.action({ action: "run", ticketId: negative.ticketId });
  const repaired = await until(
    () => client.status(negative.ticketId),
    (r) => r.attempts.length === 2 && !r.activeOperation,
  );
  ensure(
    repaired.state === "awaiting_review",
    "live_repair",
    repaired.error ?? repaired.state,
  );
  const repairTest = execFileSync(
    process.execPath,
    ["--test", "sample.test.mjs"],
    {
      cwd: repaired.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  writeFileSync(join(output, "real-repair-test.log"), repairTest);
  await client.action({ action: "verify", ticketId: negative.ticketId });
  const fixed = await until(
    () => client.status(negative.ticketId),
    (r) =>
      r.verifications.length === 2 &&
      !!r.verifications.at(-1)?.endedAt &&
      !r.activeOperation,
  );
  ensure(
    fixed.verifications.at(-1)?.passed,
    "live_repair_verify",
    "Repair verification failed",
  );
  const fixedAttempt = fixed.attempts.at(-1)!;
  const focused = await client.request<ReviewRun>("/api/actions", {
    action: "request-review",
    request: {
      requestId: "negative-focused",
      poolId: "live",
      ticketId: negative.ticketId,
      revision: 1,
      attemptId: fixedAttempt.id,
      snapshotDigest: fixedAttempt.snapshot!.digest,
      mode: "focused",
      priorRunId: rejected.id,
    },
  });
  const focusedResult = (await reviewsDone([focused.id]))[0]!;
  record("real repair focused review", focusedResult);
  ensure(
    focusedResult.state === "completed" &&
      focusedResult.report?.recommendation === "pass",
    "live_focused_review",
    focusedResult.error ?? JSON.stringify(focusedResult.report),
  );
  await client.action({
    action: "review",
    review: {
      schemaVersion: 2,
      ticketId: negative.ticketId,
      revision: 1,
      attemptId: fixedAttempt.id,
      snapshotDigest: fixedAttempt.snapshot!.digest,
      spec: { verdict: "pass", findings: [] },
      standards: { verdict: "pass", findings: [] },
      verdict: "accept",
      findings: [],
      reviewer: "Host adopted real focused repair evidence",
      source: {
        runId: focusedResult.id,
        reportDigest: focusedResult.reportDigest!,
      },
    },
  });
  record("scenario passed", {
    realImplementationTasks: 2,
    realRepairTasks: 1,
    realFocusedReviews: 1,
    realPositiveReviews: 2,
    realNegativeReviews: 1,
    negativeAdmission:
      "deterministic seed, explicitly not a real implementation",
    peakReviewOwned,
    postRestartAccepted: 2,
    mainIntegration: false,
    finalAstraReview: "pending parent inspection of candidate",
  });
} catch (error) {
  record("scenario failed", { error: String(error) });
  process.exitCode = 1;
} finally {
  await server.close();
  await controller.close();
}
