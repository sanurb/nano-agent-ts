import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { toolExecutionIdSchema } from "../agent/tool-execution-journal.ts";
import { runBoundedCommand } from "../shared/bounded-command.ts";
import { gradeCodingTask } from "../evaluation/coding-grader.ts";
import { codingEvaluationTasks } from "../evaluation/coding-tasks.ts";
import { DockerToolExecutor } from "./docker-tool-executor.ts";
import { validateSandboxWorkspace } from "./sandbox-workspace.ts";

const image = process.env.NANO_AGENT_TEST_SANDBOX_IMAGE;
type SandboxTestArguments = { readonly file_path: string; readonly content?: string } | { readonly command: string };

async function withWorkspace(run: (root: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nano-sb-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try { await run(root, workspace); } finally { await rm(root, { recursive: true, force: true }); }
}

test("sandbox admission rejects host IPC endpoints even in normally ignored directories", async () => {
  await withWorkspace(async (_root, workspace) => {
    await mkdir(join(workspace, "node_modules"));
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(workspace, "node_modules", "host.sock"), resolve); });
    try { expect(await validateSandboxWorkspace(workspace)).toMatchObject({ ok: false, error: { reason: "policy_denied" } }); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

test("sandbox admission rejects sparse oversized workspaces without reading their contents", async () => {
  await withWorkspace(async (_root, workspace) => {
    const file = await open(join(workspace, "huge"), "w");
    try { await file.truncate(4 * 1024 * 1024 * 1024); } finally { await file.close(); }
    expect(await validateSandboxWorkspace(workspace)).toMatchObject({ ok: false, error: { reason: "policy_denied" } });
  });
});

test.skipIf(image === undefined)("real Docker isolates host files, credentials, workspace shell writes, and network access", async () => {
  if (!image) throw new Error("Sandbox integration image must be explicitly configured");
  await withWorkspace(async (root, workspace) => {
    await writeFile(join(root, "host-secret"), "not mounted");
    await writeFile(join(workspace, "source.txt"), "original");
    const sandbox = await DockerToolExecutor.create(workspace, image);
    if (!sandbox.ok) throw sandbox.error;
    const call = async (name: string, args: SandboxTestArguments) => sandbox.value.executeTool({ id: toolCallIdSchema.parse("sandbox-test"), name, arguments: JSON.stringify(args) });
    expect(await call("Write", { file_path: "source.txt", content: "authorized" })).toMatchObject({ ok: true, value: { status: "success" } });
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("authorized");
    expect(await call("Read", { file_path: join(root, "host-secret") })).toMatchObject({ ok: false, error: { reason: "policy_denied" } });
    const hostPath = join(root, "host-secret").replaceAll("'", "'\\''");
    expect(await call("Bash", { command: `test ! -e '${hostPath}' && echo host-not-mounted` }))
      .toMatchObject({ ok: true, value: { status: "success", content: "host-not-mounted\n" } });
    expect(await call("Bash", { command: "echo denied > source.txt" })).toMatchObject({ ok: true, value: { status: "error" } });
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("authorized");
    expect(await call("Bash", { command: "bun -e 'console.log(process.env.OPENROUTER_API_KEY === undefined ? \"unset\" : \"leaked\")'" }))
      .toMatchObject({ ok: true, value: { status: "success", content: "unset\n" } });
    expect(await call("Bash", { command: "bun -e 'try { await fetch(\"http://1.1.1.1\", {signal:AbortSignal.timeout(1000)}); console.log(\"escaped\") } catch { console.log(\"blocked\") }'" }))
      .toMatchObject({ ok: true, value: { status: "success", content: "blocked\n" } });
    expect(await call("Bash", { command: "test ! -e /agent/app/evaluation/coding-tasks.ts && test ! -e /agent/app/evaluation/coding-grader.ts && echo grader-not-mounted" }))
      .toMatchObject({ ok: true, value: { status: "success", content: "grader-not-mounted\n" } });
  });
}, 60_000);

test.skipIf(image === undefined)("Docker cancellation removes a running SIGTERM-resistant descendant, correlated by durable execution ID", async () => {
  if (!image) throw new Error("Sandbox integration image must be explicitly configured");
  await withWorkspace(async (_root, workspace) => {
    const sandbox = await DockerToolExecutor.create(workspace, image);
    if (!sandbox.ok) throw sandbox.error;
    const docker = Bun.which("docker");
    if (!docker) throw new Error("Docker integration executable missing");
    const env = { PATH: `${dirname(docker)}:/usr/bin:/bin`, HOME: homedir(), LANG: "C.UTF-8" };
    const context = await runBoundedCommand([docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { env, timeoutMs: 2000 });
    expect(context.code).toBe(0);
    const control = (args: readonly string[]) => runBoundedCommand([docker, "--host", context.stdout.trim(), ...args], { env, timeoutMs: 2000 });
    const executionId = toolExecutionIdSchema.parse(Bun.randomUUIDv7());
    const cancellation = new AbortController();
    const pending = sandbox.value.executeTool({ id: toolCallIdSchema.parse("cancel-container"), name: "Bash", arguments: JSON.stringify({ command: "bun -e 'process.on(\"SIGTERM\",()=>{}); await Bun.write(\"/tmp/cancellation-ready\",\"ready\"); setInterval(()=>{},1000)'" }) }, cancellation.signal, { executionId });
    let ready = false;
    const deadline = AbortSignal.timeout(15_000);
    try {
      while (!deadline.aborted) {
        const listed = await control(["ps", "--no-trunc", "--filter", `label=nano-agent.execution_id=${executionId}`, "--format", "{{.ID}}"]);
        const id = listed.stdout.trim();
        if (listed.code === 0 && /^[a-f0-9]{64}$/.test(id)) {
          const marker = await control(["exec", id, "test", "-f", "/tmp/cancellation-ready"]);
          if (marker.code === 0) { ready = true; break; }
        }
        await Bun.sleep(20); // Poll an external state predicate, not an assumed execution delay.
      }
      expect(ready).toBe(true);
      cancellation.abort();
      expect(await pending).toMatchObject({ ok: true, value: { status: "cancelled" } });
      const remaining = await control(["ps", "-a", "--filter", `label=nano-agent.execution_id=${executionId}`, "--format", "{{.ID}}"]);
      expect(remaining.code).toBe(0);
      expect(remaining.stdout.trim()).toBe("");
    } finally { cancellation.abort(); await pending; }
  });
}, 180_000);

test.skipIf(image === undefined)("real isolated grading rejects a broken fixture and accepts a separately authored reference solution", async () => {
  if (!image) throw new Error("Sandbox integration image must be explicitly configured");
  await withWorkspace(async (_root, workspace) => {
    const task = codingEvaluationTasks(42).find((entry) => entry.id === "median-feature");
    if (!task) throw new Error("Missing median control fixture");
    for (const file of task.files) await writeFile(join(workspace, file.path), file.content);
    const sandbox = await DockerToolExecutor.create(workspace, image);
    if (!sandbox.ok) throw sandbox.error;
    expect(await gradeCodingTask(sandbox.value, task)).toMatchObject({ verified: false, available: true });
    await writeFile(join(workspace, "stats.js"), "export default xs => { const ordered=xs.toSorted((a,b)=>a-b); const n=ordered.length; return n===0 ? null : n%2 ? ordered[(n-1)/2] : (ordered[n/2-1]+ordered[n/2])/2; };\n");
    expect(await gradeCodingTask(sandbox.value, task)).toMatchObject({ verified: true, available: true });
  });
}, 60_000);
