import { Database } from "bun:sqlite";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toolCallIdSchema, type AgentToolCall } from "../agent/agent-message.ts";
import { maxReconciliationCharacters, ExecutionJournalError, toolExecutionIdSchema, type JournalInvocation, type ToolExecutionId, type ToolExecutionJournal } from "../agent/tool-execution-journal.ts";
import { maxToolArgumentCharacters, maxToolOutcomeCharacters, type ToolOutcome } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

import { privateDirectoryMode, privateFileMode } from "../shared/file-permissions.ts";

const journalApplicationId = 0x4e414754; // ASCII NAGT distinguishes this journal from arbitrary SQLite databases.
const journalSchemaVersion = 1;
const sqliteFileHeader = "SQLite format 3\u0000";
const maxSqlitePageBytes = 65_536;
const maxJournalBytes = 67_108_864; // 64 MiB hard page ceiling.
const journalAdmissionCeilingBytes = 62_914_560; // 60 MiB leaves room for outcomes/reconciliation.
const maxJournalInvocations = 10_000;
const invocationStorageExpansionFactor = 2; // Account conservatively for page/index overhead.
const pendingOutcomeReserveBytes = 524_288; // 512 KiB per active or newly admitted invocation.
const journalBusyTimeoutMs = 1000;
const rowSchema = z.object({ id: toolExecutionIdSchema, call_json: z.string(), state: z.enum(["started", "settled", "not_executed"]), outcome_json: z.string().nullable(), reconciliation: z.string().nullable() });
const callSchema = z.object({ id: toolCallIdSchema, name: z.string().min(1), arguments: z.string().max(maxToolArgumentCharacters) });
const outcomeSchema = z.object({ status: z.enum(["success", "error", "cancelled", "uncertain"]), content: z.string().max(maxToolOutcomeCharacters), terminate: z.boolean().optional() });

/** Private local effect journal with synchronous FULL commits and an exclusive process lease. Not a conversation store. */
export class SqliteExecutionJournal implements ToolExecutionJournal {
  #closure: OperationResult<void, ExecutionJournalError> | null = null;
  private constructor(private readonly database: Database, private readonly owner: string) {}

  /** Acquire one writer; an abandoned lease remains blocked until explicit operator reconciliation. */
  static async open(path: string): Promise<OperationResult<SqliteExecutionJournal, ExecutionJournalError>> {
    let database: Database | undefined;
    try {
      await mkdir(dirname(path), { recursive: true, mode: privateDirectoryMode });
      const file = await open(path, "a+", privateFileMode);
      let populated = false;
      try {
        populated = (await file.stat()).size > 0;
        if (populated) {
          const header = Buffer.alloc(sqliteFileHeader.length);
          await file.read(header, 0, header.length, 0);
          if (header.toString() !== sqliteFileHeader) return { ok: false, error: new ExecutionJournalError("corrupt") };
        }
      } finally { await file.close(); }
      database = new Database(path, { create: true, strict: true });
      const identity = z.object({ application_id: z.number().int() }).parse(database.query("PRAGMA application_id").get());
      const version = z.object({ user_version: z.number().int() }).parse(database.query("PRAGMA user_version").get());
      if ((populated && identity.application_id !== journalApplicationId) || ![0, journalSchemaVersion].includes(version.user_version)) {
        database.close(); return { ok: false, error: new ExecutionJournalError("corrupt") };
      }
      await chmod(path, privateFileMode);
      const pageSize = z.object({ page_size: z.number().int().positive().max(maxSqlitePageBytes) }).parse(database.query("PRAGMA page_size").get());
      database.exec(`PRAGMA max_page_count=${Math.floor(maxJournalBytes / pageSize.page_size)};
        PRAGMA application_id=${journalApplicationId}; PRAGMA user_version=${journalSchemaVersion};
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${journalBusyTimeoutMs};
        CREATE TABLE IF NOT EXISTS journal_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tool_invocations (id TEXT PRIMARY KEY, call_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('started','settled','not_executed')), outcome_json TEXT);
        CREATE TABLE IF NOT EXISTS tool_reconciliations (execution_id TEXT PRIMARY KEY, evidence TEXT NOT NULL);`);
      const owner = randomUUID();
      const acquired = database.query("INSERT OR IGNORE INTO journal_lease VALUES (1, ?, ?)").run(owner, process.pid);
      if (acquired.changes !== 1) { database.close(); return { ok: false, error: new ExecutionJournalError("busy") }; }
      return { ok: true, value: new SqliteExecutionJournal(database, owner) };
    } catch {
      database?.close();
      return { ok: false, error: new ExecutionJournalError("unavailable") };
    }
  }

  /** Persist a fresh execution ID before any external effect; cap retained records rather than silently deleting history. */
  start(call: AgentToolCall): OperationResult<ToolExecutionId, ExecutionJournalError> {
    try {
      const serialized = JSON.stringify(callSchema.parse(call));
      const count = z.object({ count: z.number(), active: z.number() }).parse(this.database.query("SELECT count(*) AS count, coalesce(sum(state='started'),0) AS active FROM tool_invocations").get());
      const pages = z.object({ page_count: z.number() }).parse(this.database.query("PRAGMA page_count").get());
      const size = z.object({ page_size: z.number() }).parse(this.database.query("PRAGMA page_size").get());
      const allocatedBytes = pages.page_count * size.page_size;
      const invocationBytes = Buffer.byteLength(serialized) * invocationStorageExpansionFactor;
      const reservedOutcomeBytes = (count.active + 1) * pendingOutcomeReserveBytes;
      const projectedBytes = allocatedBytes + invocationBytes + reservedOutcomeBytes;
      if (count.count >= maxJournalInvocations || projectedBytes > journalAdmissionCeilingBytes) {
        return { ok: false, error: new ExecutionJournalError("unavailable") };
      }
      const id = toolExecutionIdSchema.parse(randomUUID());
      this.database.query("INSERT INTO tool_invocations VALUES (?, ?, 'started', NULL)").run(id, serialized);
      return { ok: true, value: id };
    } catch { return { ok: false, error: new ExecutionJournalError("unavailable") }; }
  }

  /** Commit the complete outcome before the scheduler publishes its ordered conversation message; null means admission denied. */
  finish(id: ToolExecutionId, outcome: ToolOutcome | null): OperationResult<void, ExecutionJournalError> {
    try {
      const result = this.database.query("UPDATE tool_invocations SET state=?, outcome_json=? WHERE id=? AND state='started'")
        .run(outcome === null ? "not_executed" : "settled", outcome === null ? null : JSON.stringify(outcomeSchema.parse(outcome)), id);
      if (result.changes !== 1) return { ok: false, error: new ExecutionJournalError("corrupt") };
      return { ok: true, value: undefined };
    } catch { return { ok: false, error: new ExecutionJournalError("unavailable") }; }
  }

  /** Read private recovery evidence through schemas; callers must not forward this raw data to telemetry. */
  inspect(): OperationResult<readonly JournalInvocation[], ExecutionJournalError> {
    try {
      const entries: JournalInvocation[] = [];
      for (const input of this.database.query("SELECT i.*, r.evidence AS reconciliation FROM tool_invocations i LEFT JOIN tool_reconciliations r ON r.execution_id=i.id ORDER BY i.rowid").all()) {
        const row = rowSchema.parse(input);
        const call = callSchema.parse(JSON.parse(row.call_json));
        const parsed = row.outcome_json === null ? null : outcomeSchema.parse(JSON.parse(row.outcome_json));
        let outcome: ToolOutcome | null = null;
        if (parsed !== null) {
          const { terminate, ...value } = parsed;
          outcome = terminate === undefined ? value : { ...value, terminate };
        }
        if ((row.state === "settled") !== (outcome !== null)) return { ok: false, error: new ExecutionJournalError("corrupt") };
        entries.push({ id: row.id, call, state: row.state, outcome, reconciliation: row.reconciliation });
      }
      return { ok: true, value: entries };
    } catch { return { ok: false, error: new ExecutionJournalError("corrupt") }; }
  }

  /** Query only unresolved identities on the dispatch path; full private payloads are loaded only on explicit inspection. */
  unresolved(): OperationResult<readonly ToolExecutionId[], ExecutionJournalError> {
    try {
      const rows = this.database.query(`SELECT i.id FROM tool_invocations i
        LEFT JOIN tool_reconciliations r ON r.execution_id=i.id WHERE r.execution_id IS NULL
        AND (i.state='started' OR (i.state='settled' AND coalesce(json_extract(i.outcome_json, '$.status'),'invalid') NOT IN ('success','error')))`)
        .all();
      return { ok: true, value: z.array(z.object({ id: toolExecutionIdSchema })).parse(rows).map((row) => row.id) };
    } catch { return { ok: false, error: new ExecutionJournalError("corrupt") }; }
  }

  /** Append operator reconciliation after inspection; never overwrite original evidence or replay an effect. */
  reconcile(id: ToolExecutionId, evidence: string): OperationResult<void, ExecutionJournalError> {
    if (!evidence.trim() || evidence.length > maxReconciliationCharacters) return { ok: false, error: new ExecutionJournalError("unresolved") };
    try {
      const pending = this.unresolved();
      if (!pending.ok || !pending.value.includes(id)) return { ok: false, error: new ExecutionJournalError("unresolved") };
      const updated = this.database.query("INSERT INTO tool_reconciliations VALUES (?, ?)").run(id, evidence);
      return updated.changes === 1 ? { ok: true, value: undefined } : { ok: false, error: new ExecutionJournalError("corrupt") };
    } catch { return { ok: false, error: new ExecutionJournalError("unavailable") }; }
  }

  /** Release only this process's lease; unresolved invocations remain unresolved on the next open. */
  close(): OperationResult<void, ExecutionJournalError> {
    if (this.#closure !== null) return this.#closure;
    let failure: ExecutionJournalError | null = null;
    try {
      this.database.query("DELETE FROM journal_lease WHERE owner=?").run(this.owner);
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch { failure = new ExecutionJournalError("unavailable"); }
    try { this.database.close(); } catch { failure = new ExecutionJournalError("unavailable"); }
    this.#closure = failure === null ? { ok: true, value: undefined } : { ok: false, error: failure };
    return this.#closure;
  }

  /** Operator-only crash recovery: refuse a live owner and release an abandoned lease without replaying any effect. */
  static releaseAbandonedLease(path: string): OperationResult<void, ExecutionJournalError> {
    let database: Database | undefined;
    try {
      database = new Database(path, { readonly: false, strict: true });
      const input = database.query("SELECT pid, owner FROM journal_lease WHERE singleton=1").get();
      if (!input) return { ok: true, value: undefined };
      const { pid, owner } = z.object({ pid: z.number().int().positive(), owner: z.string() }).parse(input);
      try { process.kill(pid, 0); return { ok: false, error: new ExecutionJournalError("busy") }; }
      catch (error) { if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return { ok: false, error: new ExecutionJournalError("busy") }; }
      database.query("DELETE FROM journal_lease WHERE singleton=1 AND pid=? AND owner=?").run(pid, owner);
      return { ok: true, value: undefined };
    } catch { return { ok: false, error: new ExecutionJournalError("unavailable") }; }
    finally { database?.close(); }
  }
}
