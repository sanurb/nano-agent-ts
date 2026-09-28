import {
  maxPythonCellErrorMessageCharacters,
  maxPythonCellToolCalls,
  pythonCellProtocolVersion,
  type PythonCellHostMessage,
  type PythonCellJsonValue,
  type PythonCellRunnerMessage,
} from "./python-cell-protocol.ts";

/** One capability request emitted by model-written Python code. */
export interface PythonCellCapabilityCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, PythonCellJsonValue>>;
}

/** Host callback that resolves a capability call to a JSON-compatible value. */
export type PythonCellCapabilityHandler = (
  call: PythonCellCapabilityCall,
  signal: AbortSignal,
) => Promise<PythonCellJsonValue>;

/** Dependencies for serving bounded capability calls from one cell. */
export interface PythonCellCapabilityServerOptions {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly callCapability: PythonCellCapabilityHandler;
  readonly writeMessage: (message: PythonCellHostMessage) => Promise<void>;
  readonly onLimit: () => void;
}

/** Enforce call count and translate host capability outcomes into protocol replies. */
export class PythonCellCapabilityServer {
  #toolCalls = 0;

  constructor(private readonly options: PythonCellCapabilityServerOptions) {}

  /** Resolve one runner call and write exactly one matching reply unless the cell limit stops it. */
  async serve(message: Extract<PythonCellRunnerMessage, { type: "tool_call" }>): Promise<void> {
    this.#toolCalls++;
    if (this.#toolCalls > maxPythonCellToolCalls) {
      this.options.onLimit();
      return;
    }
    try {
      const value = await this.options.callCapability({
        callId: message.call_id,
        name: message.name,
        arguments: message.args,
      }, this.options.signal);
      await this.options.writeMessage({
        v: pythonCellProtocolVersion,
        type: "tool_reply",
        run_id: this.options.runId,
        call_id: message.call_id,
        ok: true,
        value,
      });
    } catch (error) { // no-excuse-ok: catch -- Capability failures cross the untrusted process boundary as data.
      const messageText = error instanceof Error ? error.message : "Capability call failed";
      await this.options.writeMessage({
        v: pythonCellProtocolVersion,
        type: "tool_reply",
        run_id: this.options.runId,
        call_id: message.call_id,
        ok: false,
        error: {
          code: "tool_error",
          message: messageText.slice(0, maxPythonCellErrorMessageCharacters),
        },
      });
    }
  }
}
