# TypeScript worker architecture

The worker implements code changes; an external orchestrator owns requirements, scheduling, review, acceptance and integration. Acceptance never means merged or released. The worker runtime prohibits delegation; development review follows the current repository working guide.

## Runtime integration

The distribution uses the public `@deepseek-ai/dsh-sdk-client` version pinned by `package.json` and `package-lock.json`. The SDK owns the runtime subprocess; named profiles and ordered patches configure it. The worker supplies an explicit environment, listens for native turn/receipt events and closes the owned runtime on cancellation. Receipt or idle alone is not acceptance. Local initialization and resolved policy behavior are checked by the doctor tests; SDK wire fixtures cover execution and instruction delivery.

## Components

`contracts` owns validated commands and browser-safe DTOs. `core` owns SQLite transactions, immutable ticket revisions, attempts, snapshots, independent verification and review. `runtime` adapts the public TS SDK behind an owned execution process and a final worker policy overlay. `server` mounts lifecycle resources as a Cordis plugin and exposes authenticated loopback HTTP plus replayable events. `cli` is a client of that same service, guided by the bundled skill. `web` imports the same contract types and supplies task creation, filtering, details, execution/cancellation, verification, review and explicit recovery.

No embedded planning model, replacement agent loop, auto merge, remote execution or automatic retry. Independent tickets may run concurrently up to a configured capacity; a ticket has one execution/verification owner. Start intent is persisted before any subprocess or model send. Restart does not replay prompts and fences uncertain executions until owned processes are accounted for. Runtime environment and per-attempt Harness home are isolated. Worktrees are cooperative isolation, not a security boundary against malicious code.

## Durable rules

A dedicated `controller-ownership.sqlite` connection holds an exclusive lock for the controller lifetime, including stale process-marker replacement. It is separate from state transactions and is never unlinked; the OS releases its lock on process exit. The `controller.lock` process marker remains for inspection and detection of an older active controller.

SQLite is authoritative; a journal in the same transaction provides ordered, replayable UI events. Large artifacts use content-addressed immutable files. A snapshot includes HEAD, staged state, file content, executable modes, symlink targets, tracked deletions and untracked files. Review requires the exact revision, attempt and snapshot; the latest verification for that attempt and revision must pass without changing the before/after snapshot. A newer failed or incomplete verification supersedes an earlier pass. Accepted evidence is reported stale after edits. Complete requires raw completed plus receipt, delivery bound to the current attempt, snapshot in scope and clean process exit. Unknown outcomes stay interrupted. Recovery is inspect-first and an explicit continuation never sends a prompt.

For opt-in independent ticket reviewers, dynamic pools and final host integration review, see [Two-level review](two-level-review.md). Ordinary tickets retain external review.

## Independent review coordination

The additive schema-2 `review_pools`, `review_runs` and `scheduled_operations` tables persist pool configuration, independent review evidence and explicitly queued execution intent. `packages/core/src/review-coordinator.ts` owns admission and review lifecycle through the controller; contracts validate the same actions for CLI and Web. Authenticated `GET /api/reviews` projects pools, operations, runs and current evidence applicability without mutating task state.

Implementation, verification and review consume the same global owned capacity. A batch has one pool. Its configured `implementationLimit` bounds implementation and reviewer ownership separately; it is not derived from currently live implementers. Admission chooses the oldest executable durable request across pools and roles, reserves ownership before dispatch, and retains the order of temporarily constrained requests. Direct run/verify cannot bypass an older executable request. No idle reviewer session is kept. Downscaling uses `pendingLimit` to drain existing owners; uncertain process cleanup continues to hold capacity.

Each review run uses an independent session, Harness home and inspection clone through the existing public SDK adapter. It binds the immutable ticket revision, implementation attempt, original snapshot, frozen reviewer configuration and inspection inputs. The controller validates report structure, acceptance coverage, provenance and unchanged evidence; a completed report may still recommend changes. The host records separate Spec and Standards decisions using the report digest and run identity. Neither report completion nor released ownership accepts a ticket. Restart fences active reviewers and suspends queued intent; explicit cleanup and pool re-enablement do not replay an uncertain send.

Final candidate review remains a host procedure, with provenance in the existing batch record rather than an automatic merge state machine. The host reviews the complete baseline-to-candidate difference, including integration repairs and non-ignored untracked files, and checks baseline and candidate identity again before authorized promotion. If the host substantially implements repairs, independent review covers the complete final candidate.

## Compatibility

Controller data uses schema 2 and `~/.dsh-worker-v2` by default. An unsupported SQLite schema is refused; legacy contracts must be converted explicitly. Session observation does not import controller history or promote it to acceptance evidence. The observer reads V0–V3 headers only. Harness session format V3 is separate from controller schema 2; this dependency upgrade does not migrate the controller database.

When resuming an older attempt, the runner copies its session directory into the new attempt's Harness home before using the public `agents.resume` API. Harness performs the supported V2-to-V3 transcript migration and preserves the old generation. The original attempt remains unchanged. Migration failure must remain a failed continuation, without a fresh-session fallback or automatic resend. V3 session artifacts cannot be read by Harness versions that only support V2; retain prior attempt homes when planning a runtime rollback. Configuration and controller data remain outside the repository.

## Acceptance for this rebuild

1. Node-only install/build/CLI; shared validated TS contracts and real SQLite.
2. Prepare preserves primary checkout, pins Git base and ownership, rejects duplicate/overlapping work and invalid revisions before side effects.
3. SDK adapter uses official launch/profile/patch semantics, no private process field, sanitized environment, redacted event persistence, bounded execution and owned shutdown.
4. Durable submit/rework/verify/review/recovery history; stale, incomplete, out-of-scope or uncertain evidence cannot pass.
5. Authenticated interactive UI and CLI commands use the same controller; journal replay and restart recovery work; no mutation by read endpoints.
6. Regression tests use real Git/SQLite/processes and the public SDK against a deterministic wire fixture; actual released runtime initialization/close is tested separately, with no development worker dispatch.
7. Desktop browser interactions, built-package consumption, and explicit Spec and Standards review evidence. Historical self-review is not independent review.

## Display scope

The user clarified that mobile viewing is not a requirement. Desktop management is the UI acceptance target. Existing responsive styles may remain, but mobile-specific development and tests are not acceptance gates.

## Web control, instructions and trajectory

The desktop workbench can create and edit immutable task revisions, run/cancel, verify/review, recover, and archive/restore idle tasks. Archive is a reversible visibility flag; evidence and worktrees remain. Normal edit fields retain advanced runtime settings, excluded paths and additional verification commands. Repository and base changes still require a new task.

A natural-language composer creates the task objective. The operator supplies repository, scope, acceptance and execution configuration; there is no implicit planning-model call or keyword parser pretending to understand arbitrary management commands. Per-task text instructions queue for the current revision's next run, or steer the already running session through the official SDK `client.prompt`. Instructions cannot reopen accepted/interrupted work or change the delivery/review contract. Revision changes do not silently carry queued text from an older revision; edit the objective or add a current-revision instruction when it should apply again.

Instruction intent is persisted before IPC. A client-generated instruction identity makes retrying the same input idempotent; conflicting reuse is rejected. States distinguish queued, sending, received and uncertain. Received proves Harness admission, not execution or a response causally assigned to that prompt. Sending failures and restart uncertainty are never automatically replayed. The runner only admits live text after its initial inbox receipt and closes the input channel when the activity interval ends.

Trajectory design follows upstream `packages/client/ui-trajectory` (ordered session ledger, turn/message/tool records) and the SDK's `session.event`, `session.status`, `subagent.started`, `subagent.finished` notifications. Native `tool/result` uses `data.message.content[].toolCallId`, paired with `tool/call.data.callId`; simpler adapters are handled without losing unknown event data. Entries carry controller sequence/time, attempt and session identity. The controller's journal retains notifications after exact-value credential redaction and an additive attempt identity. Browser previews omit reasoning blocks and stream payloads; they show observable text, tool inputs/results and lifecycle events rather than invented thought narration.

Authenticated `/api/tickets/:id/trajectory?after=N` returns up to 100 scanned entries plus the next cursor and agent activity; optional `limit`, `attempt` and exact `kind` filters follow the [evidence query contract](orchestration.md#evidence-query-contract); `/activity` returns only activity. Projection state rebuilds from the durable journal on restart and advances incrementally afterward. Agent cards are grouped by task/attempt with explicit child-parent identities when the runtime reports them. Ownership teardown and crash fencing override obsolete running labels. The present worker policy still disables delegation: displaying reported children does not enable subagent execution.

Web trajectory polling updates every second while viewing, dashboard activity every three seconds, alongside the existing replayable SSE control journal. Filters cover attempt, session, event kind and text within the loaded window. The browser keeps at most 300 entries and renders expandable records; additional pages and a restart-from-beginning action allow history inspection. Original artifacts stay in SQLite/runs; paging does not delete them. Tool output is rendered as text under the existing same-origin token/CSP policy. Form drafts survive lifecycle refresh; instruction IDs survive transient send failures.

## Orchestrator entry: CLI + Skill

The orchestrator invokes the regular CLI and follows the bundled skill returned by `skill`. CLI and Web share authenticated loopback control and persistent state.

CLI covers prepare, run, status/list, bounded waiting, natural-language instructions, cancellation/recovery, verification/review, archive/restore, hash-verified artifact retrieval, and local skill/workflow discovery. JSON input can come from files or stdin; instruction text can also come from a UTF-8 file or stdin. A stable instruction identity is required for safe retries. CLI `trajectory` and `activity` expose the existing observable projections. Per-ticket `events` pages control changes without native notifications or process bookkeeping. `brief` projects current-revision evidence in core, omitting full diffs, manifests and old attempts while preserving verification, review and snapshot identity. All use read-only authenticated service routes; [Efficient orchestration](orchestration.md) defines cursor, truncation and freshness semantics.

## Polling, storage and maintenance

HTTP overview and CLI wait use compact ticket records. Snapshot manifests are stored once in SQLite's additive `snapshots` table; ticket rows retain digest, scope diagnostics and a `detailsOmitted` marker. Full status hydrates file/index/diff evidence for review. Existing schema-2 inline snapshots remain readable and are extracted on their next state write.

Polling checks run in one background worker. Requests for the same ticket state share a check and reuse its result for at most three seconds (`snapshotCheckedAt`, `snapshotMaxAgeMs`). File hashes are reused only when inode, size, mode, nanosecond modification and change times match. These checks inform display; verification, review and recovery capture exact contents without this cache. Running/ready polling does not capture a repository. The synchronous embedding `status()` remains an explicit immediate inspection; transports use `pollStatus()` / `pollOverview()`.

Periodic process scans use asynchronous OS commands and persist only identity-set changes. Initial ownership and final cleanup remain mandatory. Snapshot capture for settlement and review occurs before the short SQLite state transaction. Each capture reads index entries once for both paths and identity, and obtains raw changed paths and the binary patch from one Git diff per working/staged comparison. File metadata is read once per entry. Ownership, symlink and evidence checks remain active. Snapshots still hash the complete delivered tree and staged state; blob storage copies only changed files. Changed paths also compare actual file bytes and executable modes with the assigned base tree in its checkout representation, so assume-unchanged/skip-worktree index flags and `core.fileMode=false` cannot hide scope violations; staged-only changes remain included. At first worktree creation, Git 2.43+ reconstructs checkout bytes from the assigned commit and its attributes. Conversion overrides are saved once as a content-addressed baseline outside ticket JSON; the ticket retains only its path and digest. Subsequent snapshots verify this immutable evidence and bind its digest, so later attribute, filter configuration or filter program changes cannot redefine the admitted baseline. Polling disables external clean, smudge and process filters for patch reads. Working patches compare Git blobs without those filters; scope decisions use actual bytes against the admitted checkout baseline, so legitimate checkout conversions do not count as edits. Legacy records without this admission evidence compare raw committed bytes and never infer a new baseline from current files or filter settings. Existing immutable blobs reuse a checked inode/metadata cache, while artifact downloads always hash the actual bytes.

Verification interruption retains its operation kind across restarts and recovery failures. After explicit cleanup, an unchanged valid delivery returns to `awaiting_review` for another verification, with no new model attempt. A changed or invalid delivery returns to `ready`; verification is never inferred to have passed.

`prune --days 7` explicitly removes old Harness homes only for idle tasks' clean, ended attempts, plus old doctor scratch directories whose recorded owner has exited. Legacy doctor directories without ownership evidence are retained. Successful doctor runs remove their own scratch directory. The journal, ticket history, raw runner events, admission inputs and snapshots have indefinite evidence retention; they are not automatically aged out because recovery, event replay and external acceptance depend on them. Archive changes visibility and does not authorize evidence deletion.

The single npm distribution has enforceable internal import directions (see `tests/boundaries.test.ts`). `shared` contains Node OS utilities below runtime/core; the root public entry composes controller, runtime and CLI exports. Runtime cannot import core, and core cannot import clients. Browser display labels live in `packages/web`; trajectory wire titles use language-neutral event keys.

## Coding capability composition

Controller-local `plugins.json` or a complete per-ticket `execution.plugins` selection adds native MCP, terminal, hook and PTC capabilities before the final worker policy. Reports retain credential references; runtime resolution supplies actual values only to the selected transport. Hook documents are snapshotted for the attempt. The public local subprocess provider is extended only to preserve the attempt marker, including PTYs. Programmatic code uses the official worker-thread backend with a cooperative restriction on direct process creation; commands go through the existing owned tools. Required plugin startup completes before the SDK becomes ready.

Native session statistics are relayed through an attempt-local telemetry file into durable controller `worker/stats` observations at checkpoints/closed steps and replayed through the existing trajectory API. They do not append custom required events to Harness session history, so session resume remains compatible with the pinned event vocabulary. This observation never changes ticket acceptance. Ralph is explicitly disabled alongside subagent/workflow tools. See [Worker capabilities](plugins.md).

The runner preflights controller-local `tools.json` selections after durable attempt admission and before the first model prompt. It records the resolved configuration and injects the coding plugin before the final worker policy. The default model-facing `grep` uses tgrep through the public subprocess seam, with a per-attempt disk index checked against live file metadata; unstable or filtered searches use tgrep live traversal. Native glob remains on packaged ripgrep. Native Harness LSP packages provide selected language navigation through an ownership-preserving stdio launcher. Read-only tool inspection does not install or dispatch; explicit `tools install` provisions the pinned tgrep binary. See [Coding tools](coding-tools.md) for configuration, costs and limits.

## Execution lifecycle additions

See [Setup, baselines, credentials and answers](execution-lifecycle.md) for the schema-2 additions and their ownership, redaction, comparison and resume rules. Baselines never relax acceptance; recovery persists an answer without dispatch, and only an explicit run starts the new attempt.
