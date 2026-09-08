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

## Compatibility

Controller data uses schema 2 and `~/.dsh-worker-v2` by default. An unsupported SQLite schema is refused; legacy contracts must be converted explicitly. Session observation does not import controller history or promote it to acceptance evidence. Configuration and controller data remain outside the repository.

## Acceptance for this rebuild

1. Node-only install/build/CLI; shared validated TS contracts and real SQLite.
2. Prepare preserves primary checkout, pins Git base and ownership, rejects duplicate/overlapping work and invalid revisions before side effects.
3. SDK adapter uses official launch/profile/patch semantics, no private process field, sanitized environment, raw event persistence, bounded execution and owned shutdown.
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

Trajectory design follows upstream `packages/client/ui-trajectory` (ordered session ledger, turn/message/tool records) and the SDK's `session.event`, `session.status`, `subagent.started`, `subagent.finished` notifications. Native `tool/result` uses `data.message.content[].toolCallId`, paired with `tool/call.data.callId`; simpler adapters are handled without losing unknown event data. Entries carry controller sequence/time, attempt and session identity. The controller's journal retains raw notifications and an additive attempt identity. Browser previews omit reasoning blocks and stream payloads; they show observable text, tool inputs/results and lifecycle events rather than invented thought narration.

Authenticated `/api/tickets/:id/trajectory?after=N` returns 100 ordered entries plus the next cursor and agent activity; `/activity` returns only activity. Projection state rebuilds from the durable journal on restart and advances incrementally afterward. Agent cards are grouped by task/attempt with explicit child-parent identities when the runtime reports them. Ownership teardown and crash fencing override obsolete running labels. The present worker policy still disables delegation: displaying reported children does not enable subagent execution.

Web trajectory polling updates every second while viewing, dashboard activity every three seconds, alongside the existing replayable SSE control journal. Filters cover attempt, session, event kind and text within the loaded window. The browser keeps at most 300 entries and renders expandable records; additional pages and a restart-from-beginning action allow history inspection. Original artifacts stay in SQLite/runs; paging does not delete them. Tool output is rendered as text under the existing same-origin token/CSP policy. Form drafts survive lifecycle refresh; instruction IDs survive transient send failures.

## Orchestrator entry: CLI + Skill

The orchestrator invokes the regular CLI and follows the bundled skill returned by `skill`. CLI and Web share authenticated loopback control and persistent state.

CLI covers prepare, run, status/list, bounded waiting, natural-language instructions, cancellation/recovery, verification/review, archive/restore, hash-verified artifact retrieval, and local skill/workflow discovery. JSON input can come from files or stdin; instruction text can also come from a UTF-8 file or stdin. A stable instruction identity is required for safe retries. Detailed trajectory, raw event and agent-activity querying are Web-only; no CLI trace-query command is provided.

## Polling, storage and maintenance

HTTP overview and CLI wait use compact ticket records. Snapshot manifests are stored once in SQLite's additive `snapshots` table; ticket rows retain digest, scope diagnostics and a `detailsOmitted` marker. Full status hydrates file/index/diff evidence for review. Existing schema-2 inline snapshots remain readable and are extracted on their next state write.

Polling checks run in one background worker. Requests for the same ticket state share a check and reuse its result for at most three seconds (`snapshotCheckedAt`, `snapshotMaxAgeMs`). File hashes are reused only when inode, size, mode, nanosecond modification and change times match. These checks inform display; verification, review and recovery capture exact contents without this cache. Running/ready polling does not capture a repository. The synchronous embedding `status()` remains an explicit immediate inspection; transports use `pollStatus()` / `pollOverview()`.

Periodic process scans use asynchronous OS commands and persist only identity-set changes. Initial ownership and final cleanup remain mandatory. Snapshot capture for settlement and review occurs before the short SQLite state transaction. Each capture reads index entries once for both paths and identity, and obtains raw changed paths and the binary patch from one Git diff per working/staged comparison. File metadata is read once per entry. Ownership, symlink and evidence checks remain active. Snapshots still hash the complete delivered tree and staged state; blob storage copies only changed files. Changed paths also compare actual file bytes and executable modes with the assigned base tree in its checkout representation, so assume-unchanged/skip-worktree index flags and `core.fileMode=false` cannot hide scope violations; staged-only changes remain included. At first worktree creation, Git 2.43+ reconstructs checkout bytes from the assigned commit and its attributes. Conversion overrides are saved once as a content-addressed baseline outside ticket JSON; the ticket retains only its path and digest. Subsequent snapshots verify this immutable evidence and bind its digest, so later attribute, filter configuration or filter program changes cannot redefine the admitted baseline. Polling never runs conversion filters. Legacy records without this admission evidence compare raw committed bytes and never infer a new baseline from current files or filter settings. Existing immutable blobs reuse a checked inode/metadata cache, while artifact downloads always hash the actual bytes.

Verification interruption retains its operation kind across restarts and recovery failures. After explicit cleanup, an unchanged valid delivery returns to `awaiting_review` for another verification, with no new model attempt. A changed or invalid delivery returns to `ready`; verification is never inferred to have passed.

`prune --days 7` explicitly removes old Harness homes only for idle tasks' clean, ended attempts, plus old doctor scratch directories whose recorded owner has exited. Legacy doctor directories without ownership evidence are retained. Successful doctor runs remove their own scratch directory. The journal, ticket history, raw runner events, admission inputs and snapshots have indefinite evidence retention; they are not automatically aged out because recovery, event replay and external acceptance depend on them. Archive changes visibility and does not authorize evidence deletion.

The single npm distribution has enforceable internal import directions (see `tests/boundaries.test.ts`). `shared` contains Node OS utilities below runtime/core; the root public entry composes controller, runtime and CLI exports. Runtime cannot import core, and core cannot import clients. Browser display labels live in `packages/web`; trajectory wire titles use language-neutral event keys.
