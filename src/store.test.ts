import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJob,
  ensureDataDir,
  getJob,
  listJobs,
  updateJob,
} from "./store.js";
import { addTask } from "./tasks.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ocfree-store-"));
  dirs.push(base);
  const dataDir = join(base, "state");
  await ensureDataDir({ dataDir });
  return dataDir;
}

describe("job store", () => {
  it("creates, updates, reads, and lists jobs newest first", async () => {
    const dataDir = await makeDataDir();
    const first = await createJob(dataDir, "canary", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createJob(dataDir, "task", { taskId: "task-x" });

    const updated = await updateJob(dataDir, first.id, {
      status: "done",
      result: { ok: true },
    });
    expect(updated?.status).toBe("done");
    expect(updated?.result).toEqual({ ok: true });

    expect((await getJob(dataDir, first.id))?.id).toBe(first.id);
    expect((await getJob(dataDir, "job-missing"))).toBeNull();

    const jobs = await listJobs(dataDir, 10);
    expect(jobs.map((job) => job.id)).toEqual([second.id, first.id]);
    expect((await listJobs(dataDir, 1))[0].id).toBe(second.id);
  });
});

describe("task validation", () => {
  it("rejects the filesystem root as a repository", async () => {
    const dataDir = await makeDataDir();
    await expect(
      addTask(dataDir, {
        title: "bad",
        repo: "/",
        prompt: "do something",
      }),
    ).rejects.toThrow(/root/i);
  });

  it("rejects a repository that does not exist", async () => {
    const dataDir = await makeDataDir();
    await expect(
      addTask(dataDir, {
        title: "bad",
        repo: join(dataDir, "missing-repo"),
        prompt: "do something",
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});
