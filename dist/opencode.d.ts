import type { ModelId, ModelInfo, OpenCodeFreeConfig, ResolvedConfig } from "./types.js";
export declare function normalizeModel(id: string): ModelId;
export declare function isFreeModel(id: string): boolean;
export declare function resolveBin(config: OpenCodeFreeConfig | ResolvedConfig): Promise<string>;
export declare function listFreeModels(config: OpenCodeFreeConfig | ResolvedConfig): Promise<ModelInfo[]>;
export interface RunOpencodeOptions {
    bin: string;
    dir: string;
    model: string;
    prompt: string;
    timeoutSec: number;
    sessionId?: string;
    signal?: AbortSignal;
}
export interface TokenTotals {
    input: number;
    output: number;
    reasoning: number;
}
export interface ParsedEvents {
    toolCalls: number;
    cost: number;
    tokens: TokenTotals;
    ttfoMs: number | null;
    sessionId?: string;
}
export interface RunOpencodeResult {
    exitCode: number | null;
    timedOut: boolean;
    latencyMs: number;
    ttfoMs: number | null;
    stdout: string;
    stderr: string;
    toolCalls: number;
    cost: number;
    tokens: TokenTotals;
    sessionId?: string;
    error?: string;
}
export declare function parseEvents(stdout: string): ParsedEvents;
export declare function harnessMajor(bin: string): Promise<number>;
export declare function buildRunArgs(options: {
    major: number;
    model: string;
    dir: string;
    prompt: string;
    sessionId?: string;
}): string[];
export declare function runOpencode(options: RunOpencodeOptions): Promise<RunOpencodeResult>;
