import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { OperationResult } from "../shared/operation-result.ts";

import { maxSearchMatches } from "./search-policy.ts";

const maxGrepResponseLineCharacters = 550; // Includes the truncation notice, not just the matched text.
const grepMatchDeadlineMs = 1000;

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), matches: z.array(z.object({ line: z.number().int().positive(), text: z.string().max(maxGrepResponseLineCharacters) })).max(maxSearchMatches) }),
  z.object({ ok: z.literal(false) }),
]);

/** A regex never blocks the coordinator; syntax, worker failure, and budget exhaustion are explicit outcomes. */
export class GrepMatchError extends Error {
  /** Stable isolated match error tag. */
  readonly _tag = "GrepMatchError" as const;
  /** Do not echo the supplied expression or source text. */
  constructor(readonly reason: "invalid_pattern" | "budget" | "cancelled" | "worker_failed") {
    super("Grep matching unavailable: expression rejected, cancelled, or exceeded its execution budget");
  }
}

/** Own one isolated regex worker per search; callers must close it in finally, including successful searches. */
export class GrepMatcher {
  readonly #worker: Worker;
  #failed = false;
  #closing: Promise<void> | undefined;

  /** Pattern compilation and matching occur off the coordinator thread with no inherited environment. */
  constructor(pattern: string, ignoreCase: boolean) {
    this.#worker = new Worker(new URL("./grep-matcher-worker.ts", import.meta.url), { workerData: { pattern, ignoreCase }, env: {} });
    this.#worker.on("error", () => { this.#failed = true; });
  }

  /** Match one bounded file at a time; a one-second deadline terminates even catastrophic regex backtracking. */
  async match(content: string, limit: number, signal?: AbortSignal): Promise<OperationResult<readonly { readonly line: number; readonly text: string }[], GrepMatchError>> {
    if (this.#failed || this.#closing) return { ok: false, error: new GrepMatchError("worker_failed") };
    const result = await new Promise<OperationResult<readonly { readonly line: number; readonly text: string }[], GrepMatchError>>((resolve) => {
      const settle = (result: OperationResult<readonly { readonly line: number; readonly text: string }[], GrepMatchError>) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#worker.off("message", message);
        this.#worker.off("error", error);
        resolve(result);
      };
      const abort = () => settle({ ok: false, error: new GrepMatchError("cancelled") });
      const error = () => settle({ ok: false, error: new GrepMatchError("worker_failed") });
      const message = (input: z.input<typeof responseSchema>) => {
        const parsed = responseSchema.safeParse(input);
        settle(parsed.success && parsed.data.ok ? { ok: true, value: parsed.data.matches }
          : { ok: false, error: new GrepMatchError("invalid_pattern") });
      };
      const timer = setTimeout(() => settle({ ok: false, error: new GrepMatchError("budget") }), grepMatchDeadlineMs);
      this.#worker.once("message", message);
      this.#worker.once("error", error);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.#worker.postMessage({ content, limit });
    });
    if (!result.ok) await this.close();
    return result;
  }

  /** Await real worker termination rather than abandoning a still-running regex. */
  close(): Promise<void> {
    this.#closing ??= this.#worker.terminate().then(() => {});
    return this.#closing;
  }
}
