import { realpath } from "node:fs/promises";
import { z } from "zod";
import { maxReconciliationCharacters, toolExecutionIdSchema } from "../agent/tool-execution-journal.ts";
import { SqliteExecutionJournal } from "../session/sqlite-execution-journal.ts";
import { renderTerminalText } from "./terminal-text.ts";
import { defaultExecutionJournalPath } from "./execution-configuration.ts";

import { processArgumentOffset } from "../shared/process-policy.ts";

const jsonIndentSpaces = 2;
const commandSchema = z.union([
  z.tuple([z.literal("inspect")]), z.tuple([z.literal("release-abandoned")]),
  z.tuple([z.literal("show"), toolExecutionIdSchema]),
  z.tuple([z.literal("reconcile"), toolExecutionIdSchema, z.string().trim().min(1).max(maxReconciliationCharacters)]),
]);

async function runJournalCli(): Promise<void> {
  const command = commandSchema.safeParse(process.argv.slice(processArgumentOffset));
  if (!command.success) { console.error("Usage: journal-main.ts inspect | show <execution-id> | release-abandoned | reconcile <execution-id> <inspection-evidence>"); process.exitCode = 1; return; }
  const path = process.env.NANO_AGENT_JOURNAL_PATH ?? defaultExecutionJournalPath(await realpath(process.cwd()));
  if (command.data[0] === "release-abandoned") {
    const released = SqliteExecutionJournal.releaseAbandonedLease(path);
    if (!released.ok) { console.error(released.error.message); process.exitCode = 1; }
    return;
  }
  const opened = await SqliteExecutionJournal.open(path);
  if (!opened.ok) { console.error(opened.error.message); process.exitCode = 1; return; }
  try {
    if (command.data[0] === "reconcile") {
      const reconciled = opened.value.reconcile(command.data[1], command.data[2]);
      if (!reconciled.ok) { console.error(reconciled.error.message); process.exitCode = 1; }
      return;
    }
    const entries = opened.value.inspect();
    if (!entries.ok) { console.error(entries.error.message); process.exitCode = 1; return; }
    if (command.data[0] === "show") {
      const id = command.data[1];
      const entry = entries.value.find((value) => value.id === id);
      if (!entry) { console.error("Execution journal entry not found"); process.exitCode = 1; return; }
      console.log(renderTerminalText(JSON.stringify(entry, null, jsonIndentSpaces))); // Explicit private-payload inspection, not telemetry.
    } else console.log(JSON.stringify(entries.value.map((entry) => ({ id: entry.id, tool: entry.call.name, state: entry.state, status: entry.outcome?.status, reconciled: entry.reconciliation !== null })), null, jsonIndentSpaces));
  } finally {
    const closed = opened.value.close();
    if (!closed.ok) { console.error(closed.error.message); process.exitCode = 1; }
  }
}

try { await runJournalCli(); }
catch { console.error("Execution journal unavailable; inspection did not authorize any replay"); process.exitCode = 1; }
