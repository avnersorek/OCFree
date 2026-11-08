import { describe, expect, it } from "vitest";
import { parseBenchlmRows, rankModelsByOnline } from "./online.js";
import type { OnlineRating, OnlineRatings } from "./online.js";
import type { ModelRating } from "./types.js";

function ratings(
  models: Record<string, OnlineRating>,
): OnlineRatings {
  return {
    updatedAt: "2026-11-08T00:00:00.000Z",
    source: "test",
    models,
  };
}

function onlineRating(score: number, rank?: number): OnlineRating {
  return {
    score,
    source: "test",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...(rank !== undefined ? { rank } : {}),
  };
}

function localRating(
  model: string,
  partialScore: number,
  medianLatencyMs: number,
): ModelRating {
  return {
    model,
    available: true,
    score: 0,
    passRate: 0,
    partialScore,
    speedScore: 0,
    formatScore: 0,
    medianLatencyMs,
    totalCost: 0,
    costVerified: true,
    runs: 1,
    failures: 0,
  };
}

describe("rankModelsByOnline", () => {
  it("puts a rated model before an unrated model", () => {
    const ranked = rankModelsByOnline(
      ["unrated-model", "rated-model"],
      ratings({ "rated-model": onlineRating(40) }),
    );
    expect(ranked).toEqual(["rated-model", "unrated-model"]);
  });

  it("sorts rated models by score descending", () => {
    const ranked = rankModelsByOnline(
      ["low", "high", "middle"],
      ratings({
        low: onlineRating(30),
        high: onlineRating(90),
        middle: onlineRating(60),
      }),
    );
    expect(ranked).toEqual(["high", "middle", "low"]);
  });

  it("uses local partialScore before latency as a tie-breaker", () => {
    const online = ratings({
      fast: onlineRating(80),
      accurate: onlineRating(80),
    });
    const ranked = rankModelsByOnline(
      ["fast", "accurate"],
      online,
      [
        localRating("fast", 0.4, 1_000),
        localRating("accurate", 0.9, 20_000),
      ],
    );
    expect(ranked).toEqual(["accurate", "fast"]);
  });

  it("uses latency when local partialScore is tied", () => {
    const online = ratings({
      slow: onlineRating(80),
      quick: onlineRating(80),
    });
    const ranked = rankModelsByOnline(
      ["slow", "quick"],
      online,
      [
        localRating("slow", 0.7, 30_000),
        localRating("quick", 0.7, 2_000),
      ],
    );
    expect(ranked).toEqual(["quick", "slow"]);
  });
});

describe("parseBenchlmRows", () => {
  it("maps a row using score index 14 and slug index 2", () => {
    const row = [
      null,
      null,
      "deepseek-v4-1-flash",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      63.5,
    ];
    const html = `<script>window.__DATA__={"rows":[${JSON.stringify(row)}]}</script>`;
    const models = parseBenchlmRows(html);
    expect(models["deepseek-v4.1-flash-free"]?.score).toBe(63.5);
    expect(models["deepseek-v4.1-flash-free"]?.source).toContain("BenchLM");
  });
});
