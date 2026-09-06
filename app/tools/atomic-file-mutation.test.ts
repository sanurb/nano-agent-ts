import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileForMutation, replaceFileAtomically } from "./atomic-file-mutation.ts";
import { editTool } from "./edit-tool.ts";
import { writeTool } from "./write-tool.ts";

async function withFile(run: (root: string, path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-atomic-"));
  try { await run(root, join(root, "file.txt")); } finally { await rm(root, { recursive: true, force: true }); }
}

test("stale replacements preserve the external editor's bytes and leave no staging file", async () => {
  await withFile(async (root, path) => {
    await writeFile(path, "original");
    const snapshot = await readFileForMutation(path);
    if (!snapshot.ok) throw snapshot.error;
    await writeFile(path, "external change");
    const result = await replaceFileAtomically(path, "agent change", snapshot.value);
    expect(result).toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining("target changed") } });
    expect(await readFile(path, "utf8")).toBe("external change");
    expect(await readdir(root)).toEqual(["file.txt"]);
  });
});

test("cancellation after staging admission preserves original bytes and removes the temporary file", async () => {
  await withFile(async (root, path) => {
    await writeFile(path, "original");
    const snapshot = await readFileForMutation(path);
    if (!snapshot.ok) throw snapshot.error;
    const cancellation = new AbortController();
    const pending = replaceFileAtomically(path, "x".repeat(8 * 1024 * 1024), snapshot.value, cancellation.signal);
    queueMicrotask(() => cancellation.abort());
    expect(await pending).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["file.txt"]);
  });
});

test("an OS-enforced partial write failure leaves the original intact and cleans staging", async () => {
  await withFile(async (root, path) => {
    await writeFile(path, "original");
    const module = fileURLToPath(new URL("./atomic-file-mutation.ts", import.meta.url));
    const script = `
      const ignore = () => {}; process.on('SIGXFSZ', ignore);
      const {readFileForMutation, replaceFileAtomically} = await import(${JSON.stringify(module)});
      const snapshot = await readFileForMutation(${JSON.stringify(path)});
      if (!snapshot.ok) throw snapshot.error;
      console.log(JSON.stringify(await replaceFileAtomically(${JSON.stringify(path)}, 'x'.repeat(16384), snapshot.value)));
      process.off('SIGXFSZ', ignore);
    `;
    const child = Bun.spawn(["/bin/bash", "-c", 'ulimit -f 1; exec "$@"', "limited-writer", process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: {} });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, value: { status: "error" } });
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["file.txt"]);
  });
});

test("Edit preserves untouched mixed line endings and executable permissions", async () => {
  await withFile(async (_root, path) => {
    await writeFile(path, "a\r\nb\nc\r\n");
    await chmod(path, 0o755);
    const result = await editTool.execute(JSON.stringify({ file_path: path, edits: [{ old_string: "b", new_string: "B" }] }));
    expect(result).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(path, "utf8")).toBe("a\r\nB\nc\r\n");
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });
});

test("atomic Write refuses hard links rather than silently detaching an alias", async () => {
  await withFile(async (root, path) => {
    await writeFile(path, "original");
    const alias = join(root, "alias");
    await link(path, alias);
    expect(await writeTool.execute(JSON.stringify({ file_path: path, content: "replacement" })))
      .toMatchObject({ ok: true, value: { status: "error" } });
    expect(await readFile(alias, "utf8")).toBe("original");
    expect(await readFile(path, "utf8")).toBe("original");
  });
});
