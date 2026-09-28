import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentToolRuntime } from "../agent/agent-tool-runtime.ts";
import { JournaledToolExecutor } from "../agent/journaled-tool-executor.ts";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { successfulToolResult } from "../agent/tool-executor.ts";
import { SqliteExecutionJournal } from "../session/sqlite-execution-journal.ts";
import { defineTool } from "./agent-tool.ts";
import { LocalToolExecutor } from "./local-tool-executor.ts";
import {
  evalToolName,
  PythonCellToolExecutor,
  type PythonCellRunner,
} from "./python-cell-tool.ts";

test("Eval records read-only capability calls beneath the cell execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "python-cell-tool-"));
  try {
    const opened = await SqliteExecutionJournal.open(join(root, "journal.sqlite"));
    if (!opened.ok) throw opened.error;
    const journal = opened.value;
    const read = defineTool({
      definition: { name: "Read", description: "Return fixture contents", parameters: {} },
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async () => successfulToolResult("fixture contents"),
    });
    const runner: PythonCellRunner = {
      capabilityDescription: "Test runner.",
      run: async (input) => ({
        generation: 1,
        status: "success",
        output: String(await input.callCapability({
          callId: "py-child",
          name: "Read",
          arguments: {},
        }, input.signal ?? new AbortController().signal)),
        displays: [],
        executionCount: 1,
      }),
      reset: async () => 2,
      close: async () => {},
    };
    let runtime: AgentToolRuntime | undefined;
    const cells = new PythonCellToolExecutor(new LocalToolExecutor([read]), runner, () => runtime);
    const executor = new JournaledToolExecutor(cells, journal);
    runtime = new AgentToolRuntime(executor);

    try {
      expect(await executor.executeTool({
        id: toolCallIdSchema.parse("eval-parent"),
        name: evalToolName,
        arguments: JSON.stringify({ action: "run", language: "python", code: "cap.read()" }),
      }, undefined, { scopeId: "lane-a" })).toEqual(successfulToolResult("fixture contents"));
      const inspected = journal.inspect();
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value).toHaveLength(2);
      const [parent, child] = inspected.value;
      expect(parent).toMatchObject({ parentExecutionId: null, call: { name: evalToolName } });
      expect(child).toMatchObject({ parentExecutionId: parent?.id, call: { name: "Read" } });
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Eval preserves nested uncertainty even when Python catches the capability failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "python-cell-tool-"));
  try {
    const opened = await SqliteExecutionJournal.open(join(root, "journal.sqlite"));
    if (!opened.ok) throw opened.error;
    const journal = opened.value;
    const read = defineTool({
      definition: { name: "Read", description: "Return uncertainty", parameters: {} },
      argumentsSchema: z.object({}),
      argumentsExpectation: "an object",
      run: async () => ({ ok: true, value: { status: "uncertain", content: "read outcome unknown" } }),
    });
    const runner: PythonCellRunner = {
      capabilityDescription: "Test runner.",
      run: async (input) => {
        try {
          await input.callCapability({ callId: "py-child", name: "Read", arguments: {} }, input.signal ?? new AbortController().signal);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        return {
          generation: 1,
          status: "success",
          output: "caught",
          displays: [],
          executionCount: 1,
        };
      },
      reset: async () => 2,
      close: async () => {},
    };
    let runtime: AgentToolRuntime | undefined;
    const cells = new PythonCellToolExecutor(new LocalToolExecutor([read]), runner, () => runtime);
    const executor = new JournaledToolExecutor(cells, journal);
    runtime = new AgentToolRuntime(executor);

    try {
      expect(await executor.executeTool({
        id: toolCallIdSchema.parse("eval-parent"),
        name: evalToolName,
        arguments: JSON.stringify({ action: "run", language: "python", code: "try: cap.read()\\nexcept: pass" }),
      }, undefined, { scopeId: "lane-a" })).toMatchObject({ ok: true, value: { status: "uncertain" } });
      expect(journal.unresolved()).toMatchObject({ ok: true, value: { length: 2 } });
    } finally {
      journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Eval reset targets only the active lane and reports the next generation", async () => {
  const resetScopes: string[] = [];
  const runner: PythonCellRunner = {
    capabilityDescription: "Test runner.",
    run: async () => ({
      generation: 1,
      status: "success",
      output: "",
      displays: [],
      executionCount: 1,
    }),
    reset: async (scopeId) => {
      resetScopes.push(scopeId);
      return 4;
    },
    close: async () => {},
  };
  let runtime: AgentToolRuntime | undefined;
  const cells = new PythonCellToolExecutor(new LocalToolExecutor([]), runner, () => runtime);
  const executor = new JournaledToolExecutor(cells, {
    start: () => ({ ok: true, value: z.uuid().brand<"ToolExecutionId">().parse("00000000-0000-4000-8000-000000000001") }),
    finish: () => ({ ok: true, value: undefined }),
    inspect: () => ({ ok: true, value: [] }),
    unresolved: () => ({ ok: true, value: [] }),
  });
  runtime = new AgentToolRuntime(executor);

  expect(await executor.executeTool({
    id: toolCallIdSchema.parse("eval-reset"),
    name: evalToolName,
    arguments: JSON.stringify({ action: "reset", language: "python" }),
  }, undefined, { scopeId: "lane-reset" })).toEqual(
    successfulToolResult("IPython kernel reset; next generation is 4."),
  );
  expect(resetScopes).toEqual(["lane-reset"]);
});
