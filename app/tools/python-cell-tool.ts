import { z } from "zod";
import { AgentToolRuntime } from "../agent/agent-tool-runtime.ts";
import { toolCallIdSchema, type AgentToolCall } from "../agent/agent-message.ts";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import {
  cancelledToolResult,
  failedToolResult,
  successfulToolResult,
  ToolExecutionError,
  type AgentToolExecutor,
  type ToolCapabilityDescription,
  type ToolExecutionContext,
  type ToolExecutionMode,
  type ToolExecutionResult,
} from "../agent/tool-executor.ts";
import type { PythonCellCapabilityHandler } from "./python-cell-capability-server.ts";
import type { PythonCellProcessResult } from "./python-cell-output.ts";
import {
  clampPythonCellErrorCause,
  renderPythonCellOutput,
} from "./python-cell-output-renderer.ts";
import type { PythonCellJsonValue } from "./python-cell-protocol.ts";
import { maxPythonCellCodeBytes, pythonCellDeadlineMs } from "./python-cell-protocol.ts";
import { defineTool, type AgentTool } from "./agent-tool.ts";

/** Stable provider-facing name for persistent IPython execution through the capability membrane. */
export const evalToolName = "Eval";

const evalArgumentsSchema = z.object({
  action: z.enum(["run", "reset"]),
  language: z.literal("python"),
  code: z.string().min(1).refine((code) => Buffer.byteLength(code, "utf8") <= maxPythonCellCodeBytes).optional(),
}).superRefine((value, context) => {
  if (value.action === "run" && value.code === undefined) {
    context.addIssue({ code: "custom", path: ["code"], message: "run requires code" });
  }
  if (value.action === "reset" && value.code !== undefined) {
    context.addIssue({ code: "custom", path: ["code"], message: "reset does not accept code" });
  }
});

/** Provider definition for one lane-bound IPython kernel. */
export const evalToolDefinition: AgentToolDefinition = {
  name: evalToolName,
  description: "Run or reset the persistent IPython kernel owned by this agent lane. Cells retain history, support top-level await, % and %% magics, shell syntax, and rich MIME displays. Read-only host capabilities are available through cap.read, cap.glob, and cap.grep; stdin is unavailable.",
  parameters: {
    type: "object",
    required: ["action", "language"],
    properties: {
      action: { type: "string", enum: ["run", "reset"] },
      language: { type: "string", enum: ["python"] },
      code: { type: "string", description: "Python source; the final expression is returned." },
    },
  },
};

const nestedCapabilityTools = [
  { alias: "read", name: "Read" },
  { alias: "glob", name: "Glob" },
  { alias: "grep", name: "Grep" },
] as const;
const nestedCapabilityNames = new Set(nestedCapabilityTools.map((tool) => tool.name));

interface NestedCellState {
  status: "settled" | "cancelled" | "uncertain";
}

/** Host adapter that starts an externally isolated IPython process. */
export interface PythonCellRunner {
  readonly capabilityDescription: string;
  run(input: {
    readonly scopeId: string;
    readonly runId: string;
    readonly code: string;
    readonly tools: readonly { readonly alias: string; readonly name: string }[];
    readonly timeoutMs: number;
    readonly signal: AbortSignal | undefined;
    readonly callCapability: PythonCellCapabilityHandler;
  }): Promise<PythonCellRunnerResult>;
  reset(scopeId: string): Promise<number>;
  close(): Promise<void>;
}

/** Cell result annotated with the lane's kernel generation. */
export type PythonCellRunnerResult = PythonCellProcessResult & { readonly generation: number };

/** Normal capability failure surfaced inside Python as a catchable exception. */
export class PythonCellCapabilityError extends Error {
  readonly _tag = "PythonCellCapabilityError" as const;

  constructor(message: string) {
    super(`Python cell capability failed: ${message}`);
  }
}

/** Serve Eval in front of another executor while nested calls re-enter the final journaled runtime. */
export class PythonCellToolExecutor implements AgentToolExecutor {
  readonly #evalTool: AgentTool;
  readonly #capabilityDescription: string;

  constructor(
    private readonly executor: AgentToolExecutor,
    runner: PythonCellRunner,
    getRuntime: () => AgentToolRuntime | undefined,
  ) {
    this.#evalTool = createEvalTool(runner, getRuntime);
    this.#capabilityDescription = runner.capabilityDescription;
  }

  /** Preserve underlying capability facts and add the Python cell isolation contract. */
  describeCapabilities(): readonly ToolCapabilityDescription[] {
    return [
      ...(this.executor.describeCapabilities?.() ?? []),
      { toolName: evalToolName, description: `${this.#evalTool.definition.description} ${this.#capabilityDescription}` },
    ];
  }

  /** Eval is sequential because its nested calls define their own ordering. */
  executionModeFor(toolName: string): ToolExecutionMode {
    return toolName === evalToolName ? "sequential" : this.executor.executionModeFor(toolName);
  }

  /** Execute Eval locally as an orchestrator; pass every other call through unchanged. */
  async executeTool(
    call: AgentToolCall,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === evalToolName) return this.#evalTool.execute(call.arguments, signal, context);
    return this.executor.executeTool(call, signal, context);
  }
}

function createEvalTool(
  runner: PythonCellRunner,
  getRuntime: () => AgentToolRuntime | undefined,
): AgentTool {
  return defineTool({
    definition: evalToolDefinition,
    executionMode: "sequential",
    argumentsSchema: evalArgumentsSchema,
    argumentsExpectation: "JSON with action='run' and code, or action='reset', plus language='python'",
    run: async ({ action, code }, signal, context) => {
      const parentExecutionId = context?.executionId;
      const scopeId = context?.scopeId;
      const runtime = getRuntime();
      if (parentExecutionId === undefined || scopeId === undefined || runtime === undefined) {
        return { ok: false, error: ToolExecutionError.recoveryRequired() };
      }
      if (action === "reset") {
        const generation = await runner.reset(scopeId);
        return successfulToolResult(`IPython kernel reset; next generation is ${generation}.`);
      }
      if (code === undefined) return failedToolResult(ToolExecutionError.invalidArguments(evalToolName, "run code"));
      const nestedState: NestedCellState = { status: "settled" };
      const callCapability: PythonCellCapabilityHandler = async (capabilityCall, capabilitySignal) => {
        const call = {
          id: toolCallIdSchema.parse(capabilityCall.callId),
          name: capabilityCall.name,
          arguments: JSON.stringify(capabilityCall.arguments),
        };
        const batch = await runtime.executeToolBatch([call], {
          activeToolNames: nestedCapabilityNames,
          maxParallelTools: 1,
          parentExecutionId,
          scopeId,
          signal: capabilitySignal,
        });
        if (!batch.ok) throw new PythonCellCapabilityError(batch.error.message);
        if (batch.value.status === "uncertain") nestedState.status = "uncertain";
        else if (batch.value.status === "cancelled" && nestedState.status === "settled") nestedState.status = "cancelled";
        const outcome = batch.value.outcomes[0];
        if (outcome === undefined) throw new PythonCellCapabilityError("nested call returned no outcome");
        if (outcome.status !== "success") throw new PythonCellCapabilityError(outcome.content);
        return outcome.content satisfies PythonCellJsonValue;
      };
      const result = await runner.run({
        scopeId,
        runId: parentExecutionId,
        code,
        tools: nestedCapabilityTools,
        timeoutMs: pythonCellDeadlineMs,
        signal,
        callCapability,
      });
      if (nestedState.status === "uncertain") {
        return { ok: true, value: { status: "uncertain", content: "IPython cell nested effect requires reconciliation." } };
      }
      if (nestedState.status === "cancelled") return cancelledToolResult();
      return pythonCellToolResult(result);
    },
  });
}

function pythonCellToolResult(result: PythonCellProcessResult): ToolExecutionResult {
  const content = renderPythonCellOutput(result);
  switch (result.status) {
    case "success":
      return successfulToolResult(content || `IPython cell ${result.executionCount} completed without output.`);
    case "error":
    case "limit":
    case "unavailable":
      return failedToolResult(ToolExecutionError.executionFailed(
        evalToolName,
        clampPythonCellErrorCause(`${result.error}${content ? `\n${content}` : ""}`),
      ));
    case "cancelled":
      return cancelledToolResult();
    case "uncertain":
      return {
        ok: true,
        value: {
          status: "uncertain",
          content: clampPythonCellErrorCause(
            `IPython cell outcome uncertain: ${result.error}${content ? `\n${content}` : ""}`,
          ),
        },
      };
    default:
      return result satisfies never;
  }
}
