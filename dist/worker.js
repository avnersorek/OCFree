import { runBenchmark } from "./bench.js";
import { getTask, runDevTask } from "./tasks.js";
import { getJob, resolveConfig, updateJob } from "./store.js";
function parseConfig(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }
    catch {
        return {};
    }
    return {};
}
function stringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((entry) => typeof entry === "string");
}
function numberOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}
async function main() {
    const jobId = process.argv[2];
    const dataDir = process.env.OCFREE_DATA_DIR;
    if (!jobId || !dataDir) {
        throw new Error("worker requires a job id and OCFREE_DATA_DIR");
    }
    const config = resolveConfig({
        ...parseConfig(process.env.OCFREE_CONFIG),
        dataDir,
    });
    await updateJob(dataDir, jobId, {
        status: "running",
        workerPid: process.pid,
    });
    const job = await getJob(dataDir, jobId);
    if (!job)
        throw new Error(`job not found: ${jobId}`);
    if (job.type === "bench") {
        const models = stringArray(job.params.models);
        const taskIds = stringArray(job.params.taskIds);
        const runsPerTask = numberOrUndefined(job.params.runsPerTask);
        const timeoutSec = numberOrUndefined(job.params.timeoutSec);
        const benchConfig = {
            ...config,
            ...(timeoutSec !== undefined ? { defaultTimeoutSec: timeoutSec } : {}),
        };
        let progressWrite = Promise.resolve();
        const record = await runBenchmark({
            dataDir,
            config: benchConfig,
            ...(models !== undefined ? { models } : {}),
            ...(taskIds !== undefined ? { taskIds } : {}),
            ...(runsPerTask !== undefined ? { runsPerTask } : {}),
            onProgress: (done, total, label) => {
                progressWrite = progressWrite.then(() => updateJob(dataDir, jobId, { progress: { done, total, label } }).then(() => undefined)).catch(() => undefined);
            },
        });
        await progressWrite;
        const result = { benchmarkId: record.id, ratings: record.ratings };
        await updateJob(dataDir, jobId, { status: "done", result });
        process.exitCode = 0;
        return;
    }
    if (job.type === "task") {
        const taskId = job.params.taskId;
        if (typeof taskId !== "string") {
            throw new Error("task job is missing taskId");
        }
        const task = await getTask(dataDir, taskId);
        if (!task)
            throw new Error(`task not found: ${taskId}`);
        const models = stringArray(job.params.models);
        const resume = job.params.resume === true;
        let progressWrite = Promise.resolve();
        const outcome = await runDevTask({
            dataDir,
            config,
            task,
            ...(models !== undefined ? { models } : {}),
            ...(resume ? { resume: true } : {}),
            onProgress: (done, total, label) => {
                progressWrite = progressWrite.then(() => updateJob(dataDir, jobId, { progress: { done, total, label } }).then(() => undefined)).catch(() => undefined);
            },
        });
        await progressWrite;
        await updateJob(dataDir, jobId, {
            status: "done",
            result: {
                ok: outcome.ok,
                taskId: task.id,
                attempts: outcome.attempts,
            },
        });
        process.exitCode = 0;
        return;
    }
    throw new Error(`unknown job type: ${String(job.type)}`);
}
main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ocfree worker error: ${message}\n`);
    const jobId = process.argv[2];
    const dataDir = process.env.OCFREE_DATA_DIR;
    if (jobId && dataDir) {
        try {
            await updateJob(dataDir, jobId, { status: "failed", error: message });
        }
        catch {
            process.exitCode = 1;
        }
    }
    process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
    process.stderr.write(`ocfree worker unhandled rejection: ${String(reason)}\n`);
    process.exitCode = 1;
});
