import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelId, ModelRating } from "./types.js";
import { writeJsonAtomic } from "./store.js";

export interface OnlineRating {
  score: number;
  source: string;
  url?: string;
  rank?: number;
  note?: string;
  updatedAt: string;
}

export interface OnlineRatings {
  updatedAt: string;
  source: string;
  models: Record<ModelId, OnlineRating>;
}

const BENCHLM_URL = "https://benchlm.ai/coding";
const BIG_PICKLE_URL =
  "https://github.com/PhillipChaffee/big-pickle-swe-atlas";
const USER_AGENT =
  "opencode-free/0.1 (+https://github.com/AvnerSorek/opencode-free)";

/**
 * Seeded from public online results. BenchLM weighted coding scores are on a
 * 0..100 scale; Big Pickle's value is a SWE Atlas Codebase QnA resolve-rate on
 * a different benchmark scale, so it is kept separately labelled and should
 * not be compared directly with BenchLM scores.
 */
const SEED_MODELS: Record<ModelId, OnlineRating> = {
  "deepseek-v4.1-flash-free": {
    score: 63.3,
    rank: 13,
    source: "BenchLM coding (BenchAlign v5.8)",
    url: BENCHLM_URL,
    note: "DeepSeek V4.1 Flash 1017",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
  "mimo-v2.6-flash-free": {
    score: 56.4,
    rank: 27,
    source: "BenchLM coding (BenchAlign v5.8)",
    url: BENCHLM_URL,
    note: "MiMo-V2.6-Flash",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
  "big-pickle": {
    score: 50.8,
    source: "SWE Atlas Codebase QnA",
    url: BIG_PICKLE_URL,
    note: "63/124 resolve rate; different benchmark scale",
    updatedAt: "2026-08-11T00:00:00.000Z",
  },
  "glm-5.3-flash-free": {
    score: 47.4,
    rank: 54,
    source: "BenchLM coding (BenchAlign v5.8)",
    url: BENCHLM_URL,
    note: "GLM-5.3-Flash",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
  "beam-free": {
    score: 30.5,
    rank: 103,
    source: "BenchLM coding (BenchAlign v5.8)",
    url: BENCHLM_URL,
    note: "Beam 1.0 501B-A23B; name match inferred",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
  "nemotron-3.5-lightning-free": {
    score: 18.3,
    rank: 139,
    source: "BenchLM coding (BenchAlign v5.8)",
    url: BENCHLM_URL,
    note: "Nemotron 3.5 Lightning 30B A3B NVFP4; name match inferred",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
};

export const DEFAULT_ONLINE_RATINGS: OnlineRatings = {
  updatedAt: "2026-11-08T00:00:00.000Z",
  source: "BenchLM coding + SWE Atlas",
  models: SEED_MODELS,
};

const BENCHLM_ALIASES: Record<string, ModelId> = {
  "deepseek-v4-1-flash": "deepseek-v4.1-flash-free",
  "mimo-v2-6-flash": "mimo-v2.6-flash-free",
  "glm-5-3-flash": "glm-5.3-flash-free",
  "reflection-beam": "beam-free",
  "nemotron-3-5-lightning-30b-a3b-nvfp4":
    "nemotron-3.5-lightning-free",
};

function isRating(value: unknown): value is OnlineRating {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.score === "number" &&
    Number.isFinite(record.score) &&
    typeof record.source === "string"
  );
}

function parseRatings(value: unknown): OnlineRatings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const modelsValue = record.models;
  if (!modelsValue || typeof modelsValue !== "object") return null;
  const models: Record<ModelId, OnlineRating> = {};
  for (const [model, rating] of Object.entries(
    modelsValue as Record<string, unknown>,
  )) {
    if (isRating(rating)) models[model] = rating;
  }
  if (Object.keys(models).length === 0) return null;
  return {
    updatedAt:
      typeof record.updatedAt === "string"
        ? record.updatedAt
        : new Date().toISOString(),
    source:
      typeof record.source === "string" ? record.source : "online",
    models,
  };
}

export async function loadOnlineRatings(
  dataDir: string,
): Promise<OnlineRatings> {
  try {
    const raw = await readFile(
      join(dataDir, "online-ratings.json"),
      "utf8",
    );
    const parsed = parseRatings(JSON.parse(raw));
    if (parsed) {
      return {
        ...parsed,
        models: { ...DEFAULT_ONLINE_RATINGS.models, ...parsed.models },
      };
    }
  } catch {
    // Seed on first use or after corrupt state.
  }
  return DEFAULT_ONLINE_RATINGS;
}

export async function saveOnlineRatings(
  dataDir: string,
  ratings: OnlineRatings,
): Promise<void> {
  await writeJsonAtomic(join(dataDir, "online-ratings.json"), ratings);
}

export function onlineRatingFor(
  model: ModelId,
  ratings: OnlineRatings,
): OnlineRating | undefined {
  return ratings.models[model];
}

/**
 * Quality-first ordering. Rated models always precede unrated ones; local
 * pass rate and latency are only tie-breakers inside the same quality band.
 */
export function rankModelsByOnline(
  models: ModelId[],
  online: OnlineRatings,
  localRatings: ModelRating[] = [],
): ModelId[] {
  const local = new Map(localRatings.map((rating) => [rating.model, rating]));
  return [...new Set(models)].sort((a, b) => {
    const oa = online.models[a];
    const ob = online.models[b];
    if (oa && !ob) return -1;
    if (!oa && ob) return 1;
    if (oa && ob && oa.score !== ob.score) return ob.score - oa.score;
    if (oa && ob && (oa.rank ?? Infinity) !== (ob.rank ?? Infinity)) {
      return (oa.rank ?? Infinity) - (ob.rank ?? Infinity);
    }
    const la = local.get(a);
    const lb = local.get(b);
    const pa = la?.partialScore ?? 0;
    const pb = lb?.partialScore ?? 0;
    if (pb !== pa) return pb - pa;
    return (
      (la?.medianLatencyMs ?? Number.POSITIVE_INFINITY) -
      (lb?.medianLatencyMs ?? Number.POSITIVE_INFINITY)
    );
  });
}

function extractRowsArray(html: string): unknown[] {
  const marker = '"rows":[[';
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error("BenchLM rows marker not found");
  const start = markerAt + marker.indexOf("[");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const parsed: unknown = JSON.parse(html.slice(start, index + 1));
        if (!Array.isArray(parsed)) throw new Error("BenchLM rows are not an array");
        return parsed;
      }
    }
  }
  throw new Error("BenchLM rows array did not terminate");
}

export function parseBenchlmRows(html: string): OnlineRatings["models"] {
  const rows = extractRowsArray(html);
  const found: Record<ModelId, OnlineRating> = {};
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const slug = row[2];
    const score = row[14];
    if (typeof slug !== "string") continue;
    const model = BENCHLM_ALIASES[slug];
    if (!model || typeof score !== "number" || !Number.isFinite(score)) continue;
    found[model] = {
      score,
      source: "BenchLM coding (BenchAlign v5.8)",
      url: BENCHLM_URL,
      updatedAt: new Date().toISOString(),
    };
  }
  if (Object.keys(found).length === 0) {
    throw new Error("BenchLM page contained no matched coding scores");
  }
  return found;
}

export async function refreshOnlineRatings(options: {
  dataDir: string;
  url?: string;
  timeoutMs?: number;
}): Promise<OnlineRatings> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (options.url) {
      const response = await fetch(options.url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });
      if (!response.ok) {
        throw new Error(`Online ratings fetch failed: HTTP ${response.status}`);
      }
      const parsed = parseRatings(await response.json());
      if (!parsed) throw new Error("Online ratings JSON has no models");
      await saveOnlineRatings(options.dataDir, parsed);
      return parsed;
    }

    // Scraping only happens when no custom onlineRatingsUrl is configured.
    const response = await fetch(BENCHLM_URL, {
      signal: controller.signal,
      headers: {
        accept: "text/html",
        "user-agent": USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`BenchLM fetch failed: HTTP ${response.status}`);
    }
    const found = parseBenchlmRows(await response.text());
    const merged: OnlineRatings = {
      updatedAt: new Date().toISOString(),
      source: "BenchLM coding + SWE Atlas",
      models: { ...DEFAULT_ONLINE_RATINGS.models, ...found },
    };
    await saveOnlineRatings(options.dataDir, merged);
    return merged;
  } finally {
    clearTimeout(timer);
  }
}
