# Verification record

Use current command results for current changes. Recorded runs describe their measured snapshot only; they are not a permanent acceptance gate or proof of current provider behavior. The maintained commands are in [the repository guide](../AGENTS.md#build-and-validate).

## Maintained checks

- `npm run check`: ESLint, type checking, distributable build/declarations, real Git/SQLite/HTTP/process tests, public-SDK deterministic wire fixtures, CLI lifecycle and desktop Chromium flows.
- `npm run format:check`: source formatting. `git diff --check`: whitespace consistency.
- `node dist/cli.js doctor --home DIR`: released runtime initialization/close, with zero model calls.
- Package consumption: install a locally packed tarball into an isolated directory and check public imports, declarations and CLI help.
- `npm run test:package`: build and install a fresh tarball with normal npm lifecycle scripts, check public exports, run five successful real doctor checks, and verify the diagnostic for a missing persistence dependency. Append `-- --offline` when the npm cache is populated.

Deterministic SDK fixtures are not provider/model execution. A skipped browser or unavailable runtime check is not a pass. Linux needs its own host evidence; the recorded platform is Node 24.18.0 / macOS arm64. Desktop is the browser acceptance target.

## Harness 0.1.5 compatibility

On 2026-09-11, the upgrade batch based on `64421ef055b9a69cfa024554ef79feabf1c7e097` pinned the Harness package family to `0.1.5-rc.2`. Validation used Node 24.18.0 on macOS arm64 in an isolated checkout.

- `npm run lint`, `npm run typecheck`, and `npm test -- --maxWorkers=1` passed: the test command rebuilt the distributable and ran **185 tests in 21 files**, including desktop Chromium, actual TypeScript/Go/Rust LSP, SDK lifecycle, cancellation and process cleanup. The complete suite ran serially after parallel execution exposed host-contention timeouts and a test's exact-zero elapsed-time assumption; no timeout limits or test cases were removed.
- The actual `0.1.3-alpha.2` compressed V2 fixture resumed through the current worker adapter and real released runtime. Both prior context and the new answer reached the deterministic provider, a V3 artifact was published, and the original source and copied V2 artifact stayed byte-identical. Malformed V2 input failed before a provider prompt and published no V3 successor. These migration tests make no network model calls.
- `npx tsx scripts/package-smoke.ts` passed a fresh tarball installation, five successful doctor checks, coding/optional-plugin composition, public exports, and a missing persistence-dependency diagnostic followed by recovery. Lint, type checking and build were repeated after the package test's fault injection was updated for the new dependency layout. The unchanged runtime-suite results above remain applicable. Doctor model calls: **0**.
- A separate actual DeepSeek official `deepseek-v4-pro` task changed one file in a disposable repository in **one attempt**, reached `awaiting_review` with a receipt, and passed controller verification. The owned runtime processes exited and the test controller closed. This is a real provider smoke check, not an acceptance decision or a load test.
- Source formatting, changed Markdown links and whitespace checks passed. The running service and primary checkout were not upgraded by these checks. Controller schema 2 and the explicit worker model selection remain unchanged; Linux support and activation require separate evidence.

## Flash default follow-up

On 2026-09-11, the same Harness upgrade batch changed the default worker model to `deepseek-flash`, as requested. This supersedes the earlier Pro default recorded below. CLI/API validation, the Web form, ticket template and operator instructions agree on the new default; explicitly supplied models remain unchanged.

- `npm run lint`, `npm run typecheck`, and `npm test -- --maxWorkers=1` passed again: build/declarations and **185 tests in 21 files**. Coverage includes persisted CLI defaults, the model passed through the public SDK initialization RPC, explicit model overrides and the Chromium form default.
- A fresh tarball installation passed all five doctor checks, coding/optional-plugin composition, public exports and the missing persistence-dependency diagnostic/recovery check. Doctor model calls: **0**.
- A real DeepSeek official task omitted the model in its input and resolved to `deepseek-flash`. In **one attempt**, it changed the intended file, returned a receipt, reached `awaiting_review`, and passed controller verification. No owned runtime processes remained, and the disposable controller closed. This is a provider smoke check, not an acceptance decision or multimodal feature validation.
- Source formatting and whitespace checks passed. Historical Pro verification and the genuine V2 fixture retain their original model provenance. The primary checkout and running service were not changed.

## Current acceptance

The snapshot optimization and cleanup batch uses base commit `e3757cb6ecf0c8809809f78dcfbfd7c2d7c78985` plus the uncommitted changes. The source/test/script/build-config manifest has 61 files and SHA-256 `74a0411a422eb5a0ae7fbe93a0127a2da24513d2dd9b8a5b35ff525f0d1237e9`.

- `npm run check`: lint, type checking, build/declarations and **111 tests in 17 files passed** (67.90 seconds).
- Source/document formatting, maintained documentation links and `git diff --check` passed.
- `npx tsx scripts/package-smoke.ts --offline` using that completed build passed public exports, **three actual doctor runs**, and the missing-native-binding diagnostic in a fresh installation. Model calls: **0**.
- Independent full-batch review passed **Spec and Standards**, with no blocker. The reviewer independently checked raw statistics, source identities, dependency versions and extra Git formatting configurations.
- The final paired snapshot benchmark recorded 11 samples for each of six cases, with identical snapshot digests. The exact, cached and existing-evidence medians improved by 29.0%, 35.9% and 31.6%, respectively. Historical implementation logs and superseded repair narratives remain in Git history, rather than in the operator guide. See [Performance experiments](performance.md) for reproducible workload definitions, measurements and retained safeguards.

## Default worker model

The follow-up change defaults omitted `execution.model` to `deepseek-v4-pro` during ticket validation and preserves explicit models. Its 61-file source/test/script/build-config manifest has SHA-256 `2fc5a9cb136b11401d78c2b2d3c5495a71c5a261df525fbd07a24860306518e9`.

- `npm run check`: lint, type checking, build/declarations and **117 tests in 17 files passed** (69.94 seconds), including actual doctor initialization/close with **0 model calls**.
- CLI tests cover default persistence and dispatch, explicit model preservation and invalid explicit values. Public-SDK subprocess fixtures check the model received in the actual `initialize` RPC; browser tests check the new-task form default.
- Source and changed-document formatting and `git diff --check` passed.
- Independent review passed **Spec and Standards**, with no blocker; all 61 source identities matched the validated manifest.
- The snapshot collector and benchmark sources remain unchanged from the performance measurement above.

## Real provider end-to-end check

On 2026-09-08, the same validated source snapshot was packed and installed into an isolated consumer. Its actual CLI/service used the released SDK/runtime `0.1.3-alpha.2` and the DeepSeek official provider, with no wire fixture or replacement launcher.

- The input ticket omitted `execution.model`; preparation persisted `deepseek-v4-pro`. One real attempt implemented a dependency/resource-aware queue selector, ran tests and returned a valid delivery with receipt, raw completed reason and clean process exit. No recovery or retry was needed.
- The controller independently ran **16/16 passing tests**: ten original acceptance tests remained unchanged and six worker tests were added. Verification before/after hashes matched delivered snapshot `c600831d4c4eb9bdf92f9f6e80545d14ec1745afbbe71af07ee2fed07e5d9fe9`. Independent Spec and Standards review passed, and the review API recorded `accepted`.
- Both changed-file artifacts were downloaded through the authenticated CLI and hash-checked. Integration into the disposable target matched all five delivered file hashes/modes and the tracked patch; its **16/16 tests passed** again.
- Chromium displayed the real task and Pro model without page errors. Restarting the installed service preserved acceptance, snapshot and single-attempt history without replay. Execution and verification process scans found zero surviving owned processes; both service instances shut down cleanly.
- The fresh installation's actual doctor initialized and closed successfully with **0 model calls**. The coding task above did make real provider requests; the zero-call claim applies only to doctor.

This is one real coding task on macOS arm64, not a load test, Linux validation or deployment. Private credentials, service state and detailed task evidence remain outside shared source control.

A passing local runtime check does not establish provider credentials, model execution, Linux support, integration or deployment. The SDK profile test resolves the installed launcher and confirms delegation remains disabled and token exhaustion is not success. The fresh-package check repeats runtime startup after a normal dependency installation.
