import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  csvParseTask,
  fixCapitalizeTask,
  jsonPlanTask,
  scoreRatings,
} from "./bench.js";
import type { BenchRun } from "./types.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocfree-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function run(overrides: Partial<BenchRun> & { model: string }): BenchRun {
  const ok = overrides.ok ?? true;
  return {
    taskId: "fix-capitalize",
    run: 1,
    ok: true,
    exitCode: 0,
    timedOut: false,
    latencyMs: 10_000,
    ttfoMs: null,
    attempts: 1,
    toolCalls: 1,
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0 },
    fraction: ok ? 1 : 0,
    tampered: false,
    checks: [],
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("scoreRatings", () => {
  it("computes the exact weighted score and sorts by score", () => {
    const runs: BenchRun[] = [
      run({ model: "a", latencyMs: 10_000 }),
      run({ model: "a", latencyMs: 20_000 }),
      run({ model: "b", ok: false, latencyMs: 50_000 }),
    ];

    const ratings = scoreRatings(runs, ["b", "a"]);

    expect(ratings.map((rating) => rating.model)).toEqual(["a", "b"]);
    expect(ratings[0].score).toBe(98.2);
    expect(ratings[0].passRate).toBe(1);
    expect(ratings[0].speedScore).toBeCloseTo(0.8181818182, 8);
    expect(ratings[0].formatScore).toBe(1);
    expect(ratings[0].medianLatencyMs).toBe(15_000);
    expect(ratings[0].runs).toBe(2);
    expect(ratings[0].failures).toBe(0);

    expect(ratings[1].score).toBe(11.8);
    expect(ratings[1].passRate).toBe(0);
    expect(ratings[1].failures).toBe(1);
  });

  it("penalizes tampered runs in the format score", () => {
    const ratings = scoreRatings(
      [
        run({ model: "a", tampered: true }),
        run({ model: "a" }),
        run({ model: "a", tampered: true }),
      ],
      ["a"],
    );

    expect(ratings[0].formatScore).toBeCloseTo(1 / 3, 8);
  });
});

describe("fix-capitalize verifier", () => {
  it("passes with a corrected index.js", async () => {
    const dir = await tempDir();
    await fixCapitalizeTask.setup(dir);
    await writeFile(
      join(dir, "index.js"),
      `export function capitalizeWords(s) {
  return s.trim().split(/\\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
`,
      "utf8",
    );

    const result = await fixCapitalizeTask.verify(dir);
    expect(result.passed).toBe(true);
    expect(result.tampered).toBe(false);
    expect(result.checks.find((check) => check.name === "tests")?.ok).toBe(true);
  });

  it("fails with the broken starter index.js", async () => {
    const dir = await tempDir();
    await fixCapitalizeTask.setup(dir);

    const result = await fixCapitalizeTask.verify(dir);
    expect(result.passed).toBe(false);
    expect(result.tampered).toBe(false);
  });
});

describe("json-plan verifier", () => {
  const exact = {
    steps: [
      { id: 1, action: "read" },
      { id: 2, action: "edit" },
      { id: 3, action: "test" },
    ],
    risk: "low",
  };

  it("accepts the exact JSON", async () => {
    const dir = await tempDir();
    await jsonPlanTask.setup(dir);
    await writeFile(join(dir, "plan.json"), JSON.stringify(exact), "utf8");

    const result = await jsonPlanTask.verify(dir);
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      { name: "parses", ok: true },
      { name: "schema", ok: true },
    ]);
  });

  it("rejects extra keys", async () => {
    const dir = await tempDir();
    await jsonPlanTask.setup(dir);
    await writeFile(
      join(dir, "plan.json"),
      JSON.stringify({ ...exact, note: "extra" }),
      "utf8",
    );

    const result = await jsonPlanTask.verify(dir);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "schema")?.ok).toBe(
      false,
    );
  });
});

describe("csv-parse verifier", () => {
  it("passes with a correct RFC4180-style parser", async () => {
    const dir = await tempDir();
    await csvParseTask.setup(dir);
    await writeFile(
      join(dir, "index.js"),
      `export function parseCsv(text) {
  if (text === "") return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\\r") {
      if (text[i + 1] === "\\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
`,
      "utf8",
    );

    const result = await csvParseTask.verify(dir);
    expect(result.passed).toBe(true);
    expect(result.tampered).toBe(false);
  });

  it("fails with the empty starter", async () => {
    const dir = await tempDir();
    await csvParseTask.setup(dir);

    const result = await csvParseTask.verify(dir);
    expect(result.passed).toBe(false);
  });
});
