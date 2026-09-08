# Worker capabilities

The worker composes the pinned Harness plugins through its public SDK profile and patches. Session statistics are enabled by default; MCP, interactive terminals, hooks and programmatic tool calling (PTC) are opt-in. These selections are separate from [coding tools](coding-tools.md) and [engineering skills](skills.md).

## Configuration and checkpoints

1. Create `plugins.json` in the controller home. Start from [the example](../examples/plugins.json). File paths resolve relative to that home; MCP server cwd is always the attempt worktree. Executable names without `/` resolve on the service PATH.
2. Run `dsh-worker tools --home DIR --repo REPO`. Its `plugins` section validates selections, local command availability, hook JSON and required environment variables. Inspection does not start MCP servers or call a model, so a successful HTTP endpoint check still requires startup validation.
3. Run `dsh-worker doctor --home DIR --repo REPO` to initialize and close the selected composition without a model request. This does start configured MCP servers and can run their initialization/discovery. A required server that cannot connect prevents runtime readiness.
4. Dispatch a task through the normal service. `execution.plugins` can contain a complete replacement selection for that immutable ticket revision; omitted values use schema defaults, not a merge with the controller file. Omit `execution.plugins` to use the controller selection. Changes affect subsequent attempts.
5. Inspect the attempt's private `plugins.json`, `plugins.patch.json` and snapshotted hook configuration in its run directory. The authenticated trajectory exposes actual tool activity and whole-session statistics. Configuration presence and a model's statement do not prove a tool was used.

```json
{
  "schemaVersion": 2,
  "stats": true,
  "terminal": true,
  "ptc": "off",
  "mcp": [
    {
      "name": "project",
      "transport": "stdio",
      "command": "/path/to/project-mcp",
      "args": [],
      "env": { "API_TOKEN": "PROJECT_MCP_TOKEN" }
    }
  ],
  "hooks": []
}
```

Names and environment mapping values are variable references, not credentials. In the example, `API_TOKEN` in the server receives the value of `PROJECT_MCP_TOKEN` from the runtime environment. Include `PROJECT_MCP_TOKEN` in the ticket's `execution.envRequired` and supply it to the service. Reserved runtime variables cannot be mapped. Resolved secrets are never written into generated plugin reports/patches; keep secrets out of command arguments, endpoint URLs and hook configuration. These are trusted operator configurations, not a security sandbox.

## MCP

Each server needs a unique `name`, `transport`, and either `command`/`args`/`env` for `stdio`, or `url`/`headerEnv` for `streamable-http`. `headerEnv` maps header names to environment variable names; an Authorization source must contain the complete header value, including its scheme. Endpoint URLs may not contain credentials, queries or fragments. `timeoutSeconds` defaults to 60 and is bounded to 1–300.

The official bridge exposes `mcp__SERVER__TOOL` names. It bridges tools, not MCP resources or prompts. The worker requires successful initial connection and disables automatic reconnection; a failed call is visible, and a failed attempt follows the existing explicit recovery path. No task or tool call is replayed by this configuration.

The stdio launcher preserves process ownership and follows the exact Harness owner. Native subprocesses and terminals also preserve the attempt marker through the official provider's environment scrubbing. Controller recovery remains responsible for accounting for all writers. Configure only services/tools needed by the task; additional schemas increase request size. Actual external server authorization and behavior require their own integration evidence.

## Interactive terminal

`terminal: true` adds `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close` and `terminal_list`. The ordinary one-shot `bash` tool stays available. Terminal state belongs to the exact agent and attempt; it is not restored into a new attempt. Use it for a debugger, REPL or program needing subsequent stdin. Ordinary background commands already have jobs support.

Terminal replies have a bounded 64 KB envelope. An idle indication or timeout does not prove a foreground command exited. Read the actual command status/test result and close the session when finished. Native PTY dependencies are required, and platform support must be validated on the deployment platform.

## Programmatic tool calls

`ptc: both` exposes native tools plus `run_code`; `ptc: ptc` selects the programmatic presentation. `off` retains native calling. The experimental backend runs TypeScript in a fresh upstream Node worker with a 30-second busy-time budget, 120-second wall limit, 256 MB heap cap and 1 MB outer-output cap. Programs use `await tools.NAME(args)` and print or return selected results; intermediate values are not a complete replay record.

Worker PTC is for composing registered tools. Ordinary Node child-process creation and nested Worker entrypoints are refused with instructions to use `tools.bash` or terminal tools, whose execution stays owned by the host. The guard is cooperative API policy, not protection against hostile Node/native code. There is no persistent kernel. Cancellation and deadlines still depend on the called tools honoring their lifecycle contracts.

Measure task outcomes and timing before choosing PTC as a project default. It does not promise lower token use or better code quality.

## Hooks and statistics

`hooks` accepts at most one entry per `kind` (`codex` or `claude-code`) with a `configPath` pointing to a JSON document containing a `hooks` object. The worker validates and snapshots this document before startup. Hook command paths inside it still resolve in the attempt worktree. Upstream bridges run their supported synchronous command-hook subset, with a worker default timeout of 30 seconds. Unsupported forms or execution errors may warn and continue; hooks are feedback, never proof that controller verification or external review passed.

`stats: true` mounts native `dsh-session-stats`. Its whole-session view is persisted as `worker/stats` observations and replayed into the worker's agent cards. Cards show closed steps, accumulated model/tool wall time, mean recorded first-token latency and recorded decode tokens per second. Missing first-token/decode measurements display as unrecorded. Parallel tool time is summed and may exceed elapsed attempt time; cancelled incomplete steps may have no model duration. These figures are observations, not acceptance evidence, and do not compare model quality automatically.

The final worker policy disables Ralph as well as subagent/workflow entrypoints. External orchestration retains design, delegation, verification, review, integration and release. No feature here changes those boundaries.
