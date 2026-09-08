# Getting started

This guide takes a new operator from a source checkout to a reviewed task. Commands run from the directory containing this project's `package.json`. Paths such as `/path/to/repository` are placeholders to replace. For an installed tarball, substitute `dsh-worker` for `node dist/cli.js` and use the example paths returned by `dsh-worker skill`.

The local service owns task state and executions. The external orchestrator prepares assignments, reviews evidence and integrates accepted changes. Engineering skills are optional and configurable; no personal skill suite is required.

## 1. Check prerequisites and build

Required: Node **24.18 or newer**, npm and Git 2.43 or newer. macOS arm64 is validated; Linux still needs separate platform verification.

```sh
node --version
npm --version
git --version
npm ci
npm run build
node dist/cli.js help
```

The Harness runtime requires native dependencies, including `fs-ext`. Installation must run their lifecycle scripts and may need a C++ build toolchain (Xcode Command Line Tools on macOS). A source-only `--ignore-scripts` install does not establish runtime readiness. Follow your package manager’s script policy; `doctor` reports missing persistence dependencies before starting Harness.

Expected: installation and build exit successfully, and `help` lists the CLI commands. To run the project's full test suite, install its test browser with `npx playwright install chromium`, then run `npm run check`. The test browser is not needed merely to open the Dashboard in your own browser.

## 2. Select a control home

Set this in each terminal used to control the same service:

```sh
export DSH_WORKER_HOME="$HOME/.dsh-worker-v2"
node dist/cli.js health
```

`DSH_WORKER_HOME` selects the state directory; an explicit `--home DIR` takes precedence. Keep this directory outside shared source control. It contains private login information, the database, worktrees and execution evidence.

If `health` succeeds, reuse that service and continue to the Dashboard. If it reports `service_missing` on a new installation, startup is the next step. If a lock, stale process or authentication error is reported, follow [Troubleshooting](troubleshooting.md) before starting another controller. A nonzero health result alone is not permission to replace ownership records.

## 3. Configure optional engineering skills

Create an empty configuration only if none exists:

```sh
mkdir -p "$DSH_WORKER_HOME"
if [ ! -e "$DSH_WORKER_HOME/workflow.json" ]; then
  cp examples/workflow.json "$DSH_WORKER_HOME/workflow.json"
fi
node dist/cli.js workflow
```

Expected: an empty configuration is valid and reports no selected skills. To use your own methods, edit that file in your text editor:

```json
{
  "schemaVersion": 2,
  "skillDirs": ["/path/to/skills/implementation"],
  "instructionFiles": ["/path/to/working-agreement.md"],
  "entrySkills": ["implementation"]
}
```

Replace the example paths with existing files. Each skill directory contains `SKILL.md`; `entrySkills` uses its frontmatter name. Run `workflow` again and check the resolved names and paths. Changes apply to subsequent attempts; do not edit skill sources during an active attempt. See [Skill configuration](skills.md) for path resolution and role boundaries.

## 4. Check the runtime and start the service

```sh
node dist/cli.js doctor
```

Expected: `initialized: true`, `closed: true`, and `modelCalls: 0`. This checks the installed Harness runtime without validating an API key or running a coding task.

For Dashboard access and assignment preparation without model execution:

```sh
node dist/cli.js serve --port 4317 --capacity 8
```

Expected: a private login URL is printed and dispatch is reported as disabled. Keep this terminal running. Capacity 8 is an explicit example; choose a capacity appropriate to your resources. The CLI's default capacity, if omitted, is 2.

To execute real tasks, the **service process** must inherit the credentials named by each ticket. For the bundled DeepSeek provider example, this is `DEEPSEEK_API_KEY`. If it is already supplied by your environment or credential manager, reuse it. Otherwise, the account owner must obtain an API key from the provider's official console and enter it locally. Do not paste it into a ticket, source file, chat or command-line argument.

The following credential-entry snippet is for **Bash**. If your terminal uses another shell, run `bash` first, then set `DSH_WORKER_HOME` in that shell as in step 2:

```bash
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  IFS= read -r -s -p 'DeepSeek API key: ' DEEPSEEK_API_KEY
  printf '\n'
fi
export DEEPSEEK_API_KEY
```

The key is hidden during entry and remains in that shell's environment; the snippet does not save it to disk or place its value in shell history. If input is empty or interrupted, do not start a credential-dependent task. For persistent startup, use your own credential manager rather than adding a plaintext key to a shell profile.

If a service is already running without dispatch or without these credentials, first confirm `health` reports zero active operations, then stop its foreground process with Ctrl+C. Stopping a service with active work interrupts that work. Start exactly one service from the credential-bearing shell:

```sh
node dist/cli.js serve --enable-dispatch --port 4317 --capacity 8
```

Expected: dispatch is enabled. Exporting a key in a different terminal after startup does not update the existing service's environment. Starting the service does not itself dispatch a task; an authorized `run` is the first coding execution and can incur provider usage.

## 5. Open and check the Dashboard

Open the **complete private URL printed by `serve`**, including its token fragment. Do not share that link. The browser clears the fragment after reading it and remembers the login for that address. The token survives service restarts using the same control home; another browser profile or address needs its own first login.

In a second terminal, set the same `DSH_WORKER_HOME` and run:

```sh
node dist/cli.js health
node dist/cli.js list --summary
```

Expected: `health.ok` is true, capacity and dispatch match startup, and the task list agrees with the Dashboard. A browser authentication error does not require a new API key: the Dashboard service token and the model provider key are separate credentials.

## 6. Prepare a concrete assignment

Give your external orchestrator the output of `node dist/cli.js skill`, or load the bundled `skill/SKILL.md` using its supported skill mechanism. This is CLI + Skill integration; no protocol-server registration is needed.

Copy `examples/ticket.json` to a local task file and replace all placeholders. The template is **not ready to execute unchanged**. Have the orchestrator supply:

| Field                      | Required value                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `ticketId`, `revision`     | A unique task ID, starting with revision 1.                                             |
| `targetRepo`, `baseCommit` | An existing absolute Git repository path and a full existing commit SHA.                |
| `objective`, `context`     | Concrete behavior, inputs/outputs and relevant project context.                         |
| `scope`, `outOfScope`      | Owned paths, exclusions and explicit boundaries.                                        |
| `acceptance`               | Checkable criteria with unique IDs.                                                     |
| `verification`             | Commands valid in that repository, with working directories and timeouts.               |
| `execution`                | Provider, model, optional reasoning settings and required credential environment names. |

Use `git -C /path/to/repository rev-parse HEAD` to inspect a candidate base; the repository must already contain a commit. A new worktree starts from the specified commit and does not inherit the primary checkout's uncommitted changes. Dependencies needed by verification must be available in the new worktree; describe the project's dependency setup in the assignment instead of assuming the primary checkout's ignored build files will be copied.

After reviewing the task file, prepare it:

```sh
node dist/cli.js prepare --file ticket.json
node dist/cli.js status EXAMPLE-01 --summary
```

Replace `EXAMPLE-01` in subsequent commands if you chose another ID. Expected: state `ready`, with an owned worktree. Preparation does not call the model. Existing revisions cannot be edited in place; repository or base changes require a new task.

The default worker model is `deepseek-v4-pro`. CLI and API tickets may omit `execution.model`; preparation stores the resolved default. The Web form and ticket template use the same model. An explicitly supplied model is preserved.

## 7. Run, observe and send instructions

```sh
node dist/cli.js run EXAMPLE-01
node dist/cli.js wait EXAMPLE-01 --timeout 300
node dist/cli.js status EXAMPLE-01 --summary
```

The service continues after the `run` client exits. A wait timeout does not cancel work. Use task details on the Dashboard to inspect Agent activity, tool calls and execution trajectories. Expected completion is `awaiting_review`, not automatic acceptance. For `blocked` or `interrupted`, use step 9.

To add guidance within the existing scope, write UTF-8 text into `instruction.txt` and send it once with a stable ID:

```sh
node dist/cli.js instruct EXAMPLE-01 --instruction-file instruction.txt --revision 1 --instruction-id EXAMPLE-01-note-1
```

The Dashboard also supports natural-language task entry and follow-up instructions. A receipt proves delivery to the inbox, not completed implementation. Inspect an uncertain receipt before deciding whether to resend anything.

## 8. Verify, review and integrate

```sh
node dist/cli.js verify EXAMPLE-01 --wait
node dist/cli.js status EXAMPLE-01
```

The external reviewer inspects the actual diff, acceptance evidence, scope and process exit, and records separate Spec and Standards assessments. Passing tests alone do not complete review.

Use [the review template](../examples/review.json) to construct a local `review.json`. Replace its task ID, revision, attempt ID and snapshot digest with the exact current submission. Set the assessments, findings and verdict to the actual review result; the template's values are examples, not an approval. Acceptance requires the latest controller verification for the current attempt and revision to pass on the unchanged snapshot.

```sh
node dist/cli.js review --file review.json
node dist/cli.js status EXAMPLE-01 --summary
```

Expected after a passing review: `accepted` and `stale: false`. For actual defects, submit `request_changes` with concrete findings, then assign a new attempt. The orchestrator separately retrieves accepted artifacts with `artifact SHA256 --output FILE`, checks their hashes and applies them to the intended integration checkout. Integration, commits, merges and deployment are separate operations; `accepted` does not perform them.

## 9. Troubleshoot and resume

```sh
node dist/cli.js errors EXAMPLE-01
node dist/cli.js diagnose EXAMPLE-01
node dist/cli.js recover EXAMPLE-01
```

`recover ID` is an inspection command for blocked/interrupted work. After resolving the cause, adapt [the continuation template](../examples/continuation.json) using the exact attempt and snapshot from that inspection, plus a concrete continuation instruction:

```sh
node dist/cli.js recover --file continuation.json
node dist/cli.js status EXAMPLE-01 --summary
```

Expected: `ready` for further implementation, or `awaiting_review` when interrupted verification retained an unchanged valid delivery. No model is launched. In the latter case, rerun verification; otherwise run again only when the continuation is ready for execution. Never edit the database or delete ownership records to bypass a failure. Historical errors remain queryable after recovery. See [Troubleshooting](troubleshooting.md) for error codes, output limits and unknown request outcomes.

## Completion checklist

- One service uses the intended home, capacity, dispatch setting and credentials.
- `health` succeeds and the Dashboard can authenticate.
- Optional skills resolve to your own selected files.
- The task has a concrete base, scope, acceptance and verification procedure.
- Real execution, independent verification and external review have their own evidence.
- Any integration result is recorded separately from task acceptance.

On a new installation, only account access/key entry, local choices and the independent review judgment require operator input. This guide does not claim those steps have already been performed for its reader.
