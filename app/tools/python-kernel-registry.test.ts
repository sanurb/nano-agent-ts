import { expect, test } from "bun:test";
import { createLocalPythonCellRunner } from "./local-python-cell-runner.ts";
import type { PythonCellRunner } from "./python-cell-tool.ts";

const pythonAvailable = createLocalPythonCellRunner() !== null;

function runCell(
  runner: PythonCellRunner,
  scopeId: string,
  runId: string,
  code: string,
  signal?: AbortSignal,
) {
  return runner.run({
    scopeId,
    runId,
    code,
    tools: [],
    timeoutMs: 5_000,
    signal,
    callCapability: async () => {
      throw new Error("No capabilities expected");
    },
  });
}

test.skipIf(!pythonAvailable)("Python kernels persist within a lane, isolate lanes, and reset generations", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("Python kernel registry test requires python3");
  try {
    expect(await runCell(runner, "lane-a", "a-1", "x = 41")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
    });
    expect(await runCell(runner, "lane-a", "a-2", "x + 1")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 2,
      displays: [{ data: { "text/plain": "42" } }],
    });
    expect(await runCell(runner, "lane-b", "b-1", '"x" in globals()')).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
      displays: [{ data: { "text/plain": "False" } }],
    });
    expect(await runCell(runner, "lane-a", "a-error", 'y = 7\nraise RuntimeError("expected")'))
      .toMatchObject({ status: "error", generation: 1, executionCount: 3 });
    expect(await runCell(runner, "lane-a", "a-after-error", "y")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 4,
      displays: [{ data: { "text/plain": "7" } }],
    });

    expect(await runner.reset("lane-a")).toBe(2);
    expect(await runCell(runner, "lane-a", "a-reset", '"x" in globals()')).toMatchObject({
      status: "success",
      generation: 2,
      executionCount: 1,
      displays: [{ data: { "text/plain": "False" } }],
    });
  } finally {
    await runner.close();
  }
});

test.skipIf(!pythonAvailable)("IPython Out history persists per lane and clears on reset", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("IPython kernel registry test requires uv");
  try {
    expect(await runCell(runner, "lane-history", "history-1", "40")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
    });
    expect(await runCell(runner, "lane-history", "history-2", "Out[1] + 2")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 2,
      displays: [{ data: { "text/plain": "42" } }],
    });
    expect(await runCell(runner, "lane-other", "history-other", "1 in Out")).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
      displays: [{ data: { "text/plain": "False" } }],
    });
    expect(await runner.reset("lane-history")).toBe(2);
    expect(await runCell(runner, "lane-history", "history-reset", "1 in Out")).toMatchObject({
      status: "success",
      generation: 2,
      executionCount: 1,
      displays: [{ data: { "text/plain": "False" } }],
    });
  } finally {
    await runner.close();
  }
});

test.skipIf(!pythonAvailable)("interrupting a cell retires its lane generation without replay", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("Python kernel registry test requires python3");
  const cancellation = new AbortController();
  try {
    const interrupted = await runner.run({
      scopeId: "lane-interrupt",
      runId: "interrupt-1",
      code: "marker = 1\ncap.read(file_path='README.md')",
      tools: [{ alias: "read", name: "Read" }],
      timeoutMs: 5_000,
      signal: cancellation.signal,
      callCapability: async () => {
        cancellation.abort();
        throw new Error("cancelled by test");
      },
    });
    expect(interrupted).toMatchObject({ status: "cancelled", generation: 1 });
    expect(await runCell(runner, "lane-interrupt", "interrupt-2", '"marker" in globals()')).toMatchObject({
      status: "success",
      generation: 2,
      executionCount: 1,
      displays: [{ data: { "text/plain": "False" } }],
    });
  } finally {
    await runner.close();
  }
});

test.skipIf(!pythonAvailable)("cancelling a queued cell skips it without retiring the active generation", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("Python kernel registry test requires python3");
  const capabilityStarted = Promise.withResolvers<void>();
  const releaseCapability = Promise.withResolvers<string>();
  const cancellation = new AbortController();
  try {
    const active = runner.run({
      scopeId: "lane-queue",
      runId: "queue-1",
      code: "cap.read(file_path='README.md')",
      tools: [{ alias: "read", name: "Read" }],
      timeoutMs: 5_000,
      signal: undefined,
      callCapability: async () => {
        capabilityStarted.resolve();
        return await releaseCapability.promise;
      },
    });
    await capabilityStarted.promise;
    const queued = runCell(
      runner,
      "lane-queue",
      "queue-2",
      "queued_marker = 1",
      cancellation.signal,
    );
    cancellation.abort();
    releaseCapability.resolve("released");

    expect(await active).toMatchObject({ status: "success", generation: 1 });
    expect(await queued).toMatchObject({ status: "cancelled", generation: 1 });
    expect(await runCell(runner, "lane-queue", "queue-3", '"queued_marker" in globals()'))
      .toMatchObject({
        status: "success",
        generation: 1,
        executionCount: 2,
        displays: [{ data: { "text/plain": "False" } }],
      });
  } finally {
    releaseCapability.resolve("released");
    await runner.close();
  }
});
