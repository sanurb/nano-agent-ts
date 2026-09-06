import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentToolExecutor } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { DockerToolExecutor } from "../tools/docker-tool-executor.ts";
import { LocalToolExecutor } from "../tools/local-tool-executor.ts";
import { localTools } from "../tools/local-tools.ts";
import { WorkspaceToolExecutor } from "../tools/workspace-tool-executor.ts";
import { canonicalizeToolPath } from "../tools/canonical-tool-path.ts";

const modeSchema = z.enum(["sandbox", "unsafe-local"]);

/** Startup-only execution settings; model content cannot switch security modes or choose journal storage. */
export interface ExecutionEnvironment {
  readonly mode: string | undefined;
  readonly image: string | undefined;
  readonly journalPath: string | undefined;
}

/** Safe execution bootstrap rejection, including missing isolation or unsafe state placement. */
export class ExecutionConfigurationError extends Error {
  /** Stable startup security error tag. */
  readonly _tag = "ExecutionConfigurationError" as const;
  /** No raw paths, images, or environment contents are reflected in diagnostics. */
  constructor() { super("Execution unavailable: configure a digest-pinned sandbox image and Docker, or explicitly select unsafe-local for trusted development; keep the journal outside the workspace"); }
}

/** Stable per-workspace private journal location; callers provide the canonical workspace path. */
export function defaultExecutionJournalPath(workspace: string): string {
  const project = createHash("sha256").update(workspace).digest("hex");
  return join(homedir(), ".local", "state", "nano-agent", `${project}.sqlite`);
}

/** Construct fail-closed execution and private state placement before contacting any provider. */
export async function createExecutionConfiguration(workspace: string, environment: ExecutionEnvironment): Promise<OperationResult<{
  readonly executor: AgentToolExecutor;
  readonly journalPath: string;
  readonly mode: "sandbox" | "unsafe-local";
}, ExecutionConfigurationError>> {
  const mode = modeSchema.safeParse(environment.mode ?? "sandbox");
  const canonical = await canonicalizeToolPath(workspace);
  if (!mode.success || !canonical.ok) return { ok: false, error: new ExecutionConfigurationError() };
  const root = canonical.value;
  const path = await canonicalizeToolPath(resolve(environment.journalPath ?? defaultExecutionJournalPath(root)));
  if (!path.ok) return { ok: false, error: new ExecutionConfigurationError() };
  const fromWorkspace = relative(root, path.value);
  if (!isAbsolute(fromWorkspace) && fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`)) return { ok: false, error: new ExecutionConfigurationError() };
  const executor = mode.data === "sandbox"
    ? await DockerToolExecutor.create(root, environment.image ?? "")
    : await WorkspaceToolExecutor.create(root, new LocalToolExecutor(localTools), { write: true, shell: true });
  return executor.ok ? { ok: true, value: { executor: executor.value, journalPath: path.value, mode: mode.data } }
    : { ok: false, error: new ExecutionConfigurationError() };
}
