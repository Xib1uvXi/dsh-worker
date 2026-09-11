# CLI troubleshooting

Use the same `--home DIR` as the running service. The examples use an installed `dsh-worker`; from a checkout, substitute `node /absolute/path/to/dist/cli.js`.

| Command | Purpose |
| --- | --- |
| `health --home DIR` | Check local discovery, recorded service process identity, authenticated connectivity, capacity/dispatch and local Skill configuration. Works when the service is unavailable. |
| `list --summary --home DIR` | Compact task inventory with current attempt and verification summaries. |
| `status ID --summary --home DIR` | Current state, revision, operation, attempt receipt/exit, snapshot, verification and uncertain instructions. |
| `status ID --home DIR` | Full durable task record, including snapshots, deliveries, reviews and continuations. |
| `errors ID --home DIR` | Historical errors grouped by source and bound to execution/verification/review records. |
| `errors ID --attempt ATTEMPT_ID --full --home DIR` | Restrict to one execution and include all stored failed-verification output. |
| `diagnose ID --home DIR` | Current health of a task, historical issues, and context-sensitive next-step argument arrays. Performs no repair. |
| `recover ID --home DIR` | Inspect interrupted work's current snapshot and remaining owned processes. Requires a separate explicit continuation to recover. |
| `workflow --home DIR` | Inspect configured Skill names, entry skills and source files. |
| `doctor --home DIR` | Separately initialize and close the installed Harness SDK/runtime without a model call. |

`health` checks connectivity, not provider billing, API-key validity or model execution. It does not print the service token or environment-variable values. The workflow check uses the calling CLI environment; supply the service's `DSH_WORKER_WORKFLOW` override here too if one was used. `doctor` is the explicit runtime smoke check and creates its isolated test directory. Use `trajectory ID` or the Web for detailed tool calls and messages; `brief ID` provides current-revision review evidence. See [Efficient orchestration](orchestration.md) for query and pagination semantics.

## Reading results

Data commands return JSON. `health` and `diagnose` exit **1** when their JSON report identifies an unhealthy service or a current task requiring attention; the report stays on stdout. A successful `errors` query exits **0** even when historical issues exist. Other failed commands return `{ "error": "...", "code": "...", "hint": "..." }` on stderr and exit **1**. Existing full `list` and `status` responses remain available without `--summary`.

`errors` includes execution errors/termination, delivery blockers, scope violations, failed verification commands, uncertain instructions and unsuccessful review findings. A failed command includes its argument array, exit code, timeout flag and output. Default output is the last 4,000 characters per failed command; `outputTruncated` identifies this CLI clipping. `--full` restores all **stored** output, while `serviceOutputTruncated` indicates data the service already truncated and cannot reconstruct. Model-generated test claims are not controller verification output.

Verifier exceptions are recorded on their verification record and survive recovery. Older records that lack both a completion and a stored cause are reported as incomplete; diagnostics cannot reconstruct an error discarded by an older service version.

Historical errors remain after recovery and acceptance. Use `currentState` and `diagnose.ok` to distinguish current problems from past failures. An attempt's recorded processes are durable evidence, not a fresh liveness scan. Summary snapshot-match status is `null` when that query has not captured the current checkout; detailed `status` and `diagnose` do capture it.

New attempts retain `failures.primary` and separate provider, execution, cleanup, snapshot and delivery details. Provider codes such as `TRANSPORT` survive the native turn result. Cancellation and deadline expiry have their own primary messages; absence of final JSON after such a stop is not reported as the primary failure. `errors` exposes these sources individually. Legacy flattened errors are retained as recorded, not retrospectively reclassified.

Process start observations use a fixed locale and recognize legacy English day/month layouts. An actual PID/start mismatch still fails closed. Do not delete locks or restart a reachable service solely to work around a differently formatted process timestamp.

Use `validate delivery|review --file FILE` for local format checks. For a frozen implementation whose final report was interrupted or malformed, inspect the [delivery-only recovery conditions](execution-lifecycle.md#repair-only-the-delivery-report). A missing report does not establish implementation success.

## Common cases

- **`service_missing`**: Check the control home and whether its service was started. Do not create a second service for an already-running home.
- **`service_config` / `service_url` / `service_lock`**: Inspect local discovery or process-identity configuration; do not hand-edit task state or delete ownership records to force progress.
- **`service_unreachable` / `service_timeout` / `service_stale`**: Use `health` to distinguish stale discovery/process ownership from an unreachable or unresponsive service. Normal control requests have a 10-second HTTP deadline; health connectivity uses 3 seconds. These limits do not terminate a Worker.
- **`unauthorized`**: The CLI's discovery token is not accepted by the service at that address. Confirm the correct home and owning service. For browser login, use that service's complete private login link.
- **`outcome: "unknown"`**: A mutation request lost its response or timed out. It might already have taken effect. Inspect `status`, `errors` and the Web before deciding the next action. No automatic retry occurs.
- **Interrupted/blocked task**: Read `errors`, then `recover ID` to inspect the exact attempt/snapshot/processes. Prepare an explicit continuation only after resolving the cause; recovery does not dispatch.
- **Failed verification**: Inspect command output. Correct the substantiated defect through external review/rework rather than recording acceptance from the Worker summary.
- **Uncertain instruction**: Check `trajectory ID --attempt ATTEMPT_ID` or the Web and the receipt state. Do not resend automatically or manufacture a fresh instruction ID as a retry workaround.
- **Accepted but stale**: The checkout changed after acceptance. Do not treat the old accepted snapshot as approval for the new content.

Suggestions returned by `diagnose` are argument arrays to inspect and use deliberately. The command never starts, cancels, recovers, edits state or accepts work on the caller's behalf.

## Missing native runtime dependencies

`doctor` reports `runtime_dependencies` when the installed Harness persistence module cannot load. Read the underlying module error first: a missing package requires reinstalling dependencies; a missing or incompatible native binding requires repairing that dependency for the current Node/platform combination. Harness 0.1.5 uses `koffi` and `@deepseek-ai/node-addon-system` for persistence, not `fs-ext`.

From the npm installation directory, use `npm ci` for a source checkout with its lockfile, or reinstall the installed worker package. If the error identifies a native dependency whose lifecycle scripts were skipped, permit that dependency's scripts under your npm policy and run `npm rebuild <package>` with its actual package name. Native compilation may require platform build tools. Then run the doctor command appropriate to your installation:

```sh
# Source checkout:
node dist/cli.js doctor
# Installed package:
npx dsh-worker doctor
```

[npm rebuild](https://docs.npmjs.com/cli/v11/commands/npm-rebuild/) reruns dependency lifecycle scripts; it cannot repair a missing compiler or a policy that still prevents those scripts. Doctor reports the underlying module error and does not install dependencies or change npm policy itself.

## Legacy converted worktrees

Schema-2 tickets created before admission baselines were recorded remain readable and use the raw assigned Git tree for scope checks. For an old ticket using CRLF or smudge conversions, the original checkout representation cannot safely be reconstructed from current files or current filter programs. If this causes a scope block, preserve the old evidence and prepare a new ticket/worktree to record a trusted baseline. Revisions and recovery do not silently rebaseline an existing worktree. A missing or modified recorded baseline is an integrity failure and must not be replaced with current working content.
