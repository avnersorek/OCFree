export type ModelId = string;
export interface ModelInfo {
    id: ModelId;
    fullId: string;
    free: boolean;
    discoveredAt: string;
    lastProbe?: {
        ok: boolean;
        latencyMs: number;
        error?: string;
        at: string;
    };
}
export interface ProbeResult {
    ok: boolean;
    latencyMs: number;
    error?: string;
    at: string;
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
    type: "canary" | "task";
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    createdAt: string;
    updatedAt: string;
    params: Record<string, unknown>;
    workerPid?: number;
    progress?: {
        done: number;
        total: number;
        label: string;
    };
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
