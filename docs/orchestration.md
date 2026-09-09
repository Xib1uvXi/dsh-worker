# Efficient orchestration

The external orchestrator owns the overall outcome, design, scheduling, independent review, acceptance and integration. Workers implement and test independently checkable behavior within their assignment. The controller preserves state and evidence. No additional planning model or worker delegation is enabled by this workflow.

Use [Decisions owned by the orchestrator](../examples/dsh-orchestrator/references/coordination.md) when dispatching dependent work, repartitioning scope, handling queued corrections or integrating deliveries. It supplies concrete decisions, a small obligation-record example and behavioral scenarios. Keep those decisions in the existing plan; monitoring output and accepted ticket counts do not establish that the host made them.

## Prepare a useful assignment

Start with [ticket.json](../examples/ticket.json) and adapt the [context template](../examples/context.md) into its existing `context` string. State why the change is needed, the fixed decisions and invariants, the implementation choices the worker can make, useful source references, known failures, dependencies and environment commands. Keep references tied to the assigned base or immutable artifacts. Avoid repeating the entire conversation or loading unrelated skills.

Use a task that can deliver and test one coherent behavior. Resolve shared interfaces before parallelizing their consumers. Independent files can still conflict through shared ports, databases, generated artifacts or build directories. Small changes whose handoff cost exceeds their benefit can be handled directly by the orchestrator. Worker count and delegation percentage are not delivery goals.

For a new service, establish one executable vertical path and its disposable test environment before parallelizing dependent modules. Agree on page/resume boundaries, guarded transactions, state transitions and query coverage, not just function names or file ownership. Do not assign an invariant to one worker while requiring another to bypass the enforcing interface. Keep original batch acceptance visible; record remaining integration obligations and their owners explicitly rather than treating a partially satisfied component objective as complete.

External protocol assignments should include a dated method/path/parameter/response matrix and independent examples. Label unknown behavior and ambiguous older evidence. Tests that copy the implementation's unverified assumption cannot validate the provider contract. Keep referenced context stable during a run; a ticket revision or prompt hash does not freeze the contents of a referenced mutable file.

Use `setup` for repeatable dependencies and readiness. Check the actual command environment, including a real database query, Docker build/Compose capability and owned failure cleanup. Worktrees do not isolate process-global variables, shared databases or Docker resources. Prefer explicit test configuration and per-test resource identities over mutable process-global endpoint variables.

Hold consumers of an unfinished shared fixture or interface until its required reviewed changes and readiness evidence exist in their actual base. Before accepting a component, check every explicit obligation in its current objective and acceptance. Moving a requirement to a successor needs an explicit contract repartition and preserved parent obligation, not an exception hidden in `reviewer` or `notes`. Immutable revisions and base-change rules still apply; do not rewrite historical acceptance.

## Follow one delivery

1. Run `prepare --file ticket.json`, inspect the prepared revision and worktree, then `run TASK-01`. A worktree starts at the named commit and does not inherit ignored dependencies. The assignment explicitly identifies its execution working directory separately from the primary repository reference; source reads, edits and tests use that worktree. The service owns execution after the command returns.
2. Continue independent work. Use `activity TASK-01` for observed sessions/statistics, `events TASK-01 --after 0` for control changes, or a bounded `wait TASK-01 --timeout 30 --brief`. These commands do not prove acceptance or automatically wake an inactive orchestrator.
3. For a specific observation, run `trajectory TASK-01 --attempt ATTEMPT_ID --kind tool/result --after 0`. Follow returned cursors until `hasMore` is false. Inspect the result before sending a revision-bound instruction. An uncertain receipt must never be automatically resent.
4. When submitted, run `brief TASK-01`. Match the current revision/attempt, original acceptance, worker report, delivered/current snapshots, latest verification and recorded review. Inspect `status TASK-01` for actual diffs and full evidence, and `artifact SHA256 --output FILE` for hash-checked delivered bytes. A compact report is an index for review, not a replacement for examining changes.
5. Run controller `verify TASK-01 --wait --brief`; have an external independent reviewer assess Spec and Standards against the unchanged snapshot. Record the resulting review. Preserve valid prior evidence; after a fix, recheck affected behavior and the required batch gates. Acceptance is not integration or release.
6. Integrate the accepted snapshot in dependency order under the user's authorization. Check the combined behavior before starting dependent assignments from their actual integrated base. Keep integration status in the orchestrator's task record.

If the worker returns a blocker, read its evidence and recommendation. Resolve routine decisions within existing authorization. Contract changes use a new revision; recovery first accounts for old writers. A blocked delivery ends its attempt. An explicit bound `kind: "answer"` continuation can preserve the conversation for the next run; see [Answer a blocked worker](execution-lifecycle.md#answer-a-blocked-worker). There is no live question/answer channel or automatic host wakeup. Existing `instruct` supports guidance to an active attempt, not changes to the assignment contract.

## Close the correction loop

An instruction's `received` state means admission to the native inbox. Its optional `consumption` record links the primary session's `user/message` to its message ID, observed time, turn when available, and durable journal sequence. This proves entry into the conversation, not understanding, implementation or success. Consumption can precede the IPC receipt; an uncertain receipt remains uncertain even when separate consumption evidence exists. Older instructions may have no consumption evidence.

`brief` and `status --summary` expose instruction age and `execution.deadlineAt`/`remainingSeconds`. The deadline starts after setup and is shared with the runtime watchdog; subsequent prompts do not extend it. The Web shows the same deadline and waiting instructions. These observations never resend instructions or extend execution automatically.

Native prompts may wait for the next turn. Group related observations into one coherent instruction before sending instead of creating a separate full verification cycle per small observation. Preserve stable instruction IDs. Do not replace or replay a previously sent uncertain message. If a demonstrated error makes continued work wasteful, explicitly cancel, inspect ownership and snapshot, and recover with consolidated guidance. A normal observation is not a reason to repeatedly interrupt a productive worker.

During correction, run discriminating focused checks. Once known corrections settle, run the complete batch gates on the final snapshot. Retain original command output and exit codes to extract counts later; do not rerun tests only to count or format results. Shell pipelines using `tail`, `grep` or `awk` must preserve the tested command's failure status. The controller's actual verification remains required.

The host records why it is waiting, continuing independent work or stopping an attempt, and what next evidence will resolve the decision. It reconciles outstanding original findings before treating any gate as final. Additional runtime visibility helps this judgment but does not perform it. During integration, the host resolves the combined behavior before assigning a bounded cross-component repair; naming the ticket "closeout" does not transfer that responsibility.

## Evidence query contract

All queries use the same authenticated control service. They never dispatch, accept, recover or persist a new task decision.

| Command | Output |
| --- | --- |
| `brief ID` | Execution worktree, target repository/base, current revision/attempt, scope and acceptance, worker claims, changed paths, latest verification and review bound to that delivered snapshot. No full diff, file manifest or prior attempt history. |
| `trajectory ID [--after N] [--limit N] [--attempt ID] [--kind EVENT] [--full]` | Ordered observable events, current observed agent activity, `cursor` and `hasMore`. |
| `activity ID [--attempt ID]` | Agent activity and available native statistics, with an empty entry list. Activity is observed state, not acceptance or proof of OS-process liveness. |
| `events ID [--after N] [--limit N]` | Per-ticket control journal entries, excluding native `harness.notification` and process-bookkeeping events; use trajectory for native details. |

`wait ID --brief`, `run ID --wait --brief` and `verify ID --wait --brief` return this same brief when waiting ends. The default remains full status. A wait can end in a failed, blocked or interrupted state; read the returned state and evidence. Timing out does not cancel or resend work, and `--brief` without waiting is refused for run/verify.

`after` is an exclusive nonnegative safe-integer journal sequence. `limit` is 1–100, default 100. Trajectory filters apply to each scanned page, so a page can contain no matching entries while `hasMore` is true. Always advance to its returned `cursor`; do not stop because `entries` is empty or has fewer than `limit` rows. The cursor is the last scanned row, including filtered rows. Continue with unchanged filters; restart at zero to search a different filter over all history. `kind` is an exact event kind. An attempt filter must belong to that ticket. Control events are filtered before pagination and use the same cursor shape. Replay after service restart uses the durable journal; a drained page does not prove execution ended.

CLI trajectory normally omits each entry's `raw` field and keeps the first 4,000 text characters with an explicit `textTruncated` flag. `--full` retrieves full projected text and raw detail with the existing reasoning/stream omissions. This is a bounded row count, not a byte-size limit on full detail. The existing Web endpoint still returns full projected entries by default.

Brief keeps worker test claims under `workerReport`; controller checks remain under `verification`. It selects the latest verification for the current attempt/revision even when it failed or is incomplete. A recorded review stays bound to its delivered bytes and is not reassigned to changed files. Compare `binding.deliveredSnapshot`, `binding.currentSnapshot` and `matchesDeliveredSnapshot`; missing observations are `null`. Display freshness may lag by up to three seconds, with check time and maximum age exposed. Actual acceptance captures the current files directly. The report does not create an acceptability verdict. Command output is a tail of at most 4,000 characters; `outputTruncated` describes brief clipping, while `serviceOutputTruncated` describes previously discarded data. Full stored command output remains in `status`.

HTTP equivalents are `GET /api/tickets/:id/brief`, `/trajectory`, `/activity`, and `/events`. Query names are `after`, `limit`, `attempt`, and `kind` where supported by the corresponding command. Existing global `/api/events` JSON/SSE behavior is unchanged. Polling does not register a host notification or guarantee automatic continuation of Codex or another orchestrator.

Multiple-task briefs use `brief ID [ID ...]`, accepting up to eight unique IDs. A single ID retains the original response shape. Multiple IDs return `briefs` and per-ticket `errors`, with CLI exit 1 when any query failed; successful entries remain usable. The authenticated HTTP equivalent is `GET /api/briefs?ticket=TASK-01&ticket=TASK-02`. It reads tasks independently, not as an atomic batch acceptance snapshot, and changes no task state.

`version` identifies the local CLI build. `health.clientBuild`, `health.service.build` and each new attempt's `controllerBuild` distinguish the client, running service and historical executor. Metadata includes package version, Git commit when available, a digest of build source inputs and build time. Source execution and older services can lack immutable metadata; do not infer their build from the current checkout. After updating source, follow the normal idle-service shutdown, build and restart procedure. Updating source alone does not update a running controller.

## Measure the whole collaboration

Compare the orchestrator alone, the orchestrator with the prior worker, and the orchestrator with an improvement on the same task inputs and acceptance criteria. Include preparation, coordination, waiting, review, repair and integration in elapsed time and cost. Keep failures in the denominator. Separate sample tasks used for tuning from those used for evaluation, and record the actual model/runtime/tool versions.

Record accepted-and-integrated outcomes, defects, first-submission success, total time, human interventions, orchestrator coordination work and available usage/charges. Missing billing data remains unknown. Native session timing and decode-token statistics are not complete billing. A smaller JSON response measures interface overhead; it does not by itself prove a faster or better model task.

For controller-run setup, immutable command baselines, credential references and explicit answers to blockers, see [Execution lifecycle](execution-lifecycle.md).
