#!/usr/bin/env node
import { Context } from "@deepseek-ai/cordis";
import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { serviceToken } from "./auth.js";
import { diagnose, errors, health, summary, errorInfo } from "./diagnostics.js";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { WorkerClient } from "./client.js";
import * as plugin from "../../server/src/plugin.js";
import { SdkRuntime } from "../../runtime/src/adapter.js";
import { identity, alive, cleanEnv } from "../../core/src/process.js";
import { atomic, ensure, uid } from "../../core/src/util.js";
import {
  actionSchema,
  id,
  instructionInputSchema,
} from "../../contracts/src/index.js";
import { policyPatch, workflow } from "../../runtime/src/policy.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      port: { type: "string" },
      capacity: { type: "string" },
      file: { type: "string" },
      timeout: { type: "string" },
      revision: { type: "string" },
      "instruction-id": { type: "string" },
      "instruction-file": { type: "string" },
      output: { type: "string" },
      attempt: { type: "string" },
      summary: { type: "boolean" },
      full: { type: "boolean" },
      "enable-dispatch": { type: "boolean" },
      json: { type: "boolean" },
      wait: { type: "boolean" },
      help: { type: "boolean" },
      "harness-home": { type: "string", multiple: true },
    },
  });
  const command = positionals[0] ?? "help";
  const home = resolve(
    values.home ??
      process.env.DSH_WORKER_HOME ??
      join(homedir(), ".dsh-worker-v2"),
  );
  if (command === "help" || values.help) {
    console.log(
      `dsh-worker 0.2 — CLI + Skill control service\n\nserve [--port 4317] [--capacity 2] [--enable-dispatch]\nlist [--summary] | status ID [--summary] | prepare --file ticket.json\nrun ID [--wait] | cancel ID | verify ID [--wait]\nwait ID [--timeout SECONDS]\nreview --file review.json | recover ID | recover --file continuation.json\ninstruct ID --file instruction.json\ninstruct ID --instruction-file message.txt --revision N --instruction-id KEY\narchive ID | restore ID\nartifact SHA256 --output FILE\nhealth | diagnose ID | errors ID [--attempt ATTEMPT_ID] [--full]\nsessions | doctor | skill | workflow\n\nAll commands accept --home DIR; data commands print JSON (--json is optional).\n--file - reads JSON from stdin. Instruction files contain UTF-8 text.\nReuse the same instruction ID for retries; uncertain delivery is never replayed.\n--wait/ wait defaults to a 3600-second timeout; timing out does not cancel work.\nStart the service once, then use the bundled skill/SKILL.md for orchestration.\nModel dispatch is off until explicitly enabled on serve.`,
    );
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
    (!values.attempt && !values.full) || command === "errors",
    "arguments",
    "--attempt and --full are only supported by errors",
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
    const lock = join(home, "service.lock");
    if (existsSync(lock)) {
      const prior = JSON.parse(readFileSync(lock, "utf8")) as {
        pid: number;
        start: string;
      };
      ensure(
        !alive(prior),
        "service_running",
        "Another controller owns this home",
      );
      unlinkSync(lock);
    }
    const own = identity(process.pid);
    ensure(own, "identity", "Cannot determine service process identity");
    writeFileSync(lock, JSON.stringify(own), { flag: "wx", mode: 0o600 });
    const ctx = new Context();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await ctx.fiber.dispose();
      if (existsSync(lock)) unlinkSync(lock);
      if (existsSync(join(home, "service.json")))
        unlinkSync(join(home, "service.json"));
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
      const token = serviceToken(home);
      await new Promise<void>((ready, reject) => {
        ctx.plugin(plugin, {
          home,
          capacity: Number(values.capacity ?? 2),
          dispatchEnabled: values["enable-dispatch"] ?? false,
          runtime: new SdkRuntime(join(dist, "runner.js")),
          port: Number(values.port ?? 4317),
          token,
          webDir: join(dist, "web"),
          harnessHomes: values["harness-home"],
          onReady: (url: string) => {
            atomic(
              join(home, "service.json"),
              JSON.stringify({ url, token, pid: process.pid }),
            );
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
    const dir = join(home, "doctor", uid());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const harness = new DeepSeekHarness({
      cwd: dir,
      processCwd: dir,
      dshHome: join(dir, "harness-home"),
      profile: "sdk",
      patches: [policyPatch(dir)],
      env: cleanEnv([]),
      initializeTimeoutMs: 30000,
    });
    let initialized = false;
    try {
      await harness.start();
      initialized = true;
    } finally {
      await harness.close();
    }
    console.log(
      JSON.stringify({
        node: process.version,
        sdk: "0.1.3-alpha.2",
        runtime: "0.1.3-alpha.2",
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
    ].includes(command),
    "command",
    `Unknown command ${command}; use dsh-worker help`,
  );
  const ticketId =
    [
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
    ].includes(command) ||
    (command === "recover" && !values.file)
      ? id.parse(positionals[1])
      : undefined;
  ensure(
    positionals.length <= (ticketId || command === "artifact" ? 2 : 1),
    "arguments",
    "Unexpected positional arguments",
  );
  const timeout = Number(values.timeout ?? 3600);
  ensure(
    Number.isFinite(timeout) && timeout > 0 && timeout <= 86400,
    "timeout",
    "--timeout must be greater than zero and at most 86400 seconds",
  );
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
      const status = await client.status(ticketId);
      if (!status.activeOperation || status.state === "interrupted")
        return status;
      ensure(
        Date.now() < deadline,
        "wait_timeout",
        "Wait timed out; execution continues. Inspect status before retrying; this did not cancel or resend work.",
      );
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  let result: unknown;
  if (command === "list") {
    const overview = await client.overview();
    result = values.summary
      ? { ...overview, tickets: overview.tickets.map(summary) }
      : overview;
  } else if (command === "status") {
    const status = await client.status(ticketId!);
    result = values.summary ? summary(status) : status;
  } else if (command === "errors")
    result = errors(
      await client.status(ticketId!),
      values.attempt,
      values.full,
    );
  else if (command === "diagnose") {
    const report = diagnose(await client.status(ticketId!), home);
    result = report;
    if (!report.ok) process.exitCode = 1;
  } else if (command === "wait") result = await wait(ticketId!);
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
      command === "instruct"
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
          ? { action: "archive", ticketId, archived: command === "archive" }
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
