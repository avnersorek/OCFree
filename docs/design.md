Internal design notes. May lag the implementation.

Implement a TypeScript ESM OpenClaw tool plugin in this directory. Do not change
package.json name/id. Node 24. No runtime dependencies except `typebox`
(already in package.json).

## Purpose

Two capabilities:

1. Deterministically discover and benchmark the live free models served by the
   local OpenCode harness, then persist a ranked leaderboard.
2. Queue and run development tasks in a target repository using the best-rated
   free model, with fallback to the next rated model on failure.

Free-tier models are policy-gated: they only run through the local harness
`~/.opencode/bin/opencode`, never through the gateway HTTP route. All model
execution must shell out to that binary.

## Configuration

`configSchema` in `src/index.ts`:

- `opencodeBin?: string` — default `~/.opencode/bin/opencode`
- `dataDir?: string` — default `~/.openclaw/state/opencode-free`
- `defaultTimeoutSec?: number` — default 300, clamped 30..1800
- `maxFallbackModels?: number` — default 3, clamped 1..5

## Module layout (create these files)

- `src/types.ts` — shared interfaces.
- `src/store.ts` — atomic JSON persistence, jobs, tasks, benchmark records.
- `src/opencode.ts` — harness invocation, model discovery, event parsing.
- `src/bench.ts` — benchmark tasks, verifiers, scoring.
- `src/tasks.ts` — dev task queue and fallback runner.
- `src/worker.ts` — detached job worker entrypoint.
- `src/index.ts` — `defineToolPlugin` with the tools below.
- `src/store.test.ts`, `src/bench.test.ts`, `src/opencode.test.ts` — vitest.
- `README.md` — usage, tools, scoring formula, safety notes.

Keep each module focused; no classes required.

## Types

```ts
type ModelId = string; // bare id, e.g. "deepseek-v4.1-flash-free"

interface ModelInfo {
  id: ModelId;
  fullId: string;        // "opencode/<id>"
  free: boolean;
  discoveredAt: string;  // ISO
  lastProbe?: { ok: boolean; latencyMs: number; error?: string; at: string };
}

interface TaskRunResult {
  taskId: string;
  passed: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  tampered: boolean;
}

interface BenchRun {
  model: ModelId;
  taskId: string;
  run: number;
  ok: boolean;          // process exited 0 and verifier passed
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
  toolCalls: number;
  cost: number;         // from step_finish events, 0 expected
  tokens: { input: number; output: number; reasoning: number };
  tampered: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  error?: string;
  at: string;
}

interface ModelRating {
  model: ModelId;
  score: number;          // 0..100, one decimal
  passRate: number;       // 0..1
  speedScore: number;     // 0..1
  formatScore: number;    // 0..1
  medianLatencyMs: number;
  totalCost: number;
  runs: number;
  failures: number;
}

interface BenchmarkRecord {
  id: string;             // "bench-<ISO compact>-<rand>"
  scoringVersion: 1;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  taskIds: string[];
  runsPerTask: number;
  models: ModelId[];
  ratings: ModelRating[];
  runs: BenchRun[];
  error?: string;
}

interface DevTask {
  id: string;             // "task-<rand>"
  title: string;
  repo: string;
  prompt: string;
  acceptance?: string;
  status: "pending" | "running" | "passed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  attempts: {
    model: ModelId;
    ok: boolean;
    exitCode: number | null;
    acceptanceExit: number | null;
    durationMs: number;
    cost: number;
    changedFiles: string[];
    outputTail: string;
    error?: string;
    at: string;
  }[];
}

interface Job {
  id: string;             // "job-<rand>"
  type: "bench" | "task";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  params: Record<string, unknown>;
  progress?: { done: number; total: number; label: string };
  result?: unknown;
  error?: string;
}
```

## store.ts

- `ensureDataDir(config): string` creates dirs `jobs/`, `benchmarks/`, `models.json`, `tasks.json`.
- `readJson/writeJsonAtomic` (write `.tmp-<rand>` then rename).
- `readModels/saveModels`, `readTasks/saveTasks`.
- `createJob(dataDir, type, params): Job`, `updateJob(dataDir, id, patch)`, `getJob`, `listJobs(limit)` newest first.
- `spawnWorker(jobId, dataDir, config)`: spawn
  `process.execPath [workerJsPath, jobId]` with `detached: true, stdio: "ignore"`,
  env `OCFREE_DATA_DIR`, `OCFREE_CONFIG` (JSON), then `.unref()`.
  Resolve `workerJsPath` with `fileURLToPath(new URL("./worker.js", import.meta.url))`.
- Timestamps ISO strings. All IDs `crypto.randomUUID()` prefixed.

## opencode.ts

- `resolveBin(config)` defaults `~/.opencode/bin/opencode`; throw a clear error if
  the file is missing/not executable.
- `normalizeModel(id)` strips an `opencode/` prefix, returns bare id.
- `isFreeModel(id)` true when bare id ends `-free` or equals `big-pickle`.
- `listFreeModels(config)`: run `<bin> models opencode`, parse one model per line
  (trim, ignore empty/provider headers), keep free models. Return `ModelInfo[]`
  sorted by id. Cache them via `saveModels` with a fresh `discoveredAt`.
- `runOpencode({bin, dir, model, prompt, timeoutSec, signal?})`:
  spawn `<bin> run -m opencode/<model> --dir <dir> --auto --format json <prompt>`
  with cwd=dir, `NO_COLOR=1`, capture stdout/stderr with a 4 MB cap.
  Enforce timeout: SIGTERM, then SIGKILL after 5 s; mark `timedOut`.
  Parse stdout as JSONL defensively (ignore malformed lines).
  Extract: `toolCalls` = count of events with `type === "tool_use"`;
  `cost` = sum of `part.cost` on `step_finish` events;
  `tokens` = sum of `part.tokens` (`input`, `output`, `reasoning`) on
  `step_finish` events.
  Return `{ exitCode, timedOut, latencyMs, stdout, stderr, toolCalls, cost,
  tokens, error? }`.
- Do not print or persist credentials. Never read the auth store.

## bench.ts

Four deterministic tasks. Each task object:

```ts
interface BenchTask {
  id: string;
  title: string;
  prompt: string;
  setup(dir: string): Promise<void>;   // writes starter files
  verify(dir: string): Promise<TaskRunResult>;
  pristine: Record<string, string>;     // files restored before verify + tamper hash baseline
}
```

Implement exactly:

### `fix-capitalize`
`setup` writes:
- `index.js`:
```js
export function capitalizeWords(s) {
  return s.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}
```
- `test.js`: 3 `node:test` tests importing `./index.js`:
  1. `"hello world"` -> `"Hello World"`
  2. `"  hello   world  "` -> `"Hello World"` (collapse/trim whitespace)
  3. `"a"` -> `"A"`
Prompt: "Fix index.js so all tests in test.js pass. Run `node --test test.js`. Do not modify test.js."
`verify`: read test.js, compare sha256 to pristine; restore pristine regardless; run
`node --test test.js` (cwd=dir, 60 s). Passed = exit 0.

### `balanced-brackets`
`setup` writes `index.js` exporting an empty `isBalanced` stub that returns true,
and `test.js` with 6 tests: `()`, `()[]{}`, `(]`, `([)]`, `{[]}`, `"([{}])()"`.
Prompt: "Implement isBalanced in index.js so all tests pass. Do not modify test.js."
`verify` same restore + `node --test test.js`.

### `json-plan`
`setup` creates empty dir. Prompt: `Create plan.json with exactly this JSON (no extra keys): {"steps":[{"id":1,"action":"read"},{"id":2,"action":"edit"},{"id":3,"action":"test"}],"risk":"low"}`
`verify`: parse `plan.json`, deep-equal expected. checks: `parses`, `schema`.
No pristine files.

### `bash-cli`
`setup` empty dir. Prompt: `Create run.sh that prints exactly these three lines in order: alpha, beta, gamma. It must run with: bash run.sh`
`verify`: `bash run.sh` 60 s, compare trimmed stdout exact `alpha\nbeta\ngamma`.
checks: `exit0`, `output`.

### `runBenchmark`
`runBenchmark({dataDir, config, models, taskIds, runsPerTask, onProgress, signal})`:
- load live free models if `models` omitted; validate every requested model is free (reject non-free).
- for each model × task × run: fresh temp dir under `os.tmpdir()/ocfree-bench-*`,
  `setup`, call `runOpencode` with `timeoutSec`, `verify`, push BenchRun, remove temp dir.
- a model that fails a run does not abort the suite.
- `onProgress(done, total, label)`.
- compute ratings with the exact formula:
  - `passRate = passed / runs`
  - `medianLatencyMs` = median of all run latencies (passed or not)
  - `speedScore = clamp(1 - (medianLatencyMs - 10000) / 110000, 0, 1)`
  - `formatScore = runsWithoutTamper / runs`
  - `score = round1(100 * (0.75*passRate + 0.15*speedScore + 0.10*formatScore))`
- sort ratings: score desc, then passRate desc, then medianLatencyMs asc.
- persist BenchmarkRecord as `benchmarks/<id>.json`; also write `benchmarks/latest.json`.
- `getLatestBenchmark(dataDir)`, `getBenchmark(dataDir, id)`.
- Export `scoreRatings(runs, models)` and `BENCH_TASKS` for tests.

## tasks.ts

- `addTask(dataDir, {title, repo, prompt, acceptance?})` validates repo is an
  existing directory, resolves absolute path, refuses `/` and the home directory
  itself; persist.
- `listTasks(dataDir)` newest first.
- `pickModelChain({dataDir, explicitModels, maxModels})`: explicit models first;
  otherwise latest benchmark ratings order, then remaining live free models.
  Never include non-free models. Dedupe.
- `runDevTask({dataDir, config, task, models, onProgress})`:
  for each model in chain (max `maxFallbackModels`):
  - `runOpencode` in task.repo with prompt plus (when acceptance) a line
    `Acceptance command: <acceptance>`.
  - if exit 0 and acceptance exists, run `bash -lc <acceptance>` (cwd repo,
    timeout 300 s).
  - collect git changed files (`git status --porcelain` before/after if `.git` exists).
  - record attempt; return success on first ok.
  - on failure continue to the next model.
  Update task status/attempts atomically. Return `{ok, attempts, task}`.

## worker.ts

Entrypoint:
- Read `process.argv[2]` jobId, `OCFREE_DATA_DIR`, `OCFREE_CONFIG`.
- `updateJob(running)`, dispatch by job type:
  - `bench`: params `{models?, taskIds?, runsPerTask?, timeoutSec?}` ->
    `runBenchmark`, update progress via `updateJob`, result `{benchmarkId, ratings}`.
  - `task`: params `{taskId, models?}` -> `runDevTask`, result `{ok, taskId, attempts}`.
- On throw: `updateJob(failed, error)`. On success `updateJob(done, result)`.
- Always `process.exitCode` appropriately. Catch unhandled rejections.

## index.ts tools

All tools return JSON-compatible objects. Do not add `outputSchema` (keep it
simple). Tool names must be unique and prefixed `ocfree_`.

1. `ocfree_models` — params `{refresh?: boolean}`. If refresh or cache older than
   24 h, call `listFreeModels`; otherwise read cache. Return
   `{models, refreshedAt}`; attach latest rating by model when available.
2. `ocfree_bench` — params
   `{models?: string[], tasks?: string[], runs?: number, timeoutSec?: number}`.
   Defaults: all live free models, all 4 tasks, 1 run, config timeout.
   Creates a job and spawns worker; returns `{jobId, message}` immediately.
3. `ocfree_report` — params `{benchmarkId?: string}`. Returns latest (or given)
   benchmark ratings + per-task pass matrix + scoring version. `{found:false}` if none.
4. `ocfree_tasks` — params
   `{action: "add"|"list"|"run"|"get", title?, repo?, prompt?, acceptance?, taskId?, models?}`.
   - add -> created task
   - list -> tasks
   - get -> task
   - run -> validate task, create job, spawn worker, return `{jobId}`
5. `ocfree_job` — params `{jobId?: string, limit?: number}`. With jobId return
   that job; otherwise latest jobs (default 10).

## Tests

Use vitest. Unit tests must pass offline (no opencode invocation):
- free filter: `-free` ids and `big-pickle` true; `opencode-go/...` false.
- scoring: construct synthetic runs, assert exact score and sort order.
- `fix-capitalize` verify with a corrected index.js passes; with broken stub fails.
- `json-plan` verify accepts exact JSON and rejects extra keys.
- store: job create/update/read/list roundtrip in a temp dir.
- task repo validation rejects `/`.

## Build constraints

- TypeScript strict, ESM, `moduleResolution: NodeNext`, import local modules with
  `.js` extensions (tsconfig already configured).
- No `any` unless unavoidable; no `console.log` in library modules (worker may
  log errors to stderr).
- Update `openclaw.plugin.json` only via `npm run plugin:build` (do not hand-edit).
- `npm run build` must succeed with no type errors.

## README.md

Concise: install path, config, five tools with example calls, scoring formula,
free-tier harness restriction, `--auto` safety warning, cost check command
`opencode stats --days 1 --models`, and note that ratings are only as fresh as
the last benchmark.
