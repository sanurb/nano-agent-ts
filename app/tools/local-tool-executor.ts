import type { AgentToolCall } from "../agent/agent-message.ts";
import { ToolExecutionError, type AgentToolExecutor } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { executeBashTool } from "./bash-tool.ts";
import { executeReadTool } from "./read-tool.ts";
import { executeWriteTool } from "./write-tool.ts";

/** Dispatch local tools without owning history, stdout, or automatic retries. */
export class LocalToolExecutor implements AgentToolExecutor {
  /** Return tool-result text; Read preserves BOMs and replaces malformed UTF-8 byte sequences. */
  async executeTool(call: AgentToolCall): Promise<OperationResult<string, ToolExecutionError>> {
    switch (call.name) {
      case "Read": {
        const result = await executeReadTool(call);
        if (!result.ok) return result;
        return { ok: true, value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.value) };
      }
      case "Write":
        return executeWriteTool(call);
      case "Bash":
        return executeBashTool(call);
      default:
        return { ok: false, error: new ToolExecutionError("unsupported_tool") };
    }
  }
}
