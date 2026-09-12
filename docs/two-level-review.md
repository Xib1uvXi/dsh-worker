# Independent ticket review and final integration review

This is an explicit, experimental ticket policy. An independent review worker examines each delivered ticket. The host adopts or adjudicates that evidence; Astra (or the selected host) reviews the complete integrated candidate before main. A reviewer never implements fixes or records acceptance. Ordinary tickets retain external manual review.

Check the selected CLI's `help` and the running service's authenticated `reviews` response before choosing this policy. A new checkout build does not replace a running service. The [verification record](verification.md#two-level-review-validation) includes real report-format failures; the feature is not a validated unattended default. For operational errors, see [review and queue recovery](troubleshooting.md#independent-review-and-queue-recovery).

## Configure and dispatch

Use the same authenticated service and control home for every command. From a source checkout substitute `node dist/cli.js` for `dsh-worker`. Configure the pool with an adapted [pool template](../examples/review-pool.json):

```sh
dsh-worker review-pool --file pool.json
dsh-worker prepare --file ticket.json
dsh-worker schedule TASK-01 --kind run --request-id TASK-01-implement-1
dsh-worker wait TASK-01 --timeout 300 --brief
dsh-worker schedule TASK-01 --kind verify --request-id TASK-01-verify-1
dsh-worker reviews
```

Set `reviewPolicy: "worker_then_astra"` and `reviewPoolId` on the ticket before preparing it. Selection belongs to its immutable revision; a new revision may change it explicitly. Old records are not migrated. Configure the pool first. `expectedVersion` is 0 for creation and the currently observed version for an update. A pool stays bound to one batch; the batch cannot register a second pool. Service dispatch must be enabled for model work.

`schedule` persists an explicitly queued run or verification, not a started execution. `wait` observes the ticket and may return its pre-dispatch state; inspect `reviews.operations` until the request is started or has a stated failure, then use normal ticket waiting. Retries use the same request ID and exact inputs. Conflicting reuse is refused. Direct `run`/`verify` keep their existing started-or-error semantics and refuse admission when an older executable queued operation has priority.

After the submitted snapshot's controller verification finishes, adapt the [request template](../examples/review-request.json) with the exact current revision, attempt ID and snapshot digest:

```sh
dsh-worker request-review --file request.json
dsh-worker reviews
```

A request creates an independent session, Harness home and inspection clone. The controller copies the complete delivered file manifest, including additions, deletions, modes, binary contents and supported symlinks, and preserves original diff/index evidence. Review is bound to the original input and a separately captured inspection workspace. Verification, revision, recovery and implementation on that ticket are mutually exclusive with an active reviewer. External edits invalidate the evidence; this cooperative isolation is not an OS security sandbox.

A request in `focused` mode requires `priorRunId`. Its input includes the prior report and host dispositions. Review fixes and affected behavior, retaining applicable evidence for other criteria; ordinary suggestions do not open an unlimited review cycle. A new demonstrated defect still needs resolution. A known failed verification can be examined diagnostically, but cannot support acceptance.

## Dynamic pool and shared capacity

`implementationLimit` limits both implementation admission and review ownership for the batch. The review cap is the configured implementation concurrency, not the number of currently running implementers. Tail reviews continue after implementations finish. Reviewers start only for authorized queued requests and close after each review; no idle model session is retained.

Implementation, verification and review share service capacity. Admission reserves the ticket before model dispatch. Among executable requests, the oldest durable sequence goes first; constrained requests retain their sequence while being skipped. This neither creates more service capacity nor preempts running work.

Use `review-pool` to pause, resume or change quota. Pausing prevents starts while retaining queued work. Downscaling drains existing owners naturally; `pendingLimit` is displayed until both role counts fit. The old effective limit remains visible during drain. Closing requires all owned and queued work to be resolved. It is separate from batch acceptance.

```sh
dsh-worker cancel-scheduled REQUEST_ID
dsh-worker cancel-review REVIEW_RUN_ID
dsh-worker recover-review REVIEW_RUN_ID
```

Cancel explicitly stops a live reviewer or withdraws a queued review. Recovery accounts for interrupted owned processes and releases the reservation only after confirmed cleanup; it does not rerun the review. Restart fences active reviews and suspends queued work. Inspect old processes and evidence first, then explicitly enable the pool with its current version to rearm unsent requests. Unknown delivery is never automatically replayed. A failed or malformed report requires a new, deliberately authorized request; reusing the old request ID returns the old result.

`reviews` and the Web review manager show global owned capacity, pool limits, pending quota, queued age, execution phases, cleanup ownership, errors, recommendation and current applicability. A completed report is distinct from a released slot and from accepted ticket state. Evidence history is retained after cancellation, restart, rework and drift. Applicability checks read current files and artifacts without changing controller state.

## Adopt evidence and rework

A report separately records Spec and Standards verdicts, original criterion coverage, inspected paths, structured findings, executed commands and limitations. Malformed reports, missing coverage, changed inputs and incomplete runtime exits cannot become accepted evidence. `completed` means a structurally valid report, which may still recommend changes or blocked status. Read the actual reasoning and limitations; structure validation cannot prove semantic correctness.

For normal passing tickets, the host checks binding, completeness, limitations and relevant evidence without repeating every ticket's full review. Submit the ordinary [review document](../examples/review.json) with an additional source:

```json
{
  "source": {
    "runId": "actual-review-run-id",
    "reportDigest": "actual-report-sha256"
  }
}
```

Two-level acceptance requires this exact stored independent source. A free-form reviewer name does not establish independence. The controller retains all original acceptance gates: current revision/attempt, clean submitted delivery, unchanged snapshot, and latest successful controller verification. An older verification pass cannot override a newer failure or interruption. Report/input replacement and implementation-session provenance are refused.

Host rejection or blocking can be recorded without a source when no usable report exists; this never permits acceptance. With a valid report, preserve its reference when recording changes requested. If the host disproves a blocking finding, retain the original report and provide `dispositions: [{"findingId":"F1","evidence":"specific contrary evidence"}]` for each disputed blocker. Inconclusive evidence cannot be overridden this way. Use the normal bounded rework flow for actual defects, then request a focused review of the new attempt.

## Final candidate review

Use the [batch review record](../examples/batch-review.md) in the existing local task record. Record the exact target main baseline B before integration, candidate C, original acceptance coverage, every ticket/revision/attempt/snapshot/report and the mapping into candidate files. Include required dependencies from intermediate bases, deletions, modes, symlinks, non-ignored untracked files, conflict resolutions and integration repairs. The union of ticket changed paths is not a complete candidate review.

Assemble C in an isolated candidate checkout. Astra reviews the complete B-to-C difference and necessary context, separately reporting Spec and Standards. Examine cross-ticket interfaces, resource ownership, combined error paths, omissions and scope, and run the project's complete candidate lint/test/build and required E2E gates. Individually correct tickets do not prove their composition is correct. Record unresolved findings and evidence-backed adjudications. If Astra substantially implements an integration fix, obtain an independent Spec and Standards review of the complete final B-to-C candidate; label any self-review accurately.

Before actual main integration, compare main with B and recompute C's identity, including index and non-ignored files. Main advancement or candidate edits invalidate the old final binding: rebuild the combination, revalidate affected evidence and review changes before proceeding. Never force overwrite an advanced main. Ticket acceptance, candidate approval, main integration, push and service activation remain separate states governed by task authorization. There is no automatic integrate or merge command.

## Skills and verification

The pool's `entrySkills` selects reviewer methods from that control home's configured skill catalog, independently of implementation entries. Missing configured entries fail before a model call. Reviewer execution uses the frozen pool version, model and patch copies. Instruction and skill entry-file hashes are recorded and checked for drift; referenced resources outside those files are not recursively frozen. Keep such resources stable and disclose missing evidence. Role restrictions and final worker policy remain authoritative; a skill cannot enable delegation or self-acceptance.

Run `npm run check` for contracts, controller, Git/SQLite, SDK wire, CLI/HTTP and desktop browser coverage. `tests/review-e2e.test.ts` uses a deterministic SDK wire peer, not a provider. The explicit live scenario uses disposable repositories and actual configured DeepSeek model tasks:

```sh
npm run build
npx tsx scripts/review-live.ts --real-provider --output=.scratch/two-level-review/live-run-01
```

The service environment must already contain the requested credential references. Do not paste credentials into tickets or evidence. The script retains local artifacts under `.scratch/two-level-review/live`; a failed run exits nonzero and retains failures. It checks parallel real implementations and independent reviews, candidate checks and restart persistence. Its negative case uses a deterministic broken implementation with passing syntax verification and a real independent reviewer; that seed is not claimed as real model implementation. Real-provider success is separate from deterministic protocol tests and does not establish universal model review quality.

The example explicitly selects an output directory; use a fresh directory for each deliberate run so previous evidence is not overwritten. The default above applies only when `--output` is omitted. A live run makes provider requests and can incur usage. It also requires the development dependencies and installed Playwright Chromium used by the browser tests. Preserve original failures when recording an explicit recovery separately; report valid negative findings, malformed reports and completed accepted flows as different outcomes.
