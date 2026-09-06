import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError } from "../agent/tool-executor.ts";
import { defineTool } from "./agent-tool.ts";
import { readFileForMutation, replaceFileAtomically } from "./atomic-file-mutation.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { pathArgumentSchema } from "./tool-output.ts";

const writeToolArgumentsSchema = z.object({
  file_path: pathArgumentSchema,
  content: z.string().refine((content) => content.isWellFormed()),
});

/** Advertise Write with required file_path and content, including empty content. */
export const writeToolDefinition = {
  name: "Write",
  description: "Write content to a file",
  parameters: {
    type: "object",
    required: ["file_path", "content"],
    properties: {
      file_path: { type: "string", description: "The path of the file to write to" },
      content: { type: "string", description: "The content to write to the file" },
    },
  },
} satisfies AgentToolDefinition;

/** Create or overwrite a file as UTF-8 without added formatting; parent directories must exist. */
export const writeTool = defineTool({
  definition: writeToolDefinition,
  executionMode: "sequential",
  argumentsSchema: writeToolArgumentsSchema,
  argumentsExpectation: "JSON with a nonempty file_path without NUL characters and string content",
  // Parse everything before opening the file; only the filesystem promise's rejection is translated.
  run: (args, signal) => withFileMutationQueue(args.file_path, async (target) => {
    if (signal?.aborted) return cancelledToolResult();
    const snapshot = await readFileForMutation(target, signal);
    if (!snapshot.ok) return failedToolResult(ToolExecutionError.executionFailed(writeToolDefinition.name, "unable to write file"));
    const committed = await replaceFileAtomically(target, args.content, snapshot.value, signal);
    return committed.ok && committed.value.status === "success" ? successfulToolResult("File written successfully.") : committed;
  }, signal),
});
