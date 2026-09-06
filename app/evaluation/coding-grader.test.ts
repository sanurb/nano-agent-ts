import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { successfulToolResult, type AgentToolExecutor } from "../agent/tool-executor.ts";
import { codingEvaluationTasks } from "./coding-tasks.ts";
import { fingerprintWorkspace, gradeCodingTask, unexpectedChanges } from "./coding-grader.ts";

function observations(content: string): AgentToolExecutor {
  return { executionModeFor: () => "sequential", executeTool: async () => successfulToolResult(content) };
}

test("starter tasks are seed-reproducible and reference expectations cover bug, feature, and multi-file behavior", () => {
  const tasks = codingEvaluationTasks(42);
  expect(tasks).toEqual(codingEvaluationTasks(42));
  expect(tasks).not.toEqual(codingEvaluationTasks(43));
  expect(tasks.map((task) => task.id)).toEqual(["interval-union", "median-feature", "invoice-cents"]);
  expect(tasks[0]?.checks[1]?.expected).toEqual([[1, 7]]);
  expect(tasks[1]?.checks[2]?.expected).toBe(5);
  expect(tasks[2]?.checks[1]?.expected).toBe(547);
});

test("only externally matched outputs pass; success prose, forged verdicts, and input mutation do not", async () => {
  const task = codingEvaluationTasks(42)[0];
  if (!task) throw new Error("Missing interval evaluation fixture");
  const correct = task.checks.map((check) => ({ value: check.expected, inputAfter: check.input }));
  expect(await gradeCodingTask(observations(JSON.stringify(correct)), task)).toMatchObject({ verified: true });
  for (const output of ["All tests passed!", '{"verified":true}', JSON.stringify(correct.map((check) => ({ ...check, inputAfter: [] })))]) {
    expect(await gradeCodingTask(observations(output), task)).toMatchObject({ verified: false });
  }
  expect(await gradeCodingTask(observations("[]"), { ...task, checks: [] })).toMatchObject({ verified: false, available: false });
});

test("workspace fingerprints reveal unrelated additions, changes, and deletions including ignored paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-grader-"));
  try {
    await writeFile(join(root, "source.js"), "original");
    await writeFile(join(root, "package.json"), "protected");
    const before = await fingerprintWorkspace(root);
    await writeFile(join(root, "source.js"), "allowed change");
    await rm(join(root, "package.json"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "claimed-result"), "passed");
    const after = await fingerprintWorkspace(root);
    expect(unexpectedChanges(before, after, ["source.js"])).toEqual([".git/claimed-result", "package.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
