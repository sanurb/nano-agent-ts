import { expect, test } from "bun:test";
import { toolCallIdSchema, type AgentToolCall } from "../agent/agent-message.ts";
import { AgentEffectUncertain, AgentRunCancelled, AgentRunLimitExceeded } from "../agent/agent-lane.ts";
import { successfulToolResult, type AgentToolExecutor } from "../agent/tool-executor.ts";
import type { ForkedSkillRunner, ForkedSkillRunResult } from "./forked-skill.ts";
import type { Skill } from "./skill-catalog.ts";
import { createSkillTool, skillCatalogGuidance, SkillToolExecutor } from "./skill-tool.ts";

const skills: readonly Skill[] = [
  { name: "apple", description: "Migration status.", forked: false, directory: ".claude/skills/apple", body: "Say blueberry-$0" },
  { name: "kiwi", description: "On-call rotation.", forked: true, directory: ".claude/skills/kiwi", body: "Say cherry" },
];

const location = (name: string) =>
  `Skill: ${name} (located at .claude/skills/${name})\nPaths in the instructions below are relative to that folder.\n\n`;

function call(name: string, argumentsText: string): AgentToolCall {
  return { id: toolCallIdSchema.parse("call-1"), name, arguments: argumentsText };
}

function answer(content: string): ForkedSkillRunResult {
  return { ok: true, value: { role: "assistant", content, stopReason: "stop", toolCalls: [] } };
}

function createExecutor(forkResult: ForkedSkillRunResult = answer("cherry")) {
  const forkPrompts: string[] = [];
  const delegated: AgentToolCall[] = [];
  const delegate: AgentToolExecutor = {
    describeCapabilities: () => [{ toolName: "Read", description: "Reads files." }],
    executionModeFor: () => "parallel",
    executeTool: async (toolCall) => { delegated.push(toolCall); return successfulToolResult("delegated"); },
  };
  const runForkedSkill: ForkedSkillRunner = async (instructions) => { forkPrompts.push(instructions); return forkResult; };
  return { executor: new SkillToolExecutor(delegate, createSkillTool(skills, runForkedSkill)), forkPrompts, delegated };
}

test("the catalog advertises names and descriptions only, and nothing without skills", () => {
  expect(skillCatalogGuidance(skills)).toBe(
    "You have access to the following skills:\n\n- apple: Migration status.\n- kiwi: On-call rotation.\n\n"
      + "If a skill matches the user's request, call the Skill tool with its name\nand follow the instructions it returns.",
  );
  expect(skillCatalogGuidance([])).toBeUndefined();
});

test("an inline skill returns its substituted instructions without forking", async () => {
  const { executor, forkPrompts } = createExecutor();
  expect(await executor.executeTool(call("Skill", '{"name":"apple","args":"4127"}'))).toEqual(
    successfulToolResult(`${location("apple")}Say blueberry-4127`),
  );
  expect(forkPrompts).toEqual([]);
});

test("a forked skill's fork sees only the skill's instructions and only its answer returns", async () => {
  const { executor, forkPrompts } = createExecutor();
  expect(await executor.executeTool(call("Skill", '{"name":"kiwi"}'))).toEqual(
    successfulToolResult("Skill kiwi ran in a separate context and returned: cherry"),
  );
  expect(forkPrompts).toEqual([`${location("kiwi")}Say cherry`]);
});

test.each([
  [new AgentRunCancelled(), "cancelled"],
  [new AgentEffectUncertain(), "uncertain"],
  [new AgentRunLimitExceeded(1), "error"],
])("a fork that fails with %p settles the Skill call as %s", async (error, status) => {
  const { executor } = createExecutor({ ok: false, error });
  expect(await executor.executeTool(call("Skill", '{"name":"kiwi"}'))).toMatchObject({ ok: true, value: { status } });
});

test.each([
  ["not json", "Invalid Skill arguments"],
  ['{"name":""}', "Invalid Skill arguments"],
  ['{"name":"apple","args":7}', "Invalid Skill arguments"],
  ['{"name":"pear"}', "Skill tool failed: no skill has that name"],
])("Skill arguments %j are a correctable failure for the model", async (argumentsText, message) => {
  const { executor } = createExecutor();
  const result = await executor.executeTool(call("Skill", argumentsText));
  expect(result).toMatchObject({ ok: true, value: { status: "error", content: expect.stringContaining(message) } });
});

test("every other tool keeps the wrapped executor's dispatch, scheduling, and facts", async () => {
  const { executor, delegated } = createExecutor();
  const readCall = call("Read", '{"file_path":"README.md"}');
  expect(await executor.executeTool(readCall)).toEqual(successfulToolResult("delegated"));
  expect(delegated).toEqual([readCall]);
  expect(executor.executionModeFor("Read")).toBe("parallel");
  expect(executor.executionModeFor("Skill")).toBe("sequential");
  expect(executor.describeCapabilities().map((fact) => fact.toolName)).toEqual(["Read", "Skill"]);
});
