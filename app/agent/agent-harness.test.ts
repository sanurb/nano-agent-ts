import { expect, test } from "bun:test";
import { sessionEntryIdSchema } from "../session/conversation-session.ts";
import { AgentHarness, type AcquireLaneOptions } from "./agent-harness.ts";
import type { AgentLane } from "./agent-lane.ts";
import { toolCallIdSchema, type AssistantResponse } from "./agent-message.ts";
import {
  AssistantRequestFailed,
  type AssistantProvider,
  type AssistantRequest,
  type AssistantRequestResult,
} from "./assistant-provider.ts";

function assistantResponse(content: string | null): AssistantResponse {
  return { role: "assistant", content, stopReason: "stop", toolCalls: [] };
}

function entryIds() {
  let sequence = 0;
  return { next: () => `entry-${++sequence}` };
}

class ControlledAssistantProvider implements AssistantProvider {
  readonly requests: AssistantRequest[] = [];
  readonly #pending: ReturnType<typeof Promise.withResolvers<AssistantRequestResult>>[] = [];

  requestAssistant(request: AssistantRequest): Promise<AssistantRequestResult> {
    const pending = Promise.withResolvers<AssistantRequestResult>();
    this.requests.push(request);
    this.#pending.push(pending);
    return pending.promise;
  }

  settle(index: number, result: AssistantRequestResult): void {
    const pending = this.#pending[index];
    if (!pending) throw new Error("Controlled provider has no pending request at this index");
    pending.resolve(result);
  }

  fail(index: number, defect: Error): void {
    const pending = this.#pending[index];
    if (!pending) throw new Error("Controlled provider has no pending request at this index");
    pending.reject(defect);
  }
}

async function acquireLane(harness: AgentHarness, name: string, options: AcquireLaneOptions = {}): Promise<AgentLane> {
  const result = await harness.lane(name, options);
  if (!result.ok) throw result.error;
  return result.value;
}

function createHarness(provider: AssistantProvider): AgentHarness {
  return new AgentHarness(provider, { model: "main-model", tools: [], entryIds: entryIds() });
}

test("harness is a manager with no implicit main; concurrent acquisition publishes one lane", async () => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  expect(await harness.lanes()).toEqual([]);
  expect("requestAssistant" in harness).toBe(false);
  const [first, second] = await Promise.all([acquireLane(harness, "main"), acquireLane(harness, "main")]);
  expect(first).toBe(second);
  expect(await harness.lanes()).toEqual(["main"]);
  expect(provider.requests).toEqual([]);
});

test.each(["main", "research"] as const)("same-lane overlap is rejected; either lane can finish first: %s", async (firstToFinish) => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  const main = await acquireLane(harness, "main");
  const research = await acquireLane(harness, "research", {
    configuration: { model: "research-model", tools: [] },
  });
  const mainWork = main.requestAssistant("main input");
  const duplicate = await main.requestAssistant("must not enter history");
  expect(duplicate).toMatchObject({ ok: false, error: { reason: "busy" } });
  expect(await main.startContextWindow("must not roll")).toMatchObject({ ok: false, error: { reason: "busy" } });
  const researchWork = research.requestAssistant("research input");
  expect(provider.requests.map((request) => request.model)).toEqual(["main-model", "research-model"]);
  if (firstToFinish === "research") {
    provider.settle(1, { ok: true, value: assistantResponse("research finished") });
    expect((await researchWork).ok).toBe(true);
    expect((await main.getSnapshot()).status).toBe("requesting");
    expect((await research.getSnapshot()).status).toBe("idle");
    provider.settle(0, { ok: true, value: assistantResponse("main finished") });
  } else {
    provider.settle(0, { ok: true, value: assistantResponse("main finished") });
    expect((await mainWork).ok).toBe(true);
    expect((await research.getSnapshot()).status).toBe("requesting");
    expect((await main.getSnapshot()).status).toBe("idle");
    provider.settle(1, { ok: true, value: assistantResponse("research finished") });
  }
  await Promise.all([mainWork, researchWork]);
  expect((await main.getSnapshot()).context).toEqual([
    { role: "user", content: "main input" }, assistantResponse("main finished"),
  ]);
  const next = main.requestAssistant("next input");
  expect(provider.requests[2]?.messages).toEqual([
    { role: "user", content: "main input" }, assistantResponse("main finished"),
    { role: "user", content: "next input" },
  ]);
  provider.settle(2, { ok: true, value: assistantResponse("next answer") });
  await next;
});

test("branches share entry identities at their anchor, then diverge without changing each other", async () => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  const main = await acquireLane(harness, "main");
  const initial = main.requestAssistant("shared input");
  provider.settle(0, { ok: true, value: assistantResponse("shared answer") });
  await initial;
  const shared = await main.getSnapshot();
  const research = await acquireLane(harness, "research", { createAt: shared.tipId });
  expect((await research.getSnapshot()).transcript).toEqual(shared.transcript);
  const mainWork = main.requestAssistant("main only");
  const researchWork = research.requestAssistant("research only");
  provider.settle(2, { ok: true, value: assistantResponse("research answer") });
  await researchWork;
  provider.settle(1, { ok: true, value: assistantResponse("main answer") });
  await mainWork;
  const mainAfter = await main.getSnapshot();
  const researchAfter = await research.getSnapshot();
  expect(mainAfter.transcript.slice(0, 2)).toEqual([...shared.transcript]);
  expect(researchAfter.transcript.slice(0, 2)).toEqual([...shared.transcript]);
  expect(mainAfter.transcript[2]?.parentId).toBe(shared.tipId);
  expect(researchAfter.transcript[2]?.parentId).toBe(shared.tipId);
  expect(mainAfter.context).not.toContainEqual({ role: "user", content: "research only" });
  expect(researchAfter.context).not.toContainEqual({ role: "user", content: "main only" });
  const suffixes = [...mainAfter.transcript.slice(2), ...researchAfter.transcript.slice(2)];
  expect(new Set(suffixes.map((entry) => entry.seq)).size).toBe(4);
});

test("creation-only configuration is captured; reacquiring a lane ignores anchor and configuration", async () => {
  const provider = new ControlledAssistantProvider();
  const seed = { model: "seed", tools: [{ name: "Read", description: "read", parameters: { required: ["path"] } }], entryIds: entryIds() };
  const harness = new AgentHarness(provider, seed);
  seed.model = "mutated";
  seed.tools[0]?.parameters.required.push("unwanted");
  const main = await acquireLane(harness, "main");
  const same = await acquireLane(harness, "main", {
    createAt: sessionEntryIdSchema.parse("does-not-exist"),
    configuration: { model: "replacement", tools: [] },
  });
  expect(same).toBe(main);
  const work = main.requestAssistant("hello");
  expect(provider.requests[0]?.model).toBe("seed");
  expect(provider.requests[0]?.tools[0]?.parameters.required).toEqual(["path"]);
  provider.settle(0, { ok: true, value: assistantResponse("done") });
  await work;
});

test("provider errors retain accepted input and release lane ownership for a later request", async () => {
  const provider = new ControlledAssistantProvider();
  const main = await acquireLane(createHarness(provider), "main");
  const work = main.requestAssistant("accepted input");
  const failure = new AssistantRequestFailed(503);
  provider.settle(0, { ok: false, error: failure });
  expect(await work).toEqual({ ok: false, error: failure });
  expect((await main.getSnapshot()).status).toBe("idle");
  const retry = main.requestAssistant("please retry");
  expect(provider.requests[1]?.messages).toEqual([
    { role: "user", content: "accepted input" }, { role: "user", content: "please retry" },
  ]);
  provider.settle(1, { ok: true, value: assistantResponse("done") });
  await retry;
});

test("unexpected provider rejection stays a defect and cannot leave the lane permanently busy", async () => {
  const provider = new ControlledAssistantProvider();
  const main = await acquireLane(createHarness(provider), "main");
  const work = main.requestAssistant("hello");
  const defect = new Error("Scripted provider defect");
  provider.fail(0, defect);
  await expect(work).rejects.toBe(defect);
  expect((await main.getSnapshot()).status).toBe("idle");
});

test.each(["tool_use", "length"] as const)("unresolved %s tool calls block continuation and rollover, including anchored lanes", async (stopReason) => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  const main = await acquireLane(harness, "main");
  const work = main.requestAssistant("read a file");
  const response = {
    ...assistantResponse(null),
    stopReason,
    toolCalls: [{ id: toolCallIdSchema.parse("call-1"), name: "Read", arguments: '{"file_path":"README.md"}' }],
  };
  provider.settle(0, { ok: true, value: response });
  expect(await work).toEqual({ ok: true, value: response });
  const snapshot = await main.getSnapshot();
  expect(snapshot.status).toBe("awaiting_tools");
  const child = await acquireLane(harness, "child", { createAt: snapshot.tipId });
  for (const lane of [main, child]) {
    expect(await lane.requestAssistant("continue")).toMatchObject({ ok: false, error: { reason: "pending_tools" } });
    expect(await lane.startContextWindow("unsafe reset")).toMatchObject({ ok: false, error: { reason: "pending_tools" } });
    expect((await lane.getSnapshot()).transcript).toEqual(snapshot.transcript);
  }
  expect(provider.requests).toHaveLength(1);
});

test("context rollover retains complete history and changes only its branch's active context", async () => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  const main = await acquireLane(harness, "main");
  const first = main.requestAssistant("old input");
  provider.settle(0, { ok: true, value: assistantResponse("old answer") });
  await first;
  const before = await main.getSnapshot();
  const research = await acquireLane(harness, "research", { createAt: before.tipId });
  const rollover = await main.startContextWindow("Check the actual files before continuing.");
  expect(rollover.ok).toBe(true);
  const after = await main.getSnapshot();
  expect(after.transcript.slice(0, 2)).toEqual([...before.transcript]);
  expect(after.transcript[2]).toMatchObject({ type: "context_window", parentId: before.tipId });
  expect(after.context).toEqual([{
    role: "user",
    content: "Context handoff (caller-supplied; verify live state before acting):\nCheck the actual files before continuing.",
  }]);
  expect((await research.getSnapshot()).context).toEqual(before.context);
  const next = main.requestAssistant("new input");
  expect(provider.requests[1]?.messages).toEqual([...after.context, { role: "user", content: "new input" }]);
  provider.settle(1, { ok: true, value: assistantResponse("new answer") });
  await next;
  await main.startContextWindow("");
  expect((await main.getSnapshot()).context).toEqual([]);
  expect((await main.getSnapshot()).transcript).toHaveLength(6);
});

test("snapshots and provider inputs cannot mutate committed history or lane configuration", async () => {
  const provider = new ControlledAssistantProvider();
  const main = await acquireLane(createHarness(provider), "main");
  const work = main.requestAssistant("original");
  const request = provider.requests[0];
  if (!request) throw new Error("Snapshot test expected a provider request");
  Object.defineProperty(request.messages[0], "content", { value: "tampered request" });
  const answer = assistantResponse("answer");
  provider.settle(0, { ok: true, value: answer });
  await work;
  Object.defineProperty(answer, "content", { value: "tampered response" });
  const snapshot = await main.getSnapshot();
  Object.defineProperty(snapshot.configuration, "model", { value: "tampered model" });
  Object.defineProperty(snapshot.context[0], "content", { value: "tampered snapshot" });
  const next = await main.getSnapshot();
  expect(next.configuration.model).toBe("main-model");
  expect(next.context[0]).toEqual({ role: "user", content: "original" });
  expect(next.context[1]).toEqual(assistantResponse("answer"));
});

test("invalid acquisition and empty prompts have no effects or ghost lanes", async () => {
  const provider = new ControlledAssistantProvider();
  const harness = createHarness(provider);
  for (const name of ["", "bad\u0000name"]) {
    expect(await harness.lane(name)).toMatchObject({ ok: false, error: { _tag: "InvalidBranchName" } });
  }
  expect(await harness.lane("missing", { createAt: sessionEntryIdSchema.parse("missing") })).toMatchObject({
    ok: false, error: { _tag: "UnknownSessionEntry" },
  });
  expect(await harness.lanes()).toEqual([]);
  const main = await acquireLane(harness, "main");
  expect(await main.requestAssistant("")).toMatchObject({ ok: false, error: { reason: "empty_prompt" } });
  expect((await main.getSnapshot()).transcript).toEqual([]);
  expect(provider.requests).toEqual([]);
});
