import { expect, test } from "bun:test";
import fc from "fast-check";
import type { OperationResult } from "../shared/operation-result.ts";
import { readToolDefinition } from "../tools/read-tool.ts";
import { AgentHarness } from "./agent-harness.ts";
import { toolCallIdSchema, type AgentMessage, type AgentToolCall } from "./agent-message.ts";
import {
  AssistantRequestFailed,
  type AssistantProvider,
  type AssistantRequest,
  type AssistantRequestResult,
} from "./assistant-provider.ts";
import { ToolExecutionError, type AgentToolExecutor } from "./tool-executor.ts";

class ScriptedAssistantProvider implements AssistantProvider {
  readonly requests: AssistantRequest[] = [];

  constructor(private readonly responses: readonly AssistantRequestResult[]) {}

  async requestAssistant(request: AssistantRequest): Promise<AssistantRequestResult> {
    const response = this.responses[this.requests.length];
    this.requests.push(request);
    if (!response) throw new Error("Scripted provider exhausted its assistant responses");
    return response;
  }
}

class RecordingToolExecutor implements AgentToolExecutor {
  readonly calls: AgentToolCall[] = [];

  constructor(private readonly outcomes: readonly OperationResult<string, ToolExecutionError>[]) {}

  async executeTool(call: AgentToolCall): Promise<OperationResult<string, ToolExecutionError>> {
    const result = this.outcomes[this.calls.length];
    this.calls.push(call);
    if (!result) throw new Error("Recording executor exhausted its tool outcomes");
    return result;
  }
}

function toolCall(index: number): AgentToolCall {
  return { id: toolCallIdSchema.parse(`call-${index}`), name: "Read", arguments: '{"file_path":"README.md"}' };
}

function assistantStep(content: string | null, toolCalls: readonly AgentToolCall[] = []): AssistantRequestResult {
  return { ok: true, value: { role: "assistant", content, toolCalls, stopReason: toolCalls.length ? "tool_use" : "stop" } };
}

function createRunHarness(provider: AssistantProvider, executor: AgentToolExecutor | null) {
  let sequence = 0;
  return new AgentHarness(provider, {
    model: "test-model", tools: [readToolDefinition], entryIds: { next: () => `entry-${++sequence}` },
  }, executor);
}

test("generated runs preserve every batch in order, including reused call IDs across rounds", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 }),
    async (batches) => {
      const responses = batches.map((batch) => assistantStep(null, batch.map((_, index) => toolCall(index))));
      const provider = new ScriptedAssistantProvider([...responses, assistantStep("final answer")]);
      const executor = new RecordingToolExecutor(batches.flat().map((value) => ({ ok: true, value })));
      const harness = createRunHarness(provider, executor);
      const main = await harness.lane("main");
      if (!main.ok) throw main.error;
      expect(await main.value.run("original prompt")).toEqual(assistantStep("final answer"));
      const expected: AgentMessage[] = [{ role: "user", content: "original prompt" }];
      for (const [index, batch] of batches.entries()) {
        expect(provider.requests[index]?.messages).toEqual(expected);
        const response = responses[index];
        if (!response?.ok) throw new Error("Generated run missing assistant batch");
        expected.push(response.value);
        for (const [callIndex, content] of batch.entries()) {
          expected.push({ role: "tool", toolCallId: toolCall(callIndex).id, content });
        }
      }
      expect(provider.requests.at(-1)?.messages).toEqual(expected);
      expect(executor.calls).toHaveLength(batches.flat().length);
      expect(provider.requests).toHaveLength(batches.length + 1);
      expect((await main.value.getSnapshot()).status).toBe("idle");
      expect((await main.value.startContextWindow("completed run")).ok).toBe(true);
    },
  ), { numRuns: 50 });
});

test("run ownership spans tools; other lanes progress and a fork at an unfinished batch stays blocked", async () => {
  const started = Promise.withResolvers<void>();
  const output = Promise.withResolvers<OperationResult<string, ToolExecutionError>>();
  const executor: AgentToolExecutor = {
    executeTool: async () => { started.resolve(); return output.promise; },
  };
  const provider = new ScriptedAssistantProvider([
    assistantStep(null, [toolCall(0)]), assistantStep("research answer"), assistantStep("main answer"),
  ]);
  const harness = createRunHarness(provider, executor);
  const main = await harness.lane("main");
  const research = await harness.lane("research", { configuration: { model: "research-model", tools: [] } });
  if (!main.ok) throw main.error;
  if (!research.ok) throw research.error;
  const work = main.value.run("main prompt");
  await started.promise;
  expect(await main.value.run("overlap")).toMatchObject({ ok: false, error: { reason: "busy" } });
  expect(await main.value.requestAssistant("overlap")).toMatchObject({ ok: false, error: { reason: "busy" } });
  expect(await main.value.startContextWindow("unsafe")).toMatchObject({ ok: false, error: { reason: "busy" } });
  const fork = await harness.lane("fork", { createAt: (await main.value.getSnapshot()).tipId });
  if (!fork.ok) throw fork.error;
  expect(await fork.value.run("unsafe")).toMatchObject({ ok: false, error: { reason: "pending_tools" } });
  expect(await research.value.run("research prompt")).toEqual(assistantStep("research answer"));
  expect((await main.value.getSnapshot()).status).toBe("requesting");
  output.resolve({ ok: true, value: "tool output" });
  expect(await work).toEqual(assistantStep("main answer"));
  expect((await main.value.getSnapshot()).status).toBe("idle");
  expect((await fork.value.getSnapshot()).status).toBe("awaiting_tools");
});

test("a failed tool retains prior results, stops the batch, and cannot silently replay completed effects", async () => {
  const failure = new ToolExecutionError("read_failed");
  const executor = new RecordingToolExecutor([{ ok: true, value: "first result" }, { ok: false, error: failure }]);
  const provider = new ScriptedAssistantProvider([assistantStep(null, [toolCall(0), toolCall(1), toolCall(2)])]);
  const main = await createRunHarness(provider, executor).lane("main");
  if (!main.ok) throw main.error;
  expect(await main.value.run("read files")).toEqual({ ok: false, error: failure });
  const snapshot = await main.value.getSnapshot();
  expect(snapshot.context.at(-1)).toEqual({ role: "tool", toolCallId: toolCall(0).id, content: "first result" });
  expect(snapshot.status).toBe("awaiting_tools");
  expect(await main.value.run("retry")).toMatchObject({ ok: false, error: { reason: "pending_tools" } });
  expect(executor.calls).toHaveLength(2);
  expect(provider.requests).toHaveLength(1);
});

test("model failure after tool results releases ownership without losing the completed batch", async () => {
  const failure = new AssistantRequestFailed(503);
  const provider = new ScriptedAssistantProvider([assistantStep(null, [toolCall(0)]), { ok: false, error: failure }]);
  const executor = new RecordingToolExecutor([{ ok: true, value: "file contents" }]);
  const main = await createRunHarness(provider, executor).lane("main");
  if (!main.ok) throw main.error;
  expect(await main.value.run("read files")).toEqual({ ok: false, error: failure });
  const snapshot = await main.value.getSnapshot();
  expect(snapshot.status).toBe("idle");
  expect(snapshot.context).toHaveLength(3);
  expect(executor.calls).toHaveLength(1);
});

test("unexpected executor defects propagate and leave the unresolved batch guarded", async () => {
  const defect = new Error("Scripted tool defect");
  const executor: AgentToolExecutor = { executeTool: async () => { throw defect; } };
  const provider = new ScriptedAssistantProvider([assistantStep(null, [toolCall(0)])]);
  const main = await createRunHarness(provider, executor).lane("main");
  if (!main.ok) throw main.error;
  await expect(main.value.run("read files")).rejects.toBe(defect);
  expect((await main.value.getSnapshot()).status).toBe("awaiting_tools");
});

test("runs never execute an unadvertised tool, even with a capable executor", async () => {
  const provider = new ScriptedAssistantProvider([assistantStep(null, [toolCall(0)])]);
  const executor = new RecordingToolExecutor([]);
  const lane = await createRunHarness(provider, executor).lane("no-tools", { configuration: { model: "test", tools: [] } });
  if (!lane.ok) throw lane.error;
  expect(await lane.value.run("read files")).toMatchObject({ ok: false, error: { reason: "inactive_tool" } });
  expect(executor.calls).toHaveLength(0);
});

test("run budget stops repeated tool requests after the final complete batch", async () => {
  const provider = new ScriptedAssistantProvider([assistantStep(null, [toolCall(0)]), assistantStep(null, [toolCall(0)])]);
  const executor = new RecordingToolExecutor([{ ok: true, value: "first" }, { ok: true, value: "second" }]);
  const main = await createRunHarness(provider, executor).lane("main");
  if (!main.ok) throw main.error;
  expect(await main.value.run("loop forever", { maxAssistantSteps: 2 })).toMatchObject({
    ok: false, error: { _tag: "AgentRunLimitExceeded", maxAssistantSteps: 2 },
  });
  expect(provider.requests).toHaveLength(2);
  expect(executor.calls).toHaveLength(2);
  expect((await main.value.getSnapshot()).status).toBe("idle");
});

test.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("invalid run budget %s rejects before any effects", async (maxAssistantSteps) => {
  const provider = new ScriptedAssistantProvider([]);
  const main = await createRunHarness(provider, new RecordingToolExecutor([])).lane("main");
  if (!main.ok) throw main.error;
  expect(await main.value.run("hello", { maxAssistantSteps })).toMatchObject({ ok: false, error: { reason: "invalid_step_limit" } });
  expect((await main.value.getSnapshot()).transcript).toEqual([]);
  expect(provider.requests).toHaveLength(0);
});

test("run without an executor and empty prompts fail admission without accepting input", async () => {
  const provider = new ScriptedAssistantProvider([]);
  const main = await createRunHarness(provider, null).lane("main");
  if (!main.ok) throw main.error;
  expect(await main.value.run("hello")).toMatchObject({ ok: false, error: { reason: "missing_executor" } });
  expect(await main.value.run("")).toMatchObject({ ok: false, error: { reason: "empty_prompt" } });
  expect((await main.value.getSnapshot()).transcript).toEqual([]);
  expect(provider.requests).toHaveLength(0);
});
