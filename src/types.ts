export type ModelId = string;

export interface ModelInfo {
  id: ModelId;
  fullId: string;
  free: boolean;
  discoveredAt: string;
  lastProbe?: { ok: boolean; latencyMs: number; error?: string; at: string };
}

export interface TaskRunResult {
  taskId: string;
  passed: boolean;
  fraction: number;
  checks: { name: string; ok: boolean; detail?: string }[];
  tampered: boolean;
}

export interface BenchRun {
  model: ModelId;
  taskId: string;
  run: number;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
  ttfoMs: number | null;
  attempts: number;
  toolCalls: number;
  cost: number;
  tokens: { input: number; output: number; reasoning: number };
  fraction: number;
  tampered: boolean;
  sessionId?: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  error?: string;
  at: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  at: string;
}

export interface ModelRating {
  model: ModelId;
  available: boolean;
  score: number;
  passRate: number;
  partialScore: number;
  speedScore: number;
  formatScore: number;
  medianLatencyMs: number;
  totalCost: number;
  costVerified: boolean;
  runs: number;
  failures: number;
}

export interface BenchmarkRecord {
  id: string;
  scoringVersion: 1;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  taskIds: string[];
  runsPerTask: number;
  retries: number;
  models: ModelId[];
  probes: Record<ModelId, ProbeResult>;
  ratings: ModelRating[];
  runs: BenchRun[];
  error?: string;
}

export interface DevTask {
  id: string;
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
    sessionId?: string;
    changedFiles: string[];
    outputTail: string;
    error?: string;
    at: string;
  }[];
}

export interface Job {
  id: string;
  type: "bench" | "task";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  params: Record<string, unknown>;
  workerPid?: number;
  progress?: { done: number; total: number; label: string };
  result?: unknown;
  error?: string;
}

export interface OCFreeConfig {
  opencodeBin?: string;
  dataDir?: string;
  defaultTimeoutSec?: number;
  maxFallbackModels?: number;
  allowedRepoRoots?: string[];
}

export interface ResolvedConfig {
  opencodeBin: string;
  dataDir: string;
  defaultTimeoutSec: number;
  maxFallbackModels: number;
  allowedRepoRoots: string[];
}
