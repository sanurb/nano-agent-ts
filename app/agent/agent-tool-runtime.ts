import type { AgentToolCall } from "./agent-message.ts";
import type { ToolExecutionId } from "./tool-execution-journal.ts";
import {
  cancelledToolResult,
  failedToolResult,
  ToolExecutionError,
  type ToolExecutionAdmissionError,
  type AgentToolExecutor,
  type ToolExecutionContext,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolOutcome,
} from "./tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

/** Batch completion state after every admitted tool call has settled. */
export type AgentToolBatchStatus = "settled" | "cancelled" | "uncertain";

/** Admission, concurrency, cancellation, and publication policy for one tool batch. */
export interface AgentToolBatchOptions {
  readonly activeToolNames: ReadonlySet<string>;
  readonly maxParallelTools: number;
  readonly signal?: AbortSignal;
  /** Durable identity of the active tool call that owns these nested calls. */
  readonly parentExecutionId?: ToolExecutionId;
  /** Agent lane that owns stateful resources reached by this batch. */
  readonly scopeId?: string;
  readonly onOutcome?: (call: AgentToolCall, outcome: ToolOutcome) => void;
}

/** Source-ordered outcomes and the strongest interruption observed in the batch. */
export interface AgentToolBatch {
  readonly status: AgentToolBatchStatus;
  readonly outcomes: readonly ToolOutcome[];
}

/** Invalid application-owned scheduling policy; no tool calls were admitted. */
export class InvalidAgentToolBatchOptions extends Error {
  readonly _tag = "InvalidAgentToolBatchOptions" as const;

  constructor() {
    super("Invalid agent tool batch options: maxParallelTools must be a positive safe integer");
  }
}

/** Mutable state is confined to one batch so concurrent workers observe cancellation and uncertainty. */
interface AgentToolBatchState {
  cancelled: boolean;
  uncertain: boolean;
}

type AgentToolSettlement =
  | { readonly status: "settled"; readonly call: AgentToolCall; readonly result: ToolExecutionResult }
  | { readonly status: "defect"; readonly error: unknown };

interface ScheduledAgentToolCall {
  readonly call: AgentToolCall;
  readonly mode: ToolExecutionMode;
}

interface AdjacentAgentToolGroup {
  readonly calls: readonly AgentToolCall[];
  readonly end: number;
}

/** A reusable scheduler for model-issued and nested agent tool calls. */
export class AgentToolRuntime {
  constructor(private readonly executor: AgentToolExecutor) {}

  /** Run adjacent parallel groups around sequential barriers and publish outcomes in source order. */
  async executeToolBatch(
    calls: readonly AgentToolCall[],
    options: AgentToolBatchOptions,
  ): Promise<OperationResult<AgentToolBatch, ToolExecutionAdmissionError>> {
    if (!Number.isSafeInteger(options.maxParallelTools) || options.maxParallelTools < 1) {
      throw new InvalidAgentToolBatchOptions();
    }
    const activeToolNames = new Set(options.activeToolNames);
    const scheduled: readonly ScheduledAgentToolCall[] = structuredClone(calls).map((call) => ({
      call,
      mode: this.executor.executionModeFor(call.name),
    }));
    if (!options.signal?.aborted && scheduled.some(({ call }) => !activeToolNames.has(call.name))) {
      return { ok: false, error: ToolExecutionError.inactiveTool() };
    }

    const outcomes: ToolOutcome[] = [];
    const state: AgentToolBatchState = { cancelled: false, uncertain: false };
    for (let start = 0; start < scheduled.length;) {
      const group = this.adjacentToolGroup(scheduled, start);
      const settled = await this.executeToolGroup(group.calls, options, state);
      this.publishToolGroup(settled, options, state, outcomes);
      const admissionError = this.toolGroupAdmissionError(settled);
      if (admissionError) return { ok: false, error: admissionError };
      start = group.end;
    }

    return { ok: true, value: { status: this.toolBatchStatus(options.signal, state), outcomes } };
  }

  private adjacentToolGroup(
    scheduled: readonly ScheduledAgentToolCall[],
    start: number,
  ): AdjacentAgentToolGroup {
    let end = start + 1;
    if (scheduled[start]?.mode === "parallel") {
      while (scheduled[end]?.mode === "parallel") end++;
    }
    return { calls: scheduled.slice(start, end).map((entry) => entry.call), end };
  }

  private publishToolGroup(
    settled: readonly AgentToolSettlement[],
    options: AgentToolBatchOptions,
    state: AgentToolBatchState,
    outcomes: ToolOutcome[],
  ): void {
    for (const entry of settled) {
      if (entry.status !== "settled" || !entry.result.ok) continue;
      outcomes.push(entry.result.value);
      if (entry.result.value.status === "cancelled") state.cancelled = true;
      options.onOutcome?.(entry.call, entry.result.value);
    }
  }

  private toolGroupAdmissionError(
    settled: readonly AgentToolSettlement[],
  ): ToolExecutionAdmissionError | undefined {
    for (const entry of settled) {
      if (entry.status === "defect") throw entry.error;
      if (!entry.result.ok) return entry.result.error;
    }
    return undefined;
  }

  private toolBatchStatus(signal: AbortSignal | undefined, state: AgentToolBatchState): AgentToolBatchStatus {
    if (signal?.aborted || state.cancelled) return "cancelled";
    return state.uncertain ? "uncertain" : "settled";
  }

  private async executeToolGroup(
    calls: readonly AgentToolCall[],
    options: AgentToolBatchOptions,
    state: AgentToolBatchState,
  ): Promise<readonly AgentToolSettlement[]> {
    const settled: AgentToolSettlement[] = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(calls.length, options.maxParallelTools) }, async () => {
      for (;;) {
        const index = cursor++;
        const call = calls[index];
        if (!call) return;
        settled[index] = await this.executeToolCall(call, options, state);
      }
    }));
    return settled;
  }

  private async executeToolCall(
    call: AgentToolCall,
    options: AgentToolBatchOptions,
    state: AgentToolBatchState,
  ): Promise<AgentToolSettlement> {
    try {
      const result = state.cancelled || options.signal?.aborted
        ? cancelledToolResult()
        : state.uncertain
          ? failedToolResult(ToolExecutionError.executionFailed(
            "Tool batch",
            "tool not executed because a sibling effect requires reconciliation",
          ))
          : await this.executor.executeTool(call, options.signal, toolExecutionContext(options));
      if (result.ok && result.value.status === "cancelled") state.cancelled = true;
      if (result.ok && result.value.status === "uncertain") state.uncertain = true;
      return { status: "settled", call, result };
    } catch (error) { // no-excuse-ok: catch -- Capture defects until every admitted sibling settles, then rethrow unchanged.
      return { status: "defect", error };
    }
  }
}

function toolExecutionContext(options: AgentToolBatchOptions): ToolExecutionContext | undefined {
  if (options.parentExecutionId !== undefined && options.scopeId !== undefined) {
    return { parentExecutionId: options.parentExecutionId, scopeId: options.scopeId };
  }
  if (options.parentExecutionId !== undefined) return { parentExecutionId: options.parentExecutionId };
  return options.scopeId === undefined ? undefined : { scopeId: options.scopeId };
}
