import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toolCallIdSchema, type AgentToolCall } from "../agent/agent-message.ts";
import { maxToolArgumentBytes, maxToolOutcomeCharacters, cancelledToolResult, failedToolResult, ToolExecutionError, type AgentToolExecutor, type ToolExecutionMode, type ToolExecutionResult, type ToolExecutionContext } from "../agent/tool-executor.ts";
import { runBoundedCommand } from "../shared/bounded-command.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { localTools } from "./local-tools.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { WorkspaceToolExecutor } from "./workspace-tool-executor.ts";
import { validateSandboxWorkspace } from "./sandbox-workspace.ts";

import { sandboxClientDeadlineMs } from "./sandbox-runtime-policy.ts";

const dockerControlDeadlineMs = 10_000;
// Unit-bearing Docker flags are kept whole and searchable as one named resource profile.
const sandboxResourceFlags = [
  "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=64", "--ulimit", "nofile=256:256",
  "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
] as const;

const requestObjectSchema = z.looseObject({});
// SHA-256 identities use 64 hexadecimal digits; keep the recognizable wire format literal.
const imageSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const maxDockerSocketPathCharacters = 4096;
const endpointSchema = z.string().regex(/^unix:\/\/[^\r\n]+$/)
  .max("unix://".length + maxDockerSocketPathCharacters).refine((endpoint) => !endpoint.includes("\u0000"));
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.object({
    status: z.enum(["success", "error", "cancelled", "uncertain"]), content: z.string().max(maxToolOutcomeCharacters), terminate: z.boolean().optional(),
  }) }),
  z.object({ ok: z.literal(false), error: z.object({ reason: z.enum(["unsupported_tool", "inactive_tool", "policy_denied"]) }) }),
]);

/** Isolate every tool in a digest-pinned local image; never mount credentials, host sockets, or the host root. */
export class DockerToolExecutor implements AgentToolExecutor {
  private constructor(private readonly root: string, private readonly image: string, private readonly docker: string, private readonly endpoint: string) {}

  /** Verify a local Linux daemon and immutable prebuilt image before any provider or tool work. No automatic pulls. */
  static async create(workspace: string, image: string): Promise<OperationResult<AgentToolExecutor, ToolExecutionError<"sandbox_unavailable" | "policy_denied">>> {
    const docker = Bun.which("docker");
    const parsed = imageSchema.safeParse(image);
    const root = await realpath(workspace).then((value) => value, () => null);
    if (!docker || !parsed.success || !root || /[,\r\n:]/.test(root) || !process.getuid || process.getuid() === 0) {
      return { ok: false, error: ToolExecutionError.sandboxUnavailable() };
    }
    const env = { PATH: `${dirname(docker)}:/usr/bin:/bin`, HOME: homedir(), LANG: "C.UTF-8" };
    const context = await runBoundedCommand([docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { env, timeoutMs: dockerControlDeadlineMs });
    const endpoint = context.stdout.trim();
    if (context.status !== "exited" || context.code !== 0 || !endpointSchema.safeParse(endpoint).success) return { ok: false, error: ToolExecutionError.sandboxUnavailable() };
    const backend = new DockerToolExecutor(root, parsed.data, docker, endpoint);
    if (!await backend.verifyRuntimeImage()) {
      return { ok: false, error: ToolExecutionError.sandboxUnavailable() };
    }
    const scope = await WorkspaceToolExecutor.create(root, backend, { write: true, shell: true });
    if (!scope.ok) return scope;
    const probe = await backend.invoke({ id: toolCallIdSchema.parse("sandbox-readiness"), name: "Bash", arguments: '{"command":"printf sandbox-ready"}' });
    if (!probe.ok || probe.value.status !== "success" || probe.value.content !== "sandbox-ready") return { ok: false, error: ToolExecutionError.sandboxUnavailable() };
    return scope;
  }

  /** Modes come from the same built-in registrations used inside the image. */
  executionModeFor(name: string): ToolExecutionMode { return localTools.find((tool) => tool.definition.name === name)?.executionMode ?? "sequential"; }

  /** The host owns mutation coordination across containers; the worker never receives host authority. */
  async executeTool(call: AgentToolCall, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!localTools.some((tool) => tool.definition.name === call.name)) return { ok: false, error: ToolExecutionError.unsupportedTool() };
    let input: z.input<typeof requestObjectSchema>;
    try { input = JSON.parse(call.arguments); } catch { return this.invoke(call, signal, context); }
    const parsed = requestObjectSchema.safeParse(input);
    if (!parsed.success || call.name === "Bash") return this.invoke(call, signal, context);
    const field = call.name === "Glob" || call.name === "Grep" ? "path" : "file_path";
    const target = z.string().safeParse(parsed.data[field]);
    if (!target.success) return this.invoke(call, signal, context);
    const translate = (path: string): Promise<ToolExecutionResult> => {
      const local = relative(this.root, path);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return Promise.resolve({ ok: false, error: ToolExecutionError.policyDenied() });
      return this.invoke({ ...call, arguments: JSON.stringify({ ...parsed.data, [field]: `/workspace/${local.split(sep).join("/")}` }) }, signal, context);
    };
    return call.name === "Edit" || call.name === "Write" ? withFileMutationQueue(target.data, translate, signal) : translate(target.data);
  }

  private async verifyRuntimeImage(): Promise<boolean> {
    const info = await this.control(["info", "--format", "{{.OSType}}"]);
    const inspected = await this.control(["image", "inspect", "--format", "{{.Id}}", this.image]);
    return info.status === "exited" && info.code === 0 && info.stdout.trim() === "linux"
      && inspected.status === "exited" && inspected.code === 0 && inspected.stdout.trim() === this.image;
  }

  /** Verify the nonce and remove the actual container ID, never an unconfirmed name after a create failure. */
  private async removeOwnedContainer(name: string, ownerNonce: string): Promise<boolean> {
    const inspected = await this.control(["inspect", "--format", '{{.Id}} {{index .Config.Labels "nano-agent.owner_nonce"}}', name]);
    const owned = z.tuple([z.string().regex(/^[a-f0-9]{64}$/), z.literal(ownerNonce)]).safeParse(inspected.stdout.trim().split(" "));
    if (inspected.status !== "exited" || inspected.code !== 0 || !owned.success) return false;
    const removed = await this.control(["rm", "--force", owned.data[0]]);
    return removed.status === "exited" && removed.code === 0;
  }

  private control(args: readonly string[], signal?: AbortSignal, input?: string) {
    return runBoundedCommand([this.docker, "--host", this.endpoint, ...args], {
      env: { PATH: `${dirname(this.docker)}:/usr/bin:/bin`, HOME: homedir(), LANG: "C.UTF-8" },
      signal, input: input ?? "", timeoutMs: input === undefined ? dockerControlDeadlineMs : sandboxClientDeadlineMs,
    });
  }

  private async invoke(call: AgentToolCall, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (signal?.aborted) return cancelledToolResult();
    if (Buffer.byteLength(call.arguments, "utf8") > maxToolArgumentBytes) return failedToolResult(ToolExecutionError.invalidArguments(call.name, "argument JSON within the 1MB input budget"));
    const workspace = await validateSandboxWorkspace(this.root, signal);
    if (signal?.aborted) return cancelledToolResult();
    if (!workspace.ok) return workspace;
    const ownerNonce = randomUUID();
    const executionId = context?.executionId ?? randomUUID();
    const name = `nano-agent-${ownerNonce}`;
    const uncertain = (): ToolExecutionResult => ({ ok: true, value: { status: "uncertain", content: `Sandbox ownership or cleanup was not confirmed. Inspect containers labeled nano-agent.execution_id=${executionId} before continuing.` } });
    const result = await this.control([
      "run", "--name", name, "--pull=never", "--interactive", "--network=none", "--read-only", "--restart=no", "--log-driver=none",
      "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--security-opt=no-new-privileges",
      ...sandboxResourceFlags, "--workdir", "/workspace",
      "--label", "nano-agent.owner=tool-runtime", "--label", `nano-agent.execution_id=${executionId}`, "--label", `nano-agent.owner_nonce=${ownerNonce}`, "--mount", `type=bind,source=${this.root},target=/workspace${call.name === "Edit" || call.name === "Write" ? "" : ",readonly"}`,
      this.image, "bun", "/agent/app/tools/sandbox-supervisor.ts", String(process.getuid?.()), String(process.getgid?.()),
    ], signal, JSON.stringify(call));
    if (result.status === "unavailable") return { ok: false, error: ToolExecutionError.sandboxUnavailable() };
    if (!await this.removeOwnedContainer(name, ownerNonce)) return uncertain();
    if (result.status === "cancelled" || signal?.aborted) return cancelledToolResult();
    if (result.code !== 0 || result.status !== "exited") return { ok: true, value: { status: "uncertain", content: "Sandbox execution ended without a confirmed outcome. Inspect effects before retrying." } };
    return decodeSandboxOutcome(result.stdout);
  }
}

/** A missing or invalid acknowledgement cannot establish that sandbox effects did not happen. */
function decodeSandboxOutcome(output: string): ToolExecutionResult {
  let response: z.input<typeof responseSchema>;
  try { response = JSON.parse(output); }
  catch { return { ok: true, value: { status: "uncertain", content: "Sandbox returned no valid outcome. Inspect effects before retrying." } }; }
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) return { ok: true, value: { status: "uncertain", content: "Sandbox outcome validation failed. Inspect effects before retrying." } };
  if (!parsed.data.ok) return { ok: false, error: ToolExecutionError.policyDenied() };
  const { terminate, ...outcome } = parsed.data.value;
  return { ok: true, value: terminate === undefined ? outcome : { ...outcome, terminate } };
}
