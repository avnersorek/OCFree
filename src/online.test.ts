import { describe, expect, it } from "vitest";
import { parseBenchlmRows, rankModelsByOnline } from "./online.js";
import type { OnlineRating, OnlineRatings } from "./online.js";

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
