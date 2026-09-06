import {
  branchNameSchema,
  ConversationSession,
  InvalidBranchName,
  type BranchName,
  type SessionEntryId,
  type SessionEntryIds,
  type UnknownSessionEntry,
} from "../session/conversation-session.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { AgentLane, type AgentLaneConfiguration } from "./agent-lane.ts";
import type { AssistantProvider } from "./assistant-provider.ts";
import type { AgentToolExecutor } from "./tool-executor.ts";

/** Immutable lane defaults plus an explicitly supplied source of entry identities. */
export interface AgentHarnessOptions extends AgentLaneConfiguration {
  readonly entryIds: SessionEntryIds;
}

/** Creation-only settings; acquiring an existing lane never moves or reconfigures it. */
export interface AcquireLaneOptions {
  readonly createAt?: SessionEntryId | null;
  readonly configuration?: AgentLaneConfiguration;
}

/** Manages named lanes over one privately owned in-memory session; never acts as main. */
export class AgentHarness {
  readonly #session: ConversationSession;
  readonly #lanes = new Map<BranchName, AgentLane>();
  readonly #seed: AgentLaneConfiguration;

  /** Creates no lanes, starts no model work, and captures defaults by value. */
  constructor(
    private readonly provider: AssistantProvider,
    options: AgentHarnessOptions,
    private readonly toolExecutor: AgentToolExecutor | null = null,
  ) {
    this.#session = new ConversationSession(options.entryIds);
    this.#seed = structuredClone({ model: options.model, tools: options.tools });
  }

  /** Atomically acquire a named lane; main is an explicit name, not an inherited operation. */
  async lane(
    name: string,
    options: AcquireLaneOptions = {},
  ): Promise<OperationResult<AgentLane, InvalidBranchName | UnknownSessionEntry>> {
    const parsed = branchNameSchema.safeParse(name);
    if (!parsed.success) return { ok: false, error: new InvalidBranchName() };
    const existing = this.#lanes.get(parsed.data);
    if (existing) return { ok: true, value: existing };
    const branch = this.#session.acquireBranch(parsed.data, options.createAt ?? null);
    if (!branch.ok) return branch;
    // No await between branch acquisition and publishing its single execution owner.
    const lane = new AgentLane(branch.value, this.provider, options.configuration ?? this.#seed, this.toolExecutor);
    this.#lanes.set(parsed.data, lane);
    return { ok: true, value: lane };
  }

  /** Inventory only; observing lanes never acquires main or starts background work. */
  async lanes(): Promise<readonly string[]> {
    return [...this.#lanes.keys()];
  }
}
