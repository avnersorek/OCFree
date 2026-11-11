# OCFree

OpenClaw tool plugin for discovering the free models exposed by a local
[OpenCode](https://opencode.ai) harness, checking that they actually work, and
running repository development tasks with an online-quality-ranked model chain.

Model quality comes from public online ratings. A small canary check proves a
model can run a tool, write a file, and return the expected content; it is only an
availability check, not a score.

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

Enable the `ocfree` plugin in your OpenClaw configuration and restart OpenClaw.
Because the plugin is installed from a checkout, keep the `dist/` directory
tracked; it is built output, not vendored dependencies.

## Quick example

These examples use the tool JSON directly. In an OpenClaw chat you can ask for
the same steps in natural language.

### 1. Discover free models

```json
{"refresh": true}
```

This returns the live free-model roster with online ratings and the latest
canary result for each model.

### 2. Check that a model actually works

```json
{"models": ["deepseek-v4.1-flash-free"]}
```

The call returns a background `jobId`. Poll it with:

```json
{"jobId": "job-abc123"}
```

The result verifies that the model created `probe.txt` with the expected
content. This is an availability check only; it does not affect the online
quality order.

### 3. Add a task

```json
{
  "action": "add",
  "title": "Fix failing tests",
  "repo": "/home/me/src/my-project",
  "prompt": "Run npm test and fix the failures without modifying test files.",
  "acceptance": "npm test"
}
```

The repository must be inside `allowedRepoRoots`. The call returns a `taskId`.

### 4. Run it with the quality-first model chain

```json
{"action": "run", "taskId": "task-abc123", "confirm": true}
```

`confirm` is required because this task has an acceptance command. The call
returns a `jobId`; poll it with `ocfree_job`.

To continue the last session for the selected model:

```json
{
  "action": "run",
  "taskId": "task-abc123",
  "resume": true,
  "confirm": true
}
```

### 5. Refresh online ratings when needed

```json
{"action": "refresh"}
```

This updates the rating registry used for model selection. It does not run any
coding task.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `opencodeBin` | `~/.opencode/bin/opencode` | Local OpenCode harness binary. |
| `dataDir` | `~/.openclaw/state/ocfree` | Models, canary results, tasks, jobs, and online ratings. |
| `defaultTimeoutSec` | `300` | Per-run timeout, clamped 30..1800. |
| `maxFallbackModels` | `3` | Models tried per task, clamped 1..5. |
| `onlineRatingsUrl` | unset | Optional JSON ratings registry. When set, the plugin fetches this URL instead of scraping BenchLM. |
| `allowedRepoRoots` | `["~/.openclaw/workspace"]` | Directories that may contain task repositories. Repositories are resolved through `fs.realpath` and must stay inside one of these roots. |

## Tools

### `ocfree_models`

List free models from the local harness. The cache refreshes after 24 hours or
when `refresh` is true. Each model includes its online rating and its last canary
result when available.

```json
{"refresh": true}
```

### `ocfree_canary`

Queue a background canary check. The canary creates `probe.txt` with the exact
content `ocfree-ok`, then verifies the file. It answers “is this model working?”
and nothing about quality.

```json
{"models": ["deepseek-v4.1-flash-free"]}
```

Omit `models` to check every live free model. Results are stored in
`canary.json` under the data directory.

### `ocfree_online`

Show or refresh the public online quality ratings used for model selection.

```json
{"action": "list"}
```

```json
{"action": "refresh"}
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
model.

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

Selection is quality-first and uses online ratings only:

1. Models with online ratings come first, ordered by online score.
2. Ties use the source rank, then the model id.
3. Unrated models follow all rated models.

A canary result never changes the quality order. It is used only to skip models
that recently failed the availability check; if every candidate failed, the
plugin still tries the full chain.

The online registry is a snapshot plus refresh. It is not a substitute for
running your own task on your own repository; review the model’s output and the
diff.

## v1 and v2 harness arguments

The plugin detects the OpenCode harness major version:

- **v1** requires `--dir <repo>` in `run` invocations.
- **v2** runs from the process working directory and rejects `--dir`, so the
  plugin omits it and sets `cwd` to the repository instead.

On v2, OpenCode keeps session and state data in its XDG data directory (usually
`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). If you change
`XDG_DATA_HOME` between runs, resume may not find the previous session.

## Free-tier safety

Free models are policy-gated and only run through the local harness. The plugin
never calls the gateway HTTP route and never reads or stores credentials.

Canary checks and tasks use OpenCode `--auto`, which can edit files and run
commands without interactive confirmation. Optional acceptance commands run
through `bash -lc` with the same privileges as your OpenClaw process.

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
[ATTRIBUTIONS.md](ATTRIBUTIONS.md). Internal design notes live in
[docs/design.md](docs/design.md) and may lag the implementation.
