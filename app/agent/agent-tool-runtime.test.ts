import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SqliteExecutionJournal } from "../session/sqlite-execution-journal.ts";
import { defineTool } from "../tools/agent-tool.ts";
import { LocalToolExecutor } from "../tools/local-tool-executor.ts";
import { AgentToolRuntime, type AgentToolBatchOptions } from "./agent-tool-runtime.ts";
import { JournaledToolExecutor } from "./journaled-tool-executor.ts";
import { toolCallIdSchema, type AgentToolCall } from "./agent-message.ts";
import type { ToolExecutionId } from "./tool-execution-journal.ts";
import { successfulToolResult } from "./tool-executor.ts";

function toolCall(id: string, name: string): AgentToolCall {
  return { id: toolCallIdSchema.parse(id), name, arguments: "{}" };
}

function nestedBatchOptions(
  activeToolName: string,
  parentExecutionId: ToolExecutionId,
  signal: AbortSignal | undefined,
): AgentToolBatchOptions {
  const options = {
    activeToolNames: new Set([activeToolName]),
    maxParallelTools: 1,
    parentExecutionId,
  } satisfies AgentToolBatchOptions;
  return signal === undefined ? options : { ...options, signal };
}

test("nested tool batches persist parent linkage and reject calls from a settled parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tool-runtime-"));
  try {
    const opened = await SqliteExecutionJournal.open(join(root, "journal.sqlite"));
    if (!opened.ok) throw opened.error;
    const journal = opened.value;
    let runtime: AgentToolRuntime | undefined;
    let childExecutions = 0;
    const child = defineTool({
      definition: { name: "NestedRead", description: "Return a nested result", parameters: {} },
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async () => {
        childExecutions++;
        return successfulToolResult("nested result");
      },
    });
    const parent = defineTool({
      definition: { name: "CodeCell", description: "Run nested tools", parameters: {} },
      executionMode: "sequential",
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async (_args, signal, context) => {
        const parentExecutionId = context?.executionId;
        const nestedRuntime = runtime;
        if (parentExecutionId === undefined || nestedRuntime === undefined) {
          throw new Error("Nested runtime test defect: parent execution context was not published");
        }
        const batch = await nestedRuntime.executeToolBatch(
          [toolCall("nested-call", "NestedRead")],
          nestedBatchOptions("NestedRead", parentExecutionId, signal),
        );
        if (!batch.ok) return batch;
        const outcome = batch.value.outcomes[0];
        return outcome === undefined ? successfulToolResult("no nested result") : { ok: true, value: outcome };
      },
    });
    const executor = new JournaledToolExecutor(new LocalToolExecutor([parent, child]), journal);
    runtime = new AgentToolRuntime(executor);

    try {
      expect(await executor.executeTool(toolCall("parent-call", "CodeCell"))).toEqual(
        successfulToolResult("nested result"),
      );
      const inspected = journal.inspect();
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value).toHaveLength(2);
      const [parentInvocation, childInvocation] = inspected.value;
      if (!parentInvocation || !childInvocation) {
        throw new Error("Nested runtime test defect: expected parent and child journal entries");
      }
      expect(parentInvocation).toMatchObject({ parentExecutionId: null, call: { name: "CodeCell" } });
      expect(childInvocation).toMatchObject({
        parentExecutionId: parentInvocation.id,
        call: { name: "NestedRead" },
      });

      expect(await runtime.executeToolBatch([toolCall("late-call", "NestedRead")], {
        activeToolNames: new Set(["NestedRead"]),
        maxParallelTools: 1,
        parentExecutionId: parentInvocation.id,
      })).toMatchObject({ ok: false, error: { reason: "recovery_required" } });
      expect(childExecutions).toBe(1);
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested uncertainty becomes the parent outcome and blocks later execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tool-runtime-"));
  try {
    const opened = await SqliteExecutionJournal.open(join(root, "journal.sqlite"));
    if (!opened.ok) throw opened.error;
    const journal = opened.value;
    let runtime: AgentToolRuntime | undefined;
    const uncertainChild = defineTool({
      definition: { name: "UncertainChild", description: "Return an uncertain outcome", parameters: {} },
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async () => ({ ok: true, value: { status: "uncertain", content: "inspect nested effect" } }),
    });
    const parent = defineTool({
      definition: { name: "CodeCell", description: "Run nested tools", parameters: {} },
      executionMode: "sequential",
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async (_args, signal, context) => {
        const parentExecutionId = context?.executionId;
        const nestedRuntime = runtime;
        if (parentExecutionId === undefined || nestedRuntime === undefined) {
          throw new Error("Nested runtime test defect: parent execution context was not published");
        }
        const batch = await nestedRuntime.executeToolBatch(
          [toolCall("nested-call", "UncertainChild")],
          nestedBatchOptions("UncertainChild", parentExecutionId, signal),
        );
        if (!batch.ok) return batch;
        const outcome = batch.value.outcomes[0];
        return outcome === undefined ? successfulToolResult("no nested result") : { ok: true, value: outcome };
      },
    });
    const executor = new JournaledToolExecutor(new LocalToolExecutor([parent, uncertainChild]), journal);
    runtime = new AgentToolRuntime(executor);

    try {
      expect(await executor.executeTool(toolCall("parent-call", "CodeCell")))
        .toMatchObject({ ok: true, value: { status: "uncertain" } });
      const inspected = journal.inspect();
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value.map((entry) => entry.outcome?.status)).toEqual(["uncertain", "uncertain"]);
      expect(journal.unresolved()).toMatchObject({ ok: true, value: { length: 2 } });
      expect(await executor.executeTool(toolCall("blocked-call", "UncertainChild")))
        .toMatchObject({ ok: false, error: { reason: "recovery_required" } });
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid parallelism is rejected before any tool effect", async () => {
  let executions = 0;
  const tool = defineTool({
    definition: { name: "Read", description: "Count executions", parameters: {} },
    argumentsSchema: z.object({}),
    argumentsExpectation: "an object",
    run: async () => {
      executions++;
      return successfulToolResult("unexpected");
    },
  });
  const runtime = new AgentToolRuntime(new LocalToolExecutor([tool]));

  await expect(runtime.executeToolBatch([toolCall("read-call", "Read")], {
    activeToolNames: new Set(["Read"]),
    maxParallelTools: 0,
  })).rejects.toMatchObject({ _tag: "InvalidAgentToolBatchOptions" });
  expect(executions).toBe(0);
});
