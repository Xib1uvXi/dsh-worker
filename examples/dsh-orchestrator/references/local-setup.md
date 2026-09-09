# Personal setup

Customize this file before installing the skill. Replace every `REPLACE_...` value with a verified local choice or an explicit `none` for an optional selection. Keep this generated file in the owner's skill directory rather than in a shared source repository.

## Connection

- CLI invocation: `REPLACE_CLI_INVOCATION` (installed `dsh-worker`, or `node` plus an absolute `dist/cli.js` path).
- Control home: `REPLACE_CONTROL_HOME` (use it for every service and client command).
- Workflow override: `REPLACE_WORKFLOW_OVERRIDE_OR_NONE` (the same `DSH_WORKER_WORKFLOW` selection as the service, if used).
- Credential environment names: `REPLACE_CREDENTIAL_NAMES` (names only; never include values or login URLs).
- Provider/model/reasoning preferences: `REPLACE_EXISTING_PREFERENCES_OR_PRODUCT_DEFAULTS`.
- Service capacity preference: `REPLACE_CAPACITY_PREFERENCE_OR_PRODUCT_DEFAULT`.

Discover the bundled CLI instructions and examples through `skill` using this invocation. Confirm current ownership and connectivity through `health`; this file does not establish that the service is running, idle or authorized for dispatch. Use the installed Getting started guide when startup or credentials need attention.

## Owner methods

- Existing user working rules: `REPLACE_RULE_REFERENCES_OR_NONE`.
- Planning/design methods, read for unresolved requirements: `REPLACE_PLANNING_REFERENCES_OR_NONE`.
- Implementation/debugging skills selected in controller workflow: `REPLACE_WORKER_SKILLS_OR_NONE`.
- Worker entry skill names: `REPLACE_WORKER_ENTRY_SKILLS_OR_NONE`.
- Review method and available independent reviewer: `REPLACE_REVIEW_METHOD_AND_REVIEWER`.
- Task/dependency/integration record location: `REPLACE_LOCAL_TASK_RECORD_LOCATION`.

Use that existing record for the decisions described in [host coordination](coordination.md): shared behavior, prerequisite readiness, acceptance ownership, correction disposition and integration evidence. No new database or mandatory record format is required.

Use verified absolute references or paths relative to this generated file; retain access to their supporting resources. Keep each rule in its existing authoritative source. Project-specific instructions and checks come from the current target repository, not from a fixed list copied here. Do not load this orchestrator skill into the worker's `workflow.json`.

## Delivery preferences

- Preferred integration target selection: `REPLACE_TARGET_SELECTION_CONVENTION` (resolve its actual checkout and branch for each task).
- Reporting language and useful evidence format: `REPLACE_REPORTING_PREFERENCES`.

Preferences are defaults, not standing permission to dispatch, commit, push or release. Resolve each task's requested outcome and existing authorization. If a required reviewer or environment is unavailable, report the concrete limitation and preserve completed work.
