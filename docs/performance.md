# Performance experiments

The benchmark uses a disposable real Git repository with 5,000 small tracked files, one changed file and a real controller-owned worktree. It does not dispatch a model or touch a running service. Run it from a source checkout with dependencies installed and the baseline commit in local Git history:

```sh
npm run benchmark -- --baseline e3757cb --files 5000 --samples 7
```

Use `npx tsx scripts/benchmark.ts` with the same arguments when redirecting output to a JSON file. `--baseline` loads the Git collector from that local commit and bundles it against the current shared utilities; those utilities must remain behaviorally unchanged for this comparison. The script compares both collectors on the same worktree, warms each case once, rotates case order, and records every sample plus median/p95 wall time, Git subprocess wall time and call counts. Each sample must produce the exact same snapshot digest as the reference. Use a retained local commit; baseline code is executed as part of this development experiment.

Three cases isolate retained costs:

- **exact** hashes all files with no file cache, matching acceptance-time collection.
- **cached** reuses unchanged inode/metadata hashes, matching repeated background checks without the HTTP result cache.
- **evidence** hashes all files and writes immutable evidence. Its measured samples use already-created blobs/snapshots; the initial write is warm-up, not part of the reported write cost.

The filesystem is warm. This is a local snapshot microbenchmark, not a cold-disk, network-filesystem, real-provider or concurrent-production throughput test. Git wall time includes child work and spawn/wait overhead. Run benchmarks separately from builds and tests; absolute timings vary with host load. A counter reduction alone is not evidence of a latency improvement.

## Ablations and decisions

The baseline is `e3757cb6ecf0c8809809f78dcfbfd7c2d7c78985`, before this optimization. Incremental experiments remove one source of redundant work at a time: duplicate Git ownership-directory queries, duplicate index/metadata reads, and separate changed-path/patch diff queries. The first two cumulative experiments reduced exact-snapshot median latency by 3.6% and 5.7%, respectively, against the baseline interleaved in each run. Fusing the diff reads gave the largest additional improvement. These exploratory runs used seven samples per case; their absolute times should not be compared across runs because host load varied.

The final paired run used 11 samples per case on Node 24.18.0 / macOS arm64:

| Case              | Baseline median / p95 | Optimized median / p95 | Median reduction |
| ----------------- | --------------------- | ---------------------- | ---------------- |
| Exact snapshot    | 457.63 / 497.14 ms    | 324.86 / 378.48 ms     | 29.0%            |
| Cached snapshot   | 389.90 / 425.81 ms    | 249.88 / 260.30 ms     | 35.9%            |
| Existing evidence | 467.90 / 486.93 ms    | 320.22 / 338.79 ms     | 31.6%            |

Git invocations fell from 14 to 10 per capture. The optimized exact case spent a median 204.02 ms in Git subprocesses, versus 339.60 ms at baseline. Removing the file-hash cache increased optimized repeated-read latency from 249.88 to 324.86 ms, so the cache was retained. All 66 measured snapshots and warm-ups matched the same digest. [Raw samples and source identities](performance-results.json) accompany this record.

Cleanup removes four internal re-export shims, three unused direct dependency declarations, the obsolete migration guide and superseded verification narratives. Those three packages remain transitive SDK dependencies; this is dependency-ownership cleanup, not a claim of a smaller installed dependency tree. The old standalone runtime smoke script was removed after its unique resolved-profile checks moved into the normal doctor test suite.

Changed paths and patches use Git's documented [raw diff format](https://git-scm.com/docs/git-diff#_raw_output_format), with NUL-delimited names. Rename/copy destinations, tabs/newlines, unmerged entries and binary patches have regression coverage. Actual file contents, index state, symlinks, ownership and immutable baseline evidence are still checked; no acceptance guard is disabled by a benchmark mode.

The file-hash cache remains because the exact-versus-cached ablation demonstrates its benefit. Existing asynchronous polling, compact transport records and change-only process journaling also remain; their behavior is covered by the 5,000-file/event-loop and repeated-process-report regressions. These are not removed merely to reduce source length.
