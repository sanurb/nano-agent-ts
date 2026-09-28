import {
  PythonCellCapabilityServer,
  type PythonCellCapabilityHandler,
} from "./python-cell-capability-server.ts";
import {
  pythonCellProtocolVersion,
  type PythonCellRunnerMessage,
} from "./python-cell-protocol.ts";
import {
  pythonCellProcessResult,
  PythonCellOutputBuffer,
  type PythonCellProcessResult,
} from "./python-cell-output.ts";
import {
  PythonKernelTransport,
  type PythonKernelCommand,
  type PythonKernelTransportExit,
} from "./python-kernel-transport.ts";

/** Bounded input for one cell in a persistent Python kernel. */
export interface PythonCellProcessOptions {
  readonly runId: string;
  readonly code: string;
  readonly tools: readonly { readonly alias: string; readonly name: string }[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly callCapability: PythonCellCapabilityHandler;
}

interface ActivePythonCell {
  readonly input: PythonCellProcessOptions;
  readonly settlement: PromiseWithResolvers<PythonCellProcessResult>;
  readonly capabilityServer: PythonCellCapabilityServer;
  readonly output: PythonCellOutputBuffer;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: () => void;
}

/** One serial, stateful Python process. Interrupting an active cell retires the whole kernel. */
export class PythonKernelProcess {
  readonly generation: number;
  readonly #transport: PythonKernelTransport;
  readonly #ready = Promise.withResolvers<void>();
  #active: ActivePythonCell | undefined;
  #tail = Promise.resolve();
  #closed = false;
  #isReady = false;
  #exit: PythonKernelTransportExit | undefined;
  #kernelFailure: string | undefined;
  #retirementReason: "cancelled" | "limit" | undefined;

  constructor(command: PythonKernelCommand, generation: number) {
    this.generation = generation;
    this.#transport = new PythonKernelTransport(command, (message) => this.#handleMessage(message));
    void this.#transport.closed.then((exit) => this.#handleExit(exit));
  }

  /** Queue one cell; queued cancellation does not disturb an active predecessor. */
  run(input: PythonCellProcessOptions): Promise<PythonCellProcessResult> {
    if (input.signal?.aborted) {
      return Promise.resolve({ status: "cancelled", output: "", displays: [] });
    }
    const result = this.#tail.then(() => this.#runActive(input));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Whether this generation has exited and must never accept another cell. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Retire the generation after queued work drains. */
  async close(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
  }

  /** Interrupt active work and retire the generation immediately. */
  async reset(): Promise<void> {
    this.#closed = true;
    await this.#transport.kill();
  }

  async #runActive(input: PythonCellProcessOptions): Promise<PythonCellProcessResult> {
    if (input.signal?.aborted) return { status: "cancelled", output: "", displays: [] };
    if (this.#closed) {
      return {
        status: "unavailable",
        output: "",
        displays: [],
        error: this.#exit?.stderr || this.#exit?.protocolError || "Python kernel generation is closed",
      };
    }
    const settlement = Promise.withResolvers<PythonCellProcessResult>();
    const lifecycle = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, lifecycle.signal]) : lifecycle.signal;
    const abort = (): void => {
      lifecycle.abort();
      void this.#retireActive("cancelled");
    };
    const capabilityServer = new PythonCellCapabilityServer({
      runId: input.runId,
      signal,
      callCapability: input.callCapability,
      writeMessage: (message) => this.#transport.send(message),
      onLimit: () => { void this.#retireActive("limit"); },
    });
    this.#active = {
      input,
      settlement,
      capabilityServer,
      output: new PythonCellOutputBuffer(),
      timer: undefined,
      abort,
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return await settlement.promise;
    }
    await Promise.race([this.#ready.promise, this.#transport.closed]);
    if (!this.#isReady) return await settlement.promise;
    const active = this.#active;
    if (!active) return await settlement.promise;
    active.timer = setTimeout(() => { void this.#retireActive("limit"); }, input.timeoutMs);
    try {
      await this.#transport.send({
        v: pythonCellProtocolVersion,
        type: "run",
        run_id: input.runId,
        code: input.code,
        tools: [...input.tools],
      });
    } catch (error) {
      await this.#transport.kill();
      this.#settleActive({
        status: "uncertain",
        ...(this.#active?.output.interrupted() ?? { output: "", displays: [] }),
        error: error instanceof Error ? error.message : "Python kernel run frame failed",
      });
    }
    return await settlement.promise;
  }

  async #handleMessage(message: PythonCellRunnerMessage): Promise<void> {
    if (message.type === "ready") {
      if (this.#isReady) {
        this.#kernelFailure = "Python kernel emitted more than one ready frame";
        void this.#transport.kill();
        return;
      }
      this.#isReady = true;
      this.#ready.resolve();
      return;
    }
    const active = this.#active;
    if (!active || message.run_id !== active.input.runId) {
      this.#kernelFailure = "Python kernel message did not match the active cell";
      void this.#transport.kill();
      return;
    }
    switch (message.type) {
      case "stdout":
      case "stderr":
        if (!active.output.appendText(message.data)) void this.#retireActive("limit");
        return;
      case "tool_call":
        await active.capabilityServer.serve(message);
        return;
      case "display":
      case "clear_output":
        if (!active.output.appendDisplay(message)) void this.#retireActive("limit");
        return;
      case "result":
        if (!active.output.acceptsResult(message)) {
          void this.#retireActive("limit");
          return;
        }
        if (message.status === "protocol_error") {
          this.#kernelFailure = message.error.message;
          void this.#transport.kill();
          return;
        }
        this.#settleActive(pythonCellProcessResult(active.output, message));
        return;
      default:
        message satisfies never;
    }
  }

  async #retireActive(reason: "cancelled" | "limit"): Promise<void> {
    if (!this.#active || this.#retirementReason !== undefined) return;
    this.#retirementReason = reason;
    this.#closed = true;
    await this.#transport.kill();
  }

  #settleActive(result: PythonCellProcessResult): void {
    const active = this.#active;
    if (!active) return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    active.input.signal?.removeEventListener("abort", active.abort);
    this.#active = undefined;
    active.settlement.resolve(result);
  }

  #handleExit(exit: PythonKernelTransportExit): void {
    this.#exit = exit;
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    const output = active.output.interrupted();
    if (!exit.cleanupConfirmed) {
      this.#settleActive({
        status: "uncertain",
        ...output,
        error: "Python kernel cleanup was not confirmed",
      });
      return;
    }
    if (this.#retirementReason === "cancelled") {
      this.#settleActive({ status: "cancelled", ...output });
      return;
    }
    if (this.#retirementReason === "limit") {
      this.#settleActive({
        status: "limit",
        ...output,
        error: "Python cell exceeded an execution limit",
      });
      return;
    }
    if (!this.#isReady) {
      this.#settleActive({
        status: "unavailable",
        ...output,
        error: exit.stderr || exit.protocolError || "IPython kernel failed before its ready frame",
      });
      return;
    }
    if (this.#kernelFailure !== undefined) {
      this.#settleActive({
        status: "uncertain",
        ...output,
        error: this.#kernelFailure,
      });
      return;
    }
    const error = !exit.spawned
      ? "Python kernel unavailable"
      : exit.protocolError ?? (exit.stderr || "Python kernel exited before completing the cell");
    this.#settleActive({
      status: exit.spawned ? "uncertain" : "unavailable",
      ...output,
      error,
    });
  }
}
