import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentToolCall } from "../agent/agent-message.ts";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

const writeToolArgumentsSchema = z.object({
  file_path: z.string().min(1).refine((path) => !path.includes("\u0000")),
  content: z.string(),
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
export async function executeWriteTool(call: AgentToolCall): Promise<OperationResult<string, ToolExecutionError>> {
  if (call.name !== writeToolDefinition.name) {
    return { ok: false, error: new ToolExecutionError("unsupported_tool") };
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: new ToolExecutionError("invalid_write_arguments") };
  }
  const parsed = writeToolArgumentsSchema.safeParse(argumentsValue);
  if (!parsed.success) return { ok: false, error: new ToolExecutionError("invalid_write_arguments") };

  // Parse everything before opening the file; only the filesystem promise's rejection is translated.
  return writeFile(parsed.data.file_path, parsed.data.content, { encoding: "utf8", flag: "w" }).then(
    () => ({ ok: true, value: "File written successfully." }) as const,
    () => ({ ok: false, error: new ToolExecutionError("write_failed") }) as const,
  );
}
