import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("ocfree", () => {
  it("declares the five ocfree tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "ocfree_models",
      "ocfree_canary",
      "ocfree_online",
      "ocfree_tasks",
      "ocfree_job",
    ]);
  });
});
