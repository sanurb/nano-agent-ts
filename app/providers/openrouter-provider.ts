import OpenAI from "openai";
import { z } from "zod";
import { toolCallIdSchema, type AgentMessage, type AssistantResponse } from "../agent/agent-message.ts";
import {
  AssistantRequestFailed,
  InvalidAssistantResponse,
  type AssistantProvider,
  type AssistantRequest,
  type AssistantRequestResult,
} from "../agent/assistant-provider.ts";
import type { RedactedSecret } from "../shared/redacted-secret.ts";

import { maxToolArgumentCharacters, maxToolNameCharacters } from "../agent/tool-executor.ts";

const maxAssistantContentCharacters = 1_048_576;
const maxProviderToolCallIdCharacters = 256;
const maxProviderToolCalls = 4096;
const assistantRequestDeadlineMs = 60_000;
const maxAssistantResponseBytes = 2_097_152; // 2 MiB before JSON materialization.
const maxAssistantOutputTokens = 8192;
const maxAutomaticProviderRetries = 0; // Retrying a billable request requires explicit caller policy.

const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), cost: z.number().nonnegative().optional() });

const completionResponseSchema = z.object({
  usage: z.unknown().optional(),
  choices: z.array(
    z.object({
      finish_reason: z.enum(["stop", "tool_calls", "length", "content_filter"]).transform(
        (reason) => reason === "tool_calls" ? "tool_use" : reason === "content_filter" ? "refusal" : reason,
      ),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string().max(maxAssistantContentCharacters).nullable(),
        tool_calls: z.array(z.object({
          id: toolCallIdSchema.refine((id) => id.length <= maxProviderToolCallIdCharacters),
          type: z.literal("function"),
          function: z.object({ name: z.string().min(1).max(maxToolNameCharacters), arguments: z.string().max(maxToolArgumentCharacters) }),
        })).max(maxProviderToolCalls).refine((calls) => new Set(calls.map((call) => call.id)).size === calls.length).default([]),
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

  /** Explicit latency/response budgets and no hidden billable retries; construction remains inert. */
  constructor(connection: OpenRouterConnection) {
    this.#client = new OpenAI({
      apiKey: connection.apiKey.reveal(),
      baseURL: connection.baseURL,
      timeout: assistantRequestDeadlineMs,
      maxRetries: maxAutomaticProviderRetries,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.body === null) return response;
        let receivedBytes = 0;
        const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > maxAssistantResponseBytes) throw new Error("Assistant response exceeded the 2MB transport budget");
            controller.enqueue(chunk);
          },
        }));
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
  }

  /** Translate one model request and parse the response before it reaches the harness. */
  async requestAssistant(request: AssistantRequest, signal?: AbortSignal): Promise<AssistantRequestResult> {
    const payload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: maxAssistantOutputTokens,
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
      .create(payload, { signal })
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
    const response = {
      role: "assistant", content: choice.message.content, stopReason: choice.finish_reason,
      toolCalls: choice.message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
    } satisfies AssistantResponse;
    const usage = usageSchema.safeParse(parsed.data.usage);
    if (!usage.success) return { ok: true, value: response };
    const tokens = { inputTokens: usage.data.prompt_tokens, outputTokens: usage.data.completion_tokens };
    const measured = usage.data.cost === undefined ? tokens : { ...tokens, costCredits: usage.data.cost };
    return { ok: true, value: { ...response, usage: measured } };
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
