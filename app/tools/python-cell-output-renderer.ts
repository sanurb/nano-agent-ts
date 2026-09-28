import { maxToolOutcomeCharacters } from "../agent/tool-executor.ts";
import { z } from "zod";
import type {
  PythonCellDisplay,
  PythonCellMimeBundle,
  PythonCellProcessResult,
} from "./python-cell-output.ts";
import type { PythonCellJsonValue } from "./python-cell-protocol.ts";

const truncationNotice = "\n[IPython output truncated at the tool outcome limit]";
const errorEnvelopeReserve = 256;

/** Render bounded IPython streams, rich MIME displays, and tracebacks for the model. */
export function renderPythonCellOutput(result: PythonCellProcessResult): string {
  const parts = [
    result.output,
    ...result.displays.map(renderPythonCellDisplay),
    result.status === "error" ? result.traceback.join("\n") : "",
  ].filter((part) => part.length > 0);
  return clampPythonCellOutput(parts.join(parts.length > 1 ? "\n" : ""));
}

/** Keep an error cause small enough for ToolExecutionError's stable envelope. */
export function clampPythonCellErrorCause(cause: string): string {
  return clampPythonCellOutput(cause, maxToolOutcomeCharacters - errorEnvelopeReserve);
}

function renderPythonCellDisplay(display: PythonCellDisplay): string {
  switch (display.kind) {
    case "clear_output":
      return `[IPython clear_output wait=${display.wait}]`;
    case "execute_result": {
      const projected = renderPythonCellMimeBundle(display.data);
      const plainText = z.string().safeParse(display.data["text/plain"]);
      return Object.keys(display.data).length === 1 && plainText.success
        ? projected
        : `[IPython ${display.kind} execution=${display.executionCount}]\n${projected}`;
    }
    case "display_data":
    case "update_display_data": {
      const identity = display.displayId === undefined ? "" : ` id=${display.displayId}`;
      return `[IPython ${display.kind}${identity}]\n`
        + renderPythonCellMimeBundle(display.data);
    }
    default:
      return display satisfies never;
  }
}

function renderPythonCellMimeBundle(bundle: PythonCellMimeBundle): string {
  const entries = Object.entries(bundle);
  const preferred = ["text/markdown", "text/plain", "text/html", "application/json"];
  entries.sort(([left], [right]) => mimePriority(left, preferred) - mimePriority(right, preferred));
  if (entries.length === 1) return renderMimeValue(entries[0]?.[0] ?? "", entries[0]?.[1] ?? null);
  return entries.map(([mime, value]) => `${mime}:\n${renderMimeValue(mime, value)}`).join("\n");
}

function mimePriority(mime: string, preferred: readonly string[]): number {
  const index = preferred.indexOf(mime);
  return index < 0 ? preferred.length : index;
}

function renderMimeValue(mime: string, value: PythonCellJsonValue): string {
  const text = z.string().safeParse(value);
  if ((mime === "image/png" || mime === "image/jpeg") && text.success) {
    return `[${mime} base64 payload: ${text.data.length} characters]`;
  }
  return text.success ? text.data : JSON.stringify(value);
}

function clampPythonCellOutput(
  content: string,
  maximum: number = maxToolOutcomeCharacters,
): string {
  if (content.length <= maximum) return content;
  return `${content.slice(0, maximum - truncationNotice.length)}${truncationNotice}`;
}
