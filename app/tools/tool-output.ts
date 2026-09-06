import { z } from "zod";

/** Independent line and byte ceilings; whichever binds first ends the output on a line boundary. */
export interface OutputLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
}

const maxOutputLines = 2000;
const maxOutputBytes = 51_200; // 50 KiB.

/** Ceilings chosen so one tool result cannot dominate a context window. */
export const defaultOutputLimits: OutputLimits = { maxLines: maxOutputLines, maxBytes: maxOutputBytes };

/** Longest single match line Grep emits before eliding the remainder. */
export const maxMatchLineLength = 500;

/** A head-truncated rendering plus what the caller needs to tell the model how to resume. */
export interface TruncatedOutput {
  readonly text: string;
  readonly totalLines: number;
  readonly outputLines: number;
  /** The ceiling that bound, or null when the whole input fit. */
  readonly boundBy: "lines" | "bytes" | null;
  /** The first line alone exceeded the byte ceiling, so no whole line could be emitted. */
  readonly firstLineExceedsLimit: boolean;
}

/** Keep the head of an output whole: complete lines only, never a partial one. */
export function truncateHead(content: string, limits: OutputLimits = defaultOutputLimits): TruncatedOutput {
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (totalLines <= limits.maxLines && Buffer.byteLength(content, "utf8") <= limits.maxBytes) {
    return { text: content, totalLines, outputLines: totalLines, boundBy: null, firstLineExceedsLimit: false };
  }

  const kept: string[] = [];
  let bytes = 0;
  let boundBy: "lines" | "bytes" | null = null;
  for (const line of lines) {
    if (kept.length >= limits.maxLines) {
      boundBy = "lines";
      break;
    }
    // Every line but the first also pays for the separator that rejoins it.
    const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > limits.maxBytes) {
      boundBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  return {
    text: kept.join("\n"),
    totalLines,
    outputLines: kept.length,
    boundBy,
    firstLineExceedsLimit: kept.length === 0,
  };
}

/** Elide a single overlong line so one match cannot spend the whole byte ceiling. */
export function truncateLine(line: string, maxLength: number = maxMatchLineLength): string {
  return line.length <= maxLength ? line : `${line.slice(0, maxLength)}… [line truncated]`;
}

/** Render a byte count the way the continuation hints refer to their own ceiling. */
export function formatSize(bytes: number): string {
  const bytesPerKibibyte = 1024;
  return bytes < bytesPerKibibyte ? `${bytes}B` : `${Math.round(bytes / bytesPerKibibyte)}KB`;
}

const maxPathCharacters = 4096;

/** Every path a tool accepts: bounded, well-formed text without NUL, which no filesystem call can carry. */
export const pathArgumentSchema = z.string().min(1).max(maxPathCharacters).refine((path) => path.isWellFormed() && !path.includes("\u0000"));
