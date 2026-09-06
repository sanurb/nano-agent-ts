import { z } from "zod";
import type { OperationResult } from "../shared/operation-result.ts";
import type { AgentToolCall } from "./agent-message.ts";
import type { ToolOutcome } from "./tool-executor.ts";

/** Operator reconciliation evidence is bounded in UTF-16 code units at both CLI and storage boundaries. */
export const maxReconciliationCharacters = 4096;

/** Runtime invocation identity, never a reused provider tool-call ID. */
export const toolExecutionIdSchema = z.uuid().brand<"ToolExecutionId">();
/** Unique durable identity for one admitted effect attempt. */
export type ToolExecutionId = z.infer<typeof toolExecutionIdSchema>;

/** Durable evidence retains uncertainty rather than inventing an exactly-once effect guarantee. */
export interface JournalInvocation {
  readonly id: ToolExecutionId;
  readonly call: AgentToolCall;
  readonly state: "started" | "settled" | "not_executed";
  readonly outcome: ToolOutcome | null;
  /** Separate operator evidence never replaces the original observed outcome. */
  readonly reconciliation: string | null;
}

/** Storage and recovery failures must stop admission, not be treated as successful logging. */
export class ExecutionJournalError extends Error {
  /** Stable journal failure tag. */
  readonly _tag = "ExecutionJournalError" as const;
  /** Raw database paths, SQL, and stored tool payloads never enter the diagnostic. */
  constructor(readonly reason: "unavailable" | "busy" | "corrupt" | "unresolved") {
    super(`Execution journal unavailable: ${reason}; inspect state before continuing`);
  }
}

/** Write intent before dispatch and outcome before releasing execution ownership. */
export interface ToolExecutionJournal {
  start(call: AgentToolCall): OperationResult<ToolExecutionId, ExecutionJournalError>;
  finish(id: ToolExecutionId, outcome: ToolOutcome | null): OperationResult<void, ExecutionJournalError>;
  inspect(): OperationResult<readonly JournalInvocation[], ExecutionJournalError>;
  unresolved(): OperationResult<readonly ToolExecutionId[], ExecutionJournalError>;
}
