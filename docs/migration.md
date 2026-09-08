# Python to TypeScript migration

The Python implementation, its local source/test archives, virtual environments, old controller data and prior Python development evidence have been deleted at the user's request. No Python rollback archive is maintained.

The TypeScript implementation uses schema 2 and a separate default home, `~/.dsh-worker-v2`. It does not promote or reinterpret an old Python attempt, review, session or verification as new acceptance evidence. The old Python UI process has been stopped and the old controller home removed. Prepare new schema 2 assignments with the TypeScript service.

Convert a dispatch contract explicitly: use `schemaVersion`, `ticketId`, `targetRepo`, `baseCommit`, `outOfScope`, `execution`; execution uses `reasoningEffort`, `timeoutSeconds`, `envRequired`. Remove Python-only SDK/bin version fields. SDK/runtime are the exact npm dependency pinned in the lockfile. The new public SDK owns the standard dsh launcher. Runtime patches remain explicit absolute paths and are snapshotted per attempt.

Configure local engineering methods with schema 2 `workflow.json`: `skillDirs`, `instructionFiles`, `entrySkills`. No file is copied from private configuration automatically. The current model and reasoning settings of the orchestrator are separate from each ticket's explicitly selected worker model.

The old Python HTTP endpoints are not an alias of the new API. Point CLI clients at the new control service. No global CLI or system service is installed automatically. The new service starts with model dispatch disabled.

## CLI + Skill integration

Use `dsh-worker skill` (or `node dist/cli.js skill` from a checkout) to load the current command workflow and examples. The previous MCP entry is removed; existing service data and the Web trajectory remain compatible. Invoke ordinary CLI task commands with the same controller `--home`. No trajectory/event query command is exposed in the CLI.
