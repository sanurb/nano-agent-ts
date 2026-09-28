import { spawn } from "node:child_process";
import { processTerminationGraceMs } from "../shared/process-policy.ts";
import {
  decodePythonCellRunnerFrame,
  encodePythonCellFrame,
  maxPythonCellFrameBytes,
  maxPythonCellOutputBytes,
  type PythonCellHostMessage,
  type PythonCellRunnerMessage,
} from "./python-cell-protocol.ts";

const lineFeedByte = 0x0a;

/** Executable, environment, and cleanup for one persistent Python kernel process. */
export interface PythonKernelCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup?: () => Promise<boolean>;
}

/** Terminal transport evidence after all pipes and external cleanup settle. */
export interface PythonKernelTransportExit {
  readonly spawned: boolean;
  readonly code: number | null;
  readonly stderr: string;
  readonly protocolError: string | undefined;
  readonly cleanupConfirmed: boolean;
}

/** Strict framed transport around one long-lived Python kernel process. */
export class PythonKernelTransport {
  readonly closed: Promise<PythonKernelTransportExit>;
  readonly #child;
  readonly #closedResolver = Promise.withResolvers<PythonKernelTransportExit>();
  #stdoutBuffer = Buffer.alloc(0);
  #handling = Promise.resolve();
  #spawned = false;
  #stderr = "";
  #sequence = 0;
  #protocolError: string | undefined;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    command: PythonKernelCommand,
    onMessage: (message: PythonCellRunnerMessage) => Promise<void>,
  ) {
    this.closed = this.#closedResolver.promise;
    this.#child = spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
      this.#drainFrames(onMessage);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      const retained = Buffer.byteLength(this.#stderr, "utf8");
      if (retained >= maxPythonCellOutputBytes) return;
      this.#stderr += chunk.subarray(0, maxPythonCellOutputBytes - retained).toString("utf8");
    });
    this.#child.stdin.on("error", () => {});
    this.#child.on("spawn", () => { this.#spawned = true; });
    this.#child.on("error", (error) => this.#fail(error.message));
    this.#child.on("close", (code) => {
      this.#signalProcessGroup("SIGKILL");
      if (this.#killTimer !== undefined) clearTimeout(this.#killTimer);
      void this.#handling.then(async () => {
        let cleanupConfirmed = true;
        try {
          cleanupConfirmed = command.cleanup === undefined || await command.cleanup();
        } catch { // no-excuse-ok: catch -- External cleanup failure is retained as uncertain evidence.
          cleanupConfirmed = false;
        }
        this.#closedResolver.resolve({
          spawned: this.#spawned,
          code,
          stderr: this.#stderr,
          protocolError: this.#protocolError,
          cleanupConfirmed,
        });
      });
    });
  }

  /** Write one validated host frame to the active kernel. */
  async send(message: PythonCellHostMessage): Promise<void> {
    const frame = encodePythonCellFrame(message);
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  /** Close stdin and wait for graceful kernel exit, then escalate if required. */
  async close(): Promise<PythonKernelTransportExit> {
    this.#child.stdin.end();
    this.#killTimer ??= setTimeout(
      () => this.#signalProcessGroup("SIGKILL"),
      processTerminationGraceMs,
    );
    return await this.closed;
  }

  /** Retire a lost or interrupted kernel and await pipe closure. */
  async kill(): Promise<PythonKernelTransportExit> {
    this.#signalProcessGroup("SIGTERM");
    this.#killTimer ??= setTimeout(
      () => this.#signalProcessGroup("SIGKILL"),
      processTerminationGraceMs,
    );
    return await this.closed;
  }

  #drainFrames(onMessage: (message: PythonCellRunnerMessage) => Promise<void>): void {
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf(lineFeedByte);
      if (newline < 0) break;
      const line = this.#stdoutBuffer.subarray(0, newline).toString("utf8");
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      const decoded = decodePythonCellRunnerFrame(line);
      if (!decoded.ok) {
        this.#fail(decoded.error.message);
        break;
      }
      if (decoded.value.seq !== this.#sequence + 1) {
        this.#fail("Python kernel emitted a non-monotonic sequence");
        break;
      }
      this.#sequence = decoded.value.seq;
      this.#handling = this.#handling.then(() => onMessage(decoded.value)).catch((error: Error) => {
        this.#fail(error.message);
      });
    }
    if (this.#stdoutBuffer.byteLength > maxPythonCellFrameBytes) {
      this.#fail("Python kernel frame exceeded its byte limit");
    }
  }

  #fail(message: string): void {
    this.#protocolError ??= message;
    void this.kill();
  }

  #signalProcessGroup(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error) { // no-excuse-ok: catch -- A missing group is already settled; other failures fall back to the child handle.
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      }
    }
    this.#child.kill(signal);
  }
}
