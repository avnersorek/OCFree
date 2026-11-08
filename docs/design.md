# OCFree design notes

Internal notes. May lag the implementation.

## Purpose

OCFree discovers the free models exposed by a local OpenCode harness, checks that
they actually work, ranks them by online coding quality, and runs repository
development tasks with fallback.

There is no local coding suite. Quality comes from online ratings; the canary is
only an availability check.

## Components

- `opencode.ts` — harness discovery, version detection, CLI invocation, JSONL
  parsing, cost/token/session capture.
- `online.ts` — online ratings registry, BenchLM parser, quality-first ordering.
- `canary.ts` — file-writing canary per model, persisted in `canary.json`.
- `tasks.ts` — task storage, repository allowlist, model chain, task execution,
  acceptance command, session resume.
- `store.ts` — data directory, atomic JSON state, background job store.
- `worker.ts` — detached job runner for canary and task jobs.
- `index.ts` — OpenClaw tool registration.

## Selection

1. Rated models before unrated models.
2. Higher online score first.
3. Source rank, then model id, for ties.
4. Models that failed the most recent canary are skipped when alternatives exist;
   if every candidate failed, the full chain is still tried.

Speed is not a ranking signal.

## State

Under `dataDir`:

- `models.json` — discovered free models.
- `online-ratings.json` — online ratings cache.
- `canary.json` — latest canary results.
- `tasks.json` — development tasks and attempts.
- `jobs/` — queued/running/completed job records.

## Safety

- Tasks are restricted to `allowedRepoRoots` and resolved through `fs.realpath`.
- Acceptance commands require `confirm: true`.
- Worker cancellation verifies `/proc/<pid>/cmdline` before signaling.
- OpenCode runs with `--auto`; treat every task as code execution with the
  user's privileges.
