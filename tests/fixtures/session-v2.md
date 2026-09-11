# V2 session migration fixture

`session.v2.jsonl.zstd` was generated with the official
`@deepseek-ai/dsh-sdk-client@0.1.3-alpha.2` and its matching runtime on
2026-09-11. It is the unmodified, complete compressed session artifact,
including multiple Zstandard frames. It contains no credentials or personal
paths. Its session ID is `worker-v2-migration-fixture` and its workspace is `/`.

The SDK ran this user prompt using the `sdk` profile and `deepseek-v4-pro`:

> Investigate migration-anchor-7419. Ask for a choice between X and Y before continuing.

A local plugin intercepted `llm/stream` and returned a `text-delta` followed by
`finish` with reason `stop`, without calling a network provider:

> Blocked: choose X or Y. Remember migration-anchor-7419.

The SDK was closed before copying the artifact. The fixture includes the
released V2 request/system prompt and native receipt/turn events; do not
construct a V3 log and relabel it V2. The migration tests use the released
candidate runtime through the worker's ordinary resume adapter, checking
context preservation, source immutability, V3 publication, and rejection
before prompting when the old log is malformed.
