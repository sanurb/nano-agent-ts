import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit-tool.ts";
import fc from "fast-check";

const byteOrderMark = "\uFEFF";

interface Replacement {
  readonly old_string: string;
  readonly new_string: string;
}

/** The lenient forms Edit accepts from a model: a batch, a lone replacement, or either as JSON text. */
type SuppliedEdits = readonly Replacement[] | Replacement | string;

async function withFile<T>(contents: string | Uint8Array, use: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-edit-"));
  const filePath = join(directory, "source.ts");
  try {
    await writeFile(filePath, contents);
    return await use(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function edit(file_path: string, edits: SuppliedEdits) {
  return editTool.execute(JSON.stringify({ file_path, edits }));
}

test("every edit is matched against the original file, not against earlier replacements", async () => {
  await withFile("const a = 1;\nconst b = 2;\n", async (path) => {
    const result = await edit(path, [
      { old_string: "const a = 1;", new_string: "const b = 2;" },
      { old_string: "const b = 2;", new_string: "const c = 3;" },
    ]);
    expect(result).toEqual({ ok: true, value: { status: "success", content: "Replaced 2 block(s) successfully." } });
    expect(await readFile(path, "utf8")).toBe("const b = 2;\nconst c = 3;\n");
  });
});

test("a CRLF file keeps CRLF even though old_string uses plain newlines", async () => {
  await withFile("one\r\ntwo\r\nthree\r\n", async (path) => {
    expect(await edit(path, [{ old_string: "one\ntwo", new_string: "one\ntwo and a half" }])).toMatchObject({ ok: true });
    expect(await readFile(path, "utf8")).toBe("one\r\ntwo and a half\r\nthree\r\n");
  });
});

test("a byte-order mark survives an edit that does not mention it", async () => {
  await withFile(`${byteOrderMark}export const value = 1;\n`, async (path) => {
    expect(await edit(path, [{ old_string: "value = 1", new_string: "value = 2" }])).toMatchObject({ ok: true });
    expect(await readFile(path, "utf8")).toBe(`${byteOrderMark}export const value = 2;\n`);
  });
});

test("a lone replacement object is accepted in place of an array", async () => {
  await withFile("hello\n", async (path) => {
    expect(await edit(path, { old_string: "hello", new_string: "goodbye" })).toMatchObject({ ok: true });
    expect(await readFile(path, "utf8")).toBe("goodbye\n");
  });
});

test("edits sent as JSON text are decoded before validation", async () => {
  await withFile("hello\n", async (path) => {
    const result = await edit(path, JSON.stringify([{ old_string: "hello", new_string: "goodbye" }]));
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(path, "utf8")).toBe("goodbye\n");
  });
});

test.each([
  {
    name: "text that appears more than once",
    edits: [{ old_string: "x", new_string: "y" }],
    contents: "x\nx\n",
    message: "Edit tool failed: edits[0] matches at least 2 places; each edit must match exactly one",
  },
  {
    name: "text that appears nowhere",
    edits: [{ old_string: "x", new_string: "z" }, { old_string: "absent", new_string: "y" }],
    contents: "x\n",
    message: "Edit tool failed: edits[1] matches no text in the file",
  },
  {
    name: "replacements that overlap",
    edits: [{ old_string: "abcd", new_string: "1" }, { old_string: "cdef", new_string: "2" }],
    contents: "abcdef\n",
    message: "Edit tool failed: edits[1] overlaps edits[0]",
  },
  {
    name: "a replacement that changes nothing",
    edits: [{ old_string: "same", new_string: "same" }],
    contents: "same\n",
    message: "Edit tool failed: no edit changed the file",
  },
])("the file is left untouched by $name", async ({ edits, contents, message }) => {
  await withFile(contents, async (path) => {
    expect(await edit(path, edits)).toMatchObject({ ok: true, value: { status: "error", content: message } });
    expect(await readFile(path, "utf8")).toBe(contents);
  });
});

test("a file that does not decode as UTF-8 is refused rather than rewritten", async () => {
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  await withFile(latin1, async (path) => {
    expect(await edit(path, [{ old_string: "caf", new_string: "tea" }])).toMatchObject({
      ok: true,
      value: { status: "error", content: "Edit tool failed: file is not valid UTF-8 text" },
    });
    expect(new Uint8Array(await readFile(path))).toEqual(latin1);
  });
});

test("overlapping occurrences are ambiguous even when non-overlapping split finds only one", async () => {
  await withFile("aaa", async (path) => {
    expect(await edit(path, [{ old_string: "aa", new_string: "X" }])).toMatchObject({
      ok: true, value: { status: "error", content: "Edit tool failed: edits[0] matches at least 2 places; each edit must match exactly one" },
    });
    expect(await readFile(path, "utf8")).toBe("aaa");
  });
});

test("literal uniqueness agrees with an exhaustive small-string oracle", async () => {
  const text = fc.array(fc.constantFrom("a", "b"), { maxLength: 40 }).map((parts) => parts.join(""));
  const needle = fc.array(fc.constantFrom("a", "b"), { minLength: 1, maxLength: 8 }).map((parts) => parts.join(""));
  await fc.assert(fc.asyncProperty(text, needle, async (content, old_string) => {
    const positions = Array.from({ length: content.length }, (_, index) => index).filter((index) => content.startsWith(old_string, index));
    await withFile(content, async (path) => {
      const result = await edit(path, [{ old_string, new_string: "X" }]);
      const start = positions[0];
      if (positions.length === 1 && start !== undefined) {
        expect(result).toMatchObject({ ok: true, value: { status: "success" } });
        expect(await readFile(path, "utf8")).toBe(content.slice(0, start) + "X" + content.slice(start + old_string.length));
      } else {
        expect(result).toMatchObject({ ok: true, value: { status: "error" } });
        expect(await readFile(path, "utf8")).toBe(content);
      }
    });
  }), { numRuns: 100 });
});

test("long repetitive literals settle within a parent-enforced CPU deadline", async () => {
  await withFile("a".repeat(1_500_000), async (path) => {
    const script = `const {editTool}=await import(${JSON.stringify(new URL("./edit-tool.ts", import.meta.url).href)});
      const results=[];
      for (const old_string of ['a'.repeat(500000), 'a'.repeat(250000)+'b'+'a'.repeat(250000)]) results.push(await editTool.execute(JSON.stringify({file_path:${JSON.stringify(path)},edits:[{old_string,new_string:'X'}]})));
      console.log(JSON.stringify(results));`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: {} });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(timedOut).toBe(false); expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject([{ ok: true, value: { status: "error" } }, { ok: true, value: { status: "error" } }]);
      expect(await readFile(path, "utf8")).toBe("a".repeat(1_500_000));
    } finally { clearTimeout(deadline); child.kill("SIGKILL"); await child.exited; }
  });
});

test("Edit rejects surrogate fragments and excessive matching work without changing bytes", async () => {
  await withFile("😀", async (path) => {
    for (const replacement of [{ old_string: "\ud83d", new_string: "X" }, { old_string: "😀", new_string: "\ud83d" }]) {
      expect(await edit(path, [replacement])).toMatchObject({ ok: true, value: { status: "error" } });
      expect(await readFile(path, "utf8")).toBe("😀");
    }
  });
  await withFile("a".repeat(1024 * 1024), async (path) => {
    expect(await edit(path, Array.from({ length: 33 }, () => ({ old_string: "a", new_string: "b" }))))
      .toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining("matching work budget") } });
    expect(await readFile(path, "utf8")).toBe("a".repeat(1024 * 1024));
  });
});

test("a missing file fails before any write is attempted", async () => {
  expect(await edit(join(tmpdir(), "codecrafters-edit-absent", "none.ts"), [{ old_string: "a", new_string: "b" }]))
    .toMatchObject({ ok: true, value: { status: "error", content: "Edit tool failed: unable to read file" } });
});

test("malformed arguments are rejected before the file is opened", async () => {
  for (const args of ["not json", JSON.stringify({ file_path: "x" }), JSON.stringify({ file_path: "x", edits: [] })]) {
    expect(await editTool.execute(args)).toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining("Invalid Edit arguments:") } });
  }
});
