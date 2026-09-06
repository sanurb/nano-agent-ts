import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { readTool } from "./read-tool.ts";

async function readBytes(bytes: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-read-bytes-"));
  const filePath = join(directory, "contents.bin");
  try {
    await writeFile(filePath, bytes);
    const result = await readTool.execute(JSON.stringify({ file_path: filePath }));
    if (!result.ok) throw result.error;
    return result.value.content;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Read returns file text unchanged, without added numbering, truncation, or trailing newline", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 4096 }), async (content) => {
      expect(await readBytes(new TextEncoder().encode(content))).toBe(content);
    }),
    { numRuns: 50 },
  );
});

test("Read retains a leading byte-order mark instead of stripping it", async () => {
  expect(await readBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("﻿hi");
});

test("Read replaces malformed UTF-8 rather than failing on a binary file", async () => {
  expect(await readBytes(new Uint8Array([0x68, 0xff, 0x69]))).toBe("h�i");
});

async function readWindow(content: string, args: { offset?: number; limit?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-read-window-"));
  const filePath = join(directory, "lines.txt");
  try {
    await writeFile(filePath, content, "utf8");
    return await readTool.execute(JSON.stringify({ file_path: filePath, ...args }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fiveLines = "one\ntwo\nthree\nfour\nfive";

test("offset starts the window at a 1-indexed line", async () => {
  expect(await readWindow(fiveLines, { offset: 3 })).toEqual({ ok: true, value: { status: "success", content: "three\nfour\nfive" } });
});

test("limit caps the window and reports where to resume", async () => {
  expect(await readWindow(fiveLines, { limit: 2 })).toEqual({
    ok: true,
    value: { status: "success", content: "one\ntwo\n\n[Showing lines 1-2 of 5. Use offset=3 to continue.]" },
  });
});

test("offset and limit together select an interior window", async () => {
  expect(await readWindow(fiveLines, { offset: 2, limit: 2 })).toEqual({
    ok: true,
    value: { status: "success", content: "two\nthree\n\n[Showing lines 2-3 of 5. Use offset=4 to continue.]" },
  });
});

test("a window reaching the end carries no continuation notice", async () => {
  expect(await readWindow(fiveLines, { offset: 4, limit: 99 })).toEqual({ ok: true, value: { status: "success", content: "four\nfive" } });
});

test("an offset past the end is correctable model feedback instead of an empty result", async () => {
  expect(await readWindow(fiveLines, { offset: 6 })).toMatchObject({
    ok: true,
    value: { status: "error", content: "Read tool failed: offset is past the end of the file" },
  });
});

test("a line over the byte ceiling points at Bash rather than returning a partial line", async () => {
  const result = await readWindow("x".repeat(60 * 1024), {});
  expect(result).toEqual({
    ok: true,
    value: { status: "success", content: "[Line 1 is 60KB, over the 50KB limit. Extract the part you need with Bash instead.]" },
  });
});

test("a sparse multi-gigabyte file is rejected by its opened size before allocating its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bounded-read-"));
  try {
    const path = join(directory, "huge.txt");
    const handle = await open(path, "w");
    try { await handle.truncate(4 * 1024 ** 3); } finally { await handle.close(); }
    expect(await readTool.execute(JSON.stringify({ file_path: path, limit: 1 }))).toMatchObject({
      ok: true, value: { status: "error", content: expect.stringContaining("input budget") },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed arguments are rejected before the file is opened", async () => {
  for (const args of ["not json", JSON.stringify({}), JSON.stringify({ file_path: "x", offset: 0 })]) {
    expect(await readTool.execute(args)).toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining("Invalid Read arguments:") } });
  }
});
