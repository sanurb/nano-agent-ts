import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentToolCall } from "../agent/agent-message.ts";
import { maxToolArgumentBytes, failedToolResult, ToolExecutionError, type AgentToolExecutor, type ToolExecutionMode, type ToolExecutionResult, type ToolExecutionContext } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { canonicalizeToolPath } from "./canonical-tool-path.ts";
import { pathArgumentSchema } from "./tool-output.ts";

const fileTools = new Set(["Read", "Edit", "Write"]);
const searchTools = new Set(["Glob", "Grep"]);
const requestObjectSchema = z.looseObject({});

/** Explicit workspace grants are independent of the model's advertised tool list. */
export interface WorkspaceGrants {
  readonly write: boolean;
  readonly shell: boolean;
}

/** Enforce path admission before dispatch; host checks are defense in depth, not an OS sandbox. */
export class WorkspaceToolExecutor implements AgentToolExecutor {
  private constructor(private readonly root: string, private readonly executor: AgentToolExecutor, private readonly grants: WorkspaceGrants) {}

  /** Canonicalize an existing workspace once; never allow the filesystem root as a workspace grant. */
  static async create(root: string, executor: AgentToolExecutor, grants: WorkspaceGrants): Promise<OperationResult<WorkspaceToolExecutor, ToolExecutionError<"policy_denied">>> {
    const canonical = await realpath(root).then((value) => value, () => null);
    if (!canonical || resolve(canonical, "..") === canonical) return { ok: false, error: ToolExecutionError.policyDenied() };
    const info = await stat(canonical).then((value) => value, () => null);
    if (!info?.isDirectory()) return { ok: false, error: ToolExecutionError.policyDenied() };
    const home = await realpath(homedir()).then((value) => value, () => null);
    if (home === null) return { ok: false, error: ToolExecutionError.policyDenied() };
    const homeWithinRoot = relative(canonical, home);
    if (!isAbsolute(homeWithinRoot) && homeWithinRoot !== ".." && !homeWithinRoot.startsWith(`..${sep}`)) return { ok: false, error: ToolExecutionError.policyDenied() };
    return { ok: true, value: new WorkspaceToolExecutor(canonical, executor, { ...grants }) };
  }

  /** Scheduling remains owned by the registered implementation. */
  executionModeFor(toolName: string): ToolExecutionMode { return this.executor.executionModeFor(toolName); }

  /** Deny authority escalation before effects; normalize authorized paths without changing other arguments. */
  async executeTool(call: AgentToolCall, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (call.name === "Bash") return this.grants.shell ? this.executor.executeTool(call, signal, context) : { ok: false, error: ToolExecutionError.policyDenied() };
    if ((!fileTools.has(call.name) && !searchTools.has(call.name))
      || (!this.grants.write && (call.name === "Edit" || call.name === "Write"))) return { ok: false, error: ToolExecutionError.policyDenied() };
    if (Buffer.byteLength(call.arguments, "utf8") > maxToolArgumentBytes) return failedToolResult(ToolExecutionError.invalidArguments(call.name, "argument JSON within the 1MB input budget"));
    let input: z.input<typeof requestObjectSchema>;
    try { input = JSON.parse(call.arguments); }
    catch { return this.executor.executeTool(call, signal, context); } // The registered parser reports malformed JSON without effects.
    const parsed = requestObjectSchema.safeParse(input);
    if (!parsed.success) return this.executor.executeTool(call, signal, context);
    const field = fileTools.has(call.name) ? "file_path" : "path";
    const supplied = pathArgumentSchema.safeParse(parsed.data[field] ?? (field === "path" ? "." : undefined));
    if (!supplied.success) return this.executor.executeTool(call, signal, context);
    const canonical = await canonicalizeToolPath(resolve(this.root, supplied.data));
    if (!canonical.ok) return failedToolResult(canonical.error);
    const local = relative(this.root, canonical.value);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return { ok: false, error: ToolExecutionError.policyDenied() };
    return this.executor.executeTool({ ...call, arguments: JSON.stringify({ ...parsed.data, [field]: canonical.value }) }, signal, context);
  }
}
