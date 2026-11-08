import type { ModelId, OCFreeConfig, ProbeResult, ResolvedConfig } from "./types.js";
export interface CanaryRecord {
    updatedAt: string;
    models: Record<ModelId, ProbeResult>;
}
export declare function loadCanary(dataDir: string): Promise<CanaryRecord | null>;
export interface ProbeOptions {
    bin: string;
    model: ModelId;
    timeoutSec: number;
    signal?: AbortSignal;
}
/**
 * A canary is deliberately small: it proves the model can run a tool, write a
 * file, and return the expected content. It is not a quality score.
 */
export declare function probeModel(options: ProbeOptions): Promise<ProbeResult>;
export interface RunCanaryOptions {
    dataDir: string;
    config: OCFreeConfig | ResolvedConfig;
    models?: string[];
    onProgress?: (done: number, total: number, label: string) => void;
    signal?: AbortSignal;
}
export declare function runCanary(options: RunCanaryOptions): Promise<CanaryRecord>;
