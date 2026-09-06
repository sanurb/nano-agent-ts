import { spawn } from "node:child_process";
import { processTerminationGraceMs } from "./process-policy.ts";

// Trusted control protocols get a 512 KiB envelope, separate from model-facing tool output.
const maxControlOutputBytes = 524_288;

/** Bounded trusted control-command result; callers interpret protocol and exit codes, never raw errors. */
export interface CommandOutcome {
  readonly status: "exited" | "cancelled" | "unavailable" | "output_limit" | "control_failed";
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Explicit control-process lifetime and environment; this is not an untrusted-code sandbox. */
export interface CommandOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maxBytes?: number;
}

/** Execute argv directly, bound retained output, and await process/pipe closure on every exit path. */
export function runBoundedCommand(argv: readonly string[], options: CommandOptions): Promise<CommandOutcome> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Bounded command requires an executable");
  if (options.signal?.aborted) return Promise.resolve({ status: "cancelled", code: null, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let status: CommandOutcome["status"] = "exited";
    let bytes = 0;
    let spawned = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), processTerminationGraceMs);
    };
    const abort = () => { status = "cancelled"; stop(); };
    const timer = setTimeout(abort, options.timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const limit = options.maxBytes ?? maxControlOutputBytes;
      const remaining = limit - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.byteLength;
      if (bytes > limit) { status = "output_limit"; stop(); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => {}); // Early process exit closes stdin; close/code determine the result.
    child.on("spawn", () => { spawned = true; });
    child.on("error", () => { status = spawned ? "control_failed" : "unavailable"; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ status, code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input ?? "");
  });
}
