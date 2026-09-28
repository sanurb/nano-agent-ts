import {
  PythonKernelProcess,
  type PythonCellProcessOptions,
} from "./python-cell-process.ts";
import type { PythonCellProcessResult } from "./python-cell-output.ts";
import type { PythonKernelCommand } from "./python-kernel-transport.ts";

export type { PythonKernelCommand as PythonCellProcessCommand } from "./python-kernel-transport.ts";

/** Run one disposable IPython cell for isolated process tests and adapters. */
export async function runPythonCellProcess(
  options: PythonCellProcessOptions & { readonly command: PythonKernelCommand },
): Promise<PythonCellProcessResult> {
  const kernel = new PythonKernelProcess(options.command, 1);
  try {
    return await kernel.run(options);
  } finally {
    await kernel.close();
  }
}
