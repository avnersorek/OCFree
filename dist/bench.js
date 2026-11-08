import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, readJson, resolveConfig, writeJsonAtomic, } from "./store.js";
import { isFreeModel, listFreeModels, normalizeModel, resolveBin, runOpencode } from "./opencode.js";
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
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => finish(null, error.message));
        child.on("close", (code) => finish(code));
    });
}
function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
async function restorePristine(dir, pristine) {
    let tampered = false;
    for (const [file, content] of Object.entries(pristine)) {
        const path = join(dir, file);
        let current = null;
        try {
            current = await readFile(path, "utf8");
        }
        catch {
            current = null;
        }
        if (current === null || sha256(current) !== sha256(content)) {
            tampered = true;
        }
        await writeFile(path, content, "utf8");
    }
    return tampered;
}
async function verifyNodeTests(taskId, dir, pristine) {
    const tampered = await restorePristine(dir, pristine);
    const result = await runCommand("node", ["--test", "test.js"], {
        cwd: dir,
        timeoutMs: 60_000,
    });
    const passed = result.exitCode === 0 && !result.timedOut;
    const output = `${result.stdout}\n${result.stderr}`;
    const passCount = Number(output.match(/# pass (\d+)/)?.[1] ?? NaN);
    const failCount = Number(output.match(/# fail (\d+)/)?.[1] ?? NaN);
    const total = passCount + failCount;
    const fraction = Number.isFinite(passCount) && Number.isFinite(failCount) && total > 0
        ? passCount / total
        : passed
            ? 1
            : 0;
    const detail = passed
        ? undefined
        : (result.error ?? result.stderr.trim() ?? `exit ${String(result.exitCode)}`);
    return {
        taskId,
        passed,
        fraction,
        tampered,
        checks: [
            { name: "tests", ok: passed, ...(detail ? { detail } : {}) },
            {
                name: "fraction",
                ok: fraction >= 1,
                detail: Number.isFinite(total) && total > 0
                    ? `${passCount}/${total}`
                    : passed
                        ? "all"
                        : "0",
            },
        ],
    };
}
const CAPITALIZE_INDEX = `export function capitalizeWords(s) {
  return s.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}
`;
const CAPITALIZE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizeWords } from "./index.js";

test("capitalizes a simple phrase", () => {
  assert.equal(capitalizeWords("hello world"), "Hello World");
});

test("collapses whitespace and trims", () => {
  assert.equal(capitalizeWords("  hello   world  "), "Hello World");
});

test("handles a single letter", () => {
  assert.equal(capitalizeWords("a"), "A");
});
`;
const BRACKETS_INDEX = `export function isBalanced(s) {
  return true;
}
`;
const BRACKETS_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isBalanced } from "./index.js";

test("empty pair", () => {
  assert.equal(isBalanced("()"), true);
});

test("two pairs", () => {
  assert.equal(isBalanced("()[]{}"), true);
});

test("mismatched pair", () => {
  assert.equal(isBalanced("(]"), false);
});

test("interleaved pair", () => {
  assert.equal(isBalanced("([)]"), false);
});

test("nested pair", () => {
  assert.equal(isBalanced("{[]}"), true);
});

test("mixed nested pairs", () => {
  assert.equal(isBalanced("([{}])()"), true);
});
`;
const PLAN_EXPECTED = {
    steps: [
        { id: 1, action: "read" },
        { id: 2, action: "edit" },
        { id: 3, action: "test" },
    ],
    risk: "low",
};
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null || typeof a !== "object")
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b))
            return false;
        if (a.length !== b.length)
            return false;
        return a.every((value, index) => deepEqual(value, b[index]));
    }
    const aRecord = a;
    const bRecord = b;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    if (aKeys.length !== bKeys.length)
        return false;
    if (!aKeys.every((key, index) => key === bKeys[index]))
        return false;
    return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const fixCapitalizeTask = {
    id: "fix-capitalize",
    title: "Fix capitalizeWords",
    prompt: "Fix index.js so all tests in test.js pass. Run `node --test test.js`. Do not modify test.js.",
    pristine: { "test.js": CAPITALIZE_TEST },
    async setup(dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "index.js"), CAPITALIZE_INDEX, "utf8");
        await writeFile(join(dir, "test.js"), CAPITALIZE_TEST, "utf8");
    },
    async verify(dir) {
        return verifyNodeTests("fix-capitalize", dir, {
            "test.js": CAPITALIZE_TEST,
        });
    },
};
export const balancedBracketsTask = {
    id: "balanced-brackets",
    title: "Implement balanced brackets",
    prompt: "Implement isBalanced in index.js so all tests pass. Do not modify test.js.",
    pristine: { "test.js": BRACKETS_TEST },
    async setup(dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "index.js"), BRACKETS_INDEX, "utf8");
        await writeFile(join(dir, "test.js"), BRACKETS_TEST, "utf8");
    },
    async verify(dir) {
        return verifyNodeTests("balanced-brackets", dir, {
            "test.js": BRACKETS_TEST,
        });
    },
};
export const jsonPlanTask = {
    id: "json-plan",
    title: "Write exact JSON plan",
    prompt: 'Create plan.json with exactly this JSON (no extra keys): {"steps":[{"id":1,"action":"read"},{"id":2,"action":"edit"},{"id":3,"action":"test"}],"risk":"low"}',
    pristine: {},
    async setup(dir) {
        await mkdir(dir, { recursive: true });
    },
    async verify(dir) {
        let parsed;
        let parses = false;
        let schema = false;
        let detail;
        try {
            parsed = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
            parses = true;
        }
        catch (error) {
            detail = error instanceof Error ? error.message : String(error);
        }
        if (parses) {
            schema = isRecord(parsed) && deepEqual(parsed, PLAN_EXPECTED);
            if (!schema)
                detail = "plan.json does not match the required schema";
        }
        return {
            taskId: "json-plan",
            passed: parses && schema,
            fraction: parses && schema ? 1 : 0,
            tampered: false,
            checks: [
                { name: "parses", ok: parses, ...(parses ? {} : { detail }) },
                { name: "schema", ok: schema, ...(schema ? {} : { detail }) },
            ],
        };
    },
};
export const bashCliTask = {
    id: "bash-cli",
    title: "Create bash script",
    prompt: "Create run.sh that prints exactly these three lines in order: alpha, beta, gamma. It must run with: bash run.sh",
    pristine: {},
    async setup(dir) {
        await mkdir(dir, { recursive: true });
    },
    async verify(dir) {
        const result = await runCommand("bash", ["run.sh"], {
            cwd: dir,
            timeoutMs: 60_000,
        });
        const exit0 = result.exitCode === 0 && !result.timedOut;
        const output = result.stdout.trim() === "alpha\nbeta\ngamma";
        return {
            taskId: "bash-cli",
            passed: exit0 && output,
            fraction: exit0 && output ? 1 : 0,
            tampered: false,
            checks: [
                {
                    name: "exit0",
                    ok: exit0,
                    ...(exit0
                        ? {}
                        : {
                            detail: result.error ??
                                result.stderr.trim() ??
                                `exit ${String(result.exitCode)}`,
                        }),
                },
                {
                    name: "output",
                    ok: output,
                    ...(output ? {} : { detail: JSON.stringify(result.stdout) }),
                },
            ],
        };
    },
};
const CSV_INDEX = `export function parseCsv(text) {
  return [];
}
`;
const CSV_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./index.js";

test("simple rows", () => {
  assert.deepEqual(parseCsv("a,b\\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("quoted comma", () => {
  assert.deepEqual(parseCsv('"a,b",c'), [["a,b", "c"]]);
});

test("escaped quote", () => {
  assert.deepEqual(parseCsv('"a""b",c'), [['a"b', "c"]]);
});

test("trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\\n"), [["a", "b"]]);
});

test("empty input", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("empty field", () => {
  assert.deepEqual(parseCsv("a,,b"), [["a", "", "b"]]);
});

test("quoted newline", () => {
  assert.deepEqual(parseCsv('"a\\nb",c'), [["a\\nb", "c"]]);
});

test("crlf rows", () => {
  assert.deepEqual(parseCsv("a,b\\r\\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("preserves spaces", () => {
  assert.deepEqual(parseCsv(" a , b "), [[" a ", " b "]]);
});

test("single column", () => {
  assert.deepEqual(parseCsv("a\\nb\\n"), [["a"], ["b"]]);
});
`;
export const csvParseTask = {
    id: "csv-parse",
    title: "Implement RFC4180-style CSV parser",
    prompt: "Implement parseCsv(text) in index.js. It must parse RFC4180-style CSV: comma-separated fields, double-quoted fields, doubled quotes inside quoted fields, quoted newlines, CRLF or LF row separators, no header handling. Return an array of rows (arrays of strings). Do not modify test.js.",
    pristine: { "test.js": CSV_TEST },
    async setup(dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "index.js"), CSV_INDEX, "utf8");
        await writeFile(join(dir, "test.js"), CSV_TEST, "utf8");
    },
    async verify(dir) {
        return verifyNodeTests("csv-parse", dir, { "test.js": CSV_TEST });
    },
};
const LRU_INDEX = `export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
  }
  get(key) {
    return undefined;
  }
  put(key, value) {
    void key;
    void value;
  }
}
`;
const LRU_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./index.js";

test("evicts least recently used", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("get refreshes recency", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.put("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});

test("put existing updates value and recency", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("a", 10);
  cache.put("c", 3);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.get("b"), undefined);
});

test("capacity one", () => {
  const cache = new LRUCache(1);
  cache.put("a", 1);
  cache.put("b", 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
});

test("missing key returns undefined", () => {
  const cache = new LRUCache(2);
  assert.equal(cache.get("nope"), undefined);
});

test("overwrite does not grow the cache", () => {
  const cache = new LRUCache(2);
  cache.put("a", 1);
  cache.put("a", 2);
  cache.put("b", 3);
  assert.equal(cache.get("a"), 2);
  assert.equal(cache.get("b"), 3);
});
`;
export const lruCacheTask = {
    id: "lru-cache",
    title: "Implement LRU cache",
    prompt: "Implement the LRUCache class in index.js with constructor(capacity), get(key), and put(key, value). Evict the least recently used entry when capacity is exceeded; get() must refresh recency. Do not modify test.js.",
    pristine: { "test.js": LRU_TEST },
    async setup(dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "index.js"), LRU_INDEX, "utf8");
        await writeFile(join(dir, "test.js"), LRU_TEST, "utf8");
    },
    async verify(dir) {
        return verifyNodeTests("lru-cache", dir, { "test.js": LRU_TEST });
    },
};
export const BENCH_TASKS = [
    fixCapitalizeTask,
    balancedBracketsTask,
    jsonPlanTask,
    bashCliTask,
    csvParseTask,
    lruCacheTask,
];
export function getBenchTask(id) {
    return BENCH_TASKS.find((task) => task.id === id);
}
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function round1(value) {
    return Math.round(value * 10) / 10;
}
export function scoreRatings(runs, models) {
    const ratings = models.map((model) => {
        const modelRuns = runs.filter((run) => run.model === model);
        const total = modelRuns.length;
        const passed = modelRuns.filter((run) => run.ok).length;
        const untampered = modelRuns.filter((run) => !run.tampered).length;
        const latency = median(modelRuns.map((run) => run.latencyMs));
        const passRate = total > 0 ? passed / total : 0;
        const partialScore = total > 0
            ? modelRuns.reduce((sum, run) => sum + (run.fraction ?? (run.ok ? 1 : 0)), 0) / total
            : 0;
        const speedScore = total > 0 ? clamp01(1 - (latency - 5_000) / 55_000) : 0;
        const formatScore = total > 0 ? untampered / total : 0;
        const totalCost = modelRuns.reduce((sum, run) => sum + run.cost, 0);
        const costVerified = total > 0 && totalCost === 0;
        const score = costVerified
            ? round1(100 * (0.8 * partialScore + 0.1 * speedScore + 0.1 * formatScore))
            : 0;
        return {
            model,
            available: total > 0,
            score,
            passRate,
            partialScore,
            speedScore,
            formatScore,
            medianLatencyMs: latency,
            totalCost,
            costVerified,
            runs: total,
            failures: total - passed,
        };
    });
    ratings.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.passRate !== a.passRate)
            return b.passRate - a.passRate;
        return a.medianLatencyMs - b.medianLatencyMs;
    });
    return ratings;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function probeModel(options) {
    const dir = await mkdtemp(join(tmpdir(), "ocfree-probe-"));
    try {
        const result = await runOpencode({
            bin: options.bin,
            dir,
            model: options.model,
            prompt: "Create a file named probe.txt containing exactly: ocfree-ok. Then stop.",
            timeoutSec: options.timeoutSec,
            signal: options.signal,
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
                        ? "probe file was not created with the expected content"
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
function compactIso() {
    return new Date().toISOString().replace(/[-:.TZ]/g, "");
}
export async function runBenchmark(options) {
    const resolved = resolveConfig(options.config);
    const dataDir = options.dataDir;
    await ensureDataDir(resolved);
    let models;
    if (options.models === undefined) {
        models = (await listFreeModels(resolved)).map((model) => model.id);
    }
    else {
        models = [...new Set(options.models.map(normalizeModel))];
        const rejected = models.filter((model) => !isFreeModel(model));
        if (rejected.length > 0) {
            throw new Error(`Refusing non-free models: ${rejected.join(", ")}`);
        }
    }
    const taskIds = options.taskIds === undefined
        ? BENCH_TASKS.map((task) => task.id)
        : options.taskIds;
    const tasks = taskIds.map((id) => {
        const task = getBenchTask(id);
        if (!task)
            throw new Error(`Unknown benchmark task: ${id}`);
        return task;
    });
    const runsPerTask = Math.max(1, Math.round(options.runsPerTask ?? 1));
    const retries = Math.max(0, Math.min(3, Math.round(options.retries ?? 1)));
    const probes = {};
    const record = {
        id: `bench-${compactIso()}-${randomUUID().slice(0, 8)}`,
        scoringVersion: 1,
        startedAt: new Date().toISOString(),
        status: "running",
        taskIds,
        runsPerTask,
        retries,
        models,
        probes,
        ratings: [],
        runs: [],
    };
    await writeJsonAtomic(join(dataDir, "benchmarks", `${record.id}.json`), record);
    const bin = await resolveBin(resolved);
    let done = 0;
    let total = models.length;
    const activeModels = [];
    if (options.probe === false) {
        activeModels.push(...models);
    }
    else {
        for (const model of models) {
            if (options.signal?.aborted)
                break;
            const probe = await probeModel({
                bin,
                model,
                timeoutSec: Math.min(90, resolved.defaultTimeoutSec),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            probes[model] = probe;
            done += 1;
            options.onProgress?.(done, total, `probe ${model} ${probe.ok ? "ok" : "failed"}`);
            if (probe.ok)
                activeModels.push(model);
        }
    }
    total =
        (options.probe === false ? 0 : models.length) +
            activeModels.length * tasks.length * runsPerTask;
    outer: for (const model of activeModels) {
        for (const task of tasks) {
            for (let run = 1; run <= runsPerTask; run += 1) {
                if (options.signal?.aborted)
                    break outer;
                const dir = await mkdtemp(join(tmpdir(), "ocfree-bench-"));
                const startedAt = Date.now();
                let attempts = 0;
                let benchRun;
                try {
                    await task.setup(dir);
                    let result;
                    let verify;
                    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
                        attempts = attempt;
                        result = await runOpencode({
                            bin,
                            dir,
                            model,
                            prompt: task.prompt,
                            timeoutSec: resolved.defaultTimeoutSec,
                            ...(options.signal ? { signal: options.signal } : {}),
                        });
                        verify = await task.verify(dir);
                        const passed = result.exitCode === 0 &&
                            !result.timedOut &&
                            result.error === undefined &&
                            verify.passed;
                        if (passed || options.signal?.aborted)
                            break;
                        if (attempt <= retries) {
                            await sleep(Math.min(5_000, 1_000 * attempt));
                        }
                    }
                    if (!result || !verify) {
                        throw new Error("benchmark run produced no result");
                    }
                    const ok = result.exitCode === 0 &&
                        !result.timedOut &&
                        result.error === undefined &&
                        verify.passed;
                    const errorMessage = result.error ??
                        (verify.passed
                            ? undefined
                            : (verify.checks.find((check) => !check.ok)?.detail ??
                                "verification failed"));
                    benchRun = {
                        model,
                        taskId: task.id,
                        run,
                        ok,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        latencyMs: result.latencyMs,
                        ttfoMs: result.ttfoMs,
                        attempts,
                        toolCalls: result.toolCalls,
                        cost: result.cost,
                        tokens: result.tokens,
                        fraction: verify.fraction,
                        tampered: verify.tampered,
                        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                        checks: verify.checks,
                        ...(errorMessage ? { error: errorMessage } : {}),
                        at: new Date().toISOString(),
                    };
                }
                catch (error) {
                    benchRun = {
                        model,
                        taskId: task.id,
                        run,
                        ok: false,
                        exitCode: null,
                        timedOut: false,
                        latencyMs: Date.now() - startedAt,
                        ttfoMs: null,
                        attempts,
                        toolCalls: 0,
                        cost: 0,
                        tokens: { input: 0, output: 0, reasoning: 0 },
                        fraction: 0,
                        tampered: false,
                        checks: [],
                        error: error instanceof Error ? error.message : String(error),
                        at: new Date().toISOString(),
                    };
                }
                finally {
                    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
                }
                record.runs.push(benchRun);
                done += 1;
                options.onProgress?.(done, total, `${model} ${task.id} run ${run}/${runsPerTask} attempt ${attempts}`);
            }
        }
    }
    record.status = options.signal?.aborted ? "failed" : "done";
    if (options.signal?.aborted)
        record.error = "aborted";
    record.finishedAt = new Date().toISOString();
    record.ratings = scoreRatings(record.runs, models);
    await writeJsonAtomic(join(dataDir, "benchmarks", `${record.id}.json`), record);
    await writeJsonAtomic(join(dataDir, "benchmarks", "latest.json"), record);
    return record;
}
export async function getLatestBenchmark(dataDir) {
    return readJson(join(dataDir, "benchmarks", "latest.json"), null);
}
/**
 * Pick the benchmark with the widest coverage for model selection, so a
 * one-task smoke run cannot displace a full four-task run merely by being
 * newer. Falls back to the newest completed benchmark.
 */
export async function getBestBenchmark(dataDir) {
    const dir = join(dataDir, "benchmarks");
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        return null;
    }
    const records = [];
    for (const name of names) {
        if (!name.endsWith(".json") || name === "latest.json")
            continue;
        const record = await readJson(join(dir, name), null);
        if (!record || record.status !== "done" || !Array.isArray(record.runs)) {
            continue;
        }
        records.push(record);
    }
    if (records.length === 0)
        return getLatestBenchmark(dataDir);
    records.sort((a, b) => {
        const coverageA = a.taskIds.length * a.runsPerTask * a.models.length;
        const coverageB = b.taskIds.length * b.runsPerTask * b.models.length;
        if (coverageB !== coverageA)
            return coverageB - coverageA;
        return b.startedAt.localeCompare(a.startedAt);
    });
    return records[0] ?? null;
}
export async function getBenchmark(dataDir, id) {
    return readJson(join(dataDir, "benchmarks", `${id}.json`), null);
}
