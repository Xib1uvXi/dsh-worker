#!/usr/bin/env node
import { Context } from "@deepseek-ai/cordis";
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkRuntimeDependencies } from "../../runtime/src/preflight.js";
import { runtimeVersion } from "../../runtime/src/version.js";
import { buildInfo } from "../../shared/src/build.js";
import { ZodError } from "zod";
import { diagnose, errors, health, summary, errorInfo } from "./diagnostics.js";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { WorkerClient } from "./client.js";
import * as plugin from "../../server/src/plugin.js";
import { SdkRuntime } from "../../runtime/src/adapter.js";
import { cleanEnv, identity } from "../../shared/src/process.js";
import { atomic, ensure, uid } from "../../shared/src/util.js";
import {
  actionSchema,
  cancellationGuardSchema,
  id,
  instructionInputSchema,
  evidenceQuerySchema,
  boundDelivery,
  deliverySchema,
  reviewSchema,
  ticketSchema,
  briefIdsSchema,
} from "../../contracts/src/index.js";
import { policyPatch, workflow } from "../../runtime/src/policy.js";
import {
  inspectCodingTools,
  installTgrep,
  codingPatch,
} from "../../runtime/src/coding-tools.js";
import {
  inspectPlugins,
  pluginEnvRequired,
  pluginSelection,
  pluginsPatch,
} from "../../runtime/src/plugins.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: "string" },
      "request-id": { type: "string" },
      repo: { type: "string" },
      home: { type: "string" },
      port: { type: "string" },
      capacity: { type: "string" },
      file: { type: "string" },
      "ticket-file": { type: "string" },
      timeout: { type: "string" },
      revision: { type: "string" },
      "instruction-id": { type: "string" },
      "instruction-file": { type: "string" },
      "if-unconsumed": { type: "string", multiple: true },
      output: { type: "string" },
      attempt: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      kind: { type: "string" },
      summary: { type: "boolean" },
      full: { type: "boolean" },
      brief: { type: "boolean" },
      "enable-dispatch": { type: "boolean" },
      json: { type: "boolean" },
      wait: { type: "boolean" },
      help: { type: "boolean" },
      "harness-home": { type: "string", multiple: true },
    },
  });
  const command = positionals[0] ?? "help";
  ensure(
    values["if-unconsumed"] === undefined || command === "cancel",
    "arguments",
    "--if-unconsumed is only supported by cancel",
  );
  let cancellationGuard;
  if (
    command === "cancel" &&
    (values.revision !== undefined ||
      values.attempt !== undefined ||
      values["if-unconsumed"] !== undefined)
  ) {
    ensure(
      values.revision !== undefined &&
        values.attempt !== undefined &&
        values["if-unconsumed"] !== undefined,
      "arguments",
      "Guarded cancel requires --revision, --attempt and --if-unconsumed together",
    );
    cancellationGuard = cancellationGuardSchema.parse({
      revision: Number(values.revision),
      attemptId: values.attempt,
      instructionIds: values["if-unconsumed"],
    });
  }
  const home = resolve(
    values.home ??
      process.env.DSH_WORKER_HOME ??
      join(homedir(), ".dsh-worker-v2"),
  );
  if (command === "help" || values.help) {
    console.log(
      `dsh-worker 0.2 — CLI + Skill control service\n\nserve [--port 4317] [--capacity 2] [--enable-dispatch]\nlist [--summary] | status ID [--summary] | prepare --file ticket.json\nrun ID [--wait [--brief]] | cancel ID | verify ID [--wait [--brief]]\ncancel ID --revision N --attempt ATTEMPT_ID --if-unconsumed INSTRUCTION_ID (repeatable)\nwait ID [--timeout SECONDS] [--brief]\nreview --file review.json | recover ID | recover --file continuation.json\ninstruct ID --file instruction.json\nreviews | review-pool --file pool.json | request-review --file request.json\ncancel-review RUN_ID | recover-review RUN_ID\nschedule ID --kind run|verify --request-id KEY | cancel-scheduled KEY\ninstruct ID --instruction-file message.txt --revision N --instruction-id KEY\narchive ID | restore ID\nartifact SHA256 --output FILE\nhealth | diagnose ID | errors ID [--attempt ATTEMPT_ID] [--full]\nbrief ID [ID ...] (up to 8)\nversion | validate delivery|review --file FILE [--ticket-file FILE --attempt ID]\ntrajectory ID [--after N] [--limit 100] [--attempt ID] [--kind EVENT] [--full]\nactivity ID [--attempt ID] | events ID [--after N] [--limit 100]\nsessions | doctor [--repo PATH] | skill | workflow\ntools [--repo PATH] | tools install\nprune [--days 7] (old clean Harness homes only; evidence retained)\n\nAll commands accept --home DIR; data commands print JSON (--json is optional).\n--file - reads JSON from stdin. Instruction files contain UTF-8 text.\nRunning instructions enter the next conversation turn; they do not interrupt the current tool step.\nGuarded cancel requires every bound instruction to have a receipt and no recorded consumption.\nReuse the same instruction ID for retries; uncertain delivery is never replayed.\n--wait/ wait defaults to a 3600-second timeout; timing out does not cancel work.\nStart the service once, then use the bundled skill/SKILL.md for orchestration.\nModel dispatch is off until explicitly enabled on serve.`,
    );
    return;
  }
  if (command === "version") {
    ensure(positionals.length === 1, "arguments", "version takes no arguments");
    console.log(JSON.stringify(buildInfo, null, 2));
    return;
  }
  if (command === "validate") {
    const kind = positionals[1];
    ensure(
      positionals.length === 2 && ["delivery", "review"].includes(kind ?? ""),
      "arguments",
      "Use validate delivery|review --file FILE",
    );
    ensure(values.file, "file_required", "--file is required");
    ensure(
      (!values["ticket-file"] && !values.attempt) ||
        (kind === "delivery" && values["ticket-file"] && values.attempt),
      "arguments",
      "Delivery binding checks require both --ticket-file and --attempt",
    );
    const input = JSON.parse(
      readFileSync(values.file === "-" ? 0 : resolve(values.file), "utf8"),
    );
    try {
      if (kind === "review") reviewSchema.parse(input);
      else if (values["ticket-file"])
        boundDelivery(
          input,
          ticketSchema.parse(
            JSON.parse(readFileSync(resolve(values["ticket-file"]), "utf8")),
          ),
          id.parse(values.attempt),
        );
      else deliverySchema.parse(input);
      console.log(
        JSON.stringify(
          {
            ok: true,
            kind,
            bindingChecked: !!values["ticket-file"],
            notes: [
              "Local validation only; no execution, verification, review decision or acceptance was recorded.",
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      console.log(
        JSON.stringify(
          {
            ok: false,
            kind,
            issues: error.issues.map(({ path, code, message }) => ({
              path,
              code,
              message,
            })),
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
    return;
  }
  ensure(
    !values.brief ||
      command === "wait" ||
      (["run", "verify"].includes(command) && values.wait),
    "arguments",
    "--brief requires wait, run --wait or verify --wait",
  );
  if (command === "tools") {
    if (positionals[1] === "install")
      console.log(JSON.stringify(await installTgrep(home), null, 2));
    else {
      ensure(!positionals[1], "arguments", "Use tools [install] [--repo PATH]");
      const report = await inspectCodingTools(
        home,
        resolve(values.repo ?? process.cwd()),
      );
      const plugins = inspectPlugins(home);
      console.log(
        JSON.stringify(
          { ...report, plugins, ok: report.ok && plugins.ok },
          null,
          2,
        ),
      );
      if (!report.ok || !plugins.ok) process.exitCode = 1;
    }
    return;
  }
  if (command === "skill") {
    const root = import.meta.url.endsWith(".ts")
      ? resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const path = join(root, "skill", "SKILL.md");
    console.log(
      JSON.stringify(
        {
          name: "dsh-worker",
          path,
          examples: join(root, "examples"),
          content: readFileSync(path, "utf8"),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "workflow") {
    console.log(JSON.stringify(workflow(home), null, 2));
    return;
  }
  ensure(
    !values.summary || ["list", "status"].includes(command),
    "arguments",
    "--summary is only supported by list and status",
  );
  ensure(
    !values.attempt ||
      !!cancellationGuard ||
      ["errors", "trajectory", "activity"].includes(command),
    "arguments",
    "--attempt is only supported by errors, trajectory, activity and guarded cancel",
  );
  ensure(
    !values.full || ["errors", "trajectory"].includes(command),
    "arguments",
    "--full is only supported by errors and trajectory",
  );
  ensure(
    (values.after === undefined && values.limit === undefined) ||
      ["trajectory", "events"].includes(command),
    "arguments",
    "--after and --limit are only supported by trajectory and events",
  );
  ensure(
    values.kind === undefined || ["trajectory", "schedule"].includes(command),
    "arguments",
    "--kind is only supported by trajectory and schedule",
  );
  ensure(
    values["request-id"] === undefined || command === "schedule",
    "arguments",
    "--request-id is only supported by schedule",
  );
  if (command === "health") {
    ensure(positionals.length === 1, "arguments", "health takes no task ID");
    const result = await health(home);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "serve") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const ctx = new Context();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await ctx.fiber.dispose();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    const dist = import.meta.url.endsWith(".ts")
      ? resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist")
      : dirname(fileURLToPath(import.meta.url));
    try {
      await new Promise<void>((ready, reject) => {
        ctx.plugin(plugin, {
          home,
          capacity: Number(values.capacity ?? 2),
          dispatchEnabled: values["enable-dispatch"] ?? false,
          runtime: new SdkRuntime(join(dist, "runner.js")),
          port: Number(values.port ?? 4317),
          webDir: join(dist, "web"),
          harnessHomes: values["harness-home"],
          onReady: (url: string, _controller: unknown, token: string) => {
            console.log(
              `dsh-worker: ${url}/#token=${token}\nDispatch: ${values["enable-dispatch"] ? "enabled" : "disabled"}`,
            );
            ready();
          },
          onError: reject,
        });
      });
    } catch (error) {
      await stop();
      throw error;
    }
    return;
  }
  if (command === "doctor") {
    await checkRuntimeDependencies();
    const dir = join(home, "doctor", uid());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const owner = identity(process.pid);
    ensure(owner, "identity", "Cannot identify doctor owner");
    atomic(join(dir, "owner.json"), JSON.stringify(owner));
    const workspace = values.repo ? resolve(values.repo) : dir;
    const selectedPlugins = values.repo ? pluginSelection(home) : undefined;
    const patches = values.repo
      ? [
          await codingPatch(home, workspace, dir),
          await pluginsPatch(home, workspace, dir, selectedPlugins),
          policyPatch(dir),
        ]
      : [policyPatch(dir)];
    const harness = new DeepSeekHarness({
      cwd: workspace,
      processCwd: workspace,
      dshHome: join(dir, "harness-home"),
      profile: "sdk",
      patches,
      env: cleanEnv(selectedPlugins ? pluginEnvRequired(selectedPlugins) : []),
      initializeTimeoutMs: 30000,
    });
    let initialized: boolean;
    try {
      await harness.start();
      initialized = true;
    } finally {
      await harness.close();
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(
      JSON.stringify({
        node: process.version,
        sdk: runtimeVersion,
        runtime: runtimeVersion,
        initialized,
        closed: true,
        modelCalls: 0,
        dispatchEnabled: false,
      }),
    );
    return;
  }
  ensure(
    [
      "prune",
      "reviews",
      "review-pool",
      "request-review",
      "cancel-review",
      "recover-review",
      "schedule",
      "cancel-scheduled",
      "list",
      "status",
      "errors",
      "diagnose",
      "prepare",
      "run",
      "cancel",
      "verify",
      "review",
      "recover",
      "instruct",
      "archive",
      "restore",
      "sessions",
      "wait",
      "artifact",
      "brief",
      "trajectory",
      "activity",
      "events",
    ].includes(command),
    "command",
    `Unknown command ${command}; use dsh-worker help`,
  );
  const ticketId =
    [
      "schedule",
      "status",
      "errors",
      "diagnose",
      "run",
      "cancel",
      "verify",
      "instruct",
      "archive",
      "restore",
      "wait",
      "brief",
      "trajectory",
      "activity",
      "events",
    ].includes(command) ||
    (command === "recover" && !values.file)
      ? id.parse(positionals[1])
      : undefined;
  ensure(
    command === "brief" ||
      positionals.length <=
        (ticketId ||
        [
          "artifact",
          "cancel-review",
          "recover-review",
          "cancel-scheduled",
        ].includes(command)
          ? 2
          : 1),
    "arguments",
    "Unexpected positional arguments",
  );
  const timeout = Number(values.timeout ?? 3600);
  ensure(
    Number.isFinite(timeout) && timeout > 0 && timeout <= 86400,
    "timeout",
    "--timeout must be greater than zero and at most 86400 seconds",
  );
  const query = evidenceQuerySchema.parse({
    after: values.after === undefined ? undefined : Number(values.after),
    limit: values.limit === undefined ? undefined : Number(values.limit),
    attempt: ["trajectory", "activity"].includes(command)
      ? values.attempt
      : undefined,
    kind: command === "schedule" ? undefined : values.kind,
  });
  const client = new WorkerClient(home);
  const read = () => {
    ensure(values.file, "file_required", "--file is required");
    return JSON.parse(
      readFileSync(values.file === "-" ? 0 : resolve(values.file), "utf8"),
    );
  };
  const wait = async (ticketId: string) => {
    const deadline = Date.now() + timeout * 1000;
    while (true) {
      const status = await client.status(ticketId, true);
      if (!status.activeOperation || status.state === "interrupted")
        return values.brief ? client.brief(ticketId) : client.status(ticketId);
      ensure(
        Date.now() < deadline,
        "wait_timeout",
        "Wait timed out; execution continues. Inspect status before retrying; this did not cancel or resend work.",
      );
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  let result: unknown;
  if (command === "prune") {
    result = await client.request(
      "/api/actions",
      actionSchema.parse({ action: "prune", days: Number(values.days ?? 7) }),
    );
  } else if (command === "list") {
    const overview = await client.overview();
    result = values.summary
      ? { ...overview, tickets: overview.tickets.map(summary) }
      : overview;
  } else if (command === "status") {
    const status = await client.status(ticketId!, !!values.summary);
    result = values.summary ? summary(status) : status;
  } else if (command === "brief") {
    const ids = briefIdsSchema.parse(positionals.slice(1));
    if (ids.length === 1) result = await client.brief(ids[0]!);
    else {
      const batch = await client.briefs(ids);
      result = batch;
      if (batch.errors.length) process.exitCode = 1;
    }
  } else if (command === "events")
    result = await client.events(ticketId!, query);
  else if (command === "trajectory" || command === "activity") {
    const page = await client.trajectory(
      ticketId!,
      query,
      command === "activity",
    );
    result = values.full
      ? page
      : {
          ...page,
          entries: page.entries.map(({ raw: _raw, text, ...entry }) => ({
            ...entry,
            text: text.slice(0, 4000),
            textTruncated: text.length > 4000,
          })),
        };
  } else if (command === "errors")
    result = errors(
      await client.status(ticketId!, true),
      values.attempt,
      values.full,
    );
  else if (command === "diagnose") {
    const report = diagnose(await client.status(ticketId!, true), home);
    result = report;
    if (!report.ok) process.exitCode = 1;
  } else if (command === "wait") result = await wait(ticketId!);
  else if (command === "reviews") result = await client.request("/api/reviews");
  else if (command === "sessions")
    result = await client.request("/api/sessions");
  else if (command === "artifact") {
    const digest = positionals[1];
    ensure(
      digest && /^[a-f0-9]{64}$/.test(digest),
      "digest",
      "Expected artifact SHA256",
    );
    ensure(values.output, "output", "--output FILE is required");
    const bytes = await client.artifact(digest);
    const path = resolve(values.output);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    result = { path, sha256: digest, bytes: bytes.length };
  } else if (command === "recover" && !values.file)
    result = await client.request(
      `/api/tickets/${encodeURIComponent(ticketId!)}/recovery`,
    );
  else {
    ensure(
      !(command === "instruct" && values.file && values["instruction-file"]),
      "instruction_input",
      "Use either --file or --instruction-file",
    );
    if (command === "instruct")
      ensure(
        values.file || values["instruction-file"],
        "instruction_input",
        "Provide --file JSON or --instruction-file TEXT with --revision and --instruction-id",
      );
    const raw =
      command === "review-pool"
        ? { action: command, pool: read() }
        : command === "request-review"
          ? { action: command, request: read() }
          : command === "cancel-review" || command === "recover-review"
            ? { action: command, runId: positionals[1] }
            : command === "cancel-scheduled"
              ? { action: command, requestId: positionals[1] }
              : command === "schedule"
                ? {
                    action: command,
                    ticketId,
                    kind: values.kind,
                    requestId: values["request-id"],
                  }
                : command === "cancel"
                  ? {
                      action: "cancel",
                      ticketId,
                      ...(cancellationGuard
                        ? { ifUnconsumed: cancellationGuard }
                        : {}),
                    }
                  : command === "instruct"
                    ? {
                        ...(values.file
                          ? instructionInputSchema.parse(read())
                          : {
                              instruction: readFileSync(
                                values["instruction-file"] === "-"
                                  ? 0
                                  : resolve(values["instruction-file"] ?? ""),
                                "utf8",
                              ),
                              revision: Number(values.revision),
                              instructionId: values["instruction-id"],
                            }),
                        action: "instruct",
                        ticketId,
                      }
                    : command === "archive" || command === "restore"
                      ? {
                          action: "archive",
                          ticketId,
                          archived: command === "archive",
                        }
                      : command === "prepare"
                        ? { action: command, ticket: read() }
                        : command === "review"
                          ? { action: command, review: read() }
                          : command === "recover"
                            ? { action: command, continuation: read() }
                            : { action: command, ticketId };
    const action = actionSchema.parse(raw);
    result = await client.action(action);
    if (
      values.wait &&
      (action.action === "run" || action.action === "verify")
    ) {
      result = await wait(action.ticketId);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      ...errorInfo(error),
      hint: "Use health --home DIR for service failures; status ID --summary, errors ID and diagnose ID for task failures. An uncertain request must be inspected before retrying.",
    }),
  );
  process.exitCode = 1;
});
