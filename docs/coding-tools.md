# Coding tools

Worker attempts use **tgrep** for model-facing `grep` by default, and native Harness LSP navigation for the project's detected languages. These tools are installed/configured independently of worker engineering skills. All CLI and Web dispatches use the same runner configuration. Read-only `tools` inspection does not install software, dispatch a model or modify a task.

## Set up and verify

From a source checkout, build first; an npm installation exposes the same commands as `dsh-worker`:

```sh
npm run build
node dist/cli.js tools install --home /path/to/controller-home
node dist/cli.js tools --home /path/to/controller-home --repo /path/to/repository
node dist/cli.js doctor --home /path/to/controller-home --repo /path/to/repository
```

1. `tools install` downloads tgrep **1.0.4**, verifies its pinned SHA-256 and version, and installs it under the controller home. It supports macOS and Linux on arm64/x64. It does not alter PATH or start a service. Downloads require GitHub connectivity and `tar`; failures leave the previous installation intact. An existing managed installation is reused.
2. `tools --repo` reports the chosen backend, executable paths, versions, detected languages and missing prerequisites. Exit 1 means at least one selected executable failed its check. Use the same controller home and service environment as dispatch.
3. `doctor --repo` initializes the released SDK with the coding plugins and closes it without making a model request. This proves composition and startup, not real language queries or coding success. Plain `doctor` retains its runtime-only check.
4. Start the regular service and run a task. Each attempt records `coding-tools.json` and `coding.patch.json` beside its runtime evidence. The Web trajectory shows `grep` calls labeled tgrep and LSP calls. Merely naming a tool in a prompt does not prove it was called.

TypeScript and `typescript-language-server` ship as npm dependencies; project TypeScript is resolved by the language server when available. Go and Rust need the repository's toolchain plus their language server on the service's PATH (or an explicit command below):

```sh
# Choose a gopls release compatible with the Go toolchain you maintain.
go install golang.org/x/tools/gopls@v0.23.0
# Run with the intended Rust toolchain selected.
rustup component add rust-analyzer
```

The Go binary is normally installed under `GOBIN` or `GOPATH/bin`; make that executable available to the service. A rustup proxy alone does not prove the analyzer component is installed for a repository's selected toolchain. Missing selected tools stop the attempt before a model prompt; install/configure them, then use the normal explicit recovery workflow. There is no automatic retry or dependency installation during execution admission. Preflight and the language-server launcher disable rustup automatic toolchain installation. For non-default toolchain environments, name the required variables (such as CARGO_HOME or GOPATH) in the ticket execution.envRequired so the runner inherits them.

## Optional controller configuration

With no `tools.json`, defaults are `search: tgrep`, `indexed: true`, and `languages: auto`. Auto detection examines tracked and non-ignored untracked source paths in the attempt worktree, including nested projects. Only selected languages are mounted. An empty language list disables LSP. Configuration is read at the start of each attempt and the resolved selection is saved with its evidence; edits affect subsequent attempts.

Create `tools.json` in the controller home when changing defaults:

```json
{
  "schemaVersion": 2,
  "search": "tgrep",
  "indexed": true,
  "languages": ["go", "rust", "typescript"],
  "servers": {
    "go": { "command": "/path/to/gopls" },
    "rust": { "command": "/path/to/rust-analyzer" },
    "typescript": { "args": ["--stdio"] }
  }
}
```

`tgrep` may name an alternative executable. `servers` may override `command`, `args`, `configuration` and `initializationOptions` for each supported language. Commands containing `/` resolve relative to the controller home unless absolute; other commands resolve on the service PATH. Unknown fields fail validation. Keep personal paths outside source control. Set `search: ripgrep` only for an explicit opt-out; tgrep failure never silently changes the default backend to ripgrep. The native `glob` file-discovery tool still uses packaged ripgrep.

Do not put tool selections into `workflow.json`: its schema remains dedicated to skills and instruction files. The worker policy remains the last overlay and still prohibits worker delegation and self-acceptance.

## Search behavior and cost

`grep` accepts a regex `pattern`, optional workspace-contained `path`, and one positive `include` glob. It searches current content, returns relative paths and line numbers, and retains 250 matches inline with bounded line previews. A larger complete result is saved through Harness's spill store when available; otherwise the omission is explicit. Excessive raw output fails and asks for a narrower search. Model values become argv elements, never shell code. Searches have a 60-second cooperative timeout and owned subprocess cleanup.

The worker lazily builds a private on-disk index per attempt. Before reuse it enumerates the live searchable paths and compares file identity, size, mode, and nanosecond modification/change times; it checks again after querying. Changes invalidate the index. An unstable tree or unavailable index uses **tgrep live scanning**. Explicit subpaths and filtered queries use live scanning to preserve traversal/ignore behavior. `indexed: false` always selects tgrep live scanning.

There is no watcher or search daemon, so another worktree cannot supply its live index. The extra filesystem checks and rebuilds cost time; this correctness-oriented implementation does not inherit upstream's warm-daemon benchmark numbers. A search is not an atomic repository snapshot under concurrent external writers. Read matched files before editing; controller snapshot verification remains authoritative. An attempt's index is disposable local runtime data retained with the run directory; current pruning does not remove it automatically.

## Language navigation and verification

LSP supports `goToDefinition`, `findReferences`, `goToImplementation` and `hover`, using one-based UTF-16 cursor positions. It does not add diagnostics, rename or code actions. Servers start lazily, and queries use the attempt worktree. An empty result is not a completeness guarantee. During project loading, Rust may return `content modified`; bounded read-only retries are appropriate, followed by an explicit limitation if the service remains unavailable.

A small stdio launcher preserves the controller's process marker on each language-server child and monitors the exact Harness process identity. Normal shutdown uses native Harness disposal; loss of the owner stops the language server, and controller process cleanup can still discover the marked child. The wrapper does not grant sandbox isolation or replace the SDK model loop.

The worker receives short guidance to prepare dependencies from the project's lockfile and run its focused type/lint/tests after changes. Use repository commands and toolchain settings (Go workspaces/build tags, Rust features/toolchain, TypeScript project references); the tool configuration does not invent verification commands or run installers. Existing controller verification, immutable snapshots and external Spec/Standards decisions still determine acceptance.

## Development checks

The coding-tool integration tests run real executables without provider credentials. In addition to the normal development requirements, install the pinned tgrep above, gopls, and the Rust analyzer/toolchain before `npm run check`. Set `DSH_WORKER_TEST_TGREP` to an explicit test binary path when not using the default controller home. Missing prerequisites fail these tests rather than reporting a skipped test as a pass.

```sh
npm run check
npm run test:package
```

These checks cover real language queries and tool dispatch separately from SDK initialization. They do not measure model task success or token savings. macOS arm64 is the current validation platform; Linux binaries are provided but Linux requires its own runtime evidence.
