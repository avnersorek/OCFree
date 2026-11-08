import type { BenchRun, BenchmarkRecord, ModelId, ModelRating, OpenCodeFreeConfig, ProbeResult, ResolvedConfig, TaskRunResult } from "./types.js";
export interface BenchTask {
    id: string;
    title: string;
    prompt: string;
    setup(dir: string): Promise<void>;
    verify(dir: string): Promise<TaskRunResult>;
    pristine: Record<string, string>;
}
export declare const fixCapitalizeTask: BenchTask;
export declare const balancedBracketsTask: BenchTask;
export declare const jsonPlanTask: BenchTask;
export declare const bashCliTask: BenchTask;
export declare const csvParseTask: BenchTask;
export declare const lruCacheTask: BenchTask;
export declare const BENCH_TASKS: BenchTask[];
export declare function getBenchTask(id: string): BenchTask | undefined;
export declare function scoreRatings(runs: BenchRun[], models: ModelId[]): ModelRating[];
export interface ProbeOptions {
    bin: string;
    model: ModelId;
    timeoutSec: number;
    signal?: AbortSignal;
}
export declare function probeModel(options: ProbeOptions): Promise<ProbeResult>;
export interface RunBenchmarkOptions {
    dataDir: string;
    config: OpenCodeFreeConfig | ResolvedConfig;
    models?: string[];
    taskIds?: string[];
    runsPerTask?: number;
    probe?: boolean;
    retries?: number;
    onProgress?: (done: number, total: number, label: string) => void;
    signal?: AbortSignal;
}
export declare function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkRecord>;
export declare function getLatestBenchmark(dataDir: string): Promise<BenchmarkRecord | null>;
/**
 * Pick the benchmark with the widest coverage for model selection, so a
 * one-task smoke run cannot displace a full four-task run merely by being
 * newer. Falls back to the newest completed benchmark.
 */
export declare function getBestBenchmark(dataDir: string): Promise<BenchmarkRecord | null>;
export declare function getBenchmark(dataDir: string, id: string): Promise<BenchmarkRecord | null>;
