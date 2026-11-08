import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  ensureDataDir,
  expandHome,
  readModels,
  saveModels,
} from "./store.js";
import type {
  ModelId,
  ModelInfo,
  OpenCodeFreeConfig,
  ResolvedConfig,
} from "./types.js";

const OUTPUT_CAP = 4 * 1024 * 1024;

export function normalizeModel(id: string): ModelId {
  const trimmed = id.trim();
  return trimmed.startsWith("opencode/")
    ? trimmed.slice("opencode/".length)
    : trimmed;
}

export function isFreeModel(id: string): boolean {
  const bare = normalizeModel(id);
  if (!bare || bare.includes("/")) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bare)) return false;
  return bare.endsWith("-free") || bare === "big-pickle";
}

export async function resolveBin(
  config: OpenCodeFreeConfig | ResolvedConfig,
): Promise<string> {
  const bin = expandHome(
    config.opencodeBin ?? "~/.opencode/bin/opencode",
  );
  try {
    await access(bin, constants.X_OK);
  } catch {
    throw new Error(
      `OpenCode harness not found or not executable at ${bin}. Set opencodeBin in plugin config.`,
    );
  }
  return bin;
}

interface CaptureResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function appendCapped(current: string, chunk: Buffer): string {
  const used = Buffer.byteLength(current, "utf8");
  if (used >= OUTPUT_CAP) return current;
  const remaining = OUTPUT_CAP - used;
  const next = chunk.subarray(0, remaining).toString("utf8");
  return current + next;
}

function captureProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let killTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        }, options.timeoutMs)
      : undefined;

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout,
        stderr,
        error:
          error ??
          (timedOut
            ? `timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`
            : undefined),
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

function parseModelLines(stdout: string, discoveredAt: string): ModelInfo[] {
  const seen = new Set<ModelId>();
  const models: ModelInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.endsWith(":")) continue;
    const token = line.split(/\s+/)[0] ?? "";
    if (!token || token === "opencode" || token.endsWith(":")) continue;
    if (!isFreeModel(token)) continue;
    const id = normalizeModel(token);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      fullId: `opencode/${id}`,
      free: true,
      discoveredAt,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function listFreeModels(
  config: OpenCodeFreeConfig | ResolvedConfig,
): Promise<ModelInfo[]> {
  const bin = await resolveBin(config);
  const dataDir = expandHome(
    config.dataDir ?? "~/.openclaw/state/opencode-free",
  );
  const result = await captureProcess(bin, ["models", "opencode"], {
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list OpenCode models (exit ${String(result.exitCode)}): ${
        result.error ?? result.stderr.trim() ?? "unknown error"
      }`,
    );
  }
  const models = parseModelLines(result.stdout, new Date().toISOString());
  await ensureDataDir(config);
  if (models.length > 0) {
    await saveModels(dataDir, models);
    return models;
  }
  // A transient registry failure must not erase a previously known roster.
  return readModels(dataDir);
}

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

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseEvents(stdout: string): ParsedEvents {
  let toolCalls = 0;
  let cost = 0;
  const tokens: TokenTotals = { input: 0, output: 0, reasoning: 0 };
  let stepStartTs: number | null = null;
  let firstTextTs: number | null = null;
  let sessionId: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (typeof record.sessionID === "string" && !sessionId) {
      sessionId = record.sessionID;
    }
    if (record.type === "step_start" && stepStartTs === null) {
      stepStartTs = numberOrNull(record.timestamp);
    }
    if (record.type === "text" && firstTextTs === null) {
      const part = record.part;
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text"
      ) {
        firstTextTs = numberOrNull(record.timestamp);
      }
    }
    if (record.type === "tool_use") toolCalls += 1;
    if (record.type === "step_finish") {
      const part =
        record.part && typeof record.part === "object"
          ? (record.part as Record<string, unknown>)
          : record;
      cost += numberOrZero(part.cost);
      const tokenPart =
        part.tokens && typeof part.tokens === "object"
          ? (part.tokens as Record<string, unknown>)
          : {};
      tokens.input += numberOrZero(tokenPart.input);
      tokens.output += numberOrZero(tokenPart.output);
      tokens.reasoning += numberOrZero(tokenPart.reasoning);
    }
  }

  return {
    toolCalls,
    cost,
    tokens,
    ttfoMs:
      stepStartTs !== null && firstTextTs !== null
        ? Math.max(0, firstTextTs - stepStartTs)
        : null,
    ...(sessionId ? { sessionId } : {}),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const harnessMajorCache = new Map<string, number>();

export async function harnessMajor(bin: string): Promise<number> {
  const cached = harnessMajorCache.get(bin);
  if (cached !== undefined) return cached;
  const result = await captureProcess(bin, ["--version"], {
    timeoutMs: 15_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const match = text.match(/v?(\d+)\./);
  const major = match ? Number(match[1]) : 1;
  harnessMajorCache.set(bin, major);
  return major;
}

export function buildRunArgs(options: {
  major: number;
  model: string;
  dir: string;
  prompt: string;
  sessionId?: string;
}): string[] {
  const args = [
    "run",
    "-m",
    `opencode/${normalizeModel(options.model)}`,
    "--agent",
    "build",
    "--auto",
    "--format",
    "json",
  ];
  // v1 needs --dir; v2 uses the process cwd and rejects --dir.
  if (options.major < 2) {
    args.push("--dir", options.dir);
  }
  if (options.sessionId) {
    args.push("--session", options.sessionId);
  }
  args.push(options.prompt);
  return args;
}

export async function runOpencode(
  options: RunOpencodeOptions,
): Promise<RunOpencodeResult> {
  const major = await harnessMajor(options.bin);
  const timeoutMs = Math.max(1, options.timeoutSec) * 1000;
  const startedAt = Date.now();
  const model = normalizeModel(options.model);
  const env = { ...process.env, NO_COLOR: "1" };
  const args = buildRunArgs({
    major,
    model,
    dir: options.dir,
    prompt: options.prompt,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(
      options.bin,
      args,
      { cwd: options.dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const parsed = parseEvents(stdout);
      const latencyMs = Date.now() - startedAt;
      const finalError =
        error ??
        (aborted
          ? "aborted"
          : timedOut
            ? `timed out after ${options.timeoutSec}s`
            : undefined);
      resolve({
        exitCode,
        timedOut,
        latencyMs,
        ttfoMs: parsed.ttfoMs,
        stdout,
        stderr,
        toolCalls: parsed.toolCalls,
        cost: parsed.cost,
        tokens: parsed.tokens,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        ...(finalError ? { error: finalError } : {}),
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}
