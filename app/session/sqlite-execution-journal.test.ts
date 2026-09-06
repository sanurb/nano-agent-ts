import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JournaledToolExecutor } from "../agent/journaled-tool-executor.ts";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { successfulToolResult } from "../agent/tool-executor.ts";
import { defineTool } from "../tools/agent-tool.ts";
import { LocalToolExecutor } from "../tools/local-tool-executor.ts";
import { writeTool } from "../tools/write-tool.ts";
import { SqliteExecutionJournal } from "./sqlite-execution-journal.ts";

async function withJournal(run: (path: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-journal-"));
  try { await run(join(root, "journal.sqlite"), root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function openJournal(path: string): Promise<SqliteExecutionJournal> {
  const opened = await SqliteExecutionJournal.open(path);
  if (!opened.ok) throw opened.error;
  return opened.value;
}

const providerId = toolCallIdSchema.parse("provider-may-reuse-this-id");

test("intent precedes the effect and complete outcome metadata survives reopen with distinct invocation identities", async () => {
  await withJournal(async (path) => {
    const journal = await openJournal(path);
    const tool = defineTool({ definition: { name: "InspectIntent", description: "observe the committed journal", parameters: {} }, argumentsSchema: z.object({}), argumentsExpectation: "an object", run: async () => {
      const observed = journal.inspect();
      if (!observed.ok) throw observed.error;
      expect(observed.value.at(-1)?.state).toBe("started");
      return { ok: true, value: { status: "success", content: "durable outcome", terminate: true } };
    } });
    try {
      const executor = new JournaledToolExecutor(new LocalToolExecutor([tool]), journal);
      for (let index = 0; index < 2; index++) expect(await executor.executeTool({ id: providerId, name: "InspectIntent", arguments: "{}" }))
        .toMatchObject({ ok: true, value: { status: "success", terminate: true } });
    } finally { journal.close(); }
    const reopened = await openJournal(path);
    try {
      const entries = reopened.inspect();
      if (!entries.ok) throw entries.error;
      expect(entries.value).toHaveLength(2);
      expect(new Set(entries.value.map((entry) => entry.id)).size).toBe(2);
      expect(entries.value.every((entry) => entry.call.id === providerId && entry.outcome?.terminate === true && entry.state === "settled")).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { reopened.close(); }
  });
});

test("live leases cannot be stolen and an unavailable journal denies tools before effects", async () => {
  await withJournal(async (path, root) => {
    const journal = await openJournal(path);
    expect(await SqliteExecutionJournal.open(path)).toMatchObject({ ok: false, error: { reason: "busy" } });
    expect(SqliteExecutionJournal.releaseAbandonedLease(path)).toMatchObject({ ok: false, error: { reason: "busy" } });
    journal.close();
    const executor = new JournaledToolExecutor(new LocalToolExecutor([writeTool]), journal);
    expect(await executor.executeTool({ id: providerId, name: "Write", arguments: JSON.stringify({ file_path: join(root, "forbidden"), content: "must not execute" }) }))
      .toMatchObject({ ok: false, error: { reason: "recovery_required" } });
    expect(await Bun.file(join(root, "forbidden")).exists()).toBe(false);
  });
});

test("outcome-commit failure remains uncertain and reconciliation never overwrites original evidence", async () => {
  await withJournal(async (path, root) => {
    const journal = await openJournal(path);
    const tool = defineTool({ definition: { name: "CloseStorage", description: "real storage closure fault", parameters: {} }, argumentsSchema: z.object({}), argumentsExpectation: "an object", run: async () => {
      await writeFile(join(root, "effect"), "occurred");
      journal.close();
      return successfulToolResult("effect happened but result cannot be saved");
    } });
    const executor = new JournaledToolExecutor(new LocalToolExecutor([tool]), journal);
    expect(await executor.executeTool({ id: providerId, name: "CloseStorage", arguments: "{}" }))
      .toMatchObject({ ok: true, value: { status: "uncertain" } });
    const reopened = await openJournal(path);
    try {
      const entries = reopened.inspect();
      if (!entries.ok) throw entries.error;
      const entry = entries.value[0];
      if (!entry) throw new Error("Missing uncertain journal entry");
      expect(entry).toMatchObject({ state: "started", outcome: null, reconciliation: null });
      expect(await readFile(join(root, "effect"), "utf8")).toBe("occurred");
      expect(reopened.reconcile(entry.id, "Inspected effect file: contains occurred")).toEqual({ ok: true, value: undefined });
      const after = reopened.inspect();
      if (!after.ok) throw after.error;
      expect(after.value[0]).toMatchObject({ state: "started", outcome: null, reconciliation: "Inspected effect file: contains occurred" });
      expect(reopened.unresolved()).toEqual({ ok: true, value: [] });
    } finally { reopened.close(); }
  });
});

test("a real process crash preserves the pre-effect intent and blocks replay after explicit lease recovery", async () => {
  await withJournal(async (path, root) => {
    const module = fileURLToPath(new URL("./sqlite-execution-journal.ts", import.meta.url));
    const call = { id: providerId, name: "Write", arguments: JSON.stringify({ file_path: join(root, "effect"), content: "once" }) };
    const child = Bun.spawn([process.execPath, "-e", `
      import { SqliteExecutionJournal } from ${JSON.stringify(module)};
      import { writeFile } from "node:fs/promises";
      const opened = await SqliteExecutionJournal.open(${JSON.stringify(path)});
      if (!opened.ok) throw opened.error;
      const started = opened.value.start(${JSON.stringify(call)});
      if (!started.ok) throw started.error;
      await writeFile(${JSON.stringify(join(root, "effect"))}, "once");
      console.log("EFFECT_COMMITTED");
      setInterval(() => {}, 1000);
    `], { stdout: "pipe", stderr: "pipe", env: {} });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("EFFECT_COMMITTED");
      child.kill("SIGKILL"); await child.exited;
      expect(await SqliteExecutionJournal.open(path)).toMatchObject({ ok: false, error: { reason: "busy" } });
      expect(SqliteExecutionJournal.releaseAbandonedLease(path)).toEqual({ ok: true, value: undefined });
      const journal = await openJournal(path);
      try {
        const executor = new JournaledToolExecutor(new LocalToolExecutor([writeTool]), journal);
        expect(await executor.executeTool({ ...call, arguments: JSON.stringify({ file_path: join(root, "effect"), content: "replayed" }) }))
          .toMatchObject({ ok: false, error: { reason: "recovery_required" } });
        expect(await readFile(join(root, "effect"), "utf8")).toBe("once");
        const unresolved = journal.unresolved();
        expect(unresolved.ok && unresolved.value.length).toBe(1);
      } finally { journal.close(); }
    } finally { clearTimeout(timeout); child.kill("SIGKILL"); await child.exited; }
  });
}, 10_000);
