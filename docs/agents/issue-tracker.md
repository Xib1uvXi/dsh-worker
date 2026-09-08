# Development task tracking

Repository development uses local Markdown under `.scratch/<feature>/`. This directory is Git-ignored personal working state, not a shared issue database. Reuse an existing feature directory and its records before creating another. Do not publish external issues or change tracker services merely because a remote is added later.

## Record only what the work needs

A small task can use one `checkpoint.md`. When a feature needs several assignments, use `plan.md` and `issues/<id>-<slug>.md`, with a checkpoint linking them. Existing layouts remain valid; do not rename or rebuild records solely to match this suggestion.

Each actionable assignment should identify:

- Objective, scope and exclusions.
- Original acceptance criteria and any confirmed changes.
- Dependencies, unresolved questions and applicable triage label.
- Current progress, owner or checkout when relevant, and the next action.
- Validation and review evidence tied to a commit or identifiable file snapshot.

Separate readiness from progress. Use the [triage labels](triage-labels.md) for readiness. For new records, use `planned`, `in-progress`, `blocked` or `complete` for progress; preserve an existing record's vocabulary and explain its meaning instead of rewriting history. `complete` means the requested outcome and its applicable acceptance checks are satisfied. Record integration or release separately when required.

Example for a new assignment:

```markdown
# T01: <concrete outcome>

Progress: planned
Triage: needs-triage
Dependencies: none

## Scope and acceptance
<owned paths, exclusions, and checkable criteria>

## Evidence and next action
<snapshot, checks, Spec/Standards review, blockers, and next action>
```

## Resumption and handoff

Keep a single authoritative checkpoint for active work. Record settled decisions, current checkout, relevant evidence, unresolved items and the next action. Across worktrees, pass the absolute path to that local checkpoint because ignored files are not copied automatically. Local absolute paths are appropriate in these ignored records, not as dependencies in shared repository guidance.

A fresh checkout without `.scratch/` remains usable from the source, public docs and task request. If collaborators need a durable shared requirement or decision, put that material in the appropriate shared document within the authorized scope, rather than exposing personal logs or copying the entire local tracker.

## Product task state is separate

These Markdown records track development of dsh-worker. Tasks executed by the dsh-worker product use schema 2 contracts and controller-owned SQLite state. A Markdown progress or triage label cannot create, approve or override a controller ticket, attempt, verification or review. See [Architecture](../architecture.md) and the [CLI workflow](../../skill/SKILL.md) when operating the product.
