import { expect, test } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import { defineTool, type AgentTool } from "../tools/agent-tool.ts";
import { LocalToolExecutor } from "../tools/local-tool-executor.ts";
import { AgentHarness } from "./agent-harness.ts";
import { toolCallIdSchema, type AgentToolCall } from "./agent-message.ts";
import type { AssistantProvider, AssistantRequest, AssistantRequestResult } from "./assistant-provider.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError, type ToolExecutionMode, type ToolExecutionResult } from "./tool-executor.ts";

class BatchAssistantProvider implements AssistantProvider {
  readonly requests: AssistantRequest[] = [];
  constructor(private readonly calls: readonly AgentToolCall[]) {}
  async requestAssistant(request: AssistantRequest): Promise<AssistantRequestResult> {
    this.requests.push(request);
    return { ok: true, value: this.requests.length === 1
      ? { role: "assistant", content: null, stopReason: this.calls.length ? "tool_use" : "stop", toolCalls: this.calls }
      : { role: "assistant", content: "done", stopReason: "stop", toolCalls: [] } };
  }
}

function batchCalls(modes: readonly ToolExecutionMode[]): AgentToolCall[] {
  return modes.map((mode, index) => ({ id: toolCallIdSchema.parse(`call-${index}`), name: mode, arguments: JSON.stringify({ index }) }));
}

function batchTools(run: (index: number, signal?: AbortSignal) => Promise<ToolExecutionResult>): AgentTool[] {
  return (["parallel", "sequential"] as const).map((mode) => defineTool({
    definition: { name: mode, description: "Controlled batch tool", parameters: { type: "object" } },
    executionMode: mode,
    argumentsSchema: z.object({ index: z.number().int().nonnegative() }),
    argumentsExpectation: "an index",
    run: (args, signal) => run(args.index, signal),
  }));
}

async function batchLane(calls: readonly AgentToolCall[], tools: readonly AgentTool[]) {
  const provider = new BatchAssistantProvider(calls);
  let nextId = 0;
  const harness = new AgentHarness(provider, {
    model: "batch-model", tools: tools.map((tool) => tool.definition), entryIds: { next: () => `entry-${++nextId}` },
  }, new LocalToolExecutor(tools));
  const lane = await harness.lane("main");
  if (!lane.ok) throw lane.error;
  return { lane: lane.value, provider, harness };
}

test("adjacent parallel groups overlap, drain before sequential calls, and retain source-order results", async () => {
  const modes = ["parallel", "parallel", "sequential", "parallel", "parallel"] as const;
  const calls = batchCalls(modes);
  const started = modes.map(() => Promise.withResolvers<void>());
  const release = modes.map(() => Promise.withResolvers<void>());
  const completions: number[] = [];
  const { lane, provider } = await batchLane(calls, batchTools(async (index) => {
    started[index]?.resolve();
    await release[index]?.promise;
    completions.push(index);
    return successfulToolResult(`output-${index}`);
  }));
  const work = lane.run("schedule");
  try {
    await Promise.all([started[0]?.promise, started[1]?.promise]);
    release[1]?.resolve();
    await Promise.resolve();
    expect(completions).toEqual([1]);
    expect((await lane.getSnapshot()).context.filter((entry) => entry.role === "tool")).toEqual([]);
    release[0]?.resolve();
    await started[2]?.promise;
    expect(completions).toEqual([1, 0]);
    expect((await lane.getSnapshot()).context.filter((entry) => entry.role === "tool").map((entry) => entry.content))
      .toEqual(["output-0", "output-1"]);
    release[2]?.resolve();
    await Promise.all([started[3]?.promise, started[4]?.promise]);
    release[4]?.resolve();
    await Promise.resolve();
    release[3]?.resolve();
    expect((await work).ok).toBe(true);
    expect(completions).toEqual([1, 0, 2, 4, 3]);
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool"))
      .toEqual(calls.map((call, index) => ({ role: "tool", toolCallId: call.id, content: `output-${index}` })));
  } finally {
    for (const gate of release) gate.resolve();
    await work;
  }
});

test("three successes and a correctable miss all reach the follow-up model request", async () => {
  const calls = batchCalls(["parallel", "parallel", "parallel", "parallel"]);
  const { lane, provider } = await batchLane(calls, batchTools(async (index) => index === 1
    ? failedToolResult(ToolExecutionError.executionFailed("Read", "offset is past the end of the file"))
    : successfulToolResult(`output-${index}`)));
  expect((await lane.run("read four files")).ok).toBe(true);
  const results = provider.requests[1]?.messages.filter((message) => message.role === "tool");
  expect(results?.map((message) => message.toolCallId)).toEqual(calls.map((call) => call.id));
  expect(results?.map((message) => message.content)).toEqual([
    "output-0", "Read tool failed: offset is past the end of the file", "output-2", "output-3",
  ]);
});

test("a defect drains admitted siblings, retains their results, and never starts the next group", async () => {
  const defect = new Error("Batch test execution defect");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const executed: number[] = [];
  const { lane } = await batchLane(batchCalls(["parallel", "parallel", "sequential"]), batchTools(async (index) => {
    executed.push(index);
    if (index === 0) throw defect;
    entered.resolve();
    await release.promise;
    return successfulToolResult("surviving result");
  }));
  const work = lane.run("run tools").then(() => null, (error: Error) => error);
  try {
    await entered.promise;
    expect((await lane.getSnapshot()).status).toBe("requesting");
    expect(await lane.run("overlap")).toMatchObject({ ok: false, error: { reason: "busy" } });
  } finally {
    release.resolve();
  }
  expect(await work).toBe(defect);
  expect(executed).toEqual([0, 1]);
  expect((await lane.getSnapshot()).context.at(-1)).toMatchObject({ role: "tool", content: "surviving result" });
  expect((await lane.getSnapshot()).status).toBe("awaiting_tools");
});

test("cancellation drains running siblings, accounts for skipped calls, and suppresses model continuation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const executed: number[] = [];
  const calls = batchCalls(["parallel", "parallel", "sequential", "parallel"]);
  const { lane, provider } = await batchLane(calls, batchTools(async (index, signal) => {
    expect(signal?.aborted).toBe(false);
    executed.push(index);
    if (index === 1) started.resolve();
    await release.promise;
    expect(signal?.aborted).toBe(true);
    return cancelledToolResult();
  }));
  const work = lane.run("interrupt tools", { signal: controller.signal });
  try {
    await started.promise;
    controller.abort("private cancellation reason");
    expect((await lane.getSnapshot()).status).toBe("requesting");
    expect(await lane.run("overlap")).toMatchObject({ ok: false, error: { reason: "busy" } });
  } finally {
    release.resolve();
  }
  expect(await work).toMatchObject({ ok: false, error: { _tag: "AgentRunCancelled" } });
  expect(executed).toEqual([0, 1]);
  expect(provider.requests).toHaveLength(1);
  const snapshot = await lane.getSnapshot();
  expect(snapshot.status).toBe("idle");
  const results = snapshot.context.filter((message) => message.role === "tool");
  expect(results.map((message) => message.toolCallId)).toEqual(calls.map((call) => call.id));
  expect(results.every((message) => message.content.startsWith("Tool execution cancelled."))).toBe(true);
  expect(JSON.stringify(results)).not.toContain("private cancellation reason");
  expect(await lane.run("new explicit work")).toMatchObject({ ok: true });
});

test("a pre-aborted run admits no prompt, provider request, or tool effect", async () => {
  const { lane, provider } = await batchLane(batchCalls(["parallel"]), batchTools(async () => {
    throw new Error("Pre-aborted batch must not execute tools");
  }));
  expect(await lane.run("cancelled", { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { _tag: "AgentRunCancelled" } });
  expect((await lane.getSnapshot()).transcript).toEqual([]);
  expect(provider.requests).toEqual([]);
});

test("termination requires every finalized result across the complete batch, including error outcomes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({
      mode: fc.constantFrom("parallel", "sequential"),
      terminate: fc.option(fc.boolean(), { nil: undefined }),
      status: fc.constantFrom("success", "error"),
    }), { minLength: 1, maxLength: 12 }),
    async (entries) => {
      const executed: number[] = [];
      const { lane, provider } = await batchLane(batchCalls(entries.map((entry) => entry.mode)), batchTools(async (index) => {
        executed.push(index);
        const entry = entries[index];
        if (!entry) throw new Error("Termination test missing generated outcome");
        const value = { status: entry.status, content: String(index) };
        return { ok: true, value: entry.terminate === undefined ? value : { ...value, terminate: entry.terminate } };
      }));
      const result = await lane.run("settle the full batch");
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      const allTerminate = entries.every((entry) => entry.terminate === true);
      expect(result.value.stopReason).toBe(allTerminate ? "tool_termination" : "stop");
      expect(provider.requests).toHaveLength(allTerminate ? 1 : 2);
      expect(executed).toEqual(entries.map((_, index) => index));
      expect((await lane.getSnapshot()).context.filter((message) => message.role === "tool")).toHaveLength(entries.length);
    },
  ), { numRuns: 60 });
});

test("an all-terminating mixed-mode batch settles every sibling and beats the last-step budget", async () => {
  const executed: number[] = [];
  const { lane, provider } = await batchLane(batchCalls(["sequential", "parallel", "parallel"]), batchTools(async (index) => {
    executed.push(index);
    return { ok: true, value: { status: index === 0 ? "error" : "success", content: `result-${index}`, terminate: true } };
  }));
  expect(await lane.run("end this turn", { maxAssistantSteps: 1 })).toMatchObject({ ok: true, value: {
    stopReason: "tool_termination", outcomes: [
      { content: "result-0", terminate: true }, { content: "result-1", terminate: true }, { content: "result-2", terminate: true },
    ],
  } });
  expect(executed).toEqual([0, 1, 2]);
  expect(provider.requests).toHaveLength(1);
  expect((await lane.getSnapshot()).status).toBe("idle");
  expect(await lane.run("explicit next turn")).toMatchObject({ ok: true, value: { content: "done" } });
});

test("an empty tool batch does not terminate by vacuous truth", async () => {
  const { lane, provider } = await batchLane([], batchTools(async () => {
    throw new Error("Empty tool batch must not execute");
  }));
  expect(await lane.run("no tools")).toMatchObject({ ok: true, value: { role: "assistant", stopReason: "stop" } });
  expect(provider.requests).toHaveLength(1);
});

test("cancellation takes precedence over a unanimous termination hint", async () => {
  const controller = new AbortController();
  const { lane, provider } = await batchLane(batchCalls(["sequential", "parallel"]), batchTools(async () => {
    controller.abort();
    return { ok: true, value: { status: "success", content: "completed effect", terminate: true } };
  }));
  expect(await lane.run("cancel", { signal: controller.signal })).toMatchObject({ ok: false, error: { _tag: "AgentRunCancelled" } });
  expect(provider.requests).toHaveLength(1);
  expect((await lane.getSnapshot()).status).toBe("idle");
});

test("parallel admission is bounded without changing group result order", async () => {
  const gates = Promise.withResolvers<void>();
  const full = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  const { lane } = await batchLane(batchCalls(Array.from({ length: 12 }, () => "parallel")), batchTools(async (index) => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 2) full.resolve();
    await gates.promise;
    active--;
    return successfulToolResult(String(index));
  }));
  const work = lane.run("bounded", { maxParallelTools: 2 });
  try { await full.promise; expect(active).toBe(2); }
  finally { gates.resolve(); }
  expect((await work).ok).toBe(true);
  expect(maximum).toBe(2);
});

test("the elapsed run budget aborts tools and drains their outcomes", async () => {
  const { lane, provider } = await batchLane(batchCalls(["parallel"]), batchTools(async (_, signal) => {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return cancelledToolResult();
  }));
  expect(await lane.run("bounded", { maxDurationMs: 20 })).toMatchObject({ ok: false, error: { _tag: "AgentRunBudgetExceeded", resource: "time" } });
  expect(provider.requests).toHaveLength(1);
  expect((await lane.getSnapshot()).status).toBe("idle");
});

test("an over-budget batch is recorded as non-executed before any effects", async () => {
  const { lane } = await batchLane(batchCalls(["parallel", "parallel"]), batchTools(async () => { throw new Error("Over-budget call executed"); }));
  expect(await lane.run("bounded", { maxToolCalls: 1 })).toMatchObject({ ok: false, error: { resource: "tools" } });
  expect((await lane.getSnapshot()).context.filter((message) => message.role === "tool")).toHaveLength(2);
  expect((await lane.getSnapshot()).status).toBe("idle");
});

test("context admission rejects oversized accumulated results without cutting call/result pairs", async () => {
  const { lane, provider } = await batchLane(batchCalls(["parallel"]), batchTools(async () => successfulToolResult("x".repeat(2048))));
  expect(await lane.run("bounded", { maxContextBytes: 1024 })).toMatchObject({ ok: false, error: { resource: "context" } });
  expect(provider.requests).toHaveLength(1);
  expect((await lane.getSnapshot()).status).toBe("idle");
});

test("generated mixed schedules never cross a sequential barrier or reorder transcript pairing", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom("parallel", "sequential"), { minLength: 1, maxLength: 20 }),
    async (modes) => {
      const events: string[] = [];
      const calls = batchCalls(modes);
      const { lane, provider } = await batchLane(calls, batchTools(async (index) => {
        events.push(`start-${index}`);
        await Promise.resolve();
        events.push(`end-${index}`);
        return successfulToolResult(String(index));
      }));
      expect((await lane.run("schedule")).ok).toBe(true);
      for (const [index, mode] of modes.entries()) {
        if (mode !== "sequential") continue;
        for (let before = 0; before < index; before++) expect(events.indexOf(`end-${before}`)).toBeLessThan(events.indexOf(`start-${index}`));
        for (let after = index + 1; after < modes.length; after++) expect(events.indexOf(`start-${after}`)).toBeGreaterThan(events.indexOf(`end-${index}`));
      }
      expect(provider.requests[1]?.messages.filter((message) => message.role === "tool"))
        .toEqual(calls.map((call, index) => ({ role: "tool", toolCallId: call.id, content: String(index) })));
    },
  ), { numRuns: 50 });
});
