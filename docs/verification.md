# Verification record

Use current command results for current changes. Historical runs below describe their recorded snapshot only; they are not a permanent acceptance gate or proof of current provider behavior. The maintained commands are in [the repository guide](../AGENTS.md#build-and-validate).

## Maintained checks

- `npm run check`: ESLint, type checking, distributable build/declarations, real Git/SQLite/HTTP/process tests, public-SDK deterministic wire fixtures, CLI lifecycle and desktop Chromium flows.
- `npm run format:check`: source formatting. `git diff --check`: whitespace consistency.
- `node dist/cli.js doctor --home DIR`: released runtime initialization/close, with zero model calls.
- Package consumption: install a locally packed tarball into an isolated directory and check public imports, declarations and CLI help.
- `npm run test:package`: build and install a fresh tarball with normal npm lifecycle scripts, check public exports, run the real doctor three times, and verify the diagnostic for a missing native binding. Append `-- --offline` when the npm cache is populated.

Deterministic SDK fixtures are not provider/model execution. A skipped browser or unavailable runtime check is not a pass. Linux needs its own host evidence; the recorded platform is Node 24.18.0 / macOS arm64. Desktop is the browser acceptance target.

## Historical evidence — 2026-09-08

The TypeScript rebuild initially passed 41 tests and isolated package/runtime smoke checks. Later batches added Web instructions and trajectories, desktop layout, CLI + Skill integration, persistent Dashboard authentication, configurable worker skills and CLI diagnostics. The last recorded pre-repair complete gate passed 67 tests in 12 files. Authentication, workflow and diagnostics batches recorded independent review; earlier rebuild batches recorded self-review only. These historical details remain available in Git history rather than depending on private scratch logs.

One real provider task (`LIVE-E2E-01`, DeepSeek V4 Flash through Harness 0.1.3-alpha.2) exercised implementation, instruction receipt, recovery, verification, external review and integration. Two earlier deliveries were rejected for their envelope or schema; attempt `a05bb13a-7aae-4ca1-ac4e-f11f6ddac17a` submitted and passed 18 controller verification tests at snapshot `94b6993a0e11c05439f1151d29c636dee466f9474a2c86d3b53620c9e1bc56ab`. The isolated target integration reran those 18 tests. This historical record proves neither eight concurrent provider tasks nor Linux parity nor deployment of subsequent changes.

## Polling and recovery repair

Acceptance covers responsive compact polling; durable process identity changes without repetitive writes; UTF-8 chunk boundaries; one unambiguous delivery document after ordinary Markdown prose; unchanged-delivery verification recovery; short settlement/review transactions; bounded scratch cleanup; enforced import directions; and removal of obsolete Python-era UI tests and private-log dependencies from maintained documentation.

The new regressions use local resources and deterministic runtime behavior. No real provider task is required or claimed for this repair. Results on Node 24.18.0 / macOS arm64:

- `npm run check`: 76 tests across 15 files passed, including desktop Chromium, real process recovery and SDK wire fixtures (69.01 seconds).
- Independent full review found three P2s: token initialization before ownership, compact overview replacing open detail evidence, and legacy inline snapshots retaining large polling responses. All were repaired. Focused lifecycle/auth/regression/boundary checks passed 20 tests; subsequent browser/client/CLI checks passed 14 tests. Independent focused re-review passed both Spec and Standards with no remaining blocker.
- Final performance regression: 5,000 baseline files, full response 686,365 bytes, compact polling 2,278 bytes, cached query 0.05 ms. The event loop advanced during the first asynchronous check. Twenty identical process reports produced only one ownership-addition event and one final empty-set event. Both performance tests passed after the review fixes.
- Final type checking, build/declarations, formatting, local documentation links and whitespace checks passed. The source/test/config snapshot (58 files; excludes documentation) is `2c7451e8d6366eebd3cc6570840c632a4acebc34f0ff756a866231c66540620e`, based on exact commit `e63beffc35510a8743e3ed7ffdfd8f164c3c7ab7` plus the uncommitted repair.
- The local released runtime initialized and closed through `doctor` with zero model calls. Public exports loaded from an independently installed tarball. That fresh offline install's `doctor` failed with `cannot create effect on inactive context`; the exact pre-repair baseline reproduced the same error against those installed dependencies. Fresh-install runtime validation therefore remains failed, not a pass; the cause was not established by this repair.

No real provider/model execution, Linux validation, commit, integration or deployment is claimed for this repair.

## Lint capability

Acceptance covers linting maintained TypeScript and JavaScript source, tests and configuration; type-aware Promise checks; browser restrictions on Node globals and literal module imports; generated-file exclusions; safe automatic fixes; and inclusion in the complete implementation gate. Existing formatting and runtime checks remain applicable.

Results on Node 24.18.0 / macOS arm64:

- `npm run check`: lint, type checking, build/declarations and 87 tests across 16 files passed. Nine lint regression cases exercise invalid and valid snippets, automatic fixes, ignored paths, and static/dynamic browser imports.
- `npm run format:check` and `git diff --check` passed. The source/test/config snapshot (60 files, excluding documentation) is `175343e509df7ada8c2a03697b06298b3b22bb2a3866b1d82d7dd8bb575299e5`, based on commit `e63beffc35510a8743e3ed7ffdfd8f164c3c7ab7` plus the uncommitted repair and lint changes.
- Independent full review passed Spec and Standards with no blocker. The reviewer compared this batch against its pre-lint file snapshot, checked the complete validation log and confirmed that existing dependency versions were unchanged.

This batch adds development checks; it does not establish fresh-install runtime, provider execution or Linux validation.

## Ownership, scope, freshness and doctor repair

Acceptance covers exclusive controller ownership when contenders reclaim the same dead process marker; scope enforcement for actual file changes hidden by Git index flags or mode configuration; automatic stale-evidence updates in an open detail view; and working local/fresh-install doctor initialization and shutdown without a model request.

Results on Node 24.18.0 / macOS arm64:

- The new regressions failed against the previous implementation: both controlled lock contenders opened the same home; assume-unchanged, skip-worktree and disabled file-mode tracking hid an out-of-scope file; and the open browser detail did not display the stale warning.
- `npm run check`: lint, type checking, build/declarations and 98 tests in 17 files passed. This includes real concurrent processes and crash recovery, hidden-change scope blocking and artifact contents, stale warning appearance/removal, real SDK doctor initialization/close, and the existing 5,000-file polling performance check.
- `npm run test:package -- --offline`: a fresh tarball install passed public imports and three actual doctor runs with zero model calls. Removing only the disposable consumer's `fs_ext.node` produced the new `runtime_dependencies` diagnostic; restoring it restored successful doctor initialization. Successful doctor runs left no scratch directory.
- The earlier fresh-install failure was traced to that check's `npm install --ignore-scripts`: the missing `fs-ext` native binding caused Harness to roll back plugin loading and expose `cannot create effect on inactive context`. Rebuilding only `fs-ext` in the original failing installation restored doctor. No upstream code or npm policy was changed. A script-disabled installation is not a runtime-ready installation.
- Independent full review found one P2: raw blob comparison rejected a legitimate CRLF checkout. Focused re-review exposed a second route: changing the smudge configuration could redefine the comparison. Six conversion regressions now cover normal CRLF/smudge checkouts, hidden byte edits, edited attributes, changed filter configuration/programs, restart/cache behavior and baseline tampering. The final fix pins admission-time conversion overrides as immutable evidence and retains staged-change checks; final closure follows owner adjudication and the regression results.
- Source formatting, local documentation links and whitespace checks passed. The source/test/config snapshot (65 files, excluding documentation) is `a6650334e4d3d7422b936b34651cdc1192a727f1d23129b7df9f3e3fa328be33`, based on commit `e63beffc35510a8743e3ed7ffdfd8f164c3c7ab7` plus the uncommitted repair batches.

This verifies local runtime startup and shutdown, not provider/model execution, Linux support, integration or deployment.

## Full code review and repair

The full review covered maintained packages, scripts, contracts, build/lint configuration, tests and applicable documentation, including existing uncommitted repairs. Eight confirmed defects were fixed: synchronous runtime exceptions retaining capacity; acceptance using an old verification pass after a newer failure; plugin readiness exceptions leaking service resources; compressed session rotation causing an uncaught read error; empty-token authentication bypass; health reading an obsolete lock; out-of-order detail responses selecting the wrong task; and instruction receipts deleting a newer unsent draft.

Results on Node 24.18.0 / macOS arm64:

- `npm run check`: lint, type checking, build/declarations and 106 tests in 17 files passed (81.76 seconds). Regressions include success/failure/success verification, real HTTP authentication, an isolated process for the session-file race, lifecycle resource release, upgraded service discovery and Chromium request-order/draft-preservation checks. Existing fake runtimes now wait for launch or receipt before issuing dependent actions.
- `npm run format:check` and `git diff --check` passed.
- `npx tsx scripts/package-smoke.ts --offline`, using that completed build, passed public imports, three real doctor runs and the missing-native-binding diagnostic in a fresh tarball installation. Doctor made zero model calls.
- The source/test/script/build-config snapshot (65 files, excluding documentation) is `9a0e307e01fc7a9bcf4c872e01ffb27c01345e73ff4cf9d9f482d60689e0778a`, based on commit `e63beffc35510a8743e3ed7ffdfd8f164c3c7ab7` plus the preserved uncommitted work and this repair.
- Independent full review and focused re-review passed Spec and Standards after all eight fixes. The reviewer inspected the fixes and regressions, confirmed all 65 manifest entries and checked the complete validation log without repeating the build.

No provider/model execution, Linux runtime validation, commit, integration or deployment is claimed by this batch.
