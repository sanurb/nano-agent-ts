import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { walkWorkspaceFiles } from "./workspace-file-walk.ts";

const sandboxWorkspaceScanDeadlineMs = 10_000;
const maxSandboxWorkspaceBytes = 267_386_880; // 255 MiB, before admitting one bounded mutation.

/**
 * Reject special-file IPC endpoints and oversized trees before mounting an owned, quiescent checkout.
 * Includes ignored directories: a host socket under node_modules is still host authority.
 * This is not protection against a hostile host concurrently introducing mounts or filesystem objects.
 */
export async function validateSandboxWorkspace(root: string, signal?: AbortSignal): Promise<OperationResult<void, ToolExecutionError<"policy_denied">>> {
  let bytes = 0;
  const bounded = AbortSignal.any([AbortSignal.timeout(sandboxWorkspaceScanDeadlineMs), ...(signal ? [signal] : [])]);
  for await (const entry of walkWorkspaceFiles(root, bounded, "sandbox-admission")) {
    if (entry.kind !== "file") return { ok: false, error: ToolExecutionError.policyDenied() };
    const info = await lstat(join(root, entry.path)).then((value) => value, () => null);
    if (!info?.isFile()) return { ok: false, error: ToolExecutionError.policyDenied() };
    bytes += info.size;
    // Reserve one bounded mutation's growth; an atomic staging file can temporarily add at most 8 MiB.
    if (bytes > maxSandboxWorkspaceBytes) return { ok: false, error: ToolExecutionError.policyDenied() };
  }
  return bounded.aborted ? { ok: false, error: ToolExecutionError.policyDenied() } : { ok: true, value: undefined };
}
