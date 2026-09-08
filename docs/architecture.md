# TypeScript worker architecture

This replaces the Python controller. The worker implements code changes; an external orchestrator owns requirements, scheduling, review, acceptance and integration. Acceptance never means merged or released. During this rebuild the primary agent implements directly; no worker dispatch or review delegation is used.

## Source basis

Design inspection: DeepSeek Harness checkout c389f96bf3a9b6807cb71ed6bdad5849be0df6d8. Distribution target: exact npm 0.1.3-alpha.2 (the checkout is newer and is not represented as the release).

- `docs/architecture.md`: plugins contribute reversible effects and typed services; all supported Node launches use dsh and named profiles, extended by ordered patches.
- `packages/sdk/client`: public TypeScript SDK owns a runtime subprocess, explicit environment replaces inherited environment, receipt-to-idle is an activity interval rather than proof of success.
- `packages/sdk/protocol`: no cancel/session-close RPC or version negotiation. Close the owned runtime on cancellation; use fresh sessions for explicit continuation.
- `packages/core/session`: durable turn/end reasons, model-visible input must be reconstructable from the log.

## Components

`contracts` owns validated commands and browser-safe DTOs. `core` owns SQLite transactions, immutable ticket revisions, attempts, snapshots, independent verification and review. `runtime` adapts the public TS SDK behind an owned execution process and a final worker policy overlay. `server` mounts lifecycle resources as a Cordis plugin and exposes authenticated loopback HTTP plus replayable events. `cli` is a client of that same service, guided by the bundled skill. `web` imports the same contract types and supplies task creation, filtering, details, execution/cancellation, verification, review and explicit recovery.

No embedded planning model, replacement agent loop, Python bridge, auto merge, remote execution or automatic retry. Independent tickets may run concurrently up to a configured capacity; a ticket has one execution/verification owner. Start intent is persisted before any subprocess or model send. Restart does not replay prompts and fences uncertain executions until owned processes are accounted for. Runtime environment and per-attempt Harness home are isolated. Worktrees are cooperative isolation, not a security boundary against malicious code.

## Durable rules

SQLite is authoritative; a journal in the same transaction provides ordered, replayable UI events. Large artifacts use content-addressed immutable files. A snapshot includes HEAD, staged state, file content, executable modes, symlink targets, tracked deletions and untracked files. Review requires the exact revision, attempt and snapshot; verification must pass without changing the before/after snapshot. Accepted evidence is reported stale after edits. Complete requires raw completed plus receipt, delivery bound to the current attempt, snapshot in scope and clean process exit. Unknown outcomes stay interrupted. Recovery is inspect-first and an explicit continuation never sends a prompt.

## Migration and compatibility

The old Python source, tests, archives and controller data have been removed at the user's request. Node data uses `~/.dsh-worker-v2` by default and refuses to open an older SQLite schema. Existing JSON contracts require explicit conversion to schema 2; never silently reinterpret old execution or acceptance evidence. The observer reads canonical Harness session headers without rewriting their source; old controller history is not imported as new acceptance evidence. No global skill or configuration changes are implicit.

## Acceptance for this rebuild

1. Node-only install/build/CLI; shared validated TS contracts and real SQLite.
2. Prepare preserves primary checkout, pins Git base and ownership, rejects duplicate/overlapping work and invalid revisions before side effects.
3. SDK adapter uses official launch/profile/patch semantics, no private process field, sanitized environment, raw event persistence, bounded execution and owned shutdown.
4. Durable submit/rework/verify/review/recovery history; stale, incomplete, out-of-scope or uncertain evidence cannot pass.
5. Authenticated interactive UI and CLI commands use the same controller; journal replay and restart recovery work; no mutation by read endpoints.
6. Regression tests use real Git/SQLite/processes and the public SDK against a deterministic wire fixture; actual released runtime initialization/close is tested separately, with no development worker dispatch.
7. Desktop browser interactions, built-package consumption, self-review of Spec and Standards. Independent review is intentionally not delegated under the user's current instruction; do not label self-review independent.

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

The orchestrator invokes the regular CLI and follows the bundled skill returned by `skill`. The former MCP adapter and direct SDK dependency have been removed. There is no stdio protocol server to register. CLI and Web still share authenticated loopback control and persistent state.

CLI covers prepare, run, status/list, bounded waiting, natural-language instructions, cancellation/recovery, verification/review, archive/restore, hash-verified artifact retrieval, and local skill/workflow discovery. JSON input can come from files or stdin; instruction text can also come from a UTF-8 file or stdin. A stable instruction identity is required for safe retries. Detailed trajectory, raw event and agent-activity querying are Web-only; no CLI trace-query command is provided.
