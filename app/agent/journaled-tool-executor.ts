import type { AgentToolCall } from "./agent-message.ts";
import type { ToolExecutionId, ToolExecutionJournal } from "./tool-execution-journal.ts";
import { cancelledToolResult, ToolExecutionError, type AgentToolExecutor, type ToolExecutionMode, type ToolExecutionResult } from "./tool-executor.ts";

/** Persist intent and outcomes around the existing executor; never replay uncertain effects automatically. */
export class JournaledToolExecutor implements AgentToolExecutor {
  readonly #active = new Set<ToolExecutionId>();
  /** One wrapper is shared across lanes so live sibling intents are not mistaken for abandoned attempts. */
  constructor(private readonly executor: AgentToolExecutor, private readonly journal: ToolExecutionJournal) {}

  /** Journaling does not alter the tool's scheduling policy. */
  executionModeFor(name: string): ToolExecutionMode { return this.executor.executionModeFor(name); }

  /** Admission fails closed on journal failure; effect evidence commits before conversation publication. */
  async executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (signal?.aborted) return cancelledToolResult();
    const unresolved = this.journal.unresolved();
    if (!unresolved.ok || unresolved.value.some((id) => !this.#active.has(id))) return { ok: false, error: ToolExecutionError.recoveryRequired() };
    const started = this.journal.start(call);
    if (!started.ok) return { ok: false, error: ToolExecutionError.recoveryRequired() };
    this.#active.add(started.value);
    try {
      const result = await this.executor.executeTool(call, signal, { executionId: started.value });
      const saved = this.journal.finish(started.value, result.ok ? result.value : null);
      return saved.ok ? result : { ok: true, value: { status: "uncertain", content: "Tool outcome could not be committed to the execution journal. Inspect effects before retrying." } };
    } catch (error) {
      // If this commit also fails, the pre-effect intent remains unresolved and still blocks future work.
      this.journal.finish(started.value, { status: "uncertain", content: "Tool implementation failed without a confirmed outcome. Inspect effects before retrying." });
      throw error;
    } finally { this.#active.delete(started.value); }
  }
}
