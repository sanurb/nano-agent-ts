import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { cancelledToolResult, failedToolResult, ToolExecutionError, type ToolExecutionResult } from "../agent/tool-executor.ts";
import { defineTool } from "./agent-tool.ts";
import { defaultOutputLimits, formatSize, truncateHead } from "./tool-output.ts";

import { processTerminationGraceMs } from "../shared/process-policy.ts";

const maxShellCommandCharacters = 65_536;
const shellCommandDeadlineMs = 60_000;
const lineFeedByte = 0x0a;
const maxUtf8SequenceBytes = 4;

const bashToolArgumentsSchema = z.object({
  command: z.string().min(1).max(maxShellCommandCharacters).refine((command) => command.isWellFormed() && !command.includes("\u0000")),
});

/** Advertise Bash with a single required shell command string. */
export const bashToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command and return its combined stdout and stderr. Output is capped at "
    + `${defaultOutputLimits.maxLines} lines or ${formatSize(defaultOutputLimits.maxBytes)}; narrow the command or `
    + "pipe through head when you expect more. Commands have a 60-second deadline. In sandbox mode the workspace is read-only: use Edit/Write for source changes and /tmp for build artifacts.",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "The command to execute" },
    },
  },
} satisfies AgentToolDefinition;

/** Run one command through `/bin/sh` in the process working directory and return its combined output. */
export const bashTool = defineTool({
  definition: bashToolDefinition,
  executionMode: "sequential",
  argumentsSchema: bashToolArgumentsSchema,
  argumentsExpectation: "JSON with a nonempty command without NUL characters",
  run: (args, signal) => runShellCommand(args.command, signal),
});

/** A command that ran is a completed tool call: nonzero exits report status to the model instead of failing the run. */
function runShellCommand(command: string, callerSignal?: AbortSignal): Promise<ToolExecutionResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(shellCommandDeadlineMs), ...(callerSignal ? [callerSignal] : [])]);
  if (signal.aborted) return Promise.resolve(cancelledToolResult());
  return new Promise((resolve) => {
    // A separate POSIX process group lets cancellation reach children, not just their shell parent.
    const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", HOME: "/tmp", TMPDIR: "/tmp" },
    });
    const output: Uint8Array[] = [];
    let retainedBytes = 0;
    let totalLines = 1;
    let spawnFailed = false;
    let cancellationPending = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed: ToolExecutionResult | undefined;

    const collectOutput = (chunk: Uint8Array) => {
      for (const byte of chunk) if (byte === lineFeedByte) totalLines++;
      // Keep a bounded prefix plus enough bytes for UTF-8 boundary/truncation detection; drain the rest.
      const remaining = defaultOutputLimits.maxBytes + maxUtf8SequenceBytes - retainedBytes;
      if (remaining > 0) {
        const prefix = chunk.slice(0, remaining);
        output.push(prefix);
        retainedBytes += prefix.byteLength;
      }
    };
    const finish = () => {
      if (!closed || cancellationPending) return;
      signal?.removeEventListener("abort", interrupt);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(closed);
    };
    const interrupt = () => {
      if (cancellationPending || closed) return;
      cancellationPending = true;
      signalShellGroup(child.pid, "SIGTERM");
      // Even if the shell closes early, kill surviving group members before releasing ownership.
      killTimer = setTimeout(() => {
        signalShellGroup(child.pid, "SIGKILL");
        cancellationPending = false;
        finish();
      }, processTerminationGraceMs);
    };
    child.stdout.on("data", collectOutput);
    child.stderr.on("data", collectOutput);
    child.on("error", () => { spawnFailed = true; });
    child.on("close", (code, exitSignal) => {
      const text = new TextDecoder().decode(Buffer.concat(output));
      const status = exitSignal !== null
        ? `Command terminated by signal ${exitSignal}`
        : code === 0 ? "" : `Command exited with code ${code}`;
      closed = signal?.aborted ? cancelledToolResult()
        : spawnFailed ? failedToolResult(ToolExecutionError.executionFailed(bashToolDefinition.name, "unable to start the shell command"))
          : { ok: true, value: { status: status ? "error" : "success", content: renderOutcome(text, status, totalLines) } };
      finish();
    });
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
  });
}

function signalShellGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return; // Spawn failed: there is no process group to kill.
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // Exiting between close and escalation is ordinary; other failures violate owned-process cleanup.
    if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
  }
}

/** Keep results nonempty so a silent success stays distinguishable from a missing result. */
function renderOutcome(output: string, status: string, totalLines: number): string {
  const capped = capOutput(output, totalLines);
  if (!status) return capped || "(no output)";
  return capped ? `${capped}\n${status}` : status;
}

/** A command can emit far more than a context window holds; there is no offset to resume from, so say so. */
function capOutput(output: string, totalLines: number): string {
  const truncated = truncateHead(output);
  if (truncated.boundBy === null) return truncated.text;
  const ceiling = truncated.boundBy === "bytes" ? formatSize(defaultOutputLimits.maxBytes) : `${defaultOutputLimits.maxLines} lines`;
  return `${truncated.text}\n\n[Output truncated at ${ceiling} of ${totalLines} lines. Narrow the command to see the rest.]`;
}
