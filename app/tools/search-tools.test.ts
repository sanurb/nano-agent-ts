import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "./glob-tool.ts";
import { grepTool } from "./grep-tool.ts";

/** One tree covering the cases both search tools must agree on: nesting, noise directories, and binary content. */
async function withTree<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "codecrafters-search-"));
  try {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "src", "alpha.ts"), "export const alpha = 1;\nconst TODO = 'first';\n");
    await writeFile(join(root, "src", "nested", "beta.ts"), "export const beta = 2;\nconst todo = 'second';\n");
    await writeFile(join(root, "src", "notes.md"), "TODO: write docs\n");
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "const TODO = 'dependency';\n");
    await writeFile(join(root, ".git", "COMMIT_EDITMSG"), "TODO: committed\n");
    await writeFile(join(root, "logo.bin"), new Uint8Array([0x89, 0x50, 0x4e, 0xff, 0xfe, 0x00]));
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function glob(root: string, pattern: string, limit?: number) {
  return globTool.execute(JSON.stringify({ pattern, path: root, limit }));
}

test("Glob returns matching paths relative to the search directory, alphabetically", async () => {
  await withTree(async (root) => {
    expect(await glob(root, "**/*.ts")).toEqual({ ok: true, value: { status: "success", content: "src/alpha.ts\nsrc/nested/beta.ts" } });
  });
});

test("Glob skips version-control and dependency directories", async () => {
  await withTree(async (root) => {
    const result = await glob(root, "**/*");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The walk reaches every ordinary file, so the absent entries are filtered rather than never visited.
    expect(result.value.content.split("\n")).toEqual(["logo.bin", "src/alpha.ts", "src/nested/beta.ts", "src/notes.md"]);
  });
});

test("Glob reports an empty search as a result, not a failure", async () => {
  await withTree(async (root) => {
    expect(await glob(root, "**/*.rs")).toEqual({ ok: true, value: { status: "success", content: "No files matched." } });
  });
});

test("Glob caps the result set and says so", async () => {
  await withTree(async (root) => {
    const result = await glob(root, "**/*.ts", 1);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.content.split("\n")[0]).toBe("src/alpha.ts");
    expect(result.value.content).toContain("[Showing 1 of 1+ matches.");
  });
});

test("Glob fails safely when the search directory does not exist", async () => {
  expect(await glob(join(tmpdir(), "codecrafters-search-absent"), "**/*")).toMatchObject({
    ok: true,
    value: { status: "error", content: "Glob tool failed: unable to search the requested path" },
  });
});

test("Grep locates matches as path:line:text", async () => {
  await withTree(async (root) => {
    expect(await grepTool.execute(JSON.stringify({ pattern: "const TODO", path: root }))).toEqual({
      ok: true,
      value: { status: "success", content: "src/alpha.ts:2:const TODO = 'first';" },
    });
  });
});

test("Grep matches case-insensitively on request", async () => {
  await withTree(async (root) => {
    const result = await grepTool.execute(JSON.stringify({ pattern: "todo", path: root, ignore_case: true, glob: "src/**/*.ts" }));
    expect(result).toEqual({
      ok: true,
      value: { status: "success", content: "src/alpha.ts:2:const TODO = 'first';\nsrc/nested/beta.ts:2:const todo = 'second';" },
    });
  });
});

test("Grep treats the pattern as literal text when asked", async () => {
  await withTree(async (root) => {
    expect(await grepTool.execute(JSON.stringify({ pattern: "TODO:", path: root, literal: true }))).toEqual({
      ok: true,
      value: { status: "success", content: "src/notes.md:1:TODO: write docs" },
    });
  });
});

test("Grep skips binary files rather than emitting replacement characters", async () => {
  await withTree(async (root) => {
    const result = await grepTool.execute(JSON.stringify({ pattern: "P", path: root, glob: "*.bin" }));
    expect(result).toEqual({ ok: true, value: { status: "success", content: "No matches found." } });
  });
});

test("Grep reports an unusable pattern instead of searching", async () => {
  expect(await grepTool.execute(JSON.stringify({ pattern: "([unclosed" }))).toMatchObject({
    ok: true,
    value: { status: "error", content: "Grep tool failed: pattern is not a valid regular expression" },
  });
});

test("Grep and Glob settle cancellation during a real directory scan rather than report partial success", async () => {
  await withTree(async (root) => {
    for (const tool of [grepTool, globTool]) {
      const controller = new AbortController();
      const work = tool.execute(JSON.stringify({ pattern: "TODO", path: root }), controller.signal);
      // execute has entered the asynchronous filesystem scan before control returns here.
      controller.abort("not model-visible");
      expect(await work).toMatchObject({ ok: true, value: { status: "cancelled" } });
    }
  });
});

test("catastrophic regex backtracking is terminated without blocking coordinator timers", async () => {
  await withTree(async (root) => {
    await writeFile(join(root, "pathological.txt"), `${"a".repeat(1000)}!\n`.repeat(100));
    let heartbeat = false;
    const timer = setTimeout(() => { heartbeat = true; }, 25);
    try {
      const result = await grepTool.execute(JSON.stringify({ pattern: "^(a+)+$", path: root, glob: "pathological.txt" }));
      expect(heartbeat).toBe(true);
      expect(result).toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining("matching budget") } });
    } finally { clearTimeout(timer); }
  });
}, 5000);

test("directory-depth exhaustion is disclosed instead of reported as a complete empty search", async () => {
  await withTree(async (root) => {
    const deep = join(root, ...Array.from({ length: 66 }, () => "nested"));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "hidden.rs"), "target");
    expect(await glob(root, "**/*.rs")).toMatchObject({ ok: true, value: { content: expect.stringContaining("Search incomplete") } });
  });
});

test("Grep caps matches and tells the model how to see the rest", async () => {
  await withTree(async (root) => {
    const result = await grepTool.execute(JSON.stringify({ pattern: "TODO", path: root, ignore_case: true, limit: 1 }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.content).toContain("capped at 1");
  });
});
