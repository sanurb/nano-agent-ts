import { expect, test } from "bun:test";
import {
  decodePythonCellRunnerFrame,
  encodePythonCellFrame,
  maxPythonCellFrameBytes,
} from "./python-cell-protocol.ts";

test("Python cell protocol encodes host frames and parses strict runner frames", () => {
  expect(encodePythonCellFrame({
    v: 2,
    type: "run",
    run_id: "run-1",
    code: "40 + 2",
    tools: [{ alias: "read", name: "Read" }],
  })).toBe('{"v":2,"type":"run","run_id":"run-1","code":"40 + 2","tools":[{"alias":"read","name":"Read"}]}\n');

  expect(decodePythonCellRunnerFrame(
    '{"v":2,"type":"tool_call","run_id":"run-1","seq":2,"call_id":"py-1","name":"Read","args":{"file_path":"README.md"}}',
  )).toEqual({
    ok: true,
    value: {
      v: 2,
      type: "tool_call",
      run_id: "run-1",
      seq: 2,
      call_id: "py-1",
      name: "Read",
      args: { file_path: "README.md" },
    },
  });
});

test("Python cell protocol parses ready, rich display, and formatted error frames", () => {
  expect(decodePythonCellRunnerFrame(
    '{"v":2,"type":"ready","seq":1,"python_version":"3.11.16","ipython_version":"9.17.1"}',
  )).toMatchObject({ ok: true, value: { type: "ready", seq: 1 } });
  expect(decodePythonCellRunnerFrame(JSON.stringify({
    v: 2,
    type: "display",
    kind: "execute_result",
    run_id: "run-1",
    seq: 2,
    execution_count: 1,
    data: { "text/plain": "42", "text/html": "<strong>42</strong>" },
    metadata: { "text/html": { isolated: true } },
  }))).toMatchObject({
    ok: true,
    value: {
      type: "display",
      kind: "execute_result",
      execution_count: 1,
    },
  });
  expect(decodePythonCellRunnerFrame(
    '{"v":2,"type":"clear_output","run_id":"run-1","seq":3,"wait":true}',
  )).toMatchObject({
    ok: true,
    value: { type: "clear_output", wait: true },
  });
  expect(decodePythonCellRunnerFrame(JSON.stringify({
    v: 2,
    type: "result",
    run_id: "run-1",
    seq: 4,
    status: "error",
    execution_count: 1,
    error: { code: "python_exception", message: "ValueError: broken" },
    traceback: ["ValueError Traceback", "ValueError: broken"],
  }))).toMatchObject({
    ok: true,
    value: {
      type: "result",
      status: "error",
      execution_count: 1,
    },
  });
});

test("Python cell protocol rejects stale, malformed, unknown, and oversized runner frames", () => {
  expect(decodePythonCellRunnerFrame(
    '{"v":1,"type":"ready","seq":1,"python_version":"3.11","ipython_version":"9.17.1"}',
  )).toMatchObject({ ok: false, error: { reason: "invalid" } });
  expect(decodePythonCellRunnerFrame("not-json")).toMatchObject({ ok: false, error: { reason: "malformed" } });
  expect(decodePythonCellRunnerFrame(
    '{"v":2,"type":"stdout","run_id":"run-1","seq":2,"data":"x","extra":true}',
  )).toMatchObject({ ok: false, error: { reason: "invalid" } });
  expect(decodePythonCellRunnerFrame("x".repeat(maxPythonCellFrameBytes + 1)))
    .toMatchObject({ ok: false, error: { reason: "too_large" } });
});
