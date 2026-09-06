import { z } from "zod";

/** Parse an opaque provider tool-call identity; uniqueness is only within its batch. */
export const toolCallIdSchema = z.string().min(1).brand<"ToolCallId">();

/** Provider-assigned identity, distinct from a session entry identity. */
export type ToolCallId = z.infer<typeof toolCallIdSchema>;

/** A requested tool effect, not evidence that it executed. */
export interface AgentToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  /** Untrusted JSON text; the executing tool must parse it against its own schema. */
  readonly arguments: string;
}

/** Provider-reported usage; missing cost is unknown, never zero. No pricing is inferred from a model name. */
export interface AssistantUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCredits?: number;
}

/** A settled assistant step, including calls that still require tool results. */
export interface AssistantResponse {
  readonly role: "assistant";
  readonly content: string | null;
  readonly stopReason: "stop" | "tool_use" | "length" | "refusal";
  readonly toolCalls: readonly AgentToolCall[];
  /** Observed completion metadata, deliberately omitted from provider message replay. */
  readonly usage?: AssistantUsage;
}

/** A tool's completed output, correlated with its call within the preceding assistant batch. */
export interface AgentToolResponse {
  readonly role: "tool";
  readonly toolCallId: ToolCallId;
  readonly content: string;
}

/** Conversation content only; lane state and configuration never enter model context. */
export type AgentMessage =
  | { readonly role: "user"; readonly content: string }
  | AssistantResponse
  | AgentToolResponse;
