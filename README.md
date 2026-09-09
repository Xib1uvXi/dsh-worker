# dsh-worker

A durable coding worker built on the public DeepSeek Harness TypeScript SDK. An external orchestrator owns design, scheduling, review, acceptance and integration; the worker implements and tests bounded assignments.

Use the **CLI + bundled Skill** to control tasks from an orchestrator, or the **desktop Web workspace** to create tasks, follow execution and review results. Both interfaces share validated contracts and one persistent control service.

- Run independent tickets concurrently, with a separate Harness home for each attempt and explicit conversation resume for answered blockers.
- Keep ticket revisions, execution evidence, verification and review in durable local state.
- Bind acceptance to the exact delivered snapshot and external Spec/Standards review.
- Configure worker skills explicitly, without requiring a particular personal skill suite.

## Quick start

Requires **Node 24.18 or newer**, npm and Git **2.43 or newer** on macOS or Linux. macOS arm64 is the validated development platform; Linux still needs separate platform verification.

From a source checkout:

```sh
npm ci
npm run build
node dist/cli.js tools install
node dist/cli.js tools --repo .
node dist/cli.js doctor --repo .
node dist/cli.js serve
```

`tools install` installs the pinned tgrep under the controller home. Go/Rust projects also need their language servers; see [Coding tools](docs/coding-tools.md). `doctor --repo` checks that the installed Harness runtime and selected coding plugins initialize and close without a model request. It does not validate provider credentials or a real coding task.

Open the **complete private login URL printed by `serve`**. Its fragment supplies the service token and is cleared after login; the browser remembers the token for that address. The token survives service restarts. A new browser profile or address needs the full login link again.

The service starts with **model dispatch disabled** and a default capacity of **2**. You can prepare assignments and inspect records before enabling execution.

The default control directory is `~/.dsh-worker-v2`. Use `--home DIR` consistently across the service and CLI, or set `DSH_WORKER_HOME`. Keep this directory outside shared source control: it contains the private service token, SQLite state, worktrees and execution evidence.

For credential setup, Dashboard checks and a complete first task, follow [Getting started](docs/getting-started.md).

## Run a reviewed task

The service process must inherit the credential references named in `execution.credentialEnv` and the task variables named in `execution.envRequired`. Once credentials are available, start one service with dispatch enabled:

```sh
node dist/cli.js serve --enable-dispatch --capacity 2 --port 4317
```

If a service is already running, confirm `health` reports zero active operations before stopping it with Ctrl+C and restarting. See the [startup guide](docs/getting-started.md) for private credential entry. Starting the service does not itself dispatch a task.

In another terminal, using the same control home:

```sh
# First adapt examples/ticket.json into a concrete ticket.json.
node dist/cli.js prepare --file ticket.json
node dist/cli.js run EXAMPLE-01 --wait
node dist/cli.js status EXAMPLE-01
node dist/cli.js verify EXAMPLE-01 --wait

# After external review, fill review.json with the actual evidence and verdicts.
node dist/cli.js review --file review.json
```

The [ticket template](examples/ticket.json) needs a real repository, an existing base commit, owned scope, acceptance criteria, verification commands and explicit execution settings. Replace `EXAMPLE-01` if you choose another ticket ID. A task worktree starts from the specified commit and does not inherit uncommitted changes or ignored dependencies from the primary checkout. Use `setup` for controller-run dependency installation before the model starts. Each revision also gets a separate verification baseline; [Execution lifecycle](docs/execution-lifecycle.md) explains setup, command confinement, failure comparisons, credential redaction and answers to blocked workers.

The default worker model is `deepseek-v4-pro`. CLI and API tickets may omit `execution.model`; preparation stores the resolved default. The Web form and ticket template use the same model. An explicitly supplied model is preserved.

The [review template](examples/review.json) must identify the current ticket revision, attempt and snapshot, with the external reviewer's actual Spec and Standards decisions. The examples are templates, not ready-to-run assignments or approvals.

**Accepted does not mean committed, merged, published or deployed.** Integration remains the orchestrator's responsibility.

## Orchestrator and desktop interfaces

Load the bundled command workflow and inspect CLI usage:

```sh
node dist/cli.js skill
node dist/cli.js help
```

`skill` returns portable instructions, their file path and the examples directory. An installed package exposes the same commands as `dsh-worker`. No protocol server or client registration is required.

To connect your own engineering methods and delivery preferences, follow [Create your own orchestrator skill](docs/orchestrator-setup.md). It includes a generation prompt and a portable `dsh-orchestrator` template for your host; installing this package does not install personal host skills or select worker methods for you.

| Action                            | Command after package installation                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Check service health              | `dsh-worker health`                                                                                       |
| List tasks                        | `dsh-worker list --summary`                                                                               |
| Inspect task evidence             | `dsh-worker status TASK-01`                                                                               |
| Wait for a task                   | `dsh-worker wait TASK-01 --timeout 300`                                                                   |
| Send a revision-bound instruction | `dsh-worker instruct TASK-01 --instruction-file message.txt --revision 1 --instruction-id TASK-01-note-1` |
| Inspect historical errors         | `dsh-worker errors TASK-01`                                                                               |
| Get recovery guidance             | `dsh-worker diagnose TASK-01`                                                                             |
| Inspect an interrupted task       | `dsh-worker recover TASK-01`                                                                              |
| Retrieve a verified snapshot file | `dsh-worker artifact SHA256 --output FILE`                                                                |
| Archive or restore an idle task   | `dsh-worker archive TASK-01` / `dsh-worker restore TASK-01`                                               |

From a checkout, substitute `node dist/cli.js` for `dsh-worker`. Data commands return structured JSON. `prepare`, `review`, `recover` and JSON-form `instruct` accept `--file -`; text instructions accept `--instruction-file -`. Reuse stable instruction IDs for retries. Uncertain delivery is never automatically replayed, and a wait timeout does not cancel execution. Artifact retrieval refuses to overwrite an existing file.

The desktop workspace supports natural-language task entry with explicit repository, scope and acceptance fields; editable task versions; execution and cancellation; verification and external review; recovery; and archive/restore. Additional instructions queue for the next attempt or reach the running Harness session through its native prompt API, with visible receipt states.

Execution trajectories and agent activity are available in the Web and through the CLI. Inspect messages, tool calls, parameters, results and turn boundaries by attempt or session. Reported child agents retain parent identity, but worker delegation remains disabled. Task entry does not call an extra planning model, and the UI does not invent hidden reasoning.

For compact review evidence, run `brief TASK-01`; use `trajectory TASK-01`, `activity TASK-01` and `events TASK-01` for read-only execution inspection. See [Efficient orchestration](docs/orchestration.md) for assignment context, pagination and the complete review/integration loop.

## Coding tools

Worker `grep` uses tgrep by default, with an attempt-local index and live scanning when needed for freshness. Native Harness LSP adds Go, Rust and TypeScript definition/reference/implementation/hover queries. `tools --repo PATH` checks the selected executables; `tools.json` in the controller home can select languages and paths. See [Coding tools](docs/coding-tools.md) for installation, configuration, search costs and validation limits.

## Optional worker workflow configuration

No workflow initialization is required to use the worker. The [bundled orchestrator skill](skill/SKILL.md) explains CLI control; optional **worker engineering skills** are configured separately in the control directory's `workflow.json`.

Use the [empty configuration example](examples/workflow.json) as a starting point only when needed, then inspect the resolved configuration:

```sh
node dist/cli.js workflow
```

`skillDirs` selects native Harness skill bundles, `instructionFiles` selects explicit guidance, and `entrySkills` names the skills to load first. Configuration is read before each attempt. Keep personal paths and selections outside the shared repository; the product does not embed a developer's private skill paths or change the orchestrator's model or reasoning settings. See [Skill configuration](docs/skills.md).

## Evidence and recovery guarantees

A completed model turn is eligible for review only after the controller observes a durable receipt, raw `completed` reason, correctly bound delivery, complete in-scope snapshot and owned process cleanup. Receipt, idle, exit zero and natural-language claims alone cannot promote an attempt. Missing or invalid delivery remains interrupted; blocked delivery returns its blockers.

Acceptance requires external Spec/Standards decisions and the latest controller-run verification for the current attempt and revision to pass on the unchanged snapshot. A newer failed verification invalidates an earlier pass. Verification that changes files cannot validate the old delivery. Later changes mark accepted evidence stale. Dashboard freshness checks are asynchronous and may lag by up to three seconds; acceptance always checks the current files directly.

The service owns a process-identity lock, SQLite state and child executions. A ticket cannot execute, verify and recover concurrently. Cancellation closes the SDK runtime and accounts for detached descendants; a crash never causes automatic resend. `recover ID` only inspects. An explicit continuation supplied with `recover --file continuation.json` accounts for old writers and returns the ticket to ready without starting a model. Interrupted verification with an unchanged valid delivery instead returns to awaiting review so verification can be rerun.

SQLite and its journal are authoritative; artifact files are immutable and content-addressed. Snapshots cover tracked and non-ignored untracked files, deletions, binary content, modes, symlink targets, Git HEAD and staged state. Ignored build outputs are not deliverables; files over 32 MiB and unsupported submodules block snapshot creation. Scope is checked against the assigned base. Worktrees provide cooperative workspace separation, not containment against malicious code running under your OS account.

## Development and verification

Optional [worker capabilities](docs/plugins.md) add task-selected MCP servers, interactive terminals, hooks and experimental programmatic tool calls. Whole-session timing statistics are enabled by default. Configure them in controller-local `plugins.json` or a ticket's `execution.plugins`.

The real coding-tool tests also require tgrep, gopls and rust-analyzer with the corresponding toolchains; follow [Coding tools](docs/coding-tools.md#development-checks) first.

```sh
# Install the test browser once, then run lint, type checking, build and tests.
npx playwright install chromium
npm run check

# Verify a fresh tarball install and its real doctor (zero model calls).
npm run test:package

# Build the distributable package after successful checks.
npm pack
# Install the generated tarball in a separate directory:
npm install /path/to/dsh-worker-worker-0.2.0.tgz
npx dsh-worker help
```

`npm run lint` checks maintained TypeScript, JavaScript fixtures and root configuration with ESLint. It catches unused code, unsafe Promise usage and Node-only globals/imports in browser modules. `npm run lint:fix` applies available automatic fixes; remaining diagnostics require an edit. Both commands fail on warnings. Generated `dist`, coverage, dependencies and personal `.scratch` files are excluded. Prettier remains the separate `npm run format:check` formatting check. `npm run check` runs lint before type checking, build and tests.

`npm test` builds first, then runs real Git/SQLite/process regressions, public-SDK wire fixtures, CLI lifecycle and desktop Chromium interaction checks. The deterministic SDK fixture is not a real model. The [verification record](docs/verification.md) documents completed checks, real-task evidence and remaining boundaries.

| Directory            | Responsibility                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/shared`    | Node filesystem/process primitives, with no controller/client dependencies                             |
| `packages/contracts` | Zod validation, commands, states and browser-safe types                                                |
| `packages/core`      | Durable control state, Git ownership, evidence, verification and review                                |
| `packages/runtime`   | Official TypeScript SDK adapter, isolated execution process, policy and workflow patches               |
| `packages/server`    | Cordis lifecycle plugin, authenticated loopback HTTP, replayable events and session-header observation |
| `packages/cli`       | CLI client of the control service                                                                      |
| `packages/web`       | Desktop task management and execution trajectories                                                     |

Runtime behavior uses the official `dsh --profile sdk` launcher and ordered patches, with the worker policy applied last. There is no Harness core fork or replacement model loop. See [Architecture](docs/architecture.md) for persistence, process ownership and interface details.

`serve --harness-home DIR` (repeatable) observes source-qualified Harness session headers. It selects the highest canonical v0/v1/v2 generation, supports plain/zstd and bounds reads without reading transcripts or falling back from an unsupported generation. Parent metadata does not prove current liveness; missing or corrupt sources remain explicit diagnostics.

## Documentation

| Guide                                          | Use it for                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)     | Installation, credentials, Dashboard login and the first reviewed task        |
| [Bundled orchestrator skill](skill/SKILL.md)   | Assignment handoff and the CLI review loop                                    |
| [Create your own orchestrator skill](docs/orchestrator-setup.md) | Generate and validate a personal orchestrator using your own methods |
| [Skill configuration](docs/skills.md)          | Optional worker skills and instruction files                                  |
| [CLI troubleshooting](docs/troubleshooting.md) | Error codes, failed verification, historical attempts and safe recovery       |
| [Architecture](docs/architecture.md)           | Components, durable contracts and runtime integration                         |
| [Project workflow](docs/agents/domain.md)      | Repository guidance, local task tracking, domain context and decision records |
| [Performance experiments](docs/performance.md) | Snapshot ablations, workload and measured tradeoffs                           |
| [Verification record](docs/verification.md)    | Recorded checks and the limits of their evidence                              |

## License

[MIT](LICENSE)

## Scratch retention

Run `node dist/cli.js prune --days 7 --home DIR` against the service to remove old Harness homes of clean, ended attempts and old doctor scratch directories whose recorded owner has exited. Active or uncertain tasks are excluded. Journal and snapshot evidence is retained indefinitely; this command does not delete task history. Successful `doctor` calls clean up their own scratch directories.
