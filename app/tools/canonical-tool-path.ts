import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";

// Bound both missing-parent traversal and dangling-symlink resolution.
const maxPathResolutionSteps = 256;

const missingPath = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

/** Resolve existing aliases and missing destinations through their real parents, including dangling symlinks. */
export async function canonicalizeToolPath(path: string): Promise<OperationResult<string, ToolExecutionError<"execution_failed">>> {
  let candidate = resolve(path);
  const suffix: string[] = [];
  const links = new Set<string>();
  for (let step = 0; step < maxPathResolutionSteps; step++) {
    const real = await realpath(candidate).then((value) => ({ ok: true, value }) as const,
      (error) => ({ ok: false, missing: missingPath.safeParse(error).success }) as const);
    if (real.ok) {
      const info = await lstat(real.value).then((value) => value, () => null);
      if (!info || (suffix.length > 0 && !info.isDirectory())) break;
      return { ok: true, value: resolve(real.value, ...suffix) };
    }
    if (!real.missing) break;
    const info = await lstat(candidate).then((value) => value, () => null);
    if (info?.isSymbolicLink()) {
      if (links.has(candidate)) break;
      links.add(candidate);
      const target = await readlink(candidate).then((value) => value, () => null);
      if (target === null) break;
      candidate = resolve(dirname(candidate), target);
      continue;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    suffix.unshift(basename(candidate));
    candidate = parent;
  }
  return { ok: false, error: ToolExecutionError.executionFailed("File path", "unable to resolve an accessible target") };
}
