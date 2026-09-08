# Repository working guide

This guide applies to work in this repository. It is self-contained and requires no personal skill suite. Preserve existing work and follow the current task's scope and acceptance criteria.

## Read for the task

- Start with [README](README.md) for product scope, commands and package boundaries.
- For implementation or design, read the relevant sections of [Architecture](docs/architecture.md) and the affected source and tests. Use [domain guidance](docs/agents/domain.md) to locate terminology and decisions.
- For planning, triage or resumption, follow [task tracking](docs/agents/issue-tracker.md) and its [triage vocabulary](docs/agents/triage-labels.md).
- For service operation, read [Getting started](docs/getting-started.md) and, when diagnosing a failure, [Troubleshooting](docs/troubleshooting.md).
- For changes to worker skills or instructions, read [Skill configuration](docs/skills.md). The bundled [orchestrator skill](skill/SKILL.md) describes operating the product, not a prerequisite for developing it.

Read the sections relevant to the change; do not load every document for every task. Historical acceptance and verification records describe their recorded scope and do not establish current validation or permanent staffing rules.

## Engineering boundaries

- Keep the Node/TypeScript implementation and schema 2 contracts. Validate shared inputs and browser-safe types in `packages/contracts`; keep controller state in `packages/core`, SDK adaptation in `packages/runtime`, HTTP lifecycle in `packages/server`, and clients in `packages/cli` and `packages/web`.
- Use the public Harness SDK and official launcher/profile/patch interfaces. Do not add a replacement model loop or rely on private SDK process fields.
- Keep CLI and Web operations on the same authenticated control service. Read endpoints must not mutate task state.
- Preserve durable intent before execution or instruction delivery, immutable ticket revisions, snapshot-bound review and verification, and process ownership during execution, verification and recovery. Never replay an uncertain send automatically.
- Receipt, idle, a successful process exit or a model's completion claim alone must not produce acceptance. Verification must pass for the unchanged delivered snapshot, with external Spec and Standards decisions. Acceptance is separate from integration and release.
- Keep worktrees and per-attempt environments isolated cooperatively. Do not describe them as a security sandbox. When using the worker product, its runtime delegation restriction remains in force.
- Keep credentials, service tokens, controller databases and personal task evidence outside shared source control. Worker `workflow.json` selections belong to the controller home; repository setup does not alter a running service or personal skill configuration.

## Build and validate

Requires Node 24.18 or newer, npm and Git 2.43 or newer. macOS arm64 has recorded validation; Linux needs separate platform evidence.

| Scope | Check |
| --- | --- |
| Install dependencies | `npm ci` |
| Build distributable code and types | `npm run build` |
| Focused behavior after building | `npx vitest run tests/<affected>.test.ts` with an existing test file |
| Static lint | `npm run lint` (ESLint, including typed Promise checks; zero warnings) |
| Apply available lint fixes | `npm run lint:fix` |
| Complete implementation batch | `npm run check` (lint, type checking, build and tests) |
| Source formatting | `npm run format:check` |
| Install the browser used by tests | `npx playwright install chromium` once per test environment |
| Fresh tarball installation and runtime | `npm run test:package` (or append `-- --offline` with a populated npm cache) |
| Released runtime initialization and shutdown | `node dist/cli.js doctor` after building; no model request |

For documentation-only changes, check links, command accuracy, whitespace and consistency with source; runtime tests are needed only for affected runtime behavior. Use focused tests during implementation and the complete gate at the implementation batch boundary. Formatting applies to edited source files; report unrelated existing failures separately.

`npm test` rebuilds `dist` before testing. Do not overlap builds or test runs with another writer or a live service using the same checkout's `dist`; coordinate ownership or use an isolated checkout. Browser tests require the installed Chromium binary. SDK fixtures and `doctor` do not prove a real provider task. See [Verification record](docs/verification.md) for historical evidence and its limits.

## Review and completion

Record the acceptance criteria, changed scope, commands run and the commit or file snapshot they validated. Include relevant untracked files; an empty Git diff is not proof of an empty working tree. For delivery review, report Spec (requirements and behavior) and Standards (applicable conventions and correctness) separately, and state whether review was independent or self-review.

Fix demonstrated defects within the authorized scope and recheck the affected behavior. Reuse passing evidence only while its inputs remain applicable. Distinguish planning, implementation, verification, review, integration and release; skipped, blocked or inconclusive checks are not passes. Commit, push, publish and deploy only within the task's authorization.
