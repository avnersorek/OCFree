import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, readJson, resolveConfig, writeJsonAtomic, } from "./store.js";
import { listFreeModels, normalizeModel, resolveBin, runOpencode } from "./opencode.js";
export async function loadCanary(dataDir) {
    return readJson(join(dataDir, "canary.json"), null);
}
/**
 * A canary is deliberately small: it proves the model can run a tool, write a
 * file, and return the expected content. It is not a quality score.
 */
export async function probeModel(options) {
    const dir = await mkdtemp(join(tmpdir(), "ocfree-canary-"));
    try {
        const result = await runOpencode({
            bin: options.bin,
            dir,
            model: options.model,
            prompt: "Create a file named probe.txt containing exactly: ocfree-ok. Then stop.",
            timeoutSec: options.timeoutSec,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        const written = await readFile(join(dir, "probe.txt"), "utf8").catch(() => null);
        const ok = result.exitCode === 0 &&
            !result.timedOut &&
            result.error === undefined &&
            written?.trim() === "ocfree-ok";
        return {
            ok,
            latencyMs: result.latencyMs,
            ...(ok
                ? {}
                : {
                    error: written?.trim() !== "ocfree-ok"
                        ? "canary file was not created with the expected content"
                        : (result.error ??
                            result.stderr.trim() ??
                            `exit ${String(result.exitCode)}`),
                }),
            at: new Date().toISOString(),
        };
    }
    catch (error) {
        return {
            ok: false,
            latencyMs: 0,
            error: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
        };
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
export async function runCanary(options) {
    const resolved = resolveConfig(options.config);
    const dataDir = options.dataDir;
    await ensureDataDir(resolved);
    const bin = await resolveBin(resolved);
    const models = options.models === undefined
        ? (await listFreeModels(resolved)).map((model) => model.id)
        : [...new Set(options.models.map(normalizeModel))];
    const results = {};
    const timeoutSec = Math.min(90, Math.max(10, resolved.defaultTimeoutSec));
    for (const [index, model] of models.entries()) {
        if (options.signal?.aborted)
            break;
        options.onProgress?.(index, models.length, `canary ${model}`);
        results[model] = await probeModel({
            bin,
            model,
            timeoutSec,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        options.onProgress?.(index + 1, models.length, `canary ${model} ${results[model].ok ? "ok" : "failed"}`);
    }
    const record = {
        updatedAt: new Date().toISOString(),
        models: results,
    };
    await writeJsonAtomic(join(dataDir, "canary.json"), record);
    return record;
}
