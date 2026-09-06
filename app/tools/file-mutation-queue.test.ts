import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import fc from "fast-check";
import { cancelledToolResult, successfulToolResult } from "../agent/tool-executor.ts";
import { editTool } from "./edit-tool.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { writeTool } from "./write-tool.ts";

async function mutationDirectory<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-mutation-queue-"));
  try { return await use(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("parallel Edit calls through relative and symlink aliases preserve both changes", async () => {
  await mutationDirectory(async (root) => {
    const path = join(root, "file.txt");
    const alias = join(root, "alias.txt");
    await symlink(path, alias);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 999 }), async (value) => {
      await writeFile(path, "alpha\nbeta\n");
      const outcomes = await Promise.all([
        editTool.execute(JSON.stringify({ file_path: relative(process.cwd(), path), edits: [{ old_string: "alpha", new_string: `ALPHA-${value}` }] })),
        editTool.execute(JSON.stringify({ file_path: alias, edits: [{ old_string: "beta", new_string: `BETA-${value}` }] })),
      ]);
      expect(outcomes.map((outcome) => outcome.ok && outcome.value.status)).toEqual(["success", "success"]);
      expect(await readFile(path, "utf8")).toBe(`ALPHA-${value}\nBETA-${value}\n`);
    }), { numRuns: 30 });
  });
});

test("a custom mutation shares the built-in Edit/Write queue while other files proceed", async () => {
  await mutationDirectory(async (root) => {
    const path = join(root, "file.txt");
    const alias = join(root, "alias.txt");
    await writeFile(path, "initial");
    await symlink(path, alias);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const custom = withFileMutationQueue(path, async (target) => {
      expect(await readFile(target, "utf8")).toBe("initial");
      entered.resolve();
      await release.promise;
      await writeFile(target, "custom");
      return successfulToolResult("custom mutation done");
    });
    await entered.promise;
    const edited = editTool.execute(JSON.stringify({ file_path: alias, edits: [{ old_string: "custom", new_string: "edited" }] }));
    const written = writeTool.execute(JSON.stringify({ file_path: path, content: "written" }));
    try {
      expect(await writeTool.execute(JSON.stringify({ file_path: join(root, "other.txt"), content: "independent" })))
        .toMatchObject({ ok: true, value: { status: "success" } });
      expect(await readFile(path, "utf8")).toBe("initial");
    } finally {
      release.resolve();
      await custom;
    }
    expect(await edited).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await written).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(path, "utf8")).toBe("written");
  });
});

test("missing targets use one absolute-path queue, with registration order preserved", async () => {
  await mutationDirectory(async (root) => {
    const target = join(root, "new.txt");
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => writeTool.execute(JSON.stringify({
      file_path: index % 2 ? relative(process.cwd(), target) : target, content: String(index),
    }))));
    expect(outcomes.every((outcome) => outcome.ok && outcome.value.status === "success")).toBe(true);
    expect(await readFile(target, "utf8")).toBe("11");
  });
});

test("aborted queued Write skips its effect and a cancelled mutation retains its lock until I/O settles", async () => {
  await mutationDirectory(async (root) => {
    const target = join(root, "file.txt");
    await writeFile(target, "before");
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withFileMutationQueue(target, async (path) => {
      const before = await readFile(path, "utf8");
      started.resolve();
      await release.promise; // Faithful in-flight work: cancellation does not imply this I/O has settled.
      await writeFile(path, `${before}-settled`);
      return cancelledToolResult();
    });
    await started.promise;
    const abortedWrite = writeTool.execute(JSON.stringify({ file_path: target, content: "must not overwrite" }), controller.signal);
    controller.abort();
    const edit = editTool.execute(JSON.stringify({ file_path: target, edits: [{ old_string: "before-settled", new_string: "after" }] }));
    try {
      expect(await readFile(target, "utf8")).toBe("before");
    } finally {
      release.resolve();
    }
    expect(await held).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await abortedWrite).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await edit).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(target, "utf8")).toBe("after");
  });
});

test("new files through symlinked parents share ownership before the destination exists", async () => {
  await mutationDirectory(async (root) => {
    const alias = join(root, "alias");
    await symlink(root, alias);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withFileMutationQueue(join(root, "new.txt"), async (target) => {
      started.resolve();
      await release.promise;
      await writeFile(target, "first");
      return successfulToolResult("first");
    });
    await started.promise;
    const second = editTool.execute(JSON.stringify({ file_path: join(alias, "new.txt"), edits: [{ old_string: "first", new_string: "second" }] }));
    try {
      await withFileMutationQueue(join(root, "sentinel"), async () => successfulToolResult("registration barrier"));
      expect(await Bun.file(join(root, "new.txt")).exists()).toBe(false);
    } finally { release.resolve(); }
    await first;
    expect(await second).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("second");
  });
});

test("cancelled waiters settle promptly without letting successors bypass a live predecessor", async () => {
  await mutationDirectory(async (root) => {
    const path = join(root, "file.txt");
    await writeFile(path, "initial");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withFileMutationQueue(path, async (target) => {
      started.resolve(); await release.promise;
      await writeFile(target, "first"); return successfulToolResult("first");
    });
    await started.promise;
    const cancellation = new AbortController();
    const cancelled = withFileMutationQueue(path, async () => { throw new Error("Cancelled queue callback must not run"); }, cancellation.signal);
    let successorEntered = false;
    const successor = withFileMutationQueue(path, async (target) => {
      successorEntered = true;
      expect(await readFile(target, "utf8")).toBe("first");
      return successfulToolResult("successor");
    });
    try {
      await withFileMutationQueue(join(root, "sentinel"), async () => successfulToolResult("registered"));
      cancellation.abort();
      expect(await cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } });
      expect(successorEntered).toBe(false);
    } finally { release.resolve(); }
    await Promise.all([first, successor]);
    expect(successorEntered).toBe(true);
  });
});

test("a failed mutation releases its queue without hiding the defect or poisoning the next call", async () => {
  await mutationDirectory(async (root) => {
    const target = join(root, "file.txt");
    const defect = new Error("Mutation queue test defect");
    await expect(withFileMutationQueue(target, async () => { throw defect; })).rejects.toBe(defect);
    expect(await writeTool.execute(JSON.stringify({ file_path: target, content: "recovered" })))
      .toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(target, "utf8")).toBe("recovered");
  });
});
