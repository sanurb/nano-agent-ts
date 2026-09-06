import { resolve } from "node:path";
import { cancelledToolResult, failedToolResult, type ToolExecutionResult } from "../agent/tool-executor.ts";
import { canonicalizeToolPath } from "./canonical-tool-path.ts";

// This filesystem boundary owns the process-wide lock domain, shared by every lane and custom tool.
const mutationTails = new Map<string, Promise<void>>();
let registrationTail = Promise.resolve();

/**
 * Serialize a file mutation's full read–modify–write window, not just its final write.
 * Existing aliases and missing targets through symlinked parents share a canonical key. Different files overlap.
 * The callback receives the actual queue target and must await all its I/O, even after cancellation.
 * This process-local queue is not a sandbox, an external-process lock, or a multi-file transaction.
 */
export async function withFileMutationQueue(
  filePath: string,
  mutation: (targetPath: string) => Promise<ToolExecutionResult>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  // Capture cwd-relative intent before yielding; later working-directory changes cannot retarget the call.
  const absolutePath = resolve(filePath);
  // Canonicalization is asynchronous: reserve in invocation order so a fast lookup cannot overtake another.
  const registered = registrationTail.then(async () => {
    const target = await canonicalizeToolPath(absolutePath);
    if (!target.ok) return target;
    const previous = mutationTails.get(target.value) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.then(() => release.promise);
    mutationTails.set(target.value, tail);
    void tail.then(() => { if (mutationTails.get(target.value) === tail) mutationTails.delete(target.value); });
    return { ok: true, value: { target: target.value, previous, release } } as const;
  });
  // Even a registration defect must not poison unrelated future callers.
  registrationTail = registered.then(() => {}, () => {});
  const registration = await registered;
  if (!registration.ok) return failedToolResult(registration.error);
  const { target, previous, release } = registration.value;
  const aborted = Promise.withResolvers<void>();
  const interrupt = () => aborted.resolve();
  signal?.addEventListener("abort", interrupt, { once: true });
  try {
    if (!signal?.aborted) await Promise.race([previous, aborted.promise]);
    if (signal?.aborted) return cancelledToolResult();
    return await mutation(target);
  } finally {
    signal?.removeEventListener("abort", interrupt);
    // Releasing a cancelled waiter cannot bypass its predecessor: the published tail includes previous.
    release.resolve();
  }
}
