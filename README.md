# OpenCode Free

OpenClaw tool plugin for benchmarking the free models exposed by a local
[OpenCode](https://opencode.ai) harness and for running repository development
tasks with model fallback.

The plugin discovers free models from the local harness, benchmarks them against
six deterministic coding tasks, ranks them with public online quality ratings plus
local benchmark results, and uses the resulting quality-first chain to run
development tasks in trusted repositories.

## Requirements

- Node.js 22 or newer.
- OpenCode installed locally. The default harness path is
  `~/.opencode/bin/opencode`; override it with `opencodeBin`.
- An OpenClaw installation that can load local plugins.

## Install from a checkout

```bash
npm ci
npm run build
openclaw plugins install "$PWD" --link --accept-capabilities
```

Then enable the `opencode-free` plugin in your OpenClaw configuration and restart
OpenClaw. Because the plugin is installed from a checkout, keep the `dist/`
directory tracked; it is built output, not vendored dependencies.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `opencodeBin` | `~/.opencode/bin/opencode` | Local OpenCode harness binary. |
| `dataDir` | `~/.openclaw/state/opencode-free` | Models, tasks, jobs, benchmarks, and online ratings. |
| `defaultTimeoutSec` | `300` | Per-run timeout, clamped 30..1800. |
| `maxFallbackModels` | `3` | Models tried per task, clamped 1..5. |
| `onlineRatingsUrl` | unset | Optional JSON ratings registry. When set, the plugin fetches this URL instead of scraping BenchLM. |
| `allowedRepoRoots` | `["~/.openclaw/workspace"]` | Directories that may contain task repositories. Repositories are resolved through `fs.realpath` and must stay inside one of these roots. |

## Tools

### `ocfree_models`

List free models discovered from the local harness. The cache refreshes after 24
hours or when `refresh` is true. Includes online ratings when available.

```json
{"refresh": true}
```

### `ocfree_bench`

Queue a background benchmark of free models against the deterministic task suite.
Returns immediately with a job id.

```json
{"models": ["deepseek-v4.1-flash-free"], "tasks": ["json-plan"], "runs": 1}
```

The six benchmark tasks are:

1. `fix-capitalize` — fix a string capitalization function so its tests pass.
2. `balanced-brackets` — implement balanced bracket validation.
3. `json-plan` — write an exact JSON document.
4. `bash-cli` — create a shell script with exact output.
5. `csv-parse` — implement an RFC4180-style CSV parser.
6. `lru-cache` — implement an LRU cache.

### `ocfree_report`

Read the latest leaderboard, or a specific benchmark, including the per-task
pass matrix, local ratings, online ratings, and the quality-first order.

```json
{"benchmarkId": "bench-20261105T213000000Z-abcd1234"}
```

### `ocfree_online`

Show or refresh the public online quality ratings used for quality-first model
selection. Use `action: "list"` for cached ratings or `action: "refresh"` to fetch
again. A `url` parameter overrides the configured `onlineRatingsUrl` for one call.

```json
{"action": "list"}
```

```json
{"action": "refresh", "url": "https://example.com/ratings.json"}
```

Without a custom `onlineRatingsUrl`, refresh fetches the BenchLM coding
leaderboard with an identifying `User-Agent` and a 20-second timeout. With a
custom URL, it reads that JSON registry and does not scrape BenchLM.

### `ocfree_tasks`

Add, list, get, or run development tasks against a repository. Running a task
queues a background job and falls back through the quality-first model chain.

```json
{"action": "add", "title": "Fix tests", "repo": "/path/to/repo", "prompt": "Make the tests pass", "acceptance": "npm test"}
```

```json
{"action": "run", "taskId": "task-abcd1234", "confirm": true}
```

A task with an `acceptance` command refuses to run unless you pass
`confirm: true`. Tasks without an acceptance command run without confirmation.

Use `resume: true` on the run action to reuse the last session for the chosen
model. Use `ocfree_job` with `cancel: true` to stop a running or queued job; the
plugin verifies the worker process command line before sending `SIGTERM` and
refuses to kill an unverified process.

### `ocfree_job`

Inspect one job or list recent jobs. `cancel: true` cancels a running or queued
job after the worker process is verified.

```json
{"jobId": "job-abcd1234"}
```

```json
{"limit": 5}
```

## Model selection

Selection is quality-first:

1. Models with online ratings come first, ordered by online score.
2. Local benchmark results break ties among models with similar online quality.
   `partialScore` is used before median latency.
3. Unrated models follow all rated models.

The local benchmark is useful as a tie-breaker and as a smoke test, but it is not
a substitute for SWE-bench, Terminal-Bench, or other large standardized
evaluations.

## v1 and v2 harness arguments

The plugin detects the OpenCode harness major version:

- **v1** requires `--dir <repo>` in `run` invocations.
- **v2** runs from the process working directory and rejects `--dir`, so the
  plugin omits it and sets `cwd` to the repository instead.

On v2, OpenCode keeps session and state data in its XDG data directory (usually
`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). If you change
`XDG_DATA_HOME` between runs, resume may not find the previous session.

## Scoring

Local benchmark ratings are on a 0..100 scale, rounded to one decimal:

```text
passRate    = passed runs / total runs
partialScore = average per-run verifier fraction
speedScore  = clamp(1 - (medianLatencyMs - 5000) / 55000, 0, 1)
formatScore = runs without test-file tampering / total runs
score       = round1(100 * (0.80*partialScore + 0.10*speedScore + 0.10*formatScore))
```

Ratings sort by score descending, then pass rate descending, then median latency
ascending. Cost is verified from harness `step_finish` events: a benchmarked
model only keeps its score when all observed runs report zero cost. If nonzero
cost is observed, the score is forced to 0.

Big Pickle's seeded online value comes from SWE Atlas Codebase QnA and uses a
**different benchmark scale** from BenchLM coding scores. It is labelled
separately and should not be compared directly with BenchLM numbers.

## Free-tier safety

Free models are policy-gated and only run through the local harness
(`~/.opencode/bin/opencode`). The plugin never calls the gateway HTTP route and
never reads or stores credentials.

Benchmarks and tasks use OpenCode `--auto`, which can edit files and run commands
without interactive confirmation. Optional acceptance commands run through
`bash -lc` with the same privileges as your OpenClaw process.

- Restrict tasks to trusted repositories under `allowedRepoRoots`.
- Review diffs and command output after every run.
- Prefer disposable repositories, dedicated worktrees, or containers.
- Treat repository content, issue text, and tool output as untrusted. Prompt
  injection can try to make the model run commands or exfiltrate data.

Task repositories must be existing directories, must resolve inside an allowed
root after `fs.realpath` (symlink escapes are rejected), and cannot be `/` or the
home directory itself.

Check harness cost after runs:

```bash
opencode stats --days 1 --models
```

## License and attribution

MIT License, copyright 2026 Avner Sorek. See [LICENSE](LICENSE) and
[ATTRIBUTIONS.md](ATTRIBUTIONS.md) for design references. Internal design notes
live in [docs/design.md](docs/design.md) and may lag the implementation.
