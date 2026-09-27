import type { JSONSchema7 } from "json-schema";
import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentMessage, AssistantResponse } from "./agent-message.ts";
import type { AgentInstructions } from "./agent-instructions.ts";

/** A tool advertisement in standard JSON Schema, independent of provider envelopes. */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema7;
}

/** One assistant request; the caller owns context and tool selection. */
export interface AssistantRequest {
  readonly model: string;
  readonly instructions: AgentInstructions;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentToolDefinition[];
}

/** Provider-neutral budgeting material contains raw instructions; never use it as diagnostic metadata. */
export interface AssistantRequestBudgetInput extends Omit<AssistantRequest, "instructions"> {
  readonly instructions: string;
}

/** Shared input for request-size accounting and future tokenizer adapters; explicitly includes private instruction text. */
export function assistantRequestBudgetInput(request: AssistantRequest): AssistantRequestBudgetInput {
  // Do not JSON.stringify(request): instructions intentionally serialize to metadata for safe diagnostics.
  return { model: request.model, instructions: request.instructions.text, messages: request.messages, tools: request.tools };
}

/** A provider failure safe to render without leaking response bodies or credentials. */
export class AssistantRequestFailed extends Error {
  /** Stable classification for callers; never inspect provider error text. */
  readonly _tag = "AssistantRequestFailed" as const;

  /** Preserve only an allowlisted HTTP status, not the raw SDK error. */
  constructor(readonly status: number | null) {
    super(
      status === null
        ? "Assistant request failed: provider transport error"
        : `Assistant request failed: HTTP ${status}`,
    );
  }
}

/** The provider returned no usable first choice. */
export class InvalidAssistantResponse extends Error {
  /** Stable classification for malformed responses and empty choices. */
  readonly _tag = "InvalidAssistantResponse" as const;

  /** Empty choices preserve the CLI's existing diagnostic. */
  constructor(readonly reason: "no_choices" | "malformed_response") {
    super(
      reason === "no_choices"
        ? "no choices in response"
        : "Invalid assistant response: expected choices with assistant text",
    );
  }
}

/** Expected failures owned by the provider boundary, distinct from lane admission. */
export type AssistantProviderError = AssistantRequestFailed | InvalidAssistantResponse;

/** A request returns a complete assistant step or an explicit provider failure. */
export type AssistantRequestResult = OperationResult<AssistantResponse, AssistantProviderError>;

/** The model-request capability; implementations own protocol translation and errors. */
export interface AssistantProvider {
  requestAssistant(request: AssistantRequest, signal?: AbortSignal): Promise<AssistantRequestResult>;
}
