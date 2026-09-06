import { spawn } from "node:child_process";
import { z } from "zod";
import type { AgentToolCall } from "../agent/agent-message.ts";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

const bashToolArgumentsSchema = z.object({
  command: z.string().min(1).refine((command) => !command.includes("\u0000")),
});

/** Advertise Bash with a single required shell command string. */
export const bashToolDefinition = {
  name: "Bash",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "The command to execute" },
    },
  },
} satisfies AgentToolDefinition;

/** Run one command through `/bin/sh` in the process working directory and return its combined output. */
export async function executeBashTool(call: AgentToolCall): Promise<OperationResult<string, ToolExecutionError>> {
  if (call.name !== bashToolDefinition.name) {
    return { ok: false, error: new ToolExecutionError("unsupported_tool") };
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: new ToolExecutionError("invalid_bash_arguments") };
  }
  const parsed = bashToolArgumentsSchema.safeParse(argumentsValue);
  if (!parsed.success) return { ok: false, error: new ToolExecutionError("invalid_bash_arguments") };

  return runShellCommand(parsed.data.command);
}

/** A command that ran is a completed tool call: nonzero exits report status to the model instead of failing the run. */
function runShellCommand(command: string): Promise<OperationResult<string, ToolExecutionError>> {
  return new Promise((resolve) => {
    // Closed stdin makes input-reading commands fail immediately instead of blocking the run.
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Uint8Array) => output.push(chunk));
    child.stderr.on("data", (chunk: Uint8Array) => output.push(chunk));
    child.on("error", () => resolve({ ok: false, error: new ToolExecutionError("bash_failed") }));
    child.on("close", (code, signal) => {
      const text = new TextDecoder().decode(Buffer.concat(output));
      const status = signal !== null
        ? `Command terminated by signal ${signal}`
        : code === 0
          ? ""
          : `Command exited with code ${code}`;
      resolve({ ok: true, value: renderOutcome(text, status) });
    });
  });
}

/** Keep results nonempty so a silent success stays distinguishable from a missing result. */
function renderOutcome(output: string, status: string): string {
  if (!status) return output || "(no output)";
  return output ? `${output}\n${status}` : status;
}
