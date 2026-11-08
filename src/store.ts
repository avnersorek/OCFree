import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DevTask,
  Job,
  ModelInfo,
  OpenCodeFreeConfig,
  ResolvedConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_FALLBACK = 3;
const DEFAULT_ALLOWED_REPO_ROOT = "~/.openclaw/workspace";

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function resolveConfig(config: OpenCodeFreeConfig): ResolvedConfig {
  return {
    opencodeBin: expandHome(config.opencodeBin ?? "~/.opencode/bin/opencode"),
    dataDir: expandHome(config.dataDir ?? "~/.openclaw/state/opencode-free"),
    defaultTimeoutSec: Math.round(
      clamp(config.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC, 30, 1800),
    ),
    maxFallbackModels: Math.round(
      clamp(config.maxFallbackModels ?? DEFAULT_MAX_FALLBACK, 1, 5),
    ),
    allowedRepoRoots: (
      config.allowedRepoRoots && config.allowedRepoRoots.length > 0
        ? config.allowedRepoRoots
        : [DEFAULT_ALLOWED_REPO_ROOT]
    ).map(expandHome),
  };
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function ensureDataDir(
  config: OpenCodeFreeConfig | ResolvedConfig,
): Promise<string> {
  const dataDir = expandHome(config.dataDir ?? "~/.openclaw/state/opencode-free");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "jobs"), { recursive: true });
  await mkdir(join(dataDir, "benchmarks"), { recursive: true });
  await ensureJsonFile(join(dataDir, "models.json"), []);
  await ensureJsonFile(join(dataDir, "tasks.json"), []);
  return dataDir;
}

async function ensureJsonFile(path: string, value: unknown): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    await writeJsonAtomic(path, value);
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function readModels(dataDir: string): Promise<ModelInfo[]> {
  const models = await readJson<ModelInfo[]>(join(dataDir, "models.json"), []);
  return Array.isArray(models) ? models : [];
}

export async function saveModels(
  dataDir: string,
  models: ModelInfo[],
): Promise<void> {
  await writeJsonAtomic(join(dataDir, "models.json"), models);
}

export async function readTasks(dataDir: string): Promise<DevTask[]> {
  const tasks = await readJson<DevTask[]>(join(dataDir, "tasks.json"), []);
  return Array.isArray(tasks) ? tasks : [];
}

export async function saveTasks(dataDir: string, tasks: DevTask[]): Promise<void> {
  await writeJsonAtomic(join(dataDir, "tasks.json"), tasks);
}

export async function createJob(
  dataDir: string,
  type: Job["type"],
  params: Record<string, unknown>,
): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: randomId("job"),
    type,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    params,
  };
  await writeJsonAtomic(join(dataDir, "jobs", `${job.id}.json`), job);
  return job;
}

export async function getJob(dataDir: string, id: string): Promise<Job | null> {
  return readJson<Job | null>(join(dataDir, "jobs", `${id}.json`), null);
}

export async function updateJob(
  dataDir: string,
  id: string,
  patch: Partial<Omit<Job, "id" | "type" | "createdAt">>,
): Promise<Job | null> {
  const current = await getJob(dataDir, id);
  if (!current) return null;
  const next: Job = {
    ...current,
    ...patch,
    id: current.id,
    type: current.type,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(dataDir, "jobs", `${id}.json`), next);
  return next;
}

export async function listJobs(dataDir: string, limit = 10): Promise<Job[]> {
  const dir = join(dataDir, "jobs");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = await readJson<Job | null>(join(dir, name), null);
    if (job && typeof job.id === "string") jobs.push(job);
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs.slice(0, Math.max(0, limit));
}

export function spawnWorker(
  jobId: string,
  dataDir: string,
  config: OpenCodeFreeConfig | ResolvedConfig,
): number | undefined {
  const workerJsPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerJsPath, jobId], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OCFREE_DATA_DIR: dataDir,
      OCFREE_CONFIG: JSON.stringify(config),
    },
  });
  child.unref();
  return child.pid;
}
