# Setup, verification baselines, credentials and answers

These additions retain schema 2. Existing tickets may omit `setup` and `execution.credentialEnv`; both default to empty arrays. Existing continuations default to `kind: "restart"`.

## Prepare the environment

`setup` is an ordered array of the same command objects as `verification`:

```json
{
  "setup": [
    {"args": ["npm", "ci", "--cache", "node_modules/.cache/npm"], "cwd": ".", "timeoutSeconds": 300}
  ]
}
```

Use commands appropriate to the target repository. Keep dependencies and caches Git-ignored; command caches must fit the writable worktree or the backend's temporary directories. Setup commands must be safe to repeat. The controller runs them before each attempt's first prompt and again before each verification, so removed ignored dependencies can be restored without asking the model to install them. It also initializes the separate baseline checkout.

`attempt.setup`, `verification.setup` and `verificationBaselines[].setup` retain start/end times, exit codes and redacted output independently of acceptance commands. A nonzero setup command stops the setup sequence. Initial setup failure blocks the attempt with a controller-owned reason and no model receipt. Cancellation or uncertain process cleanup leaves an interrupted operation for explicit recovery. Verification setup failure cannot pass verification.

Setup never authorizes edits outside the ticket scope. Verification setup must preserve the delivered snapshot, including tracked generated files. Removing the whole delivered worktree is not equivalent to removing dependencies: restore the exact delivered files before verification; setup does not reconstruct lost deliverables.

## Compare against the assigned base

Before the first model prompt for a revision, the controller reserves and runs one verification baseline in a separate owned checkout of `baseCommit`, with the same setup commands, task environment and command confinement. It records each command even when an earlier command fails. The primary repository and delivery worktree are preserved.

The baseline is frozen after that run; rework and repeated verification reuse it. A new revision gets a new baseline even when its worktree already contains previous work. Startup never replays an interrupted baseline. An incomplete baseline, or one whose commands changed its snapshot, is not comparable; prepare a new revision to obtain a new baseline deliberately.

`status` retains the full baseline evidence. `brief` includes bounded output tails, baseline identity, setup results and verification comparisons:

| Comparison | Meaning |
| --- | --- |
| `pass` | Current command exited zero without timing out. |
| `regressed` | Base passed; current command failed or timed out. |
| `pre-existing` | Base and current command both failed or timed out. |
| `fail` | Current command failed; no comparable baseline exists. |

These are **command-level** comparisons, not individual test-case attribution. Two failures of an aggregate test command may have different causes; inspect both outputs. Every current verification command must still pass, process cleanup must succeed, and the delivered snapshot must remain unchanged. Pre-existing failures never count as passes. External Spec and Standards review remains required.

## Command confinement

Controller setup, baseline and verification commands use the public Harness `sandbox-local` backend in `workspace-write` mode. They retain the controller's process marker, bounded output, timeout and descendant cleanup. Each completed command records `confinement.mode` and the backend's `enforcement` (`full` or `partial`); unavailable confinement fails closed.

This is the same host file-effect policy used by model tools: the worktree and backend-defined temporary areas are writable. It does not restrict network access or all reads, and does not make cooperative worktrees a security sandbox against malicious code under the same OS account. Older command records without a confinement field have no recorded confinement evidence.

## Separate provider credentials and task variables

```json
{
  "execution": {
    "provider": "deepseek-official",
    "credentialEnv": ["DEEPSEEK_API_KEY"],
    "envRequired": ["TASK_ENDPOINT"]
  }
}
```

The service must inherit the named variables. `credentialEnv` references are supplied to the public Harness credentials provider through an attempt-private store; they are absent from the runner/Harness environment and task subprocesses. For compatibility, `DEEPSEEK_API_KEY` in `envRequired` is also treated as a provider credential. Custom provider routes must name their credential references explicitly. Setup and verification receive task variables but do not require provider credential values.

`envRequired` variables are exposed to task tooling by design, including selected plugin transports that resolve those references. Put only the values that those tools need there. If a name appears in both lists, credential treatment wins.

At operation admission the worker captures the current values of the named variables. Before persisting notifications, runtime results, stdout/stderr and controller command evidence, exact occurrences are replaced with `[REDACTED:NAME]`. Streaming replacement handles values split across output chunks and runs before output truncation. This is bounded value replacement, not heuristic detection; encoded, transformed or unlisted values are outside its coverage. The private credential store is removed after proven runtime cleanup. Historical evidence and source/snapshot artifacts are not rewritten, and native Harness session logs retain their original conversation for resume; keep the controller home private.

## Repair only the delivery report

When an attempt ended cleanly with a receipt and an unchanged in-scope snapshot but no valid delivery, an explicit continuation may use `kind: "delivery"`. Use the same binding fields as the answer example below. The task must be interrupted, and current instructions must have no unconsumed or uncertain work. Inspect the implementation and historical evidence before choosing this mode; it does not mean the implementation is complete.

Recovery records intent and returns to ready without dispatch. The next `run` uses a new attempt and a fresh session, records `deliveryOnlyFrom`, and instructs the worker to report existing evidence without source edits or new checks. Reused command claims must identify their earlier attempt. Setup must preserve the frozen snapshot, and a final source snapshot change invalidates the report. Additional implementation instructions are refused; use an explicit restart when code needs changes. Unchanged source alone never substitutes for actual evidence.

Before dispatch, an explicit `kind: "restart"` may replace a pending delivery-only continuation while the task is ready. Bind it to the current revision, previous attempt and inspected current snapshot, including any external changes. This clears the pending report-only intent without dispatching; the Web recovery form exposes the same restart action.

The corrected delivery only reaches awaiting review. Controller verification and external review remain required for the new attempt; no prior approval is automatically transferred. This mode does not replay uncertain sends or silently reuse an old attempt ID.

## Validate documents before submission

These commands work without a service and record no decision:

```sh
dsh-worker validate delivery --file delivery.json
dsh-worker validate delivery --file delivery.json --ticket-file ticket.json --attempt CURRENT_ATTEMPT_ID
dsh-worker validate review --file review.json
```

`--file -` reads JSON from stdin. Validation returns JSON with `ok`; schema failures include field paths and exit 1. Without `--ticket-file` and `--attempt`, delivery validation checks only the schema. With both, it also checks the exact ticket/revision/attempt and exactly one evidence entry for each assigned acceptance ID. Snapshot freshness and runtime acceptance still belong to the service.

Delivery `notRun` and `blockers` are arrays of strings, not objects. A review's `findings` arrays contain unresolved findings; accepting reviews require them to be empty with Spec and Standards both passing. Optional review `notes` hold positive evidence and rationale without misclassifying them as unresolved defects.

## Answer a blocked worker

After inspecting a clean blocked delivery and its current snapshot, submit:

```json
{
  "kind": "answer",
  "ticketId": "EXAMPLE-01",
  "revision": 1,
  "attemptId": "replace-with-blocked-attempt-id",
  "snapshotDigest": "replace-with-current-64-character-digest",
  "instruction": "Choose X. Continue within the existing assignment."
}
```

1. Use `recover ID` to inspect ownership and obtain the current binding.
2. Use `recover --file answer.json` to persist the answer and return the ticket to ready. This action sends no prompt.
3. Use `run ID --wait` to start a new attempt. The answer is the first new prompt content, followed by the current assignment and new delivery binding.

The new attempt has its own ID, marker, Harness home and evidence. It copies the prior persisted conversation into that home and resumes its session ID through the public `agents.resume` API. A scoped Cordis service-read interceptor adapts the pinned SDK's initial `agents.create` call; the SDK still owns the agent handle, prompt protocol and teardown. Statistics remain supplemental controller evidence rather than custom required entries in the resumable session log.

Answers require the same revision, unchanged blocked snapshot, proven old-process cleanup, a valid blocked delivery and no uncertain instruction receipts. Missing, pruned or incompatible history fails explicitly; there is no silent fresh-session fallback. Old logs containing unsupported required plugin events may need a fresh continuation. A revision change or `kind: "restart"` starts a fresh session. Read endpoints and service restart never resend an answer. Pruning retains the latest answerable blocked history and any pending answer's source home.
