# Decisions owned by the orchestrator

Read this reference before dispatching dependent work, repartitioning acceptance, deciding how to handle queued corrections, or integrating deliveries. Reuse decisions and evidence already present in the current task. A routine isolated assignment needs only the relevant parts; this is not a new planning phase or a requirement to create a separate tracker.

## Establish the implementation boundary

The orchestrator decides cross-component behavior before assigning its consumers. Record the invariant, shared interface or state transition, writer and reader responsibilities, and a check that distinguishes correct composition from independently passing components. Workers choose internal implementation details within that boundary. They may investigate an unresolved question in a bounded assignment; the orchestrator evaluates their evidence and decides the contract before dependent implementation proceeds.

For example, a history page must expose rows, continuation and completeness separately; facts and resume state commit atomically; every ingestion path uses the same ownership fence. Giving one worker the Store file and another permission to write directly through its pool does not establish that contract. Decide the guarded write interface, including export jobs, before parallelizing callers. Do not preserve a known incompatible interface solely to keep files disjoint.

If shared fixtures, schemas or services are still being repaired, treat them as prerequisites for their consumers. Prove the smallest useful path in the actual execution environment: a real database query rather than a TCP socket, or the build/Compose operation the assignment will need rather than only engine availability. Record resource names/isolation and who cleans up on failure. Integrate the prerequisite into the actual consumer base before dispatch; an exit code or a passing test in another checkout is insufficient. Independent work without that dependency can continue.

## Preserve acceptance when splitting work

Keep the original user acceptance visible in the existing plan. For each obligation moved between components, record its owner, dependencies, ticket revision and eventual evidence. A small table or a few lines in the existing task record suffice:

| Original obligation | Current owner and contract | Dependency/base | Evidence and disposition |
| --- | --- | --- | --- |
| Facts and resume state survive a later-page failure | Page interface owner; then ingestion owner | Reviewed shared interface in consumer base | Pending until the real sync path resumes from stored state |
| Stale owners cannot write export progress | Guarded Store API owner and export caller owner | Shared transaction contract | Both caller and Store behavior must be covered |

Before accepting a ticket, compare its actual objective and acceptance with the delivered behavior. A statement such as "all assigned behaviors are fixed" cannot pass while its pagination requirement is deferred in the reviewer field or notes. Either complete that requirement, or make an explicit scope repartition within the user's authorized outcome before accepting the narrower work. Do not reduce the user requirement. If reducing the requested outcome needs the user's decision, preserve the work and identify that missing decision.

Use the supported immutable revision flow for changed ticket contracts, after accounting for old writers. With the current CLI, a changed base requires a new ticket ID; connect it to the old obligation in the host record. A new revision or attempt requires its own applicable delivery, verification and review bindings; never relabel an earlier approval. Keep unresolved obligations visible at the parent level with a named successor. If a misleading acceptance is discovered later, preserve its historical record and document the correction and remaining work rather than rewriting past evidence. Host dependency/obligation records are not additional ticket JSON fields.

## Make a correction decision

The host remains active as the decision owner while work runs. Inspect actual diffs and evidence, then decide whether independent work can continue, a bounded observation can wait for the next turn, or demonstrated wrong work needs explicit cancellation and recovery. State the concrete reason and the next evidence that will settle it. Repeated status narration is not that decision.

Group known related defects and their acceptance links before sending one coherent correction. Track receipt, native consumption, implementation and verification separately. If queued guidance would change the work or invalidate an expensive test cycle already underway, assess the remaining time and cleanup cost and choose deliberately between waiting and cancelling. Do not use a fixed polling count or automatic timeout as a substitute for that judgment. Unknown receipt or consumption is never permission to replay a send.

After a controlled stop, inspect process ownership and the preserved snapshot. Account for already sent or uncertain instructions, then use the supported recovery path with consolidated context; do not silently reissue their IDs as new sends. Contract changes require the appropriate revision, not a live instruction. A successful turn, consumed message or report-only recovery does not close a defect.

Before calling a verification run final, reconcile known original defects against their actual fixes and focused evidence. Do not repeatedly ask for the whole batch gate while already known blocking corrections remain queued. Run the required complete gates once those corrections settle; real subsequent changes or failures can justify reruns. Keep original output and failure status, and use it for counts. This does not prohibit a worker from testing its implementation or substitute for controller verification.

## Integrate and adjudicate

The host selects accepted artifact bindings, prepares the combined baseline and resolves merge conflicts and combination semantics. When integration exposes a real defect, decide its intended behavior, affected interfaces and bounded repair before assigning implementation. A ticket called "closeout" must not become an open-ended request to invent how several completed components should fit together. Workers may implement a cross-component fix after that decision; they do not merge sibling deliveries or decide which original requirements to discard.

Apply the owner's independent review and focused rereview rules without restarting them for every component. At host adjudication, connect each remaining substantive finding to its fix or reasoned dismissal and applicable evidence. Ordinary suggestions add no gate; a fixed review count cannot dismiss a real defect. Distinguish independent review, host adjudication, controller test execution and integration checks in the record. The controller validates submitted contracts and snapshot bindings; a reviewer name or free-text assertion does not prove the host performed these responsibilities.

Finish at the user's requested stage. Report what was submitted, verified/reviewed, integrated and released with the corresponding evidence. These responsibilities do not grant additional dispatch, commit, push or deployment authority.

## Check the behavior after updating guidance

Exercise these decisions with concrete inputs, not keyword-presence checks:

- Two disjoint file assignments share an unfinished guarded-write interface: resolve the interface or hold dependent dispatch, while allowing unrelated work.
- A component passes tests but defers an explicit acceptance item: keep it unaccepted or revise the partition with preserved parent obligations and fresh bindings.
- A worker received three corrections but is testing the old behavior: inspect consumption and choose a consolidated wait/stop/recovery action; never infer completion or blindly resend.
- Accepted components conflict on a shared state: the host decides and applies the combination, then assigns only the necessary bounded repair and verifies affected behavior.
- An isolated implementation has no unsettled interface or dependency: dispatch within existing authorization without inventing a design ceremony.
- A user asks to inspect or install guidance: complete that stage without dispatching a model task.

A scenario evaluation supports instruction quality. A representative authorized live task is separate evidence: record the host's interface decision, prerequisite check, bound worker delivery, review/adjudication and integrated result. Skill discovery, product tests and successful installation alone do not establish host behavior in a real delivery.
