import OpenAI from "openai";
import { z } from "zod";
import { toolCallIdSchema, type AgentMessage } from "../agent/agent-message.ts";
import {
  AssistantRequestFailed,
  InvalidAssistantResponse,
  type AssistantProvider,
  type AssistantRequest,
  type AssistantRequestResult,
} from "../agent/assistant-provider.ts";
import type { RedactedSecret } from "../shared/redacted-secret.ts";

const completionResponseSchema = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.enum(["stop", "tool_calls", "length", "content_filter"]).transform(
        (reason) => reason === "tool_calls" ? "tool_use" : reason === "content_filter" ? "refusal" : reason,
      ),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string().nullable(),
        tool_calls: z.array(z.object({
          id: toolCallIdSchema,
          type: z.literal("function"),
          function: z.object({ name: z.string().min(1), arguments: z.string() }),
        })).refine((calls) => new Set(calls.map((call) => call.id)).size === calls.length).default([]),
      }),
    }).refine((choice) => choice.finish_reason !== "tool_use" || choice.message.tool_calls.length > 0),
  ),
});

/** OpenRouter connection settings, supplied at startup instead of read from the environment. */
export interface OpenRouterConnection {
  readonly apiKey: RedactedSecret;
  readonly baseURL: string;
}

/** Adapts the OpenAI-compatible protocol; no SDK types escape this module. */
export class OpenRouterProvider implements AssistantProvider {
  readonly #client: OpenAI;

  /** Client construction is inert; retain the SDK's existing timeout and retry defaults. */
  constructor(connection: OpenRouterConnection) {
    this.#client = new OpenAI({
      apiKey: connection.apiKey.reveal(),
      baseURL: connection.baseURL,
    });
  }

  /** Translate one model request and parse the response before it reaches the harness. */
  async requestAssistant(request: AssistantRequest): Promise<AssistantRequestResult> {
    const payload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
    };
    if (request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: { ...tool.parameters },
        },
      }));
    }
    // Limit the catch to external work: defects in translation must remain defects.
    const completion = await this.#client.chat.completions
      .create(payload)
      .then(
        (response) => ({ ok: true, value: response }) as const,
        (error) => ({
          ok: false,
          error: new AssistantRequestFailed(
            error instanceof OpenAI.APIError ? (error.status ?? null) : null,
          ),
        }) as const,
      );

    if (!completion.ok) return completion;

    const parsed = completionResponseSchema.safeParse(completion.value);
    if (!parsed.success) {
      return { ok: false, error: new InvalidAssistantResponse("malformed_response") };
    }
    const [choice] = parsed.data.choices;
    if (!choice) {
      return { ok: false, error: new InvalidAssistantResponse("no_choices") };
    }
    return {
      ok: true,
      value: {
        role: "assistant",
        content: choice.message.content,
        stopReason: choice.finish_reason,
        toolCalls: choice.message.tool_calls.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      },
    };
  }
}

function toOpenAIMessage(message: AgentMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: message.content,
  };
  if (message.toolCalls.length > 0) {
    assistant.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return assistant;
}
