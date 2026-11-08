import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  ensureDataDir,
  createJob,
  getJob,
  listJobs,
  readModels,
  resolveConfig,
  spawnWorker,
  updateJob,
} from "./store.js";
import { isFreeModel, listFreeModels, normalizeModel } from "./opencode.js";
import {
  BENCH_TASKS,
  getBenchmark,
  getBestBenchmark,
  getLatestBenchmark,
} from "./bench.js";
import { addTask, getTask, listTasks } from "./tasks.js";
import type { BenchmarkRecord, ModelInfo, ModelRating } from "./types.js";
import {
  loadOnlineRatings,
  onlineRatingFor,
  rankModelsByOnline,
  refreshOnlineRatings,
} from "./online.js";

const ConfigSchema = Type.Object({
  opencodeBin: Type.Optional(
    Type.String({
      description:
        "Path to the local OpenCode harness binary. Defaults to ~/.opencode/bin/opencode.",
    }),
  ),
  dataDir: Type.Optional(
    Type.String({
      description:
        "Directory for state, jobs, tasks, and benchmarks. Defaults to ~/.openclaw/state/ocfree.",
    }),
  ),
  defaultTimeoutSec: Type.Optional(
    Type.Number({
      description:
        "Default per-run timeout in seconds (clamped 30..1800). Defaults to 300.",
    }),
  ),
  maxFallbackModels: Type.Optional(
    Type.Number({
      description:
        "Maximum models to try per dev task (clamped 1..5). Defaults to 3.",
    }),
  ),
  onlineRatingsUrl: Type.Optional(
    Type.String({
      description:
        "Optional JSON URL for an online ratings registry. Defaults to BenchLM coding + SWE Atlas seed.",
    }),
  ),
  allowedRepoRoots: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Directories that may contain task repositories. Repositories are resolved through fs.realpath and must stay inside one of these roots. Defaults to [\"~/.openclaw/workspace\"].",
    }),
  ),
});

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function newestIso(models: ModelInfo[]): string | null {
  let newest: string | null = null;
  for (const model of models) {
    if (newest === null || model.discoveredAt > newest) {
      newest = model.discoveredAt;
    }
  }
  return newest;
}

function cacheIsFresh(models: ModelInfo[]): boolean {
  const newest = newestIso(models);
  if (!newest) return false;
  const timestamp = Date.parse(newest);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp < CACHE_MAX_AGE_MS;
}

function withRatings(
  models: ModelInfo[],
  ratings: ModelRating[],
): (ModelInfo & { rating?: ModelRating })[] {
  const byModel = new Map(ratings.map((rating) => [rating.model, rating]));
  return models.map((model) => {
    const rating = byModel.get(model.id);
    return { ...model, ...(rating ? { rating } : {}) };
  });
}

async function isWorkerForJob(pid: number, jobId: string): Promise<boolean> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("worker.js") && cmdline.includes(jobId);
  } catch {
    return false;
  }
}

function uniqueFreeModels(models: string[]): string[] {
  const normalized = [...new Set(models.map(normalizeModel))];
  const rejected = normalized.filter((model) => !isFreeModel(model));
  if (rejected.length > 0) {
    throw new Error(`Refusing non-free models: ${rejected.join(", ")}`);
  }
  return normalized;
}

function passMatrix(benchmark: BenchmarkRecord): {
  model: string;
  tasks: Record<string, { passed: number; runs: number; passRate: number }>;
}[] {
  return benchmark.models.map((model) => {
    const tasks: Record<
      string,
      { passed: number; runs: number; passRate: number }
    > = {};
    for (const taskId of benchmark.taskIds) {
      const runs = benchmark.runs.filter(
        (run) => run.model === model && run.taskId === taskId,
      );
      const passed = runs.filter((run) => run.ok).length;
      tasks[taskId] = {
        passed,
        runs: runs.length,
        passRate: runs.length > 0 ? passed / runs.length : 0,
      };
    }
    return { model, tasks };
  });
}

export default defineToolPlugin({
  id: "ocfree",
  name: "OCFree",
  description:
    "Benchmark free OpenCode models and run repo development tasks with fallback.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "ocfree_models",
      description:
        "List free OpenCode models discovered from the local harness, refreshed when the cache is stale.",
      parameters: Type.Object({
        refresh: Type.Optional(
          Type.Boolean({ description: "Force a live model refresh." }),
        ),
      }),
      execute: async ({ refresh }, config) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);
        let models = await readModels(dataDir);
        if (refresh === true || !cacheIsFresh(models)) {
          models = await listFreeModels(resolved);
        }
        const latest = await getBestBenchmark(dataDir);
        const online = await loadOnlineRatings(dataDir);
        const rated = withRatings(models, latest?.ratings ?? []);
        return {
          models: rated.map((model) => ({
            ...model,
            online: onlineRatingFor(model.id, online) ?? null,
          })),
          refreshedAt: newestIso(models),
          onlineSource: online.source,
          onlineUpdatedAt: online.updatedAt,
        };
      },
    }),

    tool({
      name: "ocfree_bench",
      description:
        "Start a background benchmark of free OpenCode models against the deterministic task suite.",
      parameters: Type.Object({
        models: Type.Optional(
          Type.Array(Type.String(), {
            description: "Free model ids to benchmark. Defaults to all live free models.",
          }),
        ),
        tasks: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Benchmark task ids. Defaults to all six tasks: fix-capitalize, balanced-brackets, json-plan, bash-cli, csv-parse, lru-cache.",
          }),
        ),
        runs: Type.Optional(
          Type.Number({ description: "Runs per task. Defaults to 1." }),
        ),
        timeoutSec: Type.Optional(
          Type.Number({
            description: "Per-run timeout in seconds. Defaults to the plugin timeout.",
          }),
        ),
      }),
      execute: async ({ models, tasks, runs, timeoutSec }, config) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);
        const knownTasks = new Set(BENCH_TASKS.map((task) => task.id));
        if (tasks) {
          const unknown = tasks.filter((taskId) => !knownTasks.has(taskId));
          if (unknown.length > 0) {
            throw new Error(`Unknown benchmark tasks: ${unknown.join(", ")}`);
          }
        }
        const params: Record<string, unknown> = {
          taskIds: tasks ?? [...knownTasks],
          runsPerTask: Math.min(5, Math.max(1, Math.round(runs ?? 1))),
          timeoutSec: timeoutSec ?? resolved.defaultTimeoutSec,
        };
        if (models !== undefined) params.models = uniqueFreeModels(models);
        const job = await createJob(dataDir, "bench", params);
        const pid = spawnWorker(job.id, dataDir, resolved);
        if (pid) await updateJob(dataDir, job.id, { workerPid: pid });
        return {
          jobId: job.id,
          message: `Benchmark queued as ${job.id}. Check progress with ocfree_job.`,
        };
      },
    }),

    tool({
      name: "ocfree_report",
      description:
        "Show the latest benchmark leaderboard, per-task pass matrix, and scoring version.",
      parameters: Type.Object({
        benchmarkId: Type.Optional(
          Type.String({ description: "Specific benchmark id. Defaults to latest." }),
        ),
      }),
      execute: async ({ benchmarkId }, config) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);
        const benchmark = benchmarkId
          ? await getBenchmark(dataDir, benchmarkId)
          : await getLatestBenchmark(dataDir);
        if (!benchmark) return { found: false };
        const online = await loadOnlineRatings(dataDir);
        return {
          found: true,
          benchmarkId: benchmark.id,
          scoringVersion: benchmark.scoringVersion,
          status: benchmark.status,
          startedAt: benchmark.startedAt,
          finishedAt: benchmark.finishedAt,
          models: benchmark.models,
          taskIds: benchmark.taskIds,
          ratings: benchmark.ratings,
          qualityOrder: rankModelsByOnline(
            benchmark.models,
            online,
            benchmark.ratings,
          ),
          online: benchmark.models.map((model) => ({
            model,
            rating: onlineRatingFor(model, online) ?? null,
          })),
          passMatrix: passMatrix(benchmark),
        };
      },
    }),

    tool({
      name: "ocfree_online",
      description:
        "Show or refresh the online quality ratings used for quality-first model selection.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("refresh")], {
          description: "List cached ratings or refresh them.",
        }),
        url: Type.Optional(
          Type.String({
            description:
              "Optional JSON ratings URL. Defaults to the plugin config, then BenchLM coding.",
          }),
        ),
      }),
      execute: async ({ action, url }, config) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);
        const targetUrl = url ?? config.onlineRatingsUrl;
        const online =
          action === "refresh"
            ? await refreshOnlineRatings({
                dataDir,
                ...(targetUrl ? { url: targetUrl } : {}),
              })
            : await loadOnlineRatings(dataDir);
        return {
          updatedAt: online.updatedAt,
          source: online.source,
          models: online.models,
        };
      },
    }),

    tool({
      name: "ocfree_tasks",
      description:
        "Add, list, get, or run development tasks in target repositories using free models with fallback.",
      parameters: Type.Object({
        action: Type.Union(
          [
            Type.Literal("add"),
            Type.Literal("list"),
            Type.Literal("run"),
            Type.Literal("get"),
          ],
          { description: "Task operation to perform." },
        ),
        title: Type.Optional(Type.String({ description: "Task title (add)." })),
        repo: Type.Optional(
          Type.String({ description: "Absolute or ~-relative repository path (add)." }),
        ),
        prompt: Type.Optional(
          Type.String({ description: "Instructions for the coding model (add)." }),
        ),
        acceptance: Type.Optional(
          Type.String({
            description: "Optional acceptance command run with bash -lc (add).",
          }),
        ),
        taskId: Type.Optional(
          Type.String({ description: "Task id (get/run)." }),
        ),
        models: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional free model override chain (run).",
          }),
        ),
        resume: Type.Optional(
          Type.Boolean({
            description:
              "Resume the task's last session for the chosen model instead of starting fresh (run).",
          }),
        ),
        confirm: Type.Optional(
          Type.Boolean({
            description:
              "Required to run a task that has an acceptance command, because acceptance commands execute through bash -lc.",
          }),
        ),
      }),
      execute: async (
        { action, title, repo, prompt, acceptance, taskId, models, resume, confirm },
        config,
      ) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);

        if (action === "add") {
          if (!title || !repo || !prompt) {
            throw new Error("add requires title, repo, and prompt");
          }
          return addTask(
            dataDir,
            {
              title,
              repo,
              prompt,
              ...(acceptance ? { acceptance } : {}),
            },
            resolved,
          );
        }

        if (action === "list") {
          return { tasks: await listTasks(dataDir) };
        }

        if (action === "get") {
          if (!taskId) throw new Error("get requires taskId");
          const task = await getTask(dataDir, taskId);
          return task ?? { found: false };
        }

        if (!taskId) throw new Error("run requires taskId");
        const task = await getTask(dataDir, taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.acceptance && confirm !== true) {
          throw new Error(
            `Task ${taskId} has an acceptance command that runs through bash -lc. ` +
              "Re-run with confirm: true after reviewing the command and repository.",
          );
        }
        const chain = models !== undefined ? uniqueFreeModels(models) : undefined;
        const job = await createJob(dataDir, "task", {
          taskId,
          ...(chain !== undefined ? { models: chain } : {}),
          ...(resume === true ? { resume: true } : {}),
        });
        const pid = spawnWorker(job.id, dataDir, resolved);
        if (pid) await updateJob(dataDir, job.id, { workerPid: pid });
        return {
          jobId: job.id,
          taskId,
          message: `Task queued as ${job.id}. Check progress with ocfree_job.`,
        };
      },
    }),

    tool({
      name: "ocfree_job",
      description:
        "Get a background job by id, or list the most recent jobs.",
      parameters: Type.Object({
        jobId: Type.Optional(
          Type.String({ description: "Job id to inspect." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Number of recent jobs to list. Defaults to 10." }),
        ),
        cancel: Type.Optional(
          Type.Boolean({
            description: "Cancel a running or queued job before returning it.",
          }),
        ),
      }),
      execute: async ({ jobId, limit, cancel }, config) => {
        const resolved = resolveConfig(config);
        const dataDir = await ensureDataDir(resolved);
        if (jobId) {
          const job = await getJob(dataDir, jobId);
          if (!job) return { found: false };
          const active = job.status === "running" || job.status === "queued";
          const staleMs = Math.max(
            10 * 60_000,
            resolved.defaultTimeoutSec * 2_000 + 5 * 60_000,
          );
          if (
            active &&
            Date.now() - Date.parse(job.updatedAt) > staleMs
          ) {
            return (
              (await updateJob(dataDir, jobId, {
                status: "failed",
                error: "stale job: worker stopped updating progress",
              })) ?? job
            );
          }
          if (cancel === true && active) {
            if (job.workerPid) {
              if (!(await isWorkerForJob(job.workerPid, job.id))) {
                return {
                  ...job,
                  cancelled: false,
                  cancelRefused: `Refusing to cancel ${job.id}: process ${job.workerPid} could not be verified as its worker.`,
                };
              }
              try {
                process.kill(-job.workerPid, "SIGTERM");
              } catch {
                try {
                  process.kill(job.workerPid, "SIGTERM");
                } catch {
                  // Already exited.
                }
              }
            }
            return (
              (await updateJob(dataDir, jobId, {
                status: "cancelled",
                error: "cancelled by operator",
              })) ?? job
            );
          }
          return job;
        }
        const count = Math.min(100, Math.max(1, Math.round(limit ?? 10)));
        return { jobs: await listJobs(dataDir, count) };
      },
    }),
  ],
});
