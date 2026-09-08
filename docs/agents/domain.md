# Domain documentation and decisions

Treat this repository as one product context with six internal package areas. Shared domain context lives in [Architecture](../architecture.md), with the product introduction and package map in [README](../../README.md). A duplicate root `CONTEXT.md` or per-package context tree is not required.

## Read by affected area

| Change | Primary material |
| --- | --- |
| Ticket validation, states and DTOs | `packages/contracts/src/index.ts` and Architecture's durable rules |
| Persistence, ownership, snapshots, verification or review | `packages/core`, relevant tests and Architecture |
| SDK execution, policy or skill configuration | `packages/runtime`, [Skill configuration](../skills.md) and runtime/workflow tests |
| HTTP, events, session headers or trajectory | `packages/server`, `packages/web`, Architecture and HTTP/browser tests |
| CLI, authentication or operator flow | `packages/cli`, [Getting started](../getting-started.md), [Troubleshooting](../troubleshooting.md) and CLI/client tests |
| Compatibility or evidence claims | [Migration](../migration.md), [Verification record](../verification.md) and current source |

The root `AGENTS.md` supplies contributor instructions. The [bundled skill](../../skill/SKILL.md) supplies product operation instructions. The [task tracker](issue-tracker.md) supplies development planning conventions. Personal skill routing and per-controller runtime selections remain separate from these shared documents.

## Terms to preserve

- **Ticket revision:** an immutable assignment contract, including scope and acceptance.
- **Attempt:** one execution of a revision with its own session, environment and evidence.
- **Snapshot:** the exact deliverable file and Git state bound to verification and review.
- **Verification:** controller-run checks against the unchanged snapshot, with recorded results.
- **Review:** external Spec and Standards decisions bound to a revision, attempt and snapshot.
- **Accepted:** controller acceptance evidence; it does not imply a commit, integration or release.
- **Recovery:** inspection and explicit continuation after old writers are accounted for; no automatic model resend.

For exact serialized names and state transitions, inspect contracts and controller code rather than deriving them from these prose terms. Preserve uncertainty and stale-evidence semantics when changing UI labels or summaries.

## Architecture decisions

Keep the current architecture explanation in its existing document. When a new lasting decision needs rationale, create `docs/adr/NNNN-short-title.md` with status, context, decision, consequences and links to the affected design. Create the directory with the first actual decision; do not invent historical ADRs or duplicate the architecture solely for setup.

Read ADRs relevant to the affected subsystem. Propose a replacement explicitly when changing a decision and preserve its history. Update user-facing guides when behavior changes. Date-specific rebuild acceptance and verification sections are historical records; reconcile them with the current task and source instead of treating old staffing restrictions or test totals as permanent rules or fresh evidence.
