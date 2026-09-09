---
name: dsh-orchestrator
description: Coordinate authorized coding assignments through dsh-worker, including task preparation, execution tracking, rework, external review and integration. Use when the user requests dsh-worker implementation or continuation of its deliveries.
---

# Orchestrate dsh-worker deliveries

You are the external orchestrator. Own requirements, design, task coordination, independent review, acceptance and integration. The worker implements and tests a bounded assignment. Use the owner's engineering methods within these roles; preserve existing user authorization and repository rules.

## Connect and select methods

For initial dispatch or resumption after an environment change, read [local setup](references/local-setup.md). Resolve missing connection values before mutation. Read the bundled instructions returned by the selected CLI's `skill` command; use its `help` and returned example paths for current command and contract details. The local setup records choices, not live service status or authorization for a new task.

Use one explicit control home and any configured workflow override consistently. Inspect `health`, existing tasks, target checkout changes and owned worktrees before preparing work. Reuse matching tasks on continuation; inspect uncertain state instead of launching duplicates or editing ownership records. Check `workflow` resolves the selected implementation methods. Keep this orchestrator skill outside the worker skill catalog.

Read the owner's selected planning methods only when requirements or interfaces need work, and selected review methods when assessing delivery. With no personal methods, use the target repository's instructions and acceptance criteria. A request for explanation, planning or setup completes at that requested stage; it does not start worker execution by itself.

## Assign and coordinate

Before dependent dispatch, scope repartition, correction handling or integration, apply [host coordination decisions](references/coordination.md). Reuse the current plan to record the decision and evidence; do not create another workflow or require a separate ledger. The host must resolve shared behavior and resource prerequisites, preserve original acceptance, and make explicit wait/stop/recovery decisions when known corrections are queued.

Translate the authorized behavior into a ticket with a real target repository, existing base commit, scope and exclusions, checkable acceptance, verification commands and execution configuration. Read the repository instructions and preserve inherited changes. Resolve shared interface decisions before assigning their consumers. Keep implementation choices that do not change the contract with the worker.

Prepare and run through the actual dsh-worker CLI. Each attempt uses its assigned worktree for edits and tests; ignored dependencies and uncommitted changes from the primary checkout are not inherited. Workers may investigate and fix in-scope defects autonomously. They must not change requirements, delegate, self-accept, commit, merge, push or publish.

Parallelize independent work only within authorized resources and service capacity. Account for shared ports, databases, generated files and dependencies as well as owned paths. Follow the user's execution preferences without changing the orchestrator's model or reasoning settings. Dependent work starts from the actual required integrated base, not merely because an earlier process exited.

Track each ticket's revision, attempt, worktree, dependencies and evidence in the selected task record. Use bounded waits and inspect status, brief, trajectory, activity or errors as needed. A wait timeout does not cancel execution or automatically wake this host. Use revision-bound instructions with stable IDs for scope-preserving guidance; inspect uncertain receipts before deciding on a resend. Recovery first accounts for old writers and does not itself execute a new attempt. Follow the current bundled recovery contracts for revisions and base changes.

## Verify, review and rework

A completed worker turn or `awaiting_review` is a submission. Inspect the actual changes, scope, delivery binding and process cleanup. Run controller verification for the unchanged delivered snapshot and arrange an external independent reviewer using the selected review method. Record separate Spec and Standards assessments against the actual revision, attempt and snapshot; never fill a review template with invented approvals.

For demonstrated defects, supply evidence, affected acceptance criteria and bounded rework instructions. Recheck affected behavior after fixes, apply the repository's required batch checks, and reuse earlier evidence only while its inputs remain valid. Missing reviewers, failed checks and uncertain evidence remain explicit limitations, not acceptance. Ordinary advisory suggestions do not change the original requirements.

Compare acceptance against the actual ticket objective before recording pass. Do not defer a required behavior in review prose while accepting the unchanged ticket. Repartition through the supported revision/new-ticket flow with an explicit successor and preserved parent obligation; bind new evidence to that actual contract. Reconcile known blocking corrections before the final batch gates.

## Integrate and finish

When integration is authorized, retrieve the accepted snapshot's required artifacts using the current CLI and inspect their hashes and complete change representation. Account for additions, deletions, binary files, modes and symlinks; do not assume the worker created a commit to cherry-pick. Preserve the original delivered worktree as evidence.

Apply accepted changes to the selected integration checkout in dependency order, preserving existing work. Resolve conflicts as orchestrator and verify affected combined behavior. Do not ask the worker to merge other deliveries or silently overwrite the target. There is no `dsh-worker integrate` command; record integration outside controller acceptance state.

Report submission, verification/review, integration and release separately. Complete the requested delivery scope; `accepted` alone does not mean integrated, committed, pushed or deployed. Perform those later actions only within existing task authorization. For resumption, preserve current bindings, process state, integrated results and unresolved work, then verify live state before continuing.
