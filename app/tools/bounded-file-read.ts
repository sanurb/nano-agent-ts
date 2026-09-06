import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { OperationResult } from "../shared/operation-result.ts";

/** Maximum source-file input is 8 MiB; Read pagination does not bypass this input budget. */
export const maxToolFileBytes = 8_388_608;

// Read in 64 KiB chunks, never allocating the whole file based only on a path stat.
const fileReadChunkBytes = 65_536;

/** Safe filesystem rejection without reflecting paths or operating-system exception text. */
export class ToolFileReadError extends Error {
  /** Stable bounded file read failure tag. */
  readonly _tag = "ToolFileReadError" as const;
  /** The opened handle, not a separate path stat, establishes the file type and size. */
  constructor(readonly reason: "unreadable" | "too_large" | "cancelled") {
    super(reason === "too_large" ? "File input budget exceeded: narrow the file before reading"
      : reason === "cancelled" ? "File read cancelled" : "File read unavailable: expected an accessible regular file");
  }
}

/** Read at most maxBytes+1 from a regular file; reject growth, special files, and cancellation without leaking handles. */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<OperationResult<Buffer, ToolFileReadError>> {
  if (signal?.aborted) return { ok: false, error: new ToolFileReadError("cancelled") };
  // O_NONBLOCK prevents a FIFO/device open from trapping the run before we can inspect the handle.
  const opened = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).then(
    (value) => ({ ok: true, value }) as const,
    () => ({ ok: false, error: new ToolFileReadError("unreadable") }) as const,
  );
  if (!opened.ok) return opened;
  const file = opened.value;
  try {
    const info = await file.stat();
    if (!info.isFile()) return { ok: false, error: new ToolFileReadError("unreadable") };
    if (info.size > maxBytes) return { ok: false, error: new ToolFileReadError("too_large") };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      if (signal?.aborted) return { ok: false, error: new ToolFileReadError("cancelled") };
      const chunk = Buffer.alloc(Math.min(fileReadChunkBytes, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return { ok: true, value: Buffer.concat(chunks, total) };
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { ok: false, error: new ToolFileReadError("too_large") };
  } catch {
    return { ok: false, error: new ToolFileReadError(signal?.aborted ? "cancelled" : "unreadable") };
  } finally {
    await file.close();
  }
}
