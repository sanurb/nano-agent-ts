import { z } from "zod";
import type { OperationResult } from "../shared/operation-result.ts";

/** Maximum UTF-8 size of one newline-delimited Python cell protocol frame. */
export const maxPythonCellFrameBytes = 1_048_576;
/** Host and bundled runner must agree exactly; stale sandbox images fail before executing a cell. */
export const pythonCellProtocolVersion = 2;
/** Maximum UTF-8 source size admitted for one stateless Python cell. */
export const maxPythonCellCodeBytes = 262_144;
/** Maximum combined stdout, stderr, and final-value text retained from one cell. */
export const maxPythonCellOutputBytes = 65_536;
/** Maximum number of nested capability calls one cell may issue. */
export const maxPythonCellToolCalls = 32;
/** Shared identifier bound for runs, calls, aliases, and capability names. */
export const maxPythonCellIdentityCharacters = 128;
/** Shorter run identifier bound used in every frame correlation. */
export const maxPythonCellRunIdCharacters = 64;
/** Maximum safe error text returned across the cell protocol. */
export const maxPythonCellErrorMessageCharacters = 4096;
/** Maximum traceback frames or formatted sections returned for one failed cell. */
export const maxPythonCellTracebackLines = 256;
/** Default wall-clock lease for one Python cell process. */
export const pythonCellDeadlineMs = 55_000;

const runIdSchema = z.string().min(1).max(maxPythonCellRunIdCharacters).regex(/^[A-Za-z0-9_-]+$/);
const callIdSchema = z.string().min(1).max(maxPythonCellIdentityCharacters).regex(/^[A-Za-z0-9_-]+$/);
const jsonValueSchema = z.json();
const capabilitySchema = z.strictObject({
  alias: z.string().min(1).max(maxPythonCellIdentityCharacters).regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(maxPythonCellIdentityCharacters),
});
const protocolErrorSchema = z.strictObject({
  code: z.string().min(1).max(maxPythonCellRunIdCharacters),
  message: z.string().max(maxPythonCellErrorMessageCharacters),
});
const mimeTypeSchema = z.string().min(1).max(maxPythonCellIdentityCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/);
const mimeBundleSchema = z.record(mimeTypeSchema, jsonValueSchema)
  .refine((bundle) => Object.keys(bundle).length > 0 && Object.keys(bundle).length <= maxPythonCellToolCalls);
const displayMetadataSchema = z.record(z.string().max(maxPythonCellIdentityCharacters), jsonValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= maxPythonCellToolCalls);

const hostMessageSchema = z.union([
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("run"),
    run_id: runIdSchema,
    code: z.string(),
    tools: z.array(capabilitySchema).max(maxPythonCellToolCalls),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("tool_reply"),
    run_id: runIdSchema,
    call_id: callIdSchema,
    ok: z.literal(true),
    value: jsonValueSchema,
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("tool_reply"),
    run_id: runIdSchema,
    call_id: callIdSchema,
    ok: z.literal(false),
    error: protocolErrorSchema,
  }),
]);

const runnerMessageSchema = z.union([
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("ready"),
    seq: z.literal(1),
    python_version: z.string().min(1).max(maxPythonCellIdentityCharacters),
    ipython_version: z.string().min(1).max(maxPythonCellIdentityCharacters),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.enum(["stdout", "stderr"]),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    data: z.string(),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("tool_call"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    call_id: callIdSchema,
    name: z.string().min(1).max(maxPythonCellIdentityCharacters),
    args: z.record(z.string(), jsonValueSchema),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("display"),
    kind: z.literal("execute_result"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    execution_count: z.number().int().positive(),
    data: mimeBundleSchema,
    metadata: displayMetadataSchema,
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("clear_output"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    wait: z.boolean(),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("display"),
    kind: z.literal("display_data"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    display_id: callIdSchema.optional(),
    data: mimeBundleSchema,
    metadata: displayMetadataSchema,
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("display"),
    kind: z.literal("update_display_data"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    display_id: callIdSchema,
    data: mimeBundleSchema,
    metadata: displayMetadataSchema,
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("result"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    status: z.literal("ok"),
    execution_count: z.number().int().positive(),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("result"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    status: z.literal("error"),
    execution_count: z.number().int().positive(),
    error: protocolErrorSchema,
    traceback: z.array(z.string().max(maxPythonCellOutputBytes)).max(maxPythonCellTracebackLines),
  }),
  z.strictObject({
    v: z.literal(pythonCellProtocolVersion),
    type: z.literal("result"),
    run_id: runIdSchema,
    seq: z.number().int().positive(),
    status: z.literal("protocol_error"),
    error: protocolErrorSchema,
  }),
]);

/** Host-to-runner message for one lane-bound IPython cell. */
export type PythonCellHostMessage = z.infer<typeof hostMessageSchema>;
/** Runner-to-host message for one lane-bound IPython cell. */
export type PythonCellRunnerMessage = z.infer<typeof runnerMessageSchema>;
/** One rich IPython MIME display emitted during a cell. */
export type PythonCellDisplayMessage = Extract<PythonCellRunnerMessage, { type: "display" }>;
/** One rich display or clear-output event emitted during a cell. */
export type PythonCellOutputMessage = Extract<
  PythonCellRunnerMessage,
  { type: "display" | "clear_output" }
>;
/** JSON value that can cross the Python cell membrane without type loss. */
export type PythonCellJsonValue = z.infer<typeof jsonValueSchema>;

/** Malformed or oversized Python cell transport frame. */
export class PythonCellProtocolError extends Error {
  readonly _tag = "PythonCellProtocolError" as const;

  constructor(readonly reason: "empty" | "too_large" | "multiple" | "malformed" | "invalid") {
    super(`Python cell protocol failed: ${reason}`);
  }
}

/** Encode one strict host frame with its newline record delimiter. */
export function encodePythonCellFrame(message: PythonCellHostMessage): string {
  return `${JSON.stringify(hostMessageSchema.parse(message))}\n`;
}

/** Parse one runner frame after the process controller isolates its LF record. */
export function decodePythonCellRunnerFrame(
  line: string,
): OperationResult<PythonCellRunnerMessage, PythonCellProtocolError> {
  if (Buffer.byteLength(line, "utf8") > maxPythonCellFrameBytes) {
    return { ok: false, error: new PythonCellProtocolError("too_large") };
  }
  if (line.length === 0) return { ok: false, error: new PythonCellProtocolError("empty") };
  if (line.includes("\n")) return { ok: false, error: new PythonCellProtocolError("multiple") };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: new PythonCellProtocolError("malformed") };
  }
  const parsed = runnerMessageSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: new PythonCellProtocolError("invalid") };
}
