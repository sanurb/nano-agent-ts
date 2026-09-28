import { expect, setDefaultTimeout, test } from "bun:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runPythonCellProcess, type PythonCellProcessCommand } from "./python-cell-one-shot.ts";

const uv = Bun.which("uv");
const runnerPath = fileURLToPath(new URL("./python-cell-runner.py", import.meta.url));
const requirementsPath = fileURLToPath(new URL("./ipython-requirements.txt", import.meta.url));
setDefaultTimeout(30_000);

function pythonCommand(): PythonCellProcessCommand {
  if (!uv) throw new Error("IPython cell process test requires uv");
  return {
    executable: uv,
    arguments: [
      "run", "--quiet", "--no-progress", "--isolated", "--no-project",
      "--with-requirements", requirementsPath,
      "--python", "3.11",
      "--no-config",
      "python", "-I", "-u", runnerPath,
    ],
    cwd: tmpdir(),
    env: {
      PATH: `${dirname(uv)}:/usr/bin:/bin`,
      HOME: tmpdir(),
      LANG: "C.UTF-8",
      UV_CACHE_DIR: join(tmpdir(), "nano-agent-ipython-test-cache"),
    },
  };
}

test.skipIf(uv === null)("IPython cell process returns output, a rich result, and host capability data", async () => {
  const calls: unknown[] = [];
  const result = await runPythonCellProcess({
    command: pythonCommand(),
    runId: "process-test",
    code: 'print("hello")\ncap.read(file_path="README.md").upper()',
    tools: [{ alias: "read", name: "Read" }],
    timeoutMs: 5_000,
    signal: undefined,
    callCapability: async (call) => {
      calls.push(call);
      return "nested";
    },
  });

  expect(result).toEqual({
    status: "success",
    output: "hello\n",
    displays: [{
      kind: "execute_result",
      executionCount: 1,
      data: { "text/plain": "'NESTED'" },
      metadata: {},
    }],
    executionCount: 1,
  });
  expect(calls).toEqual([{
    callId: expect.stringMatching(/^py-[0-9a-f]{32}$/),
    name: "Read",
    arguments: { file_path: "README.md" },
  }]);
});

test.skipIf(uv === null)("IPython cell process retains rich display and update MIME bundles", async () => {
  const result = await runPythonCellProcess({
    command: pythonCommand(),
    runId: "display-test",
    code: [
      "from IPython.display import HTML, clear_output, display",
      "handle = display(HTML('<b>first</b>'), display_id='card')",
      "clear_output(wait=True)",
      "handle.update(HTML('<b>second</b>'))",
      "HTML('<i>final</i>')",
    ].join("\n"),
    tools: [],
    timeoutMs: 5_000,
    signal: undefined,
    callCapability: async () => {
      throw new Error("No capabilities expected");
    },
  });

  expect(result).toMatchObject({
    status: "success",
    executionCount: 1,
    displays: [{
      kind: "display_data",
      displayId: "card",
      data: { "text/html": "<b>first</b>" },
    }, {
      kind: "clear_output",
      wait: true,
    }, {
      kind: "update_display_data",
      displayId: "card",
      data: { "text/html": "<b>second</b>" },
    }, {
      kind: "execute_result",
      executionCount: 1,
      data: { "text/html": "<i>final</i>" },
    }],
  });
});

test.skipIf(uv === null)("IPython disposable processes start fresh and return formatted exceptions", async () => {
  const run = (runId: string, code: string) => runPythonCellProcess({
    command: pythonCommand(),
    runId,
    code,
    tools: [],
    timeoutMs: 5_000,
    signal: undefined,
    callCapability: async () => {
      throw new Error("No capabilities expected");
    },
  });

  expect(await run("state-write", "state = 42")).toMatchObject({ status: "success" });
  expect(await run("state-read", '"state" in globals()')).toMatchObject({
    status: "success",
    executionCount: 1,
    displays: [{ data: { "text/plain": "False" } }],
  });
  const exception = await run("exception", 'raise RuntimeError("broken")');
  expect(exception).toMatchObject({
    status: "error",
    executionCount: 1,
    error: "RuntimeError: broken",
  });
  if (exception.status !== "error") throw new Error("Expected formatted IPython exception");
  expect(exception.traceback.join("\n")).toContain("Traceback");
  expect(exception.traceback.join("\n")).toContain('raise RuntimeError("broken")');
});

test.skipIf(uv === null)("IPython cell process enforces its wall-clock limit", async () => {
  const result = await runPythonCellProcess({
    command: pythonCommand(),
    runId: "timeout-test",
    code: "while True:\n    pass",
    tools: [],
    timeoutMs: 50,
    signal: undefined,
    callCapability: async () => {
      throw new Error("No capabilities expected");
    },
  });
  expect(result).toMatchObject({ status: "limit" });
});

test.skipIf(uv === null)("IPython cell cancellation interrupts an outstanding capability call", async () => {
  const cancellation = new AbortController();
  const result = await runPythonCellProcess({
    command: pythonCommand(),
    runId: "cancel-test",
    code: "cap.read(file_path='README.md')",
    tools: [{ alias: "read", name: "Read" }],
    timeoutMs: 5_000,
    signal: cancellation.signal,
    callCapability: async () => {
      cancellation.abort();
      throw new Error("cancelled by test");
    },
  });
  expect(result).toMatchObject({ status: "cancelled" });
});
