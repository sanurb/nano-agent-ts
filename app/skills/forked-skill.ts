import type { AgentHarness } from "../agent/agent-harness.ts";
import type { AssistantResponse } from "../agent/agent-message.ts";
import type { AgentLaneConfiguration, ToolBatchTermination } from "../agent/agent-lane.ts";
import type { OperationResult } from "../shared/operation-result.ts";

const forkedSkillLanePrefix = "forked-skill";

/** A forked skill's final answer, or why its lane produced none. */
export type ForkedSkillRunResult = OperationResult<AssistantResponse | ToolBatchTermination, Error>;

/** Run skill instructions as the only prompt of a fresh conversation. */
export type ForkedSkillRunner = (instructions: string, signal?: AbortSignal) => Promise<ForkedSkillRunResult>;

/**
 * Each fork gets its own new lane, so it never sees the conversation that invoked it.
 * The harness is created after the executor that holds this runner, so it is resolved per fork.
 */
export function createForkedSkillRunner(getHarness: () => AgentHarness, configuration: AgentLaneConfiguration): ForkedSkillRunner {
  let forks = 0;
  return async (instructions, signal) => {
    forks += 1;
    const lane = await getHarness().lane(`${forkedSkillLanePrefix}-${forks}`, { configuration });
    if (!lane.ok) return lane;
    return lane.value.run(instructions, signal === undefined ? {} : { signal });
  };
}
