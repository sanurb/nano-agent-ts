import { expect, test } from "bun:test";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { failedToolResult, ToolExecutionError, type ToolExecutionResult } from "../agent/tool-executor.ts";
import { LocalToolExecutor } from "./local-tool-executor.ts";
import { localTools } from "./local-tools.ts";

const executor = new LocalToolExecutor(localTools);

function call(name: string, args: string) {
  return { id: toolCallIdSchema.parse("dispatch"), name, arguments: args };
}

test("dispatch routes a call to the tool advertising that exact name", async () => {
  expect(await executor.executeTool(call("Bash", JSON.stringify({ command: "echo routed" })))).toEqual({
    ok: true,
    value: { status: "success", content: "routed\n" },
  });
});

test("dispatch rejects an unregistered tool without disclosing the requested name", async () => {
  const result = await executor.executeTool(call("Delete", "{}"));
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      reason: "unsupported_tool",
      message: "Unsupported tool call: no executor for requested tool",
    }),
  });
});

test("every registered tool declares its scheduling mode independently of its provider advertisement", () => {
  expect(localTools.map((tool) => [tool.definition.name, tool.executionMode])).toEqual([
    ["Read", "parallel"], ["Glob", "parallel"], ["Grep", "parallel"],
    ["Edit", "sequential"], ["Write", "sequential"], ["Bash", "sequential"],
  ]);
  for (const tool of localTools) {
    expect(executor.executionModeFor(tool.definition.name)).toBe(tool.executionMode);
    expect(tool.definition).not.toHaveProperty("executionMode");
  }
});

test("model-correctable errors cannot inhabit the executor admission-error channel", () => {
  const error = ToolExecutionError.invalidArguments("Read", "a file path");
  // @ts-expect-error Correctable argument errors must be recorded through failedToolResult, not abort the run.
  const invalidResult: ToolExecutionResult = { ok: false, error };
  expect(invalidResult.ok).toBe(false);
  expect(failedToolResult(error)).toEqual({ ok: true, value: { status: "error", content: error.message } });
});
