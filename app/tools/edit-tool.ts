import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError } from "../agent/tool-executor.ts";
import { defineTool } from "./agent-tool.ts";
import { readFileForMutation, replaceFileAtomically } from "./atomic-file-mutation.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { pathArgumentSchema } from "./tool-output.ts";

const maxReplacementsPerCall = 128;
// At most 32 Mi UTF-16 code units of scan/prefix-table work across the complete batch.
const maxEditMatchingWorkUnits = 33_554_432;

const replacementSchema = z.object({
  old_string: z.string().min(1).refine((text) => text.isWellFormed()),
  new_string: z.string().refine((text) => text.isWellFormed()),
});

type Replacement = z.infer<typeof replacementSchema>;

/** Accept the batch a model actually sends: an array, a lone replacement, or either as JSON text. */
const replacementsSchema = z.preprocess(
  (value) => {
    const text = z.string().safeParse(value);
    if (!text.success) return value;
    try {
      return JSON.parse(text.data);
    } catch {
      return value;
    }
  },
  z.union([
    z.array(replacementSchema).min(1).max(maxReplacementsPerCall),
    replacementSchema.transform((single) => [single]),
  ]),
);

const editToolArgumentsSchema = z.object({
  file_path: pathArgumentSchema,
  edits: replacementsSchema,
});

const fileDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const fileEncoder = new TextEncoder();
const byteOrderMark = "\uFEFF";

/** Advertise Edit as exact, unique, non-overlapping replacement rather than a line-addressed patch. */
export const editToolDefinition = {
  name: "Edit",
  description:
    "Replace exact blocks of text in an existing file. Every old_string must appear exactly once in the file and "
    + "must not overlap another edit; add surrounding context to disambiguate. All edits are matched against the "
    + "file as it is now, not against the result of earlier edits in the same call.",
  parameters: {
    type: "object",
    required: ["file_path", "edits"],
    properties: {
      file_path: { type: "string", description: "The path of the file to edit" },
      edits: {
        type: "array",
        description: "The replacements to apply, each matched against the current file contents",
        items: {
          type: "object",
          required: ["old_string", "new_string"],
          properties: {
            old_string: { type: "string", description: "Exact text to replace, unique within the file" },
            new_string: { type: "string", description: "Text to put in its place" },
          },
        },
      },
    },
  },
} satisfies AgentToolDefinition;

/** Validate every replacement before writing, preserving byte-order mark and line endings under a shared file lock. */
export const editTool = defineTool({
  definition: editToolDefinition,
  executionMode: "sequential",
  argumentsSchema: editToolArgumentsSchema,
  argumentsExpectation:
    "JSON with a nonempty file_path without NUL characters and at least one edit of nonempty old_string and string new_string",
  run: (args, signal) => withFileMutationQueue(args.file_path, async (target) => {
    if (signal?.aborted) return cancelledToolResult();
    const snapshot = await readFileForMutation(target, signal);
    if (signal?.aborted) return cancelledToolResult();
    if (!snapshot.ok || snapshot.value.bytes === null) return failedToolResult(failure("unable to read file"));
    const bytes = snapshot.value.bytes;
    const original = fileDecoder.decode(bytes);
    // Refuse a file we cannot reproduce byte for byte; rewriting it would discard bytes we never decoded.
    if (!reencodesExactly(original, bytes)) {
      return failedToolResult(failure("file is not valid UTF-8 text"));
    }

    const bom = original.startsWith(byteOrderMark) ? byteOrderMark : "";
    const body = original.slice(bom.length);
    const applied = applyReplacements(body, args.edits);
    if (!applied.ok) return failedToolResult(applied.error);

    const committed = await replaceFileAtomically(target, bom + applied.value, snapshot.value, signal);
    return committed.ok && committed.value.status === "success"
      ? successfulToolResult(`Replaced ${args.edits.length} block(s) successfully.`) : committed;
  }, signal),
});

/** One replacement located in the pre-edit content, kept with its index for diagnostics. */
interface LocatedReplacement {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

type UniqueTextLocation = { readonly kind: "missing" } | { readonly kind: "ambiguous" } | { readonly kind: "unique"; readonly start: number };

/** KMP bounds literal matching linearly and stops at the second occurrence, including overlapping matches. */
function locateUniqueText(content: string, needle: string): UniqueTextLocation {
  const prefix = new Uint32Array(needle.length);
  const prefixAt = (index: number): number => {
    const value = prefix[index];
    if (value === undefined) throw new Error("Edit prefix-table index outside the matching budget");
    return value;
  };
  for (let index = 1, matched = 0; index < needle.length; index++) {
    while (matched > 0 && needle.charCodeAt(index) !== needle.charCodeAt(matched)) matched = prefixAt(matched - 1);
    if (needle.charCodeAt(index) === needle.charCodeAt(matched)) matched++;
    prefix[index] = matched;
  }
  let first: number | null = null;
  for (let index = 0, matched = 0; index < content.length; index++) {
    while (matched > 0 && content.charCodeAt(index) !== needle.charCodeAt(matched)) matched = prefixAt(matched - 1);
    if (content.charCodeAt(index) === needle.charCodeAt(matched)) matched++;
    if (matched === needle.length) {
      if (first !== null) return { kind: "ambiguous" };
      first = index - needle.length + 1;
      matched = prefixAt(matched - 1);
    }
  }
  return first === null ? { kind: "missing" } : { kind: "unique", start: first };
}

/** Locate every replacement against the original, reject an ambiguous batch, then splice once. */
function applyReplacements(content: string, edits: readonly Replacement[]): OperationResult<string, ToolExecutionError<"execution_failed">> {
  const normalized = normalizeToLF(content);
  if (normalized.length * edits.length + edits.reduce((size, edit) => size + edit.old_string.length, 0) > maxEditMatchingWorkUnits) {
    return { ok: false, error: failure("matching work budget exceeded; use fewer edits or a smaller file") };
  }
  const located: LocatedReplacement[] = [];
  for (const [index, edit] of edits.entries()) {
    const oldText = normalizeToLF(edit.old_string);
    const location = locateUniqueText(normalized, oldText);
    if (location.kind === "missing") return { ok: false, error: failure(`edits[${index}] matches no text in the file`) };
    if (location.kind === "ambiguous") return { ok: false, error: failure(`edits[${index}] matches at least 2 places; each edit must match exactly one`) };
    const start = location.start;
    located.push({ index, start, end: start + oldText.length, newText: normalizeToLF(edit.new_string) });
  }

  const ordered = [...located].sort((left, right) => left.start - right.start);
  for (const [position, replacement] of ordered.entries()) {
    const previous = ordered[position - 1];
    if (previous && replacement.start < previous.end) {
      return { ok: false, error: failure(`edits[${replacement.index}] overlaps edits[${previous.index}]`) };
    }
  }

  // Map only the needed normalized boundaries back to original offsets; preserve every untouched byte.
  const boundaries = new Map<number, number>();
  const needed = new Set(ordered.flatMap((replacement) => [replacement.start, replacement.end]));
  let sourceOffset = 0;
  for (let normalizedOffset = 0; normalizedOffset <= normalized.length; normalizedOffset++) {
    if (needed.has(normalizedOffset)) boundaries.set(normalizedOffset, sourceOffset);
    sourceOffset += content.startsWith("\r\n", sourceOffset) ? "\r\n".length : 1;
  }
  let edited = content;
  for (const replacement of [...ordered].reverse()) {
    const start = boundaries.get(replacement.start);
    const end = boundaries.get(replacement.end);
    if (start === undefined || end === undefined) throw new Error("Edit replacement boundary missing after normalization");
    edited = edited.slice(0, start) + restoreLineEndings(replacement.newText, detectLineEnding(content)) + edited.slice(end);
  }
  if (edited === content) return { ok: false, error: failure("no edit changed the file") };
  return { ok: true, value: edited };
}

/** A decoder that replaces malformed bytes would silently rewrite them; only a byte-exact file is editable. */
function reencodesExactly(text: string, source: Uint8Array): boolean {
  const encoded = fileEncoder.encode(text);
  return encoded.length === source.length && encoded.every((byte, index) => byte === source[index]);
}

/** A file written with CRLF keeps CRLF; matching happens on LF so old_string need not carry them. */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const firstBreak = content.indexOf("\n");
  return firstBreak > 0 && content[firstBreak - 1] === "\r" ? "\r\n" : "\n";
}

function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\r\n" | "\n"): string {
  return lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function failure(cause: string): ToolExecutionError<"execution_failed"> {
  return ToolExecutionError.executionFailed(editToolDefinition.name, cause);
}
