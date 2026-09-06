import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { executeWriteTool } from "./write-tool.ts";

test("Write creates then replaces a file with exactly the UTF-8 encoding of each supplied string", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-write-roundtrip-"));
  const filePath = join(directory, "output.txt");
  try {
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 4096 }), fc.string({ maxLength: 4096 }), async (first, replacement) => {
      await rm(filePath, { force: true });
      for (const content of [first, replacement]) {
        const result = await executeWriteTool({
          id: toolCallIdSchema.parse("write-content"),
          name: "Write",
          arguments: JSON.stringify({ file_path: filePath, content }),
        });
        expect(result).toEqual({ ok: true, value: "File written successfully." });
        expect(new Uint8Array(await readFile(filePath))).toEqual(new TextEncoder().encode(content));
      }
    }), { numRuns: 50 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
