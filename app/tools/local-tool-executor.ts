import type { AgentToolCall } from "../agent/agent-message.ts";
import { ToolExecutionError, type AgentToolExecutor, type ToolExecutionMode, type ToolExecutionResult } from "../agent/tool-executor.ts";
import type { AgentTool } from "./agent-tool.ts";

/** Dispatch by advertised name without owning history, stdout, or automatic retries. */
export class LocalToolExecutor implements AgentToolExecutor {
  readonly #tools: ReadonlyMap<string, AgentTool>;

  /** Registration happens once at the composition root; later calls cannot introduce a tool. */
  constructor(tools: readonly AgentTool[]) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  /** Unknown names cannot execute; they conservatively occupy a sequential admission slot. */
  executionModeFor(toolName: string): ToolExecutionMode {
    return this.#tools.get(toolName)?.executionMode ?? "sequential";
  }

  /** Route to the named tool and let it parse its own arguments; misrouting is unrepresentable. */
  async executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(call.name);
    if (!tool) return { ok: false, error: ToolExecutionError.unsupportedTool() };
    return tool.execute(call.arguments, signal);
  }
}
