# Final integration review record

This is a template for the host's existing local task record, not an approval or a controller database object. Fill with observed identities and evidence. Keep private execution paths and logs outside shared source control.

## Target and scope

- Target repository and branch:
- Original acceptance and confirmed changes:
- Review pool and effective implementation limit:
- Exact main baseline B:
- Candidate C: HEAD, index/diff identity, non-ignored file manifest and digest:
- B/C observed time and applicable environment:

## Provenance

| Ticket / revision / policy | Implementation attempt / base / snapshot | Independent review run / report digest | Verification identity | Candidate files and dependencies | Host adoption / dispositions |
| --- | --- | --- | --- | --- | --- |
| Fill actual values | | | | | |

Include dependencies inherited from intermediate bases, changed files, deletions, file modes and symlinks. Separately list candidate-only changes, non-ignored untracked files, conflicts and integration repairs. Identify who implemented each repair and independent review of the complete final candidate when the host authored substantive code.

## Original acceptance coverage

| Criterion | Responsible ticket or integration check | Actual evidence | Met / unresolved |
| --- | --- | --- | --- |
| Fill actual criterion | | | |

## Complete B-to-C review

- Spec: whole acceptance, combined behavior, dependencies, resource ownership and failure paths.
- Standards: applicable repository conventions, source scope, correctness and evidence integrity.
- Reviewer and independence; any host-authored code and independent coverage of the complete final candidate:
- Findings, fixes and evidence-backed dispositions; unchanged passing evidence reused:
- Actual lint/test/build and E2E command outputs, exit codes, bound input and environment:
- Real-provider observations and limitations, including failed samples and review quality:
- Final verdict and remaining blockers:

## Before integration and release

- Rechecked main equals B, or new combination and validation after main advancement:
- Rechecked C identity; changed inputs require renewed binding and relevant checks:
- Authorized action and actual outcome: candidate approved / main integrated / pushed / activated:
- Running service build and smoke evidence, when activation is in scope:

Acceptance, integration and release are separate. Do not mark an unexecuted stage complete.
