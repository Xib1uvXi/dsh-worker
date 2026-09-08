# Verification record

The earlier sections below are historical evidence for their respective batches. The current integration is CLI + Skill; see its section for removal of the former MCP adapter.

The TypeScript rebuild is tested independently of the retired Python suite. Detailed local evidence is retained under `.scratch/typescript-rebuild/`. The user requested direct development without delegation; all implementation and review in this rebuild are by the primary agent. Self-review is not represented as independent review.

The acceptance suite covers real Git worktrees and primary-checkout preservation, SQLite persistence and controller exclusivity, immutable revisions, bounded concurrent attempts, raw completion conditions, independent verification, stale reviews, rework, snapshot scope/content/modes/staged evidence, authenticated HTTP and journal replay, public TypeScript SDK wire behavior, actual process cancellation/timeout/crash recovery, CLI/MCP lifecycle and Chromium desktop/mobile interaction.

The SDK wire peer used for execution tests is a deterministic local fixture. It spends no model requests and is not a model-generated implementation. The actual published `@deepseek-ai/dsh-sdk-client` and `@deepseek-ai/dsh` 0.1.3-alpha.2 combination separately passed initialize/close with the final worker profile and no model call on Node 24.18.0 / macOS arm64.

Live model dispatch remains disabled during development. No development task was assigned to a worker or subagent. No automatic acceptance, global installation, publishing or repository commit is performed. Linux behavior has not been exercised on a Linux host.

Final command results and package-consumer validation are recorded below after the final gate.

## Final local results — 2026-09-08

- `npm run check`: TypeScript checks and build passed; 6 test files, **41 tests passed**, 34.27 s. This includes desktop/mobile Chromium interactions, durable event replay plus live delivery, concurrent execution and real controller-crash recovery.
- `npm run format:check`: passed.
- Released runtime smoke: actual SDK/runtime 0.1.3-alpha.2 initialized and closed; final delegation tools disabled, approval never, maxTokensAsSuccess false; **0 model calls**.
- Fresh directory package consumption: npm tarball installed, CLI help worked, public contracts/controller/plugin imports worked, external TypeScript consumer compiled, and the installed runtime passed `doctor` without a model request.
- Package inventory: no Python files, Python packaging metadata or `.scratch` content. The user subsequently requested deletion of the Python source/test archives and old data; they have been removed.

## Self-review

**Spec:** The Node service, shared contracts, interactive UI, MCP/CLI integration, worktree/revision ownership, execution lifecycle, evidence-bound verification/review and explicit recovery satisfy the implemented local acceptance matrix. Advanced models remain the external orchestrator; no development work was delegated. Live model-generated coding has not been exercised in this rebuild, and normal dispatch remains disabled.

**Standards:** No unresolved defect was found in the final self-review. Reproduced/fixed defects include canonical macOS paths; receipt-to-idle fixture conformance; controller ownership/recovery races; out-of-scope staged-only changes; startup cleanup; receipt/termination persistence before final exit; and integrity validation of downloadable artifacts. Verification output truncation is explicit. Filesystem snapshots, SQL and process tests use real local resources.

This is a self-review, not an independent review. Linux/macOS cross-platform parity, real provider-generated coding and production operation are separate evidence boundaries; none is claimed by the deterministic fixture tests.

The subsequent user scope clarification removes mobile viewing from future requirements. Historical mobile evidence above remains historical; the maintained browser gate now targets desktop creation, list/board switching, execution, verification, review and search.

## Web task control and trajectory — 2026-09-08

The next desktop delivery batch adds natural-language task entry and queued/live instructions, ordinary-form revision editing, archive/restore, current agent cards, and paginated per-attempt/session trajectory. The source reference is the upstream trajectory/message projection plus the installed public SDK's prompt/notification contracts. Worker delegation and normal dispatch remain disabled in the preview.

- `npm run check`: strict TypeScript checks, production bundles/declarations and **46 passing tests across 7 files**, 38.99 seconds (`.scratch/web-control/final-check.log`).
- Added persistence/restart, duplicate-instruction conflict, uncertain-send no-replay, archived execution refusal, canonical nested tool-result linkage, child-parent identity, authenticated cursor pagination, and actual SDK prompt-transport tests. Git, SQLite, HTTP and subprocess ownership are real; the SDK peer supplies deterministic events and performs a fixture file edit, not a provider/model call.
- Chromium at 1440×1000 passed both the existing create/run/verify/review flow and natural-language creation → queued instruction → running tool visibility → live instruction/receipt → result trajectory → ordinary-field revision edit → archive/restore. Screenshots under `.scratch/web-control/browser/` were visually inspected; fixture activity is not represented as a live model session.
- `npm run format:check` and `git diff --check` passed.

**Spec self-review:** The requested Web management, natural-language input, execution trajectory and concrete agent activity are implemented. Both Web and MCP reach the same validated controller. Existing external review/acceptance and disabled delegation rules remain in effect. Text instructions guide execution inside an explicit task; this batch does not introduce a conversational planning model that invents repository/scope/acceptance.

**Standards self-review:** Fixed the demonstrated source-format mismatch for `tool/result`, bounded the browser event window, retained form drafts and stable instruction IDs during refresh/retry, and fenced uncertain receipts across restart. The final checks have no unresolved failure. Review was performed by the implementing agent under the user's no-delegation instruction; it is not independent review. No real provider/model coding run, Linux validation, commit, push or publication is claimed.

## Compact desktop visual redesign — 2026-09-08

The supplied Linear screenshot is the visual reference for this presentation-only batch: neutral gray sidebar, slim breadcrumb header, status-grouped task rows, small status accents, and a right-hand inspector for actual workspace counts, natural-language input and agent activity. Task dialogs, forms, tool trajectories, list/board layouts and every existing controller action remain available. No backend, runtime policy or data model changed.

The desktop browser suite exercises the existing full task lifecycle and instruction/trajectory flow under the new layout. A separate display-fixture scenario covers multiple task states, group folding across refresh, list/board navigation, detail controls and switching between task and session views. Screenshots in `.scratch/linear-ui/browser` use explicitly synthetic display states; they are visual evidence, not real coding or acceptance records. The live preview retains its original data and disabled dispatch setting.

Final result: `npm run check` passed **47 tests / 7 files** in 46.50 seconds, including all three desktop browser flows (`.scratch/linear-ui/final-check.log`). Type checks, production build/declarations, formatting and `git diff --check` passed. Populated-list, board and detail screenshots were visually inspected. The display-fixture test reproduced initial-render starvation when journal replay triggered many concurrent overview requests; the UI now shares one in-flight overview request, and the regression passes. Spec and Standards self-review found no remaining batch blocker; no independent agent review or model dispatch was used.

## CLI + Skill integration — 2026-09-08

The user selected CLI + Skill and explicitly excluded CLI trajectory querying. Removed the worker's MCP adapter and direct protocol SDK dependency; the underlying Harness retains its own independently supplied capabilities. Detailed trajectory/raw-event/activity queries remain on the Web. Current orchestration commands cover task lifecycle, text instructions, bounded waiting, archive/restore, hash-verified artifact download and `skill`/`workflow` discovery. JSON file/stdin instructions use the shared strict contract.

`npm run check` passed **50 tests / 8 files** in 48.20 seconds (`.scratch/cli-skill/final-check.log`). New subprocess CLI tests cover skill discovery, stdin input, literal multiline instructions, duplicate/conflicting IDs, rejected foreign-target JSON fields, implementation/verification/review, artifact integrity and overwrite refusal, archiving/restoring, wait timeout without cancellation, cancellation plus explicit recovery, and refusal of retired protocol/trace commands. The service lifecycle test now runs ordinary CLI calls. Existing desktop/SDK/process regressions pass. Formatting, skill metadata and diff checks passed.

Spec/Standards self-review: the command surface and bundled skill match the selected integration; no separate protocol registration is needed. The existing local orchestrator reference was corrected from deleted Python paths to the current TypeScript entry and service-owned execution semantics. No global command installation, model dispatch or independent reviewer was used. Fixture execution remains distinct from a real provider/model coding run.

## Dashboard authentication continuity — 2026-09-08

The reported missing-token page exposed two lifecycle gaps: service restarts issued new tokens, and browser authentication only lasted for a tab session. Service tokens now persist per control directory with owner-only permissions, and the browser remembers successful login information across sessions. Initial login still requires the printed private link or an explicit token; API authentication remains enforced. Opening a token link in an already-open page also works through fragment-change handling. Invalid saved service tokens fail explicitly instead of silently replacing credentials.

`npm run check` passed **53 tests / 9 files** in 58.54 seconds (`.scratch/dashboard-auth/final-check.log`). Added token persistence, permissions, upgrade adoption and corruption checks, plus a real CLI service/Chromium regression covering unauthenticated entry, same-page token login, service restart, fresh browser context with saved storage and explicit replacement of stale browser credentials. The existing task lifecycle, trajectory, CLI, SDK and process suites pass. The local service was restarted with the fix, retaining its issued token, dispatch enabled and capacity 8; authenticated overview confirmed these settings. No provider/model coding request was made by this repair.

Independent review of the authentication changes passed Spec and Standards with no blocking findings. The reviewer compared the saved baseline and inspected the complete test results without repeating the suite. Formatting and diff checks passed.

## Configurable engineering skills — 2026-09-08

The existing per-home workflow contract remains portable and opt-in. Relative paths now resolve against the configuration file, inspection returns named skills and entry skills, invalid metadata and ambiguous names fail before dispatch, and entry instructions explicitly preserve the implementation-worker role. Validation used seven locally configured skill directories and a working agreement; those selections are local test inputs, not product dependencies or defaults.

`npm run check` passed **56 tests / 10 files** in 46.29 seconds (`.scratch/skill-config/check.log`). Formatting and diff checks passed. An independent reviewer passed Spec and Standards. Separately, the installed Harness filesystem provider discovered and loaded all seven configured skill bodies (`.scratch/skill-config/native-discovery.json`, zero model calls); this structural/native-provider check alone does not prove model use.

## Real model orchestration E2E — 2026-09-08

`LIVE-E2E-01` exercised the installed Harness 0.1.3-alpha.2 with its default `deepseek-official` / `deepseek-v4-flash` route and existing provider credentials. The orchestrator prepared a separate local Git target with an unimplemented TypeScript queue selector and ten acceptance tests, confirmed the failing baseline, and dispatched through the ordinary CLI to the existing capacity-8 service. No deterministic model peer or custom model loop was used for this run.

Web inspection confirmed a real `skill` call for the configured implementation entry, implementation tool calls, live natural-language instruction receipt, and the task's subsequent execution rounds. The Worker implemented the selector and added eight tests. The first two submissions were rejected because their final message wrapped JSON in prose and included undocumented command fields; both failed attempts remain in history. This uncovered missing command-item guidance and a recovery fast-path bug that left an in-memory capacity reservation after already-clean processes required no asynchronous cleanup.

The product now supplies the complete command-item example and accepts one conservatively wrapped JSON delivery while retaining strict fields, acceptance evidence and ticket/revision/attempt checks. Ambiguous structured prefixes, malformed or trailing content are rejected. Recovery registers its operation before its body can settle. A red regression reproduced the leaked slot; the corrected regression verifies capacity release and subsequent execution. Independent review found an envelope-prefix edge, which was fixed and expanded to conservative scalar-prefix rejection; the primary agent adjudicated that bounded envelope behavior. Independent focused review passed the recovery fix.

The third real attempt, `a05bb13a-7aae-4ca1-ac4e-f11f6ddac17a`, submitted successfully. Controller-owned verification ran **18 tests, all passing**, and retained the same before/after snapshot `94b6993a0e11c05439f1151d29c636dee466f9474a2c86d3b53620c9e1bc56ab`. The external orchestrator inspected both changed files, protected acceptance files, original Git base, scope and actual process exit evidence, then recorded passing Spec and Standards and accepted the exact snapshot. Hash-verified artifacts were integrated into the isolated target; all file hashes/modes and Git index/diff state match the accepted delivery, and integration reran **18 tests, all passing**. The Web showed accepted and **0 / 8** active slots.

The final product gate passed **60 tests / 11 files** in 52.87 seconds (`.scratch/real-e2e/final-check.log`); formatting and diff checks passed. Detailed local ticket, review, artifact and integration evidence is under `.scratch/real-e2e/`. This proves one real task's implementation/recovery/review/integration loop, not eight simultaneous provider executions, Linux behavior, or production deployment. The target has only its orchestrator-created baseline commit; no worker changes were committed, pushed or published.

## CLI troubleshooting — 2026-09-08

Added read-only service health, compact task summaries, historical error queries with attempt selection and failed-verification output, and task diagnostics with explicit next-step argument arrays. Full existing status/list output remains available. Transport errors retain machine-readable codes and mutation timeouts report unknown outcomes without automatic retries. Execution trajectories remain Web-only.

`npm run check` passed **67 tests / 12 files** in 56.61 seconds (`.scratch/cli-troubleshooting/verified-check.log`). New real HTTP/subprocess CLI checks cover missing/corrupt discovery, authentication failure without token disclosure, historical errors after recovery, attempt isolation, verification exit codes and output clipping, bounded hung requests with unknown mutation outcomes, malformed responses and unreachable services. Final argument/JSON-error classification checks passed in the **10-test CLI/client focused suite** after rebuilding (`final-focused.log`). Formatting and diff checks passed.

Independent review reproduced a verifier-exception history gap: an exception before normal completion had only a transient task error. The fix persists the exception and end time on its verification record and reports older incomplete records explicitly. Two initially failing regressions cover a first-command exception and an exception after a successful command, attempt-scoped retrieval, recovery and historical retrieval. The immediate-exception path also now registers the operation before settlement so capacity cannot leak. Focused independent re-review passed Spec and Standards.

Read-only commands against the existing real `LIVE-E2E-01` record confirmed healthy authenticated service, capacity 8/active 0, current accepted snapshot with passing verification, and both historical malformed deliveries. `diagnose` correctly reports the accepted task as currently healthy despite these historical errors. Evidence is retained in `.scratch/cli-troubleshooting/live-*.json`. The idle service was restarted with the verifier-error persistence fix while retaining authentication and dispatch configuration; no new model execution was needed.
