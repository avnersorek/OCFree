import type { DevTask, ModelId, OpenCodeFreeConfig, ResolvedConfig } from "./types.js";
export interface AddTaskInput {
    title: string;
    repo: string;
    prompt: string;
    acceptance?: string;
}
/**
 * Resolve a task repository through fs.realpath and require it to live inside
 * one of the configured roots. This rejects symlink escapes and keeps `--auto`
 * runs away from arbitrary parts of the filesystem.
 */
export declare function assertAllowedRepo(repoInput: string, config?: OpenCodeFreeConfig | ResolvedConfig): Promise<string>;
export declare function addTask(dataDir: string, input: AddTaskInput, config?: OpenCodeFreeConfig | ResolvedConfig): Promise<DevTask>;
export declare function listTasks(dataDir: string): Promise<DevTask[]>;
export declare function getTask(dataDir: string, id: string): Promise<DevTask | null>;
export interface PickModelChainOptions {
    dataDir: string;
    explicitModels?: string[];
    maxModels?: number;
    config?: OpenCodeFreeConfig | ResolvedConfig;
}
export declare function pickModelChain(options: PickModelChainOptions): Promise<ModelId[]>;
export interface RunDevTaskOptions {
    dataDir: string;
    config: OpenCodeFreeConfig | ResolvedConfig;
    task: DevTask;
    models?: string[];
    resume?: boolean;
    onProgress?: (done: number, total: number, label: string) => void;
    signal?: AbortSignal;
}
export interface RunDevTaskResult {
    ok: boolean;
    attempts: DevTask["attempts"];
    task: DevTask;
}
export declare function runDevTask(options: RunDevTaskOptions): Promise<RunDevTaskResult>;
