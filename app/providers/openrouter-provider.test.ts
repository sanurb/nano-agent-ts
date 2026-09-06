import { expect, test } from "bun:test";
import { AgentHarness } from "../agent/agent-harness.ts";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { RedactedSecret } from "../shared/redacted-secret.ts";
import { LocalToolExecutor } from "../tools/local-tool-executor.ts";
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

test("provider response bytes are bounded before JSON materialization and overflow is not retried", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return new Response('{' + ' '.repeat(3 * 1024 * 1024) + '}', { headers: { "content-type": "application/json" } });
  } });
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    expect(await provider.requestAssistant({ model: "test", messages: [], tools: [] })).toMatchObject({ ok: false });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test("provider usage is measured without inventing missing cost or leaking metadata into message replay", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    requests.push(await request.text());
    return Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3 }, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  } });
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    const first = await provider.requestAssistant({ model: "test", messages: [], tools: [] });
    if (!first.ok) throw first.error;
    expect(first.value.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    await provider.requestAssistant({ model: "test", messages: [first.value], tools: [] });
    const replay = requests[1];
    if (!replay) throw new Error("Missing provider replay request");
    expect(JSON.parse(replay).messages).toEqual([{ role: "assistant", content: "done" }]);
  } finally { server.stop(true); }
});

test("lane cancellation aborts an in-flight real SDK request without retry or a model continuation", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    requests++;
    started.resolve();
    await release.promise;
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "too late" } }] });
  } });
  const controller = new AbortController();
  try {
    const provider = new OpenRouterProvider({ apiKey: new RedactedSecret("test-key"), baseURL: server.url.href });
    const harness = new AgentHarness(provider, {
      model: "test", tools: [], entryIds: { next: () => Bun.randomUUIDv7() },
    }, new LocalToolExecutor([]));
    const lane = await harness.lane("main");
    if (!lane.ok) throw lane.error;
    const work = lane.value.run("wait for a response", { signal: controller.signal });
    await started.promise;
    controller.abort("private caller data");
    expect(await work).toMatchObject({ ok: false, error: { _tag: "AgentRunCancelled" } });
    expect(requests).toBe(1);
    expect((await lane.value.getSnapshot()).status).toBe("idle");
    expect((await lane.value.getSnapshot()).context).toEqual([{ role: "user", content: "wait for a response" }]);
  } finally {
    controller.abort();
    release.resolve();
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
    expect(requests).toEqual([{ model: "test", max_tokens: 8192, messages: [{ role: "user", content: "hello" }] }]);
  } finally {
    await server.stop(true);
  }
});
