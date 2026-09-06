import { z } from "zod";
import type { AgentMessage } from "../agent/agent-message.ts";
import type { OperationResult } from "../shared/operation-result.ts";

/** Branch names are permanent keys; empty names and NUL are rejected at acquisition. */
export const branchNameSchema = z.string().min(1).refine((name) => !name.includes("\u0000")).brand<"BranchName">();

/** A named conversation path, distinct from an entry identity. */
export type BranchName = z.infer<typeof branchNameSchema>;

/** Entry identities are supplied by the composition root, never array positions. */
export const sessionEntryIdSchema = z.string().min(1).brand<"SessionEntryId">();

/** Opaque identity of an immutable conversation entry. */
export type SessionEntryId = z.infer<typeof sessionEntryIdSchema>;

/** Inject randomness in production or deterministic identities in tests. */
export interface SessionEntryIds {
  next(): string;
}

/** Immutable history; context boundaries retain their parent rather than deleting history. */
export type ConversationEntry = {
  readonly id: SessionEntryId;
  readonly parentId: SessionEntryId | null;
  /** Monotonic across entries in every branch of this in-memory session. */
  readonly seq: number;
} & ConversationContent;

type ConversationContent =
  | { readonly type: "message"; readonly message: AgentMessage }
  | { readonly type: "context_window"; readonly handoff: string };

/** An invalid caller-supplied branch name; the diagnostic does not echo input. */
export class InvalidBranchName extends Error {
  /** Stable admission error tag. */
  readonly _tag = "InvalidBranchName" as const;

  /** Construct a safe branch-name diagnostic. */
  constructor() {
    super("Invalid branch name: use a nonempty name without NUL characters");
  }
}

/** The requested branch anchor does not exist in this session. */
export class UnknownSessionEntry extends Error {
  /** Stable admission error tag. */
  readonly _tag = "UnknownSessionEntry" as const;

  /** Retain the missing entry identity for programmatic callers. */
  constructor(readonly entryId: SessionEntryId) {
    super("Unknown session entry: cannot anchor a branch outside this session");
  }
}

/** A data-only path; the harness keeps its mutable instance private once a lane owns it. */
export interface ConversationBranch {
  readonly name: BranchName;
  getTipId(): SessionEntryId | null;
  getEntries(): readonly ConversationEntry[];
  getContext(): readonly AgentMessage[];
  appendMessage(message: AgentMessage): SessionEntryId;
  startContextWindow(handoff: string): SessionEntryId;
}

/** Session-owned append-only history, with synchronous atomic mutations and no I/O. */
export class ConversationSession {
  readonly #entries = new Map<SessionEntryId, ConversationEntry>();
  readonly #branches = new Map<BranchName, ConversationBranch>();
  #sequence = 0;

  /** Construction creates no implicit main branch and acquires no external resources. */
  constructor(private readonly entryIds: SessionEntryIds) {}

  /** Get or create a branch atomically; existing branches ignore the proposed anchor. */
  acquireBranch(
    name: BranchName,
    createAt: SessionEntryId | null,
  ): OperationResult<ConversationBranch, UnknownSessionEntry> {
    const existing = this.#branches.get(name);
    if (existing) return { ok: true, value: existing };
    if (createAt !== null && !this.#entries.has(createAt)) {
      return { ok: false, error: new UnknownSessionEntry(createAt) };
    }

    let tipId = createAt;
    const append = (content: ConversationContent): SessionEntryId => {
      const id = sessionEntryIdSchema.parse(this.entryIds.next());
      if (this.#entries.has(id)) throw new Error("Session entry ID collision: generator reused an identity");
      const entry = structuredClone({ ...content, id, parentId: tipId, seq: this.#sequence + 1 });
      // No yield between insertion, sequence publication, and tip advancement.
      this.#entries.set(id, entry);
      this.#sequence = entry.seq;
      tipId = id;
      return id;
    };
    const branch: ConversationBranch = {
      name,
      getTipId: () => tipId,
      getEntries: () => this.readPath(tipId),
      getContext: () => this.readContext(tipId),
      appendMessage: (message) => append({ type: "message", message }),
      startContextWindow: (handoff) => append({ type: "context_window", handoff }),
    };
    this.#branches.set(name, branch);
    return { ok: true, value: branch };
  }

  private readPath(tipId: SessionEntryId | null): ConversationEntry[] {
    const entries: ConversationEntry[] = [];
    let current = tipId;
    while (current !== null) {
      const entry = this.requireEntry(current);
      entries.push(structuredClone(entry));
      current = entry.parentId;
    }
    return entries.reverse();
  }

  private readContext(tipId: SessionEntryId | null): AgentMessage[] {
    const messages: AgentMessage[] = [];
    let current = tipId;
    while (current !== null) {
      const entry = this.requireEntry(current);
      if (entry.type === "context_window") {
        if (entry.handoff) {
          messages.push({
            role: "user",
            content: `Context handoff (caller-supplied; verify live state before acting):\n${entry.handoff}`,
          });
        }
        break;
      }
      messages.push(structuredClone(entry.message));
      current = entry.parentId;
    }
    return messages.reverse();
  }

  private requireEntry(id: SessionEntryId): ConversationEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("Conversation history corrupted: missing parent entry");
    return entry;
  }
}
