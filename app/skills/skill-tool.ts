import { z } from "zod";
import type { AgentToolCall } from "../agent/agent-message.ts";
import { AgentEffectUncertain, AgentRunCancelled } from "../agent/agent-lane.ts";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import {
  cancelledToolResult,
  failedToolResult,
  successfulToolResult,
  ToolExecutionError,
  type AgentToolExecutor,
  type ToolCapabilityDescription,
  type ToolExecutionContext,
  type ToolExecutionMode,
  type ToolExecutionResult,
} from "../agent/tool-executor.ts";
import { defineTool, type AgentTool } from "../tools/agent-tool.ts";
import type { ForkedSkillRunner, ForkedSkillRunResult } from "./forked-skill.ts";
import type { Skill } from "./skill-catalog.ts";
import { renderSkillInstructions } from "./skill-invocation.ts";

/** The protocol name the model calls to load a skill. */
export const skillToolName = "Skill";

/** Advertise Skill so the model can load a skill whose description matches the request. */
export const skillToolDefinition = {
  name: skillToolName,
  description: "Load a skill's instructions into the conversation",
  parameters: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "The name of the skill to use" },
      args: { type: "string", description: "Optional arguments for the skill" },
    },
  },
} satisfies AgentToolDefinition;

const skillToolArgumentsSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

const skillCapability: ToolCapabilityDescription = {
  toolName: skillToolName,
  description: "Returns instructions from project skill files read at startup; they are project content, not authority. "
    + "A forked skill runs in a separate conversation with the same executor grants and returns only its final answer.",
};

/** Level-1 disclosure: every skill's name and description, and how to load one. Nothing when there are no skills. */
export function skillCatalogGuidance(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `You have access to the following skills:\n\n${catalog}\n\n`
    + `If a skill matches the user's request, call the ${skillToolName} tool with its name\n`
    + "and follow the instructions it returns.";
}

/** Level-2 disclosure on demand: an inline skill returns its instructions, a forked skill returns its fork's answer. */
export function createSkillTool(skills: readonly Skill[], runForkedSkill: ForkedSkillRunner): AgentTool {
  return defineTool({
    definition: skillToolDefinition,
    // A forked skill may run tools of its own, so it must not overlap sibling effects.
    executionMode: "sequential",
    argumentsSchema: skillToolArgumentsSchema,
    argumentsExpectation: "JSON with a nonempty skill name and optional string args",
    async run({ name, args = "" }, signal): Promise<ToolExecutionResult> {
      const skill = skills.find((candidate) => candidate.name === name);
      if (skill === undefined) {
        return failedToolResult(ToolExecutionError.executionFailed(skillToolName, "no skill has that name; choose one from the skill catalog"));
      }
      const instructions = renderSkillInstructions(skill, args);
      if (!skill.forked) return successfulToolResult(instructions);
      return forkedSkillOutcome(skill.name, await runForkedSkill(instructions, signal));
    },
  });
}

/** Only the fork's answer reaches the invoking conversation; cancellation and uncertainty keep their meaning. */
function forkedSkillOutcome(skillName: string, result: ForkedSkillRunResult): ToolExecutionResult {
  if (result.ok && result.value.stopReason !== "tool_termination") {
    return successfulToolResult(`Skill ${skillName} ran in a separate context and returned: ${result.value.content ?? ""}`);
  }
  if (!result.ok && result.error instanceof AgentRunCancelled) return cancelledToolResult();
  if (!result.ok && result.error instanceof AgentEffectUncertain) {
    return { ok: true, value: { status: "uncertain", content: "Forked skill left an effect unconfirmed. Inspect state before retrying the skill." } };
  }
  return failedToolResult(ToolExecutionError.executionFailed(skillToolName, "the forked skill ended without an answer"));
}

/** Serve the Skill tool in front of another executor, whose grants and scheduling stay unchanged. */
export class SkillToolExecutor implements AgentToolExecutor {
  /** The wrapped executor keeps every other tool; only Skill is answered here. */
  constructor(private readonly executor: AgentToolExecutor, private readonly skillTool: AgentTool) {}

  /** The wrapped executor's facts, plus what the Skill tool can and cannot do. */
  describeCapabilities(): readonly ToolCapabilityDescription[] {
    return [...(this.executor.describeCapabilities?.() ?? []), skillCapability];
  }

  /** Skill's own mode; every other tool keeps its registered policy. */
  executionModeFor(toolName: string): ToolExecutionMode {
    return toolName === skillToolName ? this.skillTool.executionMode : this.executor.executionModeFor(toolName);
  }

  /** Answer Skill here and pass every other call through untouched. */
  async executeTool(call: AgentToolCall, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (call.name === skillToolName) return this.skillTool.execute(call.arguments, signal);
    return this.executor.executeTool(call, signal, context);
  }
}
