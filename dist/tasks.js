import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse as parsePath, resolve as resolvePath, sep, } from "node:path";
import { ensureDataDir, randomId, readModels, readTasks, resolveConfig, saveTasks, } from "./store.js";
import { loadCanary } from "./canary.js";
import { loadOnlineRatings, rankModelsByOnline } from "./online.js";
import { isFreeModel, listFreeModels, normalizeModel, resolveBin, runOpencode, } from "./opencode.js";
function isInsideRoot(repo, root) {
    return repo === root || repo.startsWith(`${root}${sep}`);
}
async function realpathOrResolved(value) {
    try {
        return await realpath(value);
    }
    catch {
        return resolvePath(value);
    }
}
/**
 * Resolve a task repository through fs.realpath and require it to live inside
 * one of the configured roots. This rejects symlink escapes and keeps `--auto`
 * runs away from arbitrary parts of the filesystem.
 */
export async function assertAllowedRepo(repoInput, config) {
    const candidate = resolvePath(expandHome(repoInput));
    const root = parsePath(candidate).root;
    if (candidate === root) {
        throw new Error("Refusing to use the filesystem root as a task repository");
    }
    if (candidate === resolvePath(homedir())) {
        throw new Error("Refusing to use the home directory as a task repository");
    }
    let info;
    try {
        info = await stat(candidate);
    }
    catch {
        throw new Error(`Task repository does not exist: ${candidate}`);
    }
    if (!info.isDirectory()) {
        throw new Error(`Task repository is not a directory: ${candidate}`);
    }
    let repo;
    try {
        repo = await realpath(candidate);
    }
    catch {
        throw new Error(`Task repository does not exist: ${candidate}`);
    }
    const resolved = resolveConfig(config ?? {});
    const roots = [];
    for (const configured of resolved.allowedRepoRoots) {
        roots.push(await realpathOrResolved(expandHome(configured)));
    }
    if (!roots.some((allowed) => isInsideRoot(repo, allowed))) {
        throw new Error(`Repository ${repo} is outside allowedRepoRoots (${roots.join(", ")}). ` +
            "Add the repository root to the plugin's allowedRepoRoots config.");
    }
    return repo;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Worker processes share tasks.json, so mutations take a short-lived lock file
 * instead of relying on an in-process mutex.
 */
async function withTasksLock(dataDir, fn) {
    const lockPath = join(dataDir, "tasks.lock");
    for (let attempt = 0; attempt < 100; attempt += 1) {
        let handle;
        try {
            handle = await open(lockPath, "wx");
        }
        catch (error) {
            const code = error.code;
            if (code !== "EEXIST")
                throw error;
            await sleep(100);
            continue;
        }
        try {
            return await fn();
        }
        finally {
            await handle.close();
            await unlink(lockPath).catch(() => undefined);
        }
    }
    throw new Error("Timed out waiting for the task store lock");
}
function expandHome(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
export async function addTask(dataDir, input, config) {
    if (!input.title.trim())
        throw new Error("Task title must not be empty");
    if (!input.prompt.trim())
        throw new Error("Task prompt must not be empty");
    const repo = await assertAllowedRepo(input.repo, config);
    const now = new Date().toISOString();
    const task = {
        id: randomId("task"),
        title: input.title.trim(),
        repo,
        prompt: input.prompt,
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
        status: "pending",
        createdAt: now,
        updatedAt: now,
        attempts: [],
    };
    await withTasksLock(dataDir, async () => {
        const tasks = await readTasks(dataDir);
        tasks.push(task);
        await saveTasks(dataDir, tasks);
    });
    return task;
}
export async function listTasks(dataDir) {
    const tasks = await readTasks(dataDir);
    return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getTask(dataDir, id) {
    const tasks = await readTasks(dataDir);
    return tasks.find((task) => task.id === id) ?? null;
}
async function persistTask(dataDir, task) {
    task.updatedAt = new Date().toISOString();
    await withTasksLock(dataDir, async () => {
        const tasks = await readTasks(dataDir);
        const index = tasks.findIndex((entry) => entry.id === task.id);
        if (index === -1)
            tasks.push(task);
        else
            tasks[index] = task;
        await saveTasks(dataDir, tasks);
    });
}
export async function pickModelChain(options) {
    const candidates = [];
    const seen = new Set();
    const limit = Math.max(1, Math.round(options.maxModels ?? 3));
    const add = (id) => {
        const model = normalizeModel(id);
        if (seen.has(model) || !isFreeModel(model))
            return;
        seen.add(model);
        candidates.push(model);
    };
    const explicit = [...new Set((options.explicitModels ?? []).map(normalizeModel))]
        .filter((model) => isFreeModel(model));
    for (const id of explicit)
        add(id);
    const cached = await readModels(options.dataDir);
    for (const model of cached) {
        if (model.free)
            add(model.id);
    }
    if (candidates.length < limit && options.config) {
        const live = await listFreeModels(options.config);
        for (const model of live)
            add(model.id);
    }
    const online = await loadOnlineRatings(options.dataDir);
    const canary = await loadCanary(options.dataDir);
    const failed = new Set(Object.entries(canary?.models ?? {})
        .filter(([, probe]) => !probe.ok)
        .map(([model]) => model));
    const eligible = candidates.filter((model) => !failed.has(model));
    const ranked = rankModelsByOnline(eligible.length > 0 ? eligible : candidates, online);
    if (explicit.length === 0)
        return ranked.slice(0, limit);
    const explicitSet = new Set(explicit);
    return [
        ...explicit,
        ...ranked.filter((model) => !explicitSet.has(model)),
    ].slice(0, limit);
}
const COMMAND_OUTPUT_CAP = 1024 * 1024;
function runCommand(command, args, options) {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const child = spawn(command, args, {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let killTimer;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        }, options.timeoutMs);
        const finish = (exitCode, error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            resolve({
                exitCode,
                timedOut,
                stdout,
                stderr,
                ...(error ? { error } : {}),
            });
        };
        const appendCapped = (current, chunk) => {
            const used = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
            if (used >= COMMAND_OUTPUT_CAP)
                return current;
            const remaining = COMMAND_OUTPUT_CAP - used;
            return current + chunk.subarray(0, remaining).toString("utf8");
        };
        child.stdout?.on("data", (chunk) => {
            stdout = appendCapped(stdout, chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr = appendCapped(stderr, chunk);
        });
        child.on("error", (error) => finish(null, error.message));
        child.on("close", (code) => finish(code));
    });
}
function hasGitRepo(repo) {
    return existsSync(join(repo, ".git"));
}
async function gitStatus(repo) {
    const result = await runCommand("git", ["status", "--porcelain"], {
        cwd: repo,
        timeoutMs: 30_000,
    });
    const files = new Set();
    if (result.exitCode !== 0)
        return files;
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const rawPath = line.slice(3).trim();
        const path = rawPath.includes(" -> ")
            ? (rawPath.split(" -> ").pop() ?? rawPath)
            : rawPath;
        files.add(path.replace(/^"|"$/g, ""));
    }
    return files;
}
export async function runDevTask(options) {
    const resolved = resolveConfig(options.config);
    await ensureDataDir(resolved);
    const task = options.task;
    task.repo = await assertAllowedRepo(task.repo, resolved);
    const resumeAttempt = options.resume
        ? [...task.attempts].reverse().find((attempt) => attempt.sessionId)
        : undefined;
    const explicitModels = resumeAttempt
        ? [resumeAttempt.model, ...(options.models ?? [])]
        : options.models;
    const chain = await pickModelChain({
        dataDir: options.dataDir,
        explicitModels,
        maxModels: resolved.maxFallbackModels,
        config: resolved,
    });
    const attempts = [];
    const bin = await resolveBin(resolved);
    task.status = "running";
    await persistTask(options.dataDir, task);
    let ok = false;
    for (const [index, model] of chain.entries()) {
        if (options.signal?.aborted)
            break;
        options.onProgress?.(index, chain.length, `running ${model} on ${task.title}`);
        const before = hasGitRepo(task.repo)
            ? await gitStatus(task.repo)
            : new Set();
        const prompt = task.acceptance
            ? `${task.prompt}\n\nAcceptance command: ${task.acceptance}`
            : task.prompt;
        const resumeSession = options.resume
            ? [...task.attempts]
                .reverse()
                .find((attempt) => attempt.model === model && attempt.sessionId)
                ?.sessionId
            : undefined;
        let run;
        try {
            run = await runOpencode({
                bin,
                dir: task.repo,
                model,
                prompt,
                timeoutSec: resolved.defaultTimeoutSec,
                ...(resumeSession ? { sessionId: resumeSession } : {}),
                signal: options.signal,
            });
        }
        catch (error) {
            run = {
                exitCode: null,
                timedOut: false,
                latencyMs: 0,
                ttfoMs: null,
                stdout: "",
                stderr: "",
                toolCalls: 0,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0 },
                error: error instanceof Error ? error.message : String(error),
            };
        }
        let acceptanceExit = null;
        let acceptanceError;
        let attemptOk = run.exitCode === 0 && !run.timedOut && run.error === undefined;
        if (attemptOk && task.acceptance) {
            const acceptance = await runCommand("bash", ["-lc", task.acceptance], { cwd: task.repo, timeoutMs: 300_000 });
            acceptanceExit = acceptance.exitCode;
            attemptOk =
                acceptance.exitCode === 0 &&
                    !acceptance.timedOut &&
                    acceptance.error === undefined;
            if (!attemptOk) {
                acceptanceError =
                    acceptance.error ??
                        (acceptance.timedOut
                            ? "acceptance command timed out"
                            : acceptance.stderr.trim() ||
                                `acceptance command exited ${String(acceptance.exitCode)}`);
            }
        }
        const after = hasGitRepo(task.repo)
            ? await gitStatus(task.repo)
            : new Set();
        const changedFiles = before.size === 0 && after.size === 0
            ? []
            : [...after].filter((file) => !before.has(file));
        const output = `${run.stdout}\n${run.stderr}`;
        const attempt = {
            model,
            ok: attemptOk,
            exitCode: run.exitCode,
            acceptanceExit,
            durationMs: run.latencyMs,
            cost: run.cost,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
            changedFiles,
            outputTail: output.slice(-2000),
            ...(attemptOk
                ? {}
                : {
                    error: acceptanceError ??
                        run.error ??
                        run.stderr.trim() ??
                        (run.timedOut ? "timed out" : `exit ${String(run.exitCode)}`),
                }),
            at: new Date().toISOString(),
        };
        attempts.push(attempt);
        task.attempts.push(attempt);
        task.status = attemptOk ? "passed" : "failed";
        await persistTask(options.dataDir, task);
        if (attemptOk) {
            ok = true;
            break;
        }
        options.onProgress?.(index + 1, chain.length, `${model} failed on ${task.title}`);
    }
    if (!ok)
        task.status = "failed";
    await persistTask(options.dataDir, task);
    return { ok, attempts, task };
}
