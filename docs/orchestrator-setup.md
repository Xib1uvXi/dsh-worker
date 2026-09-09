# Create your own orchestrator skill

Use this guide to generate a personal `dsh-orchestrator` skill for Codex or another skill-capable host. It teaches the host how to assign work, coordinate execution, review evidence and integrate results using your engineering methods. It does not create another executable or model service.

The repository supplies a portable starting point, rather than requiring the maintainer's personal skills or machine configuration:

| Resource                                                                       | Purpose                                                           | Loaded by                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------ |
| [Bundled CLI skill](../skill/SKILL.md)                                         | Current commands, contracts and recovery semantics                | External orchestrator                      |
| [Personal skill template](../examples/dsh-orchestrator/SKILL.md)               | Assignment, coordination, review and integration responsibilities | External orchestrator, after customization |
| [Local setup template](../examples/dsh-orchestrator/references/local-setup.md) | Your CLI, control home, methods and completion preferences        | Your personal orchestrator skill           |
| [Host coordination reference](../examples/dsh-orchestrator/references/coordination.md) | Concrete interface, dependency, acceptance, correction and integration decisions | External orchestrator at the relevant decision |
| Controller `workflow.json`                                                     | Optional implementation skills and instruction files              | Worker, before each attempt                |

Installing the npm package makes the guide and templates available; it does not install a personal skill into your host or change your controller configuration. The bundled skill can be used directly when you do not need a personal orchestration layer.

## 1. Locate the product and choose local settings

Follow [Getting started](getting-started.md) for installation. From a built checkout, use `node /absolute/path/to/dsh-worker/dist/cli.js` in place of `dsh-worker` below.

```sh
dsh-worker help
dsh-worker skill
```

Expected: `skill` returns `content`, `path` and `examples`. The personal template is at `dsh-orchestrator/` inside the returned `examples` directory. This works with an installed package as well as a source checkout. Locate this guide under `docs/orchestrator-setup.md` beside the package's `skill` and `examples` directories.

Choose or discover the following values before generating the personal files. Reuse existing settings when they already answer the question.

| Choice                      | What to record                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Host and installation scope | Host-supported personal skill directory; use a project directory only when explicitly wanted                                              |
| CLI                         | Verified `dsh-worker` executable or an absolute Node CLI path; keep the actual command name                                               |
| Controller home             | One explicit directory shared by CLI and service; the product default is `~/.dsh-worker-v2`                                               |
| Workflow override           | Existing `DSH_WORKER_WORKFLOW`, if any; service and inspection must use the same selection                                                |
| Engineering methods         | Existing planning, implementation, debugging and review skills or documents; choosing none is valid                                       |
| Working rules               | Existing user and repository rules to reference, without copying them into multiple competing rule sets                                   |
| Review and completion       | Available external independent reviewer and required repository checks; whether the current task requests review only or also integration |
| Execution preferences       | Existing provider/model/reasoning choices and capacity, if selected; otherwise retain product defaults                                    |
| Task records                | Where to keep task IDs, dependencies, attempts, snapshots and integration evidence locally                                                |

Credential **environment variable names** may be recorded. Credential values and private login URLs must not enter the generated skill. Follow the startup guide for making credentials available to the service.

## 2. Ask your host to generate the personal skill

Give the host this guide and the template directory. Copy the prompt below, adding any preferences not already available in your environment:

```text
Create my personal dsh-orchestrator skill using this project's
docs/orchestrator-setup.md and examples/dsh-orchestrator/ as the starting point.
Read the bundled skill returned by the actual dsh-worker skill command.

Discover my available CLI, host skill directory, applicable user/repository
rules, existing controller configuration and engineering skills. Reuse my
current model and reasoning preferences. Ask only for missing choices that
materially affect the result and cannot be inferred. Do not invent paths or
require the maintainer's personal tools.

Produce a complete dsh-orchestrator/SKILL.md, references/local-setup.md,
and references/coordination.md
in my host's personal skill directory. For Codex, use its configured skill
directory; follow the installed skill-creation guidance. Preserve any existing
skill: inspect it first and update only within my request, or create a separate
draft when a conflicting version needs my decision. Keep the normal automatic
discovery behavior unless I request explicit-only invocation.

Keep the external orchestrator responsible for design, task coordination,
independent Spec/Standards review, acceptance and integration. Workers implement
and test bounded assignments without delegation, self-acceptance or commits.
Reference my existing methods rather than duplicating their global rules.
Use plain repository guidance when I have no personal engineering skills.
Carry the template's coordination reference into the personal skill directory
and keep its conditional link from SKILL.md. Make the host resolve shared
interfaces and prerequisite readiness before dependent dispatch, preserve
original acceptance when repartitioning tickets, decide how queued corrections
are handled, and own the combined behavior during integration. Reuse my existing
task record for these decisions; do not invent ticket fields or require a new
tracking system. Do not accept an unchanged ticket with required work deferred
only in its review notes.

Configure my chosen worker implementation skills in the selected controller's
workflow.json, preserving unrelated settings and keeping orchestrator-only
skills out of the worker catalog. If I choose no worker skills, preserve the
existing configuration unless I explicitly request clearing it; otherwise an
empty configuration is valid. Do not change a service-level workflow override
or select a different control home without accounting for the existing service.

Validate metadata, all local references, the resolved workflow and CLI commands.
Evaluate the coordination reference's concrete scenarios, including the ordinary
isolated-task and setup-only controls. Keep scenario evaluation distinct from an
authorized real worker run; do not dispatch a task merely to validate installation.
Report generated paths, exact skill invocation, the selected home and remaining
validation limits. Generating this setup does not authorize starting/stopping a
service, dispatching a model task, committing, pushing or deploying.
```

Expected output is a personal directory with these three files:

```text
dsh-orchestrator/
  SKILL.md
  references/
    local-setup.md
    coordination.md
```

For Codex, its installed skill-creation guidance currently uses `$CODEX_HOME/skills`, or `~/.codex/skills` when unset; an explicit destination or host configuration takes precedence. Other hosts may use different locations and metadata. Verify discovery in the chosen host rather than assuming that copying files activates a skill in an existing session.

You can also copy and customize the template manually. Preserve all three files together, replace every `REPLACE_...` value in `references/local-setup.md`, and verify every chosen method path. The copied skill's relative links stay inside its own directory; obtain product documentation through the installed CLI instead of preserving relative links into the original checkout.

## 3. Validate the generated result without dispatch

Use the actual selected CLI and control home. Replace the example path below before running commands:

```sh
export DSH_WORKER_HOME="/path/to/your/controller-home"
dsh-worker help
dsh-worker skill
dsh-worker workflow
dsh-worker health
```

Expected checkpoints:

1. The host discovers the generated skill by its frontmatter name, normally `dsh-orchestrator`. If it caches skills, open a fresh host session and check again.
2. The local setup has no unresolved placeholders, and its CLI and method references exist. An empty optional method selection is explicit.
3. `workflow` reports exactly the selected worker skills and entry names, with the intended configuration path. The personal orchestrator skill is absent from that catalog. A source hash and a catalog entry prove availability, not actual model use.
4. If the service is running, `health` confirms its connection and process ownership using the same home. If it is stopped, record that limitation; do not remove locks or silently start a second service to make the check pass.

5. The copied coordination reference resolves locally. Scenario evaluation produces concrete host decisions for an unsettled interface, missing prerequisite, deferred acceptance item, delayed correction and integration conflict; isolated work and setup-only requests retain their ordinary scope. Report this as scenario evidence, not a real-provider or end-to-end delivery result.

For runtime initialization, run `dsh-worker doctor --repo /path/to/target-repository` separately. It creates temporary runtime state and makes zero model requests; it does not validate provider credentials or prove a real coding task. [Coding tools](coding-tools.md) covers tgrep and language-server preflight.

## 4. Try it on an authorized task

In the target project's Codex task, an example request is:

```text
Use $dsh-orchestrator to implement the pagination behavior in this project's
approved specification through dsh-worker. Run the required checks, arrange
independent Spec and Standards review, and integrate the accepted changes into
the current checkout. Preserve existing work. Do not commit or push.
```

Replace the behavior and delivery scope with your real request. Start or reuse the control service according to [Getting started](getting-started.md); the service must receive the credential environment required by the assignment.

The orchestrator should prepare a concrete ticket against the target repository's existing base, execute in its owned worktree, inspect the actual diff and verification evidence, record external review, then integrate when authorized. Keep task preparation, model execution, verification, review and integration as separate observable checkpoints. Follow [Efficient orchestration](orchestration.md) for waiting, evidence queries and dependency handling.

Inspect the host's own evidence too: the decided shared interface, prerequisite readiness in the consumer environment, original acceptance ownership, the disposition of each known correction, and the combined result it reviewed and integrated. A correct worker delivery does not by itself prove the host met these responsibilities. Reuse the current task record; no additional approval ceremony or unrelated test is required.

To confirm that the worker actually used a selected skill or LSP operation, inspect that attempt's trajectory or Web tool activity. `workflow`, `tools`, `doctor`, and successful skill discovery alone do not prove model usage. A wait timeout does not cancel work, and the skill does not automatically wake an inactive host.

## Maintain your personal version

After upgrading or relocating dsh-worker, verify the CLI and rediscover the bundled instructions with `skill`; update local connection references when necessary. Keep the reusable template and this guide in shared source control, and keep personal generated paths, controller state and credentials outside it. Your personal methods can evolve independently, while the controller's assignment, snapshot, verification and acceptance contracts remain authoritative.

An upgrade does not replace an already installed personal skill. Within an authorized guidance update, compare the installed skill with the current template, carry over the coordination reference and its entry links, and preserve local connection settings, selected methods and model preferences. Existing installations may name their connection reference differently; preserve that name rather than creating a conflicting setup file. Check references and scenario behavior again. Editing this host-only guidance does not require restarting the worker service or adding it to `workflow.json`; subsequent host use must load the updated text, and an already active task must explicitly incorporate the changed decisions.
