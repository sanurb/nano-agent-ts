import { z } from "zod";
import type {
  ConversationBranch,
  ConversationEntry,
  SessionEntryId,
} from "../session/conversation-session.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentMessage, AgentToolCall, AssistantResponse, ToolCallId } from "./agent-message.ts";
import type {
  AgentToolDefinition,
  AssistantProvider,
  AssistantProviderError,
  AssistantRequestResult,
} from "./assistant-provider.ts";
import { cancelledToolResult, failedToolResult, ToolExecutionError, type AgentToolExecutor, type ToolOutcome } from "./tool-executor.ts";

const defaultAssistantSteps = 64;
const defaultParallelTools = 4;
const maximumParallelTools = 32;
const defaultToolCalls = 256;
const maximumToolCalls = 4096;
const defaultRunDurationMs = 120_000;
const maximumRunDurationMs = 3_600_000;
const defaultContextBytes = 1_048_576; // 1 MiB.
const maximumContextBytes = 16_777_216; // 16 MiB.

const assistantStepLimitSchema = z.number().int().positive();
const runLimitsSchema = z.object({
  maxParallelTools: z.number().int().min(1).max(maximumParallelTools).default(defaultParallelTools),
  maxToolCalls: z.number().int().min(1).max(maximumToolCalls).default(defaultToolCalls),
  maxDurationMs: z.number().int().min(1).max(maximumRunDurationMs).default(defaultRunDurationMs),
  maxContextBytes: z.number().int().min(1).max(maximumContextBytes).default(defaultContextBytes),
});

interface AdmittedAgentRun {
  readonly executor: AgentToolExecutor;
  readonly maxAssistantSteps: number;
  readonly limits: z.infer<typeof runLimitsSchema>;
}

/** A finite model-call budget; defaults to 64 assistant steps per run. */
export interface AgentRunOptions {
  readonly maxAssistantSteps?: number;
  readonly maxParallelTools?: number;
  readonly maxToolCalls?: number;
  readonly maxDurationMs?: number;
  readonly maxContextBytes?: number;
  /** Stop new work and propagate interruption to in-flight effects; the lane stays owned until settlement. */
  readonly signal?: AbortSignal;
}

/** Cancellation stops automatic continuation; it does not undo completed or interrupted effects. */
export class AgentRunCancelled extends Error {
  /** Stable run cancellation tag, separate from model failure or a termination hint. */
  readonly _tag = "AgentRunCancelled" as const;

  /** Do not expose AbortSignal.reason, which can contain arbitrary caller data. */
  constructor() {
    super("Agent run cancelled: in-flight work settled; inspect interrupted effects before retrying");
  }
}

/** The run exhausted its model-call budget after settling the last successful tool batch. */
export class AgentRunLimitExceeded extends Error {
  /** Stable run-budget failure tag. */
  readonly _tag = "AgentRunLimitExceeded" as const;

  /** Record the allowed number of logical model requests, excluding SDK transport retries. */
  constructor(readonly maxAssistantSteps: number) {
    super(`Agent run limit exceeded: reached ${maxAssistantSteps} assistant steps`);
  }
}

/** A hard admission or elapsed budget stops continuation without pretending the task succeeded. */
export class AgentRunBudgetExceeded extends Error {
  /** Stable resource budget failure tag. */
  readonly _tag = "AgentRunBudgetExceeded" as const;
  /** Report only the exhausted resource, never prompt or tool payloads. */
  constructor(readonly resource: "time" | "tools" | "context") {
    super(`Agent run budget exceeded: ${resource}`);
  }
}

/** Uncertain effects require inspection, never automatic model continuation or replay. */
export class AgentEffectUncertain extends Error {
  /** Stable reconciliation-required tag. */
  readonly _tag = "AgentEffectUncertain" as const;
  /** Keep effect content in the tool result rather than the diagnostic. */
  constructor() { super("Agent effect uncertain: inspect recorded outcomes before continuing"); }
}

/** A tool batch is executable only after a complete tool-use generation, never a truncated or refused one. */
export class AgentGenerationRejected extends Error {
  /** Stable non-execution classification; retained calls receive matching non-executed results. */
  readonly _tag = "AgentGenerationRejected" as const;
  /** Preserve the provider-neutral reason without including model text. */
  constructor(readonly stopReason: AssistantResponse["stopReason"]) {
    super("Agent generation rejected: expected a complete answer or a complete tool_use response");
  }
}

/** A tool-terminated turn has no fabricated assistant answer; outcomes remain in call order. */
export interface ToolBatchTermination {
  readonly stopReason: "tool_termination";
  readonly outcomes: readonly ToolOutcome[];
}

/** A run returns an assistant answer or tool termination; cancellation and fatal failures stay explicit. */
export type AgentRunResult = OperationResult<
  AssistantResponse | ToolBatchTermination,
  LaneAdmissionError | AssistantProviderError | ToolExecutionError | AgentRunLimitExceeded | AgentRunCancelled | AgentGenerationRejected | AgentRunBudgetExceeded | AgentEffectUncertain
>;

/** Each lane captures its own model and active tool advertisements at creation. */
export interface AgentLaneConfiguration {
  readonly model: string;
  readonly tools: readonly AgentToolDefinition[];
}

const laneAdmissionMessages = {
  busy: "Agent lane busy: wait for the active request to settle",
  pending_tools: "Agent lane awaiting tool results: cannot start new work with an unresolved tool batch",
  empty_prompt: "Invalid lane prompt: prompt must not be empty",
  missing_executor: "Agent run unavailable: no tool executor configured",
  invalid_step_limit: "Invalid agent run limit: expected a positive safe integer",
  invalid_run_limits: "Invalid agent run limits: expected bounded positive integers",
} as const;

/** Safe rejection before any prompt or context change is accepted. */
export class LaneAdmissionError extends Error {
  /** Stable rejection tag; reason distinguishes the caller's recovery action. */
  readonly _tag = "LaneAdmissionError" as const;

  /** Never echo prompt, tool arguments, or handoff text in diagnostics. */
  constructor(readonly reason: keyof typeof laneAdmissionMessages) {
    super(laneAdmissionMessages[reason]);
  }
}

/** Admission failures create no entries; provider failures retain the accepted user entry. */
export type LaneRequestResult = OperationResult<AssistantResponse, AssistantProviderError | LaneAdmissionError>;

/** One atomic in-process observation; callers receive copies, not mutable session references. */
export interface AgentLaneSnapshot {
  readonly name: string;
  readonly tipId: SessionEntryId | null;
  readonly status: "idle" | "requesting" | "awaiting_tools";
  readonly configuration: AgentLaneConfiguration;
  readonly transcript: readonly ConversationEntry[];
  readonly context: readonly AgentMessage[];
}

/** One branch plus exclusive request ownership; unrelated lanes never wait on its provider. */
export class AgentLane {
  readonly #configuration: AgentLaneConfiguration;
  #status: "idle" | "requesting" = "idle";

  /** Only the harness constructs lanes; it never exposes the underlying mutable branch. */
  constructor(
    private readonly branch: ConversationBranch,
    private readonly provider: AssistantProvider,
    configuration: AgentLaneConfiguration,
    private readonly toolExecutor: AgentToolExecutor | null,
  ) {
    this.#configuration = structuredClone(configuration);
  }

  /** Stable lane identity; names are not roles or permission grants. */
  get name(): string {
    return this.branch.name;
  }

  /** Reserve before yielding, append at the tail, then release ownership on every exit path. */
  async requestAssistant(prompt: string): Promise<LaneRequestResult> {
    const rejected = this.admissionError();
    if (rejected) return { ok: false, error: rejected };
    if (!prompt) return { ok: false, error: new LaneAdmissionError("empty_prompt") };
    this.#status = "requesting";
    try {
      this.branch.appendMessage({ role: "user", content: prompt });
      return await this.requestStep();
    } finally {
      this.#status = "idle";
    }
  }

  /** Own the model/tool loop, scheduling adjacent parallel tools without crossing a sequential barrier. */
  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const admitted = this.admitRun(prompt, options);
    if (!admitted.ok) return admitted;
    const { executor, maxAssistantSteps, limits } = admitted.value;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), limits.maxDurationMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const interruption = (): AgentRunResult => ({ ok: false, error: deadline.signal.aborted
      ? new AgentRunBudgetExceeded("time") : new AgentRunCancelled() });
    let toolCalls = 0;
    this.#status = "requesting";
    try {
      this.branch.appendMessage({ role: "user", content: prompt });
      for (let step = 0; step < maxAssistantSteps; step++) {
        if (signal.aborted) return interruption();
        if (Buffer.byteLength(JSON.stringify(this.branch.getContext()), "utf8") > limits.maxContextBytes) {
          return { ok: false, error: new AgentRunBudgetExceeded("context") };
        }
        const response = await this.requestStep(signal);
        if (!response.ok) return signal.aborted ? interruption() : response;
        const completion = this.completeOrRejectGeneration(response.value, signal, interruption);
        if (completion !== null) return completion;
        toolCalls += response.value.toolCalls.length;
        if (toolCalls > limits.maxToolCalls) {
          this.recordUnexecutedCalls(response.value.toolCalls, "Tool not executed: run tool-call budget exhausted.");
          return { ok: false, error: new AgentRunBudgetExceeded("tools") };
        }
        const batch = await this.executeToolBatch(response.value.toolCalls, executor, limits.maxParallelTools, signal);
        if (!batch.ok) return batch;
        if (signal.aborted || batch.value.some((outcome) => outcome.status === "cancelled")) return interruption();
        if (batch.value.some((outcome) => outcome.status === "uncertain")) return { ok: false, error: new AgentEffectUncertain() };
        if (batch.value.length > 0 && batch.value.every((outcome) => outcome.terminate === true)) {
          return { ok: true, value: { stopReason: "tool_termination", outcomes: batch.value } };
        }
      }
      return { ok: false, error: new AgentRunLimitExceeded(maxAssistantSteps) };
    } finally {
      clearTimeout(timer);
      this.#status = "idle";
    }
  }

  private admitRun(prompt: string, options: AgentRunOptions): OperationResult<AdmittedAgentRun, LaneAdmissionError | AgentRunCancelled | AgentRunBudgetExceeded> {
    const rejected = this.admissionError();
    if (rejected) return { ok: false, error: rejected };
    if (!prompt) return { ok: false, error: new LaneAdmissionError("empty_prompt") };
    const executor = this.toolExecutor;
    if (!executor) return { ok: false, error: new LaneAdmissionError("missing_executor") };
    const steps = assistantStepLimitSchema.safeParse(options.maxAssistantSteps ?? defaultAssistantSteps);
    if (!steps.success) return { ok: false, error: new LaneAdmissionError("invalid_step_limit") };
    const limits = runLimitsSchema.safeParse(options);
    if (!limits.success) return { ok: false, error: new LaneAdmissionError("invalid_run_limits") };
    if (options.signal?.aborted) return { ok: false, error: new AgentRunCancelled() };
    if (Buffer.byteLength(prompt, "utf8") > limits.data.maxContextBytes) return { ok: false, error: new AgentRunBudgetExceeded("context") };
    return { ok: true, value: { executor, maxAssistantSteps: steps.data, limits: limits.data } };
  }

  /** Null admits a complete tool-use generation; every rejected call is paired before ownership is released. */
  private completeOrRejectGeneration(response: AssistantResponse, signal: AbortSignal, interruption: () => AgentRunResult): AgentRunResult | null {
    if (signal.aborted) {
      this.recordUnexecutedCalls(response.toolCalls, cancelledToolResult().value.content);
      return interruption();
    }
    if (response.toolCalls.length === 0) {
      return response.stopReason === "stop" ? { ok: true, value: response }
        : { ok: false, error: new AgentGenerationRejected(response.stopReason) };
    }
    if (response.stopReason === "tool_use") return null;
    this.recordUnexecutedCalls(response.toolCalls,
      "Tool not executed: assistant generation did not finish with tool_use. Request a complete new batch.");
    return { ok: false, error: new AgentGenerationRejected(response.stopReason) };
  }

  private recordUnexecutedCalls(calls: readonly AgentToolCall[], content: string): void {
    for (const call of calls) this.branch.appendMessage({ role: "tool", toolCallId: call.id, content });
  }

  /** Explicit no-summary rollover; busy lanes and unresolved tool batches cannot roll over. */
  async startContextWindow(handoff: string): Promise<OperationResult<SessionEntryId, LaneAdmissionError>> {
    const rejected = this.admissionError();
    if (rejected) return { ok: false, error: rejected };
    return { ok: true, value: this.branch.startContextWindow(handoff) };
  }

  /** Read history and its active-context projection without starting work. */
  async getSnapshot(): Promise<AgentLaneSnapshot> {
    const context = this.branch.getContext();
    return {
      name: this.name,
      tipId: this.branch.getTipId(),
      status: this.#status === "requesting" ? "requesting" : this.hasPendingToolCalls(context) ? "awaiting_tools" : "idle",
      configuration: structuredClone(this.#configuration),
      transcript: this.branch.getEntries(),
      context,
    };
  }

  /** Capture policy once; settle a whole group even on defects, then publish in source order. */
  private async executeToolBatch(
    calls: readonly AgentToolCall[],
    executor: AgentToolExecutor,
    maxParallelTools: number,
    signal?: AbortSignal,
  ): Promise<OperationResult<readonly ToolOutcome[], ToolExecutionError>> {
    const scheduled = structuredClone(calls).map((call) => ({ call, mode: executor.executionModeFor(call.name) }));
    if (!signal?.aborted && scheduled.some(({ call }) => !this.#configuration.tools.some((tool) => tool.name === call.name))) {
      return { ok: false, error: ToolExecutionError.inactiveTool() };
    }
    const outcomes: ToolOutcome[] = [];
    let cancelled = false;
    let uncertain = false;
    for (let start = 0; start < scheduled.length;) {
      let end = start + 1;
      if (scheduled[start]?.mode === "parallel") {
        while (scheduled[end]?.mode === "parallel") end++;
      }
      // A rejecting promise must not release lane ownership while a sibling still owns an effect.
      const group = scheduled.slice(start, end);
      const execute = async (call: AgentToolCall) => {
        try {
          const result = cancelled || signal?.aborted ? cancelledToolResult()
            : uncertain ? failedToolResult(ToolExecutionError.executionFailed("Tool batch", "tool not executed because a sibling effect requires reconciliation"))
              : await executor.executeTool(call, signal);
          if (result.ok && result.value.status === "cancelled") cancelled = true;
          if (result.ok && result.value.status === "uncertain") uncertain = true;
          return { status: "settled", call, result } as const;
        } catch (error) {
          return { status: "defect", error } as const;
        }
      };
      const settled: Awaited<ReturnType<typeof execute>>[] = [];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(group.length, maxParallelTools) }, async () => {
        for (;;) {
          const index = cursor++;
          const entry = group[index];
          if (!entry) return;
          settled[index] = await execute(entry.call);
        }
      }));
      for (const entry of settled) {
        if (entry.status === "settled" && entry.result.ok) {
          outcomes.push(entry.result.value);
          if (entry.result.value.status === "cancelled") cancelled = true;
          this.branch.appendMessage({ role: "tool", toolCallId: entry.call.id, content: entry.result.value.content });
        }
      }
      for (const entry of settled) {
        if (entry.status === "defect") throw entry.error;
        if (!entry.result.ok) return entry.result;
      }
      start = end;
    }
    return { ok: true, value: outcomes };
  }

  private async requestStep(signal?: AbortSignal): Promise<AssistantRequestResult> {
    const result = await this.provider.requestAssistant({
      model: this.#configuration.model,
      tools: structuredClone(this.#configuration.tools),
      messages: this.branch.getContext(),
    }, signal);
    if (result.ok) this.branch.appendMessage(result.value);
    return result;
  }

  private admissionError(): LaneAdmissionError | undefined {
    if (this.#status === "requesting") return new LaneAdmissionError("busy");
    if (this.hasPendingToolCalls(this.branch.getContext())) return new LaneAdmissionError("pending_tools");
    return undefined;
  }

  private hasPendingToolCalls(context: readonly AgentMessage[]): boolean {
    const pending = new Set<ToolCallId>();
    for (const message of context) {
      if (message.role === "assistant") {
        for (const call of message.toolCalls) pending.add(call.id);
      } else if (message.role === "tool") {
        pending.delete(message.toolCallId);
      }
    }
    return pending.size > 0;
  }
}
