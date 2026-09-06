import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError, type ToolExecutionResult } from "../agent/tool-executor.ts";
import { defineTool } from "./agent-tool.ts";
import { maxToolFileBytes, readBoundedFile } from "./bounded-file-read.ts";
import { defaultOutputLimits, formatSize, pathArgumentSchema, truncateHead } from "./tool-output.ts";

const readToolArgumentsSchema = z.object({
  file_path: pathArgumentSchema,
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

type ReadToolArguments = z.infer<typeof readToolArgumentsSchema>;

/** Retain any byte-order mark and replace malformed sequences rather than rejecting the file. */
const fileDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Advertise the Read tool's exact protocol name and arguments. */
export const readToolDefinition = {
  name: "Read",
  description:
    `Read and return the contents of a file. Output is capped at ${defaultOutputLimits.maxLines} lines or `
    + `${formatSize(defaultOutputLimits.maxBytes)}, whichever is reached first. Use offset and limit to page through a `
    + "larger file, continuing from the offset reported in the truncation notice. Files exceeding the 8MB input budget are rejected.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to read",
      },
      offset: {
        type: "number",
        description: "The 1-indexed line to start reading from. Defaults to the first line.",
      },
      limit: {
        type: "number",
        description: "The maximum number of lines to read. Defaults to the rest of the file.",
      },
    },
    required: ["file_path"],
  },
} satisfies AgentToolDefinition;

/** Return a file's contents as text; relative paths use the process working directory. */
export const readTool = defineTool({
  definition: readToolDefinition,
  executionMode: "parallel",
  argumentsSchema: readToolArgumentsSchema,
  argumentsExpectation: "JSON with a nonempty file_path without NUL characters, plus optional positive offset and limit",
  // Only filesystem rejection is translated; no catch hides defects in decoding or rendering.
  run: async (args, signal) => {
    const bytes = await readBoundedFile(args.file_path, maxToolFileBytes, signal);
    if (signal?.aborted) return cancelledToolResult();
    if (!bytes.ok) return failedToolResult(ToolExecutionError.executionFailed(readToolDefinition.name,
      bytes.error.reason === "too_large" ? "file exceeds the 8MB input budget" : "unable to read file"));
    return renderFile(fileDecoder.decode(bytes.value), args);
  },
});

/** Select the requested window, then cap it, so the model always learns where to resume. */
function renderFile(content: string, args: ReadToolArguments): ToolExecutionResult {
  const lines = content.split("\n");
  const start = (args.offset ?? 1) - 1;
  if (start >= lines.length) {
    return failedToolResult(ToolExecutionError.executionFailed(readToolDefinition.name, "offset is past the end of the file"));
  }
  const end = args.limit === undefined ? lines.length : Math.min(start + args.limit, lines.length);
  const truncated = truncateHead(lines.slice(start, end).join("\n"));

  if (truncated.firstLineExceedsLimit) {
    const size = formatSize(Buffer.byteLength(lines[start] ?? "", "utf8"));
    return successfulToolResult(`[Line ${start + 1} is ${size}, over the ${formatSize(defaultOutputLimits.maxBytes)} limit. `
      + "Extract the part you need with Bash instead.]");
  }

  const lastShown = start + truncated.outputLines;
  if (lastShown >= lines.length) return successfulToolResult(truncated.text);
  const ceiling = truncated.boundBy === "bytes" ? ` (${formatSize(defaultOutputLimits.maxBytes)} limit)` : "";
  return successfulToolResult(`${truncated.text}\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}${ceiling}. `
    + `Use offset=${lastShown + 1} to continue.]`);
}
