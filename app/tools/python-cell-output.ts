import {
  maxPythonCellOutputBytes,
  type PythonCellJsonValue,
  type PythonCellOutputMessage,
  type PythonCellRunnerMessage,
} from "./python-cell-protocol.ts";

/** Rich MIME bundle emitted by IPython's display system. */
export type PythonCellMimeBundle = Readonly<Record<string, PythonCellJsonValue>>;

/** Structured display retained from one IPython cell in publication order. */
export type PythonCellDisplay =
  | {
    readonly kind: "clear_output";
    readonly wait: boolean;
  }
  | {
    readonly kind: "execute_result";
    readonly executionCount: number;
    readonly data: PythonCellMimeBundle;
    readonly metadata: PythonCellMimeBundle;
  }
  | {
    readonly kind: "display_data";
    readonly displayId?: string;
    readonly data: PythonCellMimeBundle;
    readonly metadata: PythonCellMimeBundle;
  }
  | {
    readonly kind: "update_display_data";
    readonly displayId: string;
    readonly data: PythonCellMimeBundle;
    readonly metadata: PythonCellMimeBundle;
  };

interface CompletedPythonCellOutput {
  readonly output: string;
  readonly displays: readonly PythonCellDisplay[];
  readonly executionCount: number;
}

interface InterruptedPythonCellOutput {
  readonly output: string;
  readonly displays: readonly PythonCellDisplay[];
}

/** Observable disposition of one IPython cell after protocol work settles. */
export type PythonCellProcessResult =
  | ({ readonly status: "success" } & CompletedPythonCellOutput)
  | ({ readonly status: "error"; readonly error: string; readonly traceback: readonly string[] } & CompletedPythonCellOutput)
  | ({ readonly status: "limit"; readonly error: string } & InterruptedPythonCellOutput)
  | ({ readonly status: "cancelled" } & InterruptedPythonCellOutput)
  | ({ readonly status: "unavailable"; readonly error: string } & InterruptedPythonCellOutput)
  | ({ readonly status: "uncertain"; readonly error: string } & InterruptedPythonCellOutput);

/** Bounded stdout, stderr, rich displays, and tracebacks for one active cell. */
export class PythonCellOutputBuffer {
  #output = "";
  #outputBytes = 0;
  readonly #displays: PythonCellDisplay[] = [];

  /** Append stream text up to the cell byte ceiling; false means the generation must retire. */
  appendText(data: string): boolean {
    const bytes = Buffer.byteLength(data, "utf8");
    const remaining = maxPythonCellOutputBytes - this.#outputBytes;
    if (remaining > 0) this.#output += Buffer.from(data).subarray(0, remaining).toString("utf8");
    this.#outputBytes += bytes;
    return this.#outputBytes <= maxPythonCellOutputBytes;
  }

  /** Retain one complete MIME display or reject the cell before storing a partial bundle. */
  appendDisplay(message: PythonCellOutputMessage): boolean {
    const display = pythonCellDisplay(message);
    const bytes = Buffer.byteLength(JSON.stringify(display), "utf8");
    this.#outputBytes += bytes;
    if (this.#outputBytes > maxPythonCellOutputBytes) return false;
    this.#displays.push(display);
    return true;
  }

  /** Account for traceback/error data before constructing a completed outcome. */
  acceptsResult(message: Extract<PythonCellRunnerMessage, { type: "result" }>): boolean {
    if (message.status !== "error") return true;
    this.#outputBytes += Buffer.byteLength(JSON.stringify({
      error: message.error,
      traceback: message.traceback,
    }), "utf8");
    return this.#outputBytes <= maxPythonCellOutputBytes;
  }

  /** Snapshot interrupted output without exposing the mutable accumulator. */
  interrupted(): InterruptedPythonCellOutput {
    return { output: this.#output, displays: [...this.#displays] };
  }

  /** Snapshot successful output with its IPython execution count. */
  success(executionCount: number): CompletedPythonCellOutput & { readonly status: "success" } {
    return { status: "success", ...this.interrupted(), executionCount };
  }

  /** Snapshot a formatted IPython exception with its execution count. */
  error(
    executionCount: number,
    error: string,
    traceback: readonly string[],
  ): CompletedPythonCellOutput & {
    readonly status: "error";
    readonly error: string;
    readonly traceback: readonly string[];
  } {
    return {
      status: "error",
      ...this.interrupted(),
      executionCount,
      error,
      traceback: [...traceback],
    };
  }
}

/** Translate one terminal runner result without losing accumulated rich output. */
export function pythonCellProcessResult(
  output: PythonCellOutputBuffer,
  result: Extract<PythonCellRunnerMessage, { type: "result" }>,
): PythonCellProcessResult {
  switch (result.status) {
    case "ok":
      return output.success(result.execution_count);
    case "error":
      return output.error(
        result.execution_count,
        result.error.message,
        result.traceback,
      );
    case "protocol_error":
      return {
        status: "uncertain",
        ...output.interrupted(),
        error: result.error.message,
      };
    default:
      return result satisfies never;
  }
}

function pythonCellDisplay(message: PythonCellOutputMessage): PythonCellDisplay {
  switch (message.type) {
    case "clear_output":
      return { kind: "clear_output", wait: message.wait };
    case "display":
      return pythonCellRichDisplay(message);
    default:
      return message satisfies never;
  }
}

function pythonCellRichDisplay(
  message: Extract<PythonCellOutputMessage, { type: "display" }>,
): PythonCellDisplay {
  switch (message.kind) {
    case "execute_result":
      return {
        kind: message.kind,
        executionCount: message.execution_count,
        data: message.data,
        metadata: message.metadata,
      };
    case "display_data":
      return message.display_id === undefined
        ? { kind: message.kind, data: message.data, metadata: message.metadata }
        : {
          kind: message.kind,
          displayId: message.display_id,
          data: message.data,
          metadata: message.metadata,
        };
    case "update_display_data":
      return {
        kind: message.kind,
        displayId: message.display_id,
        data: message.data,
        metadata: message.metadata,
      };
    default:
      return message satisfies never;
  }
}
