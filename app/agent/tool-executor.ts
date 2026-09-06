import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentToolCall } from "./agent-message.ts";
import type { ToolExecutionId } from "./tool-execution-journal.ts";

/** Tool argument JSON is bounded to 1 MiB before parsing or dispatch. */
export const maxToolArgumentBytes = 1_048_576;

/** Decoded argument text cannot exceed the enclosing byte budget; schemas measure UTF-16 code units. */
export const maxToolArgumentCharacters = maxToolArgumentBytes;

/** Private journal/worker envelopes allow bounded outcome text plus rendering metadata. */
export const maxToolOutcomeCharacters = 65_536;

/** Shared provider/worker bound for a registered tool name, in UTF-16 code units. */
export const maxToolNameCharacters = 128;

/** The failed boundary: tool admission, argument parsing, or the tool's own effect. */
export type ToolExecutionFailure =
  | "unsupported_tool"
  | "inactive_tool"
  | "invalid_arguments"
  | "execution_failed"
  | "policy_denied"
  | "sandbox_unavailable"
  | "recovery_required";

/** Expected tool failure; diagnostics never echo model arguments, paths, commands, or file contents. */
export class ToolExecutionError<Reason extends ToolExecutionFailure = ToolExecutionFailure> extends Error {
  /** Stable tool failure tag; reason identifies the failed boundary. */
  readonly _tag = "ToolExecutionError" as const;

  /** Only the factories below construct errors, so every reason keeps its matching diagnostic. */
  private constructor(readonly reason: Reason, message: string) {
    super(message);
  }

  /** No registered tool answers to the requested name. */
  static unsupportedTool(): ToolExecutionError<"unsupported_tool"> {
    return new ToolExecutionError("unsupported_tool", "Unsupported tool call: no executor for requested tool");
  }

  /** The tool exists but was never advertised on the calling lane. */
  static inactiveTool(): ToolExecutionError<"inactive_tool"> {
    return new ToolExecutionError("inactive_tool", "Tool execution denied: tool is not active on this lane");
  }

  /** Explicit grants, not model instructions, determine workspace and shell authority. */
  static policyDenied(): ToolExecutionError<"policy_denied"> {
    return new ToolExecutionError("policy_denied", "Tool execution denied: operation is outside the granted workspace or capabilities");
  }

  /** Required isolation never falls back to host execution. */
  static sandboxUnavailable(): ToolExecutionError<"sandbox_unavailable"> {
    return new ToolExecutionError("sandbox_unavailable", "Tool sandbox unavailable: configure a supported local sandbox image and runtime");
  }

  /** An unresolved invocation requires operator reconciliation, never automatic replay. */
  static recoveryRequired(): ToolExecutionError<"recovery_required"> {
    return new ToolExecutionError("recovery_required", "Tool recovery required: inspect unresolved journal entries before executing new work");
  }

  /** Report what the tool required, never what the model actually sent. */
  static invalidArguments(toolName: string, expectation: string): ToolExecutionError<"invalid_arguments"> {
    return new ToolExecutionError("invalid_arguments", `Invalid ${toolName} arguments: expected ${expectation}`);
  }

  /** Report the class of effect failure, never the offending path, command, or output. */
  static executionFailed(toolName: string, cause: string): ToolExecutionError<"execution_failed"> {
    return new ToolExecutionError("execution_failed", `${toolName} tool failed: ${cause}`);
  }
}

/** A settled tool outcome is model feedback, including a correctable failure, not a run failure. */
export interface ToolOutcome {
  readonly status: "success" | "error" | "cancelled" | "uncertain";
  readonly content: string;
  /** Skip automatic model continuation only when every settled result in a nonempty batch agrees. */
  readonly terminate?: boolean;
}

/** Only admission failures use the error channel; implementation defects may reject. */
export type ToolExecutionResult = OperationResult<ToolOutcome, ToolExecutionError<"unsupported_tool" | "inactive_tool" | "policy_denied" | "sandbox_unavailable" | "recovery_required">>;

/** Record successful tool output without mixing it with the executor's error channel. */
export function successfulToolResult(content: string) {
  return { ok: true, value: { status: "success", content } } as const satisfies ToolExecutionResult;
}

/** Record a model-correctable tool failure using only its safe diagnostic, never raw exception text. */
export function failedToolResult(error: ToolExecutionError<"invalid_arguments" | "execution_failed">) {
  return { ok: true, value: { status: "error", content: error.message } } as const satisfies ToolExecutionResult;
}

/** Cancellation is an outcome, not rollback; callers must inspect any interrupted effects before retrying. */
export function cancelledToolResult() {
  return { ok: true, value: {
    status: "cancelled",
    content: "Tool execution cancelled. In-flight effects may have occurred; inspect state before retrying.",
  } } as const satisfies ToolExecutionResult;
}

/** Adjacent parallel calls may overlap; a sequential call is a barrier on both sides. */
export type ToolExecutionMode = "parallel" | "sequential";

/** Runtime-assigned correlation, never part of model arguments or a grant of additional authority. */
export interface ToolExecutionContext { readonly executionId: ToolExecutionId; }

/** Injected tool execution; implementations own argument parsing, I/O, and safe failures. */
export interface AgentToolExecutor {
  /** Read scheduling policy from the registered implementation, never from model arguments. */
  executionModeFor(toolName: string): ToolExecutionMode;
  /** Settle all owned I/O before returning, including cancellation; correctable failures are outcomes. */
  executeTool(call: AgentToolCall, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult>;
}
