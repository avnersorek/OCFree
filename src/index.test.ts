import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("ocfree", () => {
  it("declares the six ocfree tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "ocfree_models",
      "ocfree_bench",
      "ocfree_report",
      "ocfree_online",
      "ocfree_tasks",
      "ocfree_job",
    ]);
  });
});
