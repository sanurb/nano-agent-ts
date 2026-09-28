import { expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { createLocalPythonCellRunner } from "./local-python-cell-runner.ts";
import type { PythonCellRunner, PythonCellRunnerResult } from "./python-cell-tool.ts";

const ipythonAvailable = createLocalPythonCellRunner() !== null;
setDefaultTimeout(30_000);

function runCell(
  runner: PythonCellRunner,
  runId: string,
  code: string,
): Promise<PythonCellRunnerResult> {
  return runner.run({
    scopeId: "ipython-features",
    runId,
    code,
    tools: [],
    timeoutMs: 5_000,
    signal: undefined,
    callCapability: async () => {
      throw new Error("No capabilities expected");
    },
  });
}

function plainText(result: PythonCellRunnerResult): string {
  if (result.status !== "success") throw new Error("Expected successful IPython cell");
  const display = result.displays.find((candidate) => candidate.kind === "execute_result");
  return z.string().parse(display?.data["text/plain"]);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) { // no-excuse-ok: catch -- ESRCH is the observable process-tree cleanup result.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test.skipIf(!ipythonAvailable)("IPython evaluates top-level await in the persistent namespace", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("IPython feature test requires uv");
  try {
    const result = await runCell(
      runner,
      "async-1",
      "import asyncio\nawait asyncio.sleep(0)\n6 * 7",
    );
    expect(result).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
    });
    expect(plainText(result)).toBe("42");
  } finally {
    await runner.close();
  }
});

test.skipIf(!ipythonAvailable)("IPython cell magics retain captured objects for later cells", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("IPython feature test requires uv");
  try {
    expect(await runCell(
      runner,
      "magic-1",
      '%%capture captured\nprint("hidden output")',
    )).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 1,
      output: "",
    });
    const result = await runCell(runner, "magic-2", "captured.stdout");
    expect(result).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 2,
    });
    expect(plainText(result)).toBe("'hidden output\\n'");
  } finally {
    await runner.close();
  }
});

test.skipIf(!ipythonAvailable)("IPython rejects interactive stdin and survives exit requests", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("IPython feature test requires uv");
  try {
    expect(await runCell(runner, "stdin-1", 'input("blocked")')).toMatchObject({
      status: "error",
      generation: 1,
      executionCount: 1,
      error: expect.stringContaining("EOFError"),
    });
    expect(await runCell(runner, "exit-2", "exit()")).toMatchObject({
      status: "error",
      generation: 1,
      executionCount: 2,
      error: expect.stringContaining("SystemExit"),
    });
    const result = await runCell(runner, "after-exit-3", "40 + 2");
    expect(result).toMatchObject({
      status: "success",
      generation: 1,
      executionCount: 3,
    });
    expect(plainText(result)).toBe("42");
  } finally {
    await runner.close();
  }
});

test.skipIf(!ipythonAvailable)("reset kills IPython descendant processes before advancing generation", async () => {
  const runner = createLocalPythonCellRunner();
  if (!runner) throw new Error("IPython feature test requires uv");
  let descendantPid: number | undefined;
  try {
    const started = await runCell(runner, "descendant-1", [
      "import subprocess, sys",
      "child = subprocess.Popen(",
      "    [sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)'],",
      "    stdout=subprocess.DEVNULL,",
      "    stderr=subprocess.DEVNULL,",
      ")",
      "child.pid",
    ].join("\n"));
    descendantPid = z.coerce.number().int().positive().parse(plainText(started));
    expect(processExists(descendantPid)).toBeTrue();

    expect(await runner.reset("ipython-features")).toBe(2);
    expect(processExists(descendantPid)).toBeFalse();
  } finally {
    if (descendantPid !== undefined && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await runner.close();
  }
});
