import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentToolCall } from "./agent-message.ts";

/** The failed boundary: tool admission, argument parsing, or the tool's own effect. */
export type ToolExecutionFailure =
  | "unsupported_tool"
  | "invalid_arguments"
  | "read_failed"
  | "inactive_tool"
  | "invalid_write_arguments"
  | "write_failed"
  | "invalid_bash_arguments"
  | "bash_failed";

const toolExecutionMessages = {
  unsupported_tool: "Unsupported tool call: no executor for requested tool",
  invalid_arguments: "Invalid Read arguments: expected JSON with a nonempty file_path without NUL characters",
  read_failed: "Read tool failed: unable to read file",
  inactive_tool: "Tool execution denied: tool is not active on this lane",
  invalid_write_arguments: "Invalid Write arguments: expected JSON with a nonempty file_path without NUL characters and string content",
  write_failed: "Write tool failed: unable to write file",
  invalid_bash_arguments: "Invalid Bash arguments: expected JSON with a nonempty command without NUL characters",
  bash_failed: "Bash tool failed: unable to start the shell command",
} satisfies Record<ToolExecutionFailure, string>;

/** Expected tool failure; diagnostics never echo model arguments, paths, commands, or file contents. */
export class ToolExecutionError extends Error {
  /** Stable tool failure tag; reason identifies the failed boundary. */
  readonly _tag = "ToolExecutionError" as const;

  /** Preserve safe diagnostics for tool admission, argument parsing, and effect failures. */
  constructor(readonly reason: ToolExecutionFailure) {
    super(toolExecutionMessages[reason]);
  }
}

/** Injected tool execution; implementations own argument parsing, I/O, and safe failures. */
export interface AgentToolExecutor {
  executeTool(call: AgentToolCall): Promise<OperationResult<string, ToolExecutionError>>;
}
