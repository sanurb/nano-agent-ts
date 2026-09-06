import type { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { maxToolArgumentBytes, cancelledToolResult, failedToolResult, ToolExecutionError, type ToolExecutionMode, type ToolExecutionResult } from "../agent/tool-executor.ts";

/** An advertised tool bound to its own argument parsing; dispatch supplies arguments, never routing. */
export interface AgentTool {
  readonly definition: AgentToolDefinition;
  readonly executionMode: ToolExecutionMode;
  /** Parse untrusted argument text and perform the effect; expected failures are values. */
  execute(argumentsText: string, signal?: AbortSignal): Promise<ToolExecutionResult>;
}

/** Everything one tool contributes: how it is advertised, how it is admitted, and what it does. */
export interface AgentToolSpecification<Arguments> {
  readonly definition: AgentToolDefinition;
  /** Defaults to parallel; sequential tools form a barrier within a scheduled batch. */
  readonly executionMode?: ToolExecutionMode;
  /** The runtime gate over model-supplied arguments, stricter than the advertised schema. */
  readonly argumentsSchema: z.ZodType<Arguments>;
  /** Completes "expected …" in the rejection diagnostic; describes the contract, never the input. */
  readonly argumentsExpectation: string;
  /** Runs only on arguments that already satisfy the schema. */
  run(args: Arguments, signal?: AbortSignal): Promise<ToolExecutionResult>;
}

/** Bind one tool's parsing to its effect so adding a tool never touches dispatch. */
export function defineTool<Arguments>(specification: AgentToolSpecification<Arguments>): AgentTool {
  // Constructed per rejection so the stack points at the offending call, not at module load.
  const reject = (): ToolExecutionResult => failedToolResult(ToolExecutionError.invalidArguments(
    specification.definition.name,
    specification.argumentsExpectation,
  ));
  return {
    definition: specification.definition,
    executionMode: specification.executionMode ?? "parallel",
    async execute(argumentsText: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
      if (signal?.aborted) return cancelledToolResult();
      if (Buffer.byteLength(argumentsText, "utf8") > maxToolArgumentBytes) return failedToolResult(ToolExecutionError.invalidArguments(specification.definition.name, "argument JSON within the 1MB input budget"));
      let argumentsValue: unknown;
      // Only the model's JSON text is guarded; a defect in the tool's own effect must still surface.
      try {
        argumentsValue = JSON.parse(argumentsText);
      } catch {
        return reject();
      }
      const parsed = specification.argumentsSchema.safeParse(argumentsValue);
      if (!parsed.success) return reject();
      return specification.run(parsed.data, signal);
    },
  };
}
