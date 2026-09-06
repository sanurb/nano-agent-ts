import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentToolCall } from "../agent/agent-message.ts";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

const readToolArgumentsSchema = z.object({
  file_path: z.string().min(1).refine((path) => !path.includes("\u0000")),
});

/** Advertise the Read tool's exact protocol name and arguments. */
export const readToolDefinition = {
  name: "Read",
  description: "Read and return the contents of a file",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to read",
      },
    },
    required: ["file_path"],
  },
} satisfies AgentToolDefinition;

/** Execute only Read and return unmodified file bytes; relative paths use the process working directory. */
export async function executeReadTool(call: AgentToolCall): Promise<OperationResult<Uint8Array, ToolExecutionError>> {
  if (call.name !== readToolDefinition.name) {
    return { ok: false, error: new ToolExecutionError("unsupported_tool") };
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: new ToolExecutionError("invalid_arguments") };
  }
  const parsed = readToolArgumentsSchema.safeParse(argumentsValue);
  if (!parsed.success) return { ok: false, error: new ToolExecutionError("invalid_arguments") };

  // Only filesystem rejection is translated; no catch hides defects in parsing or rendering.
  return readFile(parsed.data.file_path).then(
    (bytes) => ({ ok: true, value: bytes }) as const,
    () => ({ ok: false, error: new ToolExecutionError("read_failed") }) as const,
  );
}
