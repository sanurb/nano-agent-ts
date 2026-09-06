import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import type { AgentToolExecutor } from "../agent/tool-executor.ts";
import { readBoundedFile, maxToolFileBytes } from "../tools/bounded-file-read.ts";
import { walkWorkspaceFiles } from "../tools/workspace-file-walk.ts";
import type { CodingEvaluationTask } from "./coding-tasks.ts";

import { maxEvaluationChecks } from "./evaluation-protocol.ts";

const workspaceFingerprintDeadlineMs = 10_000;
const observationsSchema = z.array(z.object({ value: z.json(), inputAfter: z.json() })).max(maxEvaluationChecks);

/** Verification is independent of both the assistant's answer and any tests it wrote. */
export interface CodingGrade {
  readonly passedChecks: number;
  readonly totalChecks: number;
  readonly verified: boolean;
  readonly available: boolean;
}

/** Compare candidate values in the trusted controller; execute candidate code only inside the sandbox. */
export async function gradeCodingTask(executor: AgentToolExecutor, task: CodingEvaluationTask, signal?: AbortSignal): Promise<CodingGrade> {
  if (task.checks.length === 0) return { passedChecks: 0, totalChecks: 0, verified: false, available: false };
  const inputs = JSON.stringify(task.checks.map((check) => check.input));
  const command = `bun /agent/app/evaluation/candidate-driver.ts ${quoteArgument(task.entryPoint)} ${quoteArgument(inputs)}`;
  const result = await executor.executeTool({ id: toolCallIdSchema.parse("independent-grader"), name: "Bash", arguments: JSON.stringify({ command }) }, signal);
  const empty = { passedChecks: 0, totalChecks: task.checks.length, verified: false };
  if (!result.ok || result.value.status === "uncertain" || signal?.aborted) return { ...empty, available: false };
  if (result.value.status !== "success") return { ...empty, available: true };
  let input: z.input<typeof observationsSchema>;
  try { input = JSON.parse(result.value.content); } catch { return { ...empty, available: true }; }
  const observed = observationsSchema.safeParse(input);
  if (!observed.success || observed.data.length !== task.checks.length) return { ...empty, available: true };
  const passedChecks = task.checks.filter((check, index) => {
    const actual = observed.data[index];
    return actual !== undefined && isDeepStrictEqual(actual.value, check.expected) && isDeepStrictEqual(actual.inputAfter, check.input);
  }).length;
  return { passedChecks, totalChecks: task.checks.length, verified: passedChecks === task.checks.length, available: true };
}

/** Hash all bounded regular files to detect unrelated mutations; never execute workspace code on the host. */
export async function fingerprintWorkspace(root: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const deadline = AbortSignal.timeout(workspaceFingerprintDeadlineMs);
  for await (const entry of walkWorkspaceFiles(root, deadline, "sandbox-admission")) {
    if (entry.kind !== "file") throw new Error("Evaluation workspace coverage unavailable");
    const bytes = await readBoundedFile(join(root, entry.path), maxToolFileBytes, deadline);
    if (!bytes.ok) throw new Error("Evaluation workspace fingerprint exceeded its file budget");
    files.set(entry.path, createHash("sha256").update(bytes.value).digest("hex"));
  }
  if (deadline.aborted) throw new Error("Evaluation workspace fingerprint deadline exceeded");
  return files;
}

/** Report changed/deleted/added paths rather than trusting the agent's description of its diff. */
export function unexpectedChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, allowed: readonly string[]): readonly string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path) && !allowed.includes(path)).sort();
}

function quoteArgument(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
