import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError, type ToolExecutionResult } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { maxToolFileBytes, readBoundedFile } from "./bounded-file-read.ts";
import { privateFileMode } from "../shared/file-permissions.ts";

const privilegedModeBits = 0o7000; // setuid, setgid, sticky: never reproduce these on a replacement.
const ownerWriteBit = 0o200;
const ordinaryPermissionBits = 0o777;

/** Original bytes and ordinary permissions observed under the file queue; null bytes mean the target did not exist. */
export interface FileMutationSnapshot {
  readonly bytes: Buffer | null;
  readonly mode: number;
}

/** Capture bounded original bytes; refuse special files, hard links, privileged modes, and ownership changes. */
export async function readFileForMutation(path: string, signal?: AbortSignal): Promise<OperationResult<FileMutationSnapshot, ToolExecutionError<"execution_failed">>> {
  const info = await lstat(path).then((value) => ({ kind: "file", value }) as const,
    (error) => ({ kind: z.object({ code: z.literal("ENOENT") }).safeParse(error).success ? "missing" : "error" }) as const);
  if (info.kind === "missing") return { ok: true, value: { bytes: null, mode: privateFileMode } };
  if (info.kind !== "file" || !info.value.isFile() || info.value.nlink > 1 || (info.value.mode & privilegedModeBits) !== 0 || (info.value.mode & ownerWriteBit) === 0
    || (process.getuid && info.value.uid !== process.getuid())) {
    return { ok: false, error: ToolExecutionError.executionFailed("File mutation", "target must be an owned writable regular file with one hard link and ordinary permissions") };
  }
  const bytes = await readBoundedFile(path, maxToolFileBytes, signal);
  return bytes.ok ? { ok: true, value: { bytes: bytes.value, mode: info.value.mode & ordinaryPermissionBits } }
    : { ok: false, error: ToolExecutionError.executionFailed("File mutation", "unable to read target within input budget") };
}

interface FilePublication { phase: "staging" | "publishing" | "published"; }

/**
 * Stage and sync a same-directory replacement, recheck stale content, then publish by rename.
 * Cooperating tools must also hold withFileMutationQueue. External compare/rename races are not an OS-level CAS.
 * A failed publication acknowledgement is uncertain, not proof the original survived. ACLs/xattrs are not preserved.
 */
export async function replaceFileAtomically(path: string, content: string, expected: FileMutationSnapshot, signal?: AbortSignal): Promise<ToolExecutionResult> {
  if (!content.isWellFormed()) return failedToolResult(ToolExecutionError.executionFailed("File mutation", "replacement must be well-formed Unicode"));
  if (Buffer.byteLength(content, "utf8") > maxToolFileBytes) return failedToolResult(ToolExecutionError.executionFailed("File mutation", "replacement exceeds the 8MB input budget"));
  const temp = join(dirname(path), `.agent-tmp-${randomUUID()}`);
  const publication: FilePublication = { phase: "staging" };
  const commit = async (): Promise<ToolExecutionResult> => {
    try {
      if (signal?.aborted) return cancelledToolResult();
      const file = await open(temp, "wx", privateFileMode);
      try {
        await file.writeFile(content, { encoding: "utf8", signal });
        await file.chmod(expected.mode);
        await file.sync();
      } finally { await file.close(); }
      if (signal?.aborted) return cancelledToolResult();
      const current = await readFileForMutation(path, signal);
      if (!current.ok) return failedToolResult(current.error);
      const unchanged = expected.bytes === null ? current.value.bytes === null
        : current.value.bytes !== null && expected.bytes.equals(current.value.bytes) && expected.mode === current.value.mode;
      if (!unchanged) return failedToolResult(ToolExecutionError.executionFailed("File mutation", "target changed since it was read; read the current file before retrying"));
      if (signal?.aborted) return cancelledToolResult();
      publication.phase = "publishing";
      await rename(temp, path);
      publication.phase = "published";
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return successfulToolResult("File replacement committed.");
    } catch {
      if (publication.phase !== "staging") return { ok: true, value: { status: "uncertain", content: "File replacement publication or durability was not confirmed. Inspect the file before any retry." } };
      return signal?.aborted ? cancelledToolResult() : failedToolResult(ToolExecutionError.executionFailed("File mutation", "unable to commit replacement; original file was not replaced"));
    }
  };
  const result = await commit();
  // Never delete a path after ownership transferred by rename; uncertain publication retains evidence for inspection.
  if (publication.phase !== "staging") return result;
  const removed = await rm(temp, { force: true }).then(() => true, () => false);
  return removed ? result : { ok: true, value: { status: "uncertain", content: "Staged-file cleanup failed. Inspect the target and .agent-tmp-* files before retrying." } };
}
