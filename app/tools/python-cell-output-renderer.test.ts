import { expect, test } from "bun:test";
import { maxToolOutcomeCharacters } from "../agent/tool-executor.ts";
import {
  clampPythonCellErrorCause,
  renderPythonCellOutput,
} from "./python-cell-output-renderer.ts";
import type { PythonCellProcessResult } from "./python-cell-output.ts";

test("IPython renderer keeps simple final expressions concise", () => {
  const result: PythonCellProcessResult = {
    status: "success",
    output: "",
    displays: [{
      kind: "execute_result",
      executionCount: 3,
      data: { "text/plain": "42" },
      metadata: {},
    }],
    executionCount: 3,
  };

  expect(renderPythonCellOutput(result)).toBe("42");
});

test("IPython renderer exposes rich text and summarizes binary MIME payloads", () => {
  const result: PythonCellProcessResult = {
    status: "success",
    output: "before\n",
    displays: [{
      kind: "display_data",
      displayId: "display-1",
      data: {
        "text/plain": "<rich object>",
        "text/markdown": "**rich**",
        "text/html": "<strong>rich</strong>",
        "image/png": "base64-payload",
      },
      metadata: { "text/html": { isolated: true } },
    }, {
      kind: "clear_output",
      wait: true,
    }, {
      kind: "update_display_data",
      displayId: "display-1",
      data: { "text/plain": "'updated'" },
      metadata: {},
    }],
    executionCount: 1,
  };

  expect(renderPythonCellOutput(result)).toBe(
    "before\n\n"
      + "[IPython display_data id=display-1]\n"
      + "text/markdown:\n**rich**\n"
      + "text/plain:\n<rich object>\n"
      + "text/html:\n<strong>rich</strong>\n"
      + "image/png:\n[image/png base64 payload: 14 characters]\n"
      + "[IPython clear_output wait=true]\n"
      + "[IPython update_display_data id=display-1]\n'updated'",
  );
});

test("IPython renderer includes formatted tracebacks and clamps journal content", () => {
  const result: PythonCellProcessResult = {
    status: "error",
    output: "",
    displays: [],
    executionCount: 2,
    error: "ValueError: broken",
    traceback: ["ValueError Traceback", "ValueError: broken"],
  };

  expect(renderPythonCellOutput(result)).toBe(
    "ValueError Traceback\nValueError: broken",
  );
  expect(clampPythonCellErrorCause("x".repeat(maxToolOutcomeCharacters))).toHaveLength(
    maxToolOutcomeCharacters - 256,
  );
});
