import { expect, test } from "bun:test";
import { AgentHarness } from "../agent/agent-harness.ts";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { RedactedSecret } from "../shared/redacted-secret.ts";
import { readToolDefinition } from "../tools/read-tool.ts";
import { OpenRouterProvider } from "./openrouter-provider.ts";

const readToolCall = {
  id: "call_read",
  type: "function",
  function: { name: "Read", arguments: '{"file_path":"README.md"}' },
} as const;

test("real SDK replays assistant history, preserves tool calls, and leaves continuation blocked", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      requests.push(body);
      return Response.json({ choices: [requests.length === 1
        ? { finish_reason: "stop", message: { role: "assistant", content: "First answer" } }
        : { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [readToolCall] } },
      ] });
    },
  });
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    const harness = new AgentHarness(provider, {
      model: "test-model", tools: [readToolDefinition], entryIds: { next: () => Bun.randomUUIDv7() },
    });
    const main = await harness.lane("main");
    if (!main.ok) throw main.error;
    expect((await main.value.requestAssistant("First question")).ok).toBe(true);
    expect(await main.value.requestAssistant("Read the file")).toEqual({
      ok: true,
      value: {
        role: "assistant", content: null, stopReason: "tool_use",
        toolCalls: [{ id: toolCallIdSchema.parse("call_read"), name: "Read", arguments: '{"file_path":"README.md"}' }],
      },
    });
    expect(requests[1]).toMatchObject({
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Read the file" },
      ],
    });
    expect(await main.value.requestAssistant("continue")).toMatchObject({ ok: false, error: { reason: "pending_tools" } });
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
  }
});

test.each([
  { finish_reason: "tool_calls", message: { role: "assistant", content: null } },
  { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [readToolCall, readToolCall] } },
  { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ ...readToolCall, id: "" }] } },
  { finish_reason: "future_unknown_reason", message: { role: "assistant", content: "text" } },
  { message: { role: "assistant", content: "missing finish reason" } },
])("rejects malformed assistant protocol metadata without exposing the payload: %j", async (choice) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ choices: [choice] }) });
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    expect(await provider.requestAssistant({ model: "test", messages: [{ role: "user", content: "hello" }], tools: [] })).toMatchObject({
      ok: false, error: { _tag: "InvalidAssistantResponse", reason: "malformed_response" },
    });
  } finally {
    await server.stop(true);
  }
});

test.each([
  { wireReason: "stop", stopReason: "stop" },
  { wireReason: "length", stopReason: "length" },
  { wireReason: "content_filter", stopReason: "refusal" },
])("normalizes provider stop reason and omits unadvertised tools: $wireReason", async ({ wireReason, stopReason }) => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      requests.push(body);
      return Response.json({ choices: [{ finish_reason: wireReason, message: { role: "assistant", content: null } }] });
    },
  });
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    expect(await provider.requestAssistant({ model: "test", messages: [{ role: "user", content: "hello" }], tools: [] })).toEqual({
      ok: true, value: { role: "assistant", content: null, stopReason, toolCalls: [] },
    });
    expect(requests).toEqual([{ model: "test", messages: [{ role: "user", content: "hello" }] }]);
  } finally {
    await server.stop(true);
  }
});
