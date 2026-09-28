import { PythonKernelProcess } from "./python-cell-process.ts";
import type { PythonKernelCommand } from "./python-kernel-transport.ts";
import type { PythonCellRunner, PythonCellRunnerResult } from "./python-cell-tool.ts";

/** Command factory and isolation statement for lane-bound Python kernels. */
export interface PythonKernelFactory {
  readonly capabilityDescription: string;
  createCommand(scopeId: string, generation: number): PythonKernelCommand;
}

interface PythonKernelEntry {
  readonly generation: number;
  readonly process: PythonKernelProcess;
}

/** Own one serial Python process per agent lane and retire generations on loss or reset. */
export class PythonKernelRegistry implements PythonCellRunner {
  readonly capabilityDescription: string;
  readonly #entries = new Map<string, PythonKernelEntry>();
  readonly #nextGeneration = new Map<string, number>();

  constructor(private readonly factory: PythonKernelFactory) {
    this.capabilityDescription = factory.capabilityDescription;
  }

  /** Run a cell in its lane's current generation, creating one lazily when absent. */
  async run(input: Parameters<PythonCellRunner["run"]>[0]): Promise<PythonCellRunnerResult> {
    const entry = this.#entry(input.scopeId);
    const result = await entry.process.run(input);
    if (entry.process.closed) this.#retireEntry(input.scopeId, entry);
    return { ...result, generation: entry.generation };
  }

  /** Retire one lane and reserve the next generation identity. */
  async reset(scopeId: string): Promise<number> {
    const entry = this.#entries.get(scopeId);
    if (entry) {
      this.#entries.delete(scopeId);
      this.#nextGeneration.set(scopeId, entry.generation + 1);
      await entry.process.reset();
      return entry.generation + 1;
    }
    const next = (this.#nextGeneration.get(scopeId) ?? 1) + 1;
    this.#nextGeneration.set(scopeId, next);
    return next;
  }

  /** Close every lane-owned kernel and release all external process resources. */
  async close(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.process.close()));
  }

  #entry(scopeId: string): PythonKernelEntry {
    const existing = this.#entries.get(scopeId);
    if (existing && !existing.process.closed) return existing;
    if (existing) this.#retireEntry(scopeId, existing);
    const generation = this.#nextGeneration.get(scopeId) ?? 1;
    const entry = {
      generation,
      process: new PythonKernelProcess(this.factory.createCommand(scopeId, generation), generation),
    };
    this.#entries.set(scopeId, entry);
    return entry;
  }

  #retireEntry(scopeId: string, entry: PythonKernelEntry): void {
    if (this.#entries.get(scopeId) === entry) this.#entries.delete(scopeId);
    this.#nextGeneration.set(scopeId, entry.generation + 1);
  }
}
