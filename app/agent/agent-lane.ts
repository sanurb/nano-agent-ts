import { z } from "zod";
import type {
  ConversationBranch,
  ConversationEntry,
  SessionEntryId,
} from "../session/conversation-session.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentMessage, AssistantResponse, ToolCallId } from "./agent-message.ts";
import type {
  AgentToolDefinition,
  AssistantProvider,
  AssistantProviderError,
  AssistantRequestResult,
} from "./assistant-provider.ts";
import { ToolExecutionError, type AgentToolExecutor } from "./tool-executor.ts";

const assistantStepLimitSchema = z.number().int().positive();

/** A finite model-call budget; defaults to 64 assistant steps per run. */
export interface AgentRunOptions {
  readonly maxAssistantSteps?: number;
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

/** A run returns a final assistant response or an explicit admission, model, tool, or budget failure. */
export type AgentRunResult = OperationResult<
  AssistantResponse,
  LaneAdmissionError | AssistantProviderError | ToolExecutionError | AgentRunLimitExceeded
>;

/** Each lane captures its own model and active tool advertisements at creation. */
export interface AgentLaneConfiguration {
  readonly model: string;
  readonly tools: readonly AgentToolDefinition[];
}

/** Safe rejection before any prompt or context change is accepted. */
export class LaneAdmissionError extends Error {
  /** Stable rejection tag; reason distinguishes the caller's recovery action. */
  readonly _tag = "LaneAdmissionError" as const;

  /** Never echo prompt, tool arguments, or handoff text in diagnostics. */
  constructor(readonly reason: "busy" | "pending_tools" | "empty_prompt" | "missing_executor" | "invalid_step_limit") {
    super(
      reason === "busy"
        ? "Agent lane busy: wait for the active request to settle"
        : reason === "pending_tools"
          ? "Agent lane awaiting tool results: cannot start new work with an unresolved tool batch"
          : reason === "missing_executor"
            ? "Agent run unavailable: no tool executor configured"
            : reason === "invalid_step_limit"
              ? "Invalid agent run limit: expected a positive safe integer"
              : "Invalid lane prompt: prompt must not be empty",
    );
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

  /** Own the entire model/tool loop; execute each active tool in order and return only the final response. */
  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const rejected = this.admissionError();
    if (rejected) return { ok: false, error: rejected };
    if (!prompt) return { ok: false, error: new LaneAdmissionError("empty_prompt") };
    const executor = this.toolExecutor;
    if (!executor) return { ok: false, error: new LaneAdmissionError("missing_executor") };
    const limit = assistantStepLimitSchema.safeParse(options.maxAssistantSteps ?? 64);
    if (!limit.success) return { ok: false, error: new LaneAdmissionError("invalid_step_limit") };

    this.#status = "requesting";
    try {
      this.branch.appendMessage({ role: "user", content: prompt });
      for (let step = 0; step < limit.data; step++) {
        const response = await this.requestStep();
        if (!response.ok) return response;
        if (response.value.toolCalls.length === 0) return response;
        for (const call of structuredClone(response.value.toolCalls)) {
          if (!this.#configuration.tools.some((tool) => tool.name === call.name)) {
            return { ok: false, error: new ToolExecutionError("inactive_tool") };
          }
          const output = await executor.executeTool(call);
          if (!output.ok) return output;
          this.branch.appendMessage({ role: "tool", toolCallId: call.id, content: output.value });
        }
      }
      return { ok: false, error: new AgentRunLimitExceeded(limit.data) };
    } finally {
      this.#status = "idle";
    }
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

  private async requestStep(): Promise<AssistantRequestResult> {
    const result = await this.provider.requestAssistant({
      model: this.#configuration.model,
      tools: structuredClone(this.#configuration.tools),
      messages: this.branch.getContext(),
    });
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
