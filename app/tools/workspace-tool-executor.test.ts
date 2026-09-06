import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { createExecutionConfiguration } from "../cli/execution-configuration.ts";
import { LocalToolExecutor } from "./local-tool-executor.ts";
import { localTools } from "./local-tools.ts";
import { WorkspaceToolExecutor } from "./workspace-tool-executor.ts";

async function workspaceFixture(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-workspace-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "must remain private");
    await run(workspace, outside);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const callId = toolCallIdSchema.parse("workspace-test");

test.each(["../outside/secret.txt", "existing-link", "linked-parent/new.txt", "dangling-link"])("workspace rejects escaped mutation %s before touching the target", async (path) => {
  await workspaceFixture(async (workspace, outside) => {
    await symlink(join(outside, "secret.txt"), join(workspace, "existing-link"));
    await symlink(outside, join(workspace, "linked-parent"));
    await symlink(join(outside, "new.txt"), join(workspace, "dangling-link"));
    const scope = await WorkspaceToolExecutor.create(workspace, new LocalToolExecutor(localTools), { write: true, shell: false });
    if (!scope.ok) throw scope.error;
    const result = await scope.value.executeTool({ id: callId, name: "Write", arguments: JSON.stringify({ file_path: path, content: "denied" }) });
    expect(result).toMatchObject({ ok: false, error: { reason: "policy_denied" } });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("must remain private");
    expect(await Bun.file(join(outside, "new.txt")).exists()).toBe(false);
  });
});

test("workspace read and shell grants are checked independently of tool advertisement", async () => {
  await workspaceFixture(async (workspace, outside) => {
    await writeFile(join(workspace, "visible.txt"), "visible");
    const scope = await WorkspaceToolExecutor.create(workspace, new LocalToolExecutor(localTools), { write: false, shell: false });
    if (!scope.ok) throw scope.error;
    expect(await scope.value.executeTool({ id: callId, name: "Read", arguments: '{"file_path":"visible.txt"}' }))
      .toMatchObject({ ok: true, value: { status: "success", content: "visible" } });
    for (const call of [
      { name: "Read", arguments: JSON.stringify({ file_path: join(outside, "secret.txt") }) },
      { name: "Write", arguments: '{"file_path":"visible.txt","content":"denied"}' },
      { name: "Bash", arguments: JSON.stringify({ command: `touch ${JSON.stringify(join(outside, "effect"))}` }) },
    ]) expect(await scope.value.executeTool({ ...call, id: callId })).toMatchObject({ ok: false, error: { reason: "policy_denied" } });
    expect(await readFile(join(workspace, "visible.txt"), "utf8")).toBe("visible");
    expect(await Bun.file(join(outside, "effect")).exists()).toBe(false);
  });
});

test("default search paths bind to the granted workspace, not the host process directory", async () => {
  await workspaceFixture(async (workspace) => {
    await writeFile(join(workspace, "visible.txt"), "visible");
    const scope = await WorkspaceToolExecutor.create(workspace, new LocalToolExecutor(localTools), { write: false, shell: false });
    if (!scope.ok) throw scope.error;
    expect(await scope.value.executeTool({ id: callId, name: "Glob", arguments: '{"pattern":"**/*.txt"}' }))
      .toMatchObject({ ok: true, value: { status: "success", content: "visible.txt" } });
  });
});

test("invalid sandbox setup never falls back to local execution and journals cannot be placed in the workspace", async () => {
  await workspaceFixture(async (workspace, outside) => {
    expect(await createExecutionConfiguration(workspace, { mode: undefined, image: undefined, journalPath: join(outside, "journal.sqlite") }))
      .toMatchObject({ ok: false, error: { _tag: "ExecutionConfigurationError" } });
    expect(await createExecutionConfiguration(workspace, { mode: "unsafe-local", image: undefined, journalPath: join(workspace, "journal.sqlite") }))
      .toMatchObject({ ok: false, error: { _tag: "ExecutionConfigurationError" } });
    expect(await WorkspaceToolExecutor.create("/", new LocalToolExecutor(localTools), { write: true, shell: true }))
      .toMatchObject({ ok: false, error: { reason: "policy_denied" } });
  });
});
