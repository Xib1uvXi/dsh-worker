# Verification record

Use current command results for current changes. Recorded runs describe their measured snapshot only; they are not a permanent acceptance gate or proof of current provider behavior. The maintained commands are in [the repository guide](../AGENTS.md#build-and-validate).

## Maintained checks

- `npm run check`: ESLint, type checking, distributable build/declarations, real Git/SQLite/HTTP/process tests, public-SDK deterministic wire fixtures, CLI lifecycle and desktop Chromium flows.
- `npm run format:check`: source formatting. `git diff --check`: whitespace consistency.
- `node dist/cli.js doctor --home DIR`: released runtime initialization/close, with zero model calls.
- Package consumption: install a locally packed tarball into an isolated directory and check public imports, declarations and CLI help.
- `npm run test:package`: build and install a fresh tarball with normal npm lifecycle scripts, check public exports, run the real doctor three times, and verify the diagnostic for a missing native binding. Append `-- --offline` when the npm cache is populated.

Deterministic SDK fixtures are not provider/model execution. A skipped browser or unavailable runtime check is not a pass. Linux needs its own host evidence; the recorded platform is Node 24.18.0 / macOS arm64. Desktop is the browser acceptance target.

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
