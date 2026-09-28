import { z } from "zod";
import type {
  ConversationBranch,
  ConversationEntry,
  SessionEntryId,
} from "../session/conversation-session.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentMessage, AgentToolCall, AssistantResponse, ToolCallId } from "./agent-message.ts";
import { assistantRequestBudgetInput } from "./assistant-provider.ts";
import type { AgentInstructionContract, AgentInstructions, InstructionMetadata } from "./agent-instructions.ts";
import type {
  AgentToolDefinition,
  AssistantProvider,
  AssistantProviderError,
  AssistantRequest,
  AssistantRequestResult,
} from "./assistant-provider.ts";
import { AgentToolRuntime } from "./agent-tool-runtime.ts";
import { cancelledToolResult, ToolExecutionError, type AgentToolExecutor, type ToolOutcome } from "./tool-executor.ts";

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
  /** UTF-8 bytes of neutral request material, including instructions and tools; not a provider token count. */
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

/** Creation-only model, tool advertisements, and application instruction contract; never populated from conversation text. */
export interface AgentLaneConfiguration {
  readonly model: string;
  readonly tools: readonly AgentToolDefinition[];
  /** Creation-only application rules; omission inherits captured harness defaults, never branch history. */
  readonly instructions?: AgentInstructionContract;
  /**
   * Lower-priority guidance sourced from project files, such as the skill catalog. Unlike the
   * instruction contract it is never inherited: a lane created with its own configuration has none unless given.
   */
  readonly projectGuidance?: string | undefined;
}

/** Only admitted, composed instructions reach a lane's immutable runtime configuration. */
export interface ResolvedAgentLaneConfiguration extends Omit<AgentLaneConfiguration, "instructions" | "projectGuidance"> {
  readonly instructions: AgentInstructions;
}

/** Latest accepted run/request identity is private in-memory metadata, not conversation or durable recovery state. */
export interface AgentRunMetadata {
  readonly instructions: InstructionMetadata;
  readonly assistantRequests: number;
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
export type LaneRequestResult = OperationResult<AssistantResponse, AssistantProviderError | LaneAdmissionError | AgentRunBudgetExceeded>;

/** One atomic in-process observation; callers receive copies, not mutable session references. */
export interface AgentLaneSnapshot {
  readonly name: string;
  readonly tipId: SessionEntryId | null;
  readonly status: "idle" | "requesting" | "awaiting_tools";
  readonly configuration: Omit<AgentLaneConfiguration, "instructions" | "projectGuidance">;
  readonly instructionMetadata: InstructionMetadata;
  readonly runMetadata: AgentRunMetadata | null;
  readonly transcript: readonly ConversationEntry[];
  readonly context: readonly AgentMessage[];
}

/** One branch plus exclusive request ownership; unrelated lanes never wait on its provider. */
export class AgentLane {
  readonly #configuration: ResolvedAgentLaneConfiguration;
  #runMetadata: AgentRunMetadata | null = null;
  #status: "idle" | "requesting" = "idle";

  /** Only the harness constructs lanes; it never exposes the underlying mutable branch. */
  constructor(
    private readonly branch: ConversationBranch,
    private readonly provider: AssistantProvider,
    configuration: ResolvedAgentLaneConfiguration,
    private readonly toolExecutor: AgentToolExecutor | null,
  ) {
    this.#configuration = { ...structuredClone({ model: configuration.model, tools: configuration.tools }), instructions: configuration.instructions };
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
    if (this.requestBytes([...this.branch.getContext(), { role: "user", content: prompt }]) > defaultContextBytes) {
      return { ok: false, error: new AgentRunBudgetExceeded("context") };
    }
    this.#runMetadata = { instructions: this.#configuration.instructions.metadata, assistantRequests: 0 };
    this.#status = "requesting";
    try {
      this.branch.appendMessage({ role: "user", content: prompt });
      return await this.requestStep();
    } finally {
      this.#status = "idle";
    }
  }

  /**
   * Own the model/tool loop, scheduling adjacent parallel tools without crossing a sequential barrier.
   * Several prompts become consecutive user messages, such as stacked skill instructions.
   */
  async run(prompt: string | readonly string[], options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const prompts = [prompt].flat();
    const admitted = this.admitRun(prompts, options);
    if (!admitted.ok) return admitted;
    const { executor, maxAssistantSteps, limits } = admitted.value;
    const toolRuntime = new AgentToolRuntime(executor);
    const activeToolNames = new Set(this.#configuration.tools.map((tool) => tool.name));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), limits.maxDurationMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const interruption = (): AgentRunResult => ({ ok: false, error: deadline.signal.aborted
      ? new AgentRunBudgetExceeded("time") : new AgentRunCancelled() });
    let toolCalls = 0;
    this.#runMetadata = { instructions: this.#configuration.instructions.metadata, assistantRequests: 0 };
    this.#status = "requesting";
    try {
      for (const text of prompts) this.branch.appendMessage({ role: "user", content: text });
      for (let step = 0; step < maxAssistantSteps; step++) {
        if (signal.aborted) return interruption();
        if (this.requestBytes(this.branch.getContext()) > limits.maxContextBytes) {
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
        const batch = await toolRuntime.executeToolBatch(response.value.toolCalls, {
          activeToolNames,
          maxParallelTools: limits.maxParallelTools,
          signal,
          scopeId: this.name,
          onOutcome: (call, outcome) => {
            this.branch.appendMessage({ role: "tool", toolCallId: call.id, content: outcome.content });
          },
        });
        if (!batch.ok) return batch;
        if (batch.value.status === "cancelled") return interruption();
        if (batch.value.status === "uncertain") return { ok: false, error: new AgentEffectUncertain() };
        if (batch.value.outcomes.length > 0 && batch.value.outcomes.every((outcome) => outcome.terminate === true)) {
          return { ok: true, value: { stopReason: "tool_termination", outcomes: batch.value.outcomes } };
        }
      }
      return { ok: false, error: new AgentRunLimitExceeded(maxAssistantSteps) };
    } finally {
      clearTimeout(timer);
      this.#status = "idle";
    }
  }

  private admitRun(prompts: readonly string[], options: AgentRunOptions): OperationResult<AdmittedAgentRun, LaneAdmissionError | AgentRunCancelled | AgentRunBudgetExceeded> {
    const rejected = this.admissionError();
    if (rejected) return { ok: false, error: rejected };
    if (prompts.length === 0 || prompts.includes("")) return { ok: false, error: new LaneAdmissionError("empty_prompt") };
    const executor = this.toolExecutor;
    if (!executor) return { ok: false, error: new LaneAdmissionError("missing_executor") };
    const steps = assistantStepLimitSchema.safeParse(options.maxAssistantSteps ?? defaultAssistantSteps);
    if (!steps.success) return { ok: false, error: new LaneAdmissionError("invalid_step_limit") };
    const limits = runLimitsSchema.safeParse(options);
    if (!limits.success) return { ok: false, error: new LaneAdmissionError("invalid_run_limits") };
    if (options.signal?.aborted) return { ok: false, error: new AgentRunCancelled() };
    const userMessages = prompts.map((content) => ({ role: "user", content }) as const);
    if (this.requestBytes([...this.branch.getContext(), ...userMessages]) > limits.data.maxContextBytes) return { ok: false, error: new AgentRunBudgetExceeded("context") };
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
      configuration: structuredClone({ model: this.#configuration.model, tools: this.#configuration.tools }),
      instructionMetadata: this.#configuration.instructions.metadata,
      runMetadata: this.#runMetadata === null ? null : structuredClone(this.#runMetadata),
      transcript: this.branch.getEntries(),
      context,
    };
  }

  private createRequest(messages: readonly AgentMessage[]): AssistantRequest {
    return { model: this.#configuration.model, instructions: this.#configuration.instructions,
      tools: structuredClone(this.#configuration.tools), messages };
  }

  private requestBytes(messages: readonly AgentMessage[]): number {
    return Buffer.byteLength(JSON.stringify(assistantRequestBudgetInput(this.createRequest(messages))), "utf8");
  }

  private async requestStep(signal?: AbortSignal): Promise<AssistantRequestResult> {
    this.#runMetadata = { instructions: this.#configuration.instructions.metadata,
      assistantRequests: (this.#runMetadata?.assistantRequests ?? 0) + 1 };
    const result = await this.provider.requestAssistant(this.createRequest(this.branch.getContext()), signal);
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
