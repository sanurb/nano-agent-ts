import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { executeReadTool } from "./read-tool.ts";

test("Read preserves arbitrary file bytes without text decoding or formatting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-read-bytes-"));
  const filePath = join(directory, "contents.bin");
  try {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
      await writeFile(filePath, bytes);
      const result = await executeReadTool({
        id: toolCallIdSchema.parse("read-bytes"),
        name: "Read",
        arguments: JSON.stringify({ file_path: filePath }),
      });
      if (!result.ok) throw result.error;
      expect(new Uint8Array(result.value)).toEqual(bytes);
    }), { numRuns: 50 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
