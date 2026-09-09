# Configurable engineering skills

The orchestrator's bundled CLI skill describes how to control the worker. Worker engineering skills are a separate, opt-in configuration: each controller home can use its owner's methods, without installing a particular personal suite into this package.

To create the external host's personal `dsh-orchestrator` skill, follow [Create your own orchestrator skill](orchestrator-setup.md). Its template selects your orchestration methods and connection settings; the configuration below selects the implementation methods available to the worker.

Create `workflow.json` in the same home passed to `serve` and CLI commands:

```json
{
  "schemaVersion": 2,
  "skillDirs": ["/path/to/skills/implementation", "/path/to/skills/debugging"],
  "instructionFiles": ["/path/to/working-agreement.md"],
  "entrySkills": ["implementation"]
}
```

- `skillDirs`: explicitly selected skill bundle directories, each containing `SKILL.md` with a unique kebab-case `name` and a nonempty `description` in YAML frontmatter. The configured directories enter the native Harness skill catalog; skill bodies and resources load on demand. Default user and project skill roots are excluded by this configuration.
- `instructionFiles`: selected UTF-8 guidance files included in the worker assignment. Include a working agreement here when its rules must always be present.
- `entrySkills`: configured skill names the worker is instructed to load before implementation. Other configured skills remain available when relevant. Naming an entry is an instruction, not proof the model used it; verify actual tool activity during execution.

Paths may be absolute, start with `~/`, or be relative to the configuration file's directory. A service-level `DSH_WORKER_WORKFLOW` can select a different file; use the same override for local CLI inspection. An explicitly selected missing file is an error. With no configuration, the worker does not assume personal skills are installed.

Run `dsh-worker workflow --home DIR` (or the equivalent Node CLI invocation) to inspect the resolved configuration path, named skills, entry skills and source hashes. Configuration is read again before each attempt; changes apply to subsequent attempts without restarting the service. Avoid editing referenced skill sources during execution: Harness reads those files on demand, while the attempt records their initial hashes rather than freezing all referenced resources.

## Selecting implementation methods

Select an implementation skill as the entry and optionally add supporting methods for debugging, design, research or testing. Use skill names from your own files' frontmatter, configure their directories in your control home, and keep their referenced resources available. Select your working agreement through `instructionFiles` when appropriate. No particular skill suite or agent installation is required; the empty example configuration is valid. Keep personal selections outside the shared repository.

The external orchestrator continues to own planning, scheduling, independent review, acceptance and integration. Skill text supplies engineering methods within the worker role; it does not authorize the worker to delegate, self-accept, commit or merge. Keep orchestrator-only instructions outside the worker catalog.

The host's [coordination reference](../examples/dsh-orchestrator/references/coordination.md) belongs with its personal orchestrator skill. It records the decisions needed before dependent dispatch, scope repartition, correction handling and integration. Updating `workflow.json` or installing a newer worker cannot repair an outdated host skill; update and evaluate that host guidance separately through the [setup and maintenance guide](orchestrator-setup.md#maintain-your-personal-version).
