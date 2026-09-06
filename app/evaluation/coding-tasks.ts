import fc from "fast-check";

const generatedCasesPerTask = 12;
const medianInputMagnitude = 100;
const maxMedianInputs = 20;
const intervalStartMagnitude = 20;
const maxIntervalWidth = 10;
const maxIntervalsPerCase = 12;
const maxInvoiceItems = 10;
const maxItemQuantity = 10;
const maxUnitCents = 10_000;
const middlePairSize = 2;

// Fixed examples deliberately cover empty/singleton/even/negative/duplicate medians.
// oxlint-disable-next-line no-magic-numbers -- Example inputs are data, not runtime policy or unexplained calculations.
const medianEdgeCases = [[], [1], [8, 2], [3, -2, 3]] as const;
// oxlint-disable-next-line no-magic-numbers -- Nested and touching intervals distinguish a union from a sort.
const intervalEdgeCases = [[], [[1, 4], [2, 3], [4, 7]]] as const;
// oxlint-disable-next-line no-magic-numbers -- Unequal quantities and non-dollar-aligned cents expose both seeded invoice faults.
const invoiceEdgeCases = [[], [[2, 125], [3, 99]]] as const;

/** Numeric fixture values keep the external grading protocol small and unambiguous. */
export type EvaluationValue = number | null | readonly EvaluationValue[];

/** A hidden input and independently computed expected output, never copied into the agent workspace. */
export interface EvaluationCheck {
  readonly input: readonly EvaluationValue[];
  readonly expected: EvaluationValue;
}

/** A starter task is a fixture, not a claim of benchmark coverage or state-of-the-art capability. */
export interface CodingEvaluationTask {
  readonly id: string;
  readonly prompt: string;
  readonly entryPoint: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly allowedChanges: readonly string[];
  readonly checks: readonly EvaluationCheck[];
}

/** Seeded, isolated bug-fix, feature, and multi-file tasks. Reference answers stay in the controller. */
export function codingEvaluationTasks(seed: number): readonly CodingEvaluationTask[] {
  const sampling = { seed, numRuns: generatedCasesPerTask };
  const numbers = [...medianEdgeCases, ...fc.sample(fc.array(
    fc.integer({ min: -medianInputMagnitude, max: medianInputMagnitude }), { maxLength: maxMedianInputs },
  ), sampling)];
  const interval = fc.tuple(
    fc.integer({ min: -intervalStartMagnitude, max: intervalStartMagnitude }),
    fc.integer({ min: 0, max: maxIntervalWidth }),
  ).map(([start, width]) => [start, start + width] as const);
  const ranges = [...intervalEdgeCases, ...fc.sample(fc.array(interval, { maxLength: maxIntervalsPerCase }), sampling)];
  const item = fc.tuple(fc.integer({ min: 0, max: maxItemQuantity }), fc.integer({ min: 0, max: maxUnitCents }));
  const invoices = [...invoiceEdgeCases, ...fc.sample(fc.array(item, { maxLength: maxInvoiceItems }), sampling)];
  return [
    {
      id: "interval-union", entryPoint: "intervals.js", allowedChanges: ["intervals.js"],
      prompt: "Fix default merge(intervals) in intervals.js. Inputs are finite integer [start,end] pairs with start<=end. Return sorted disjoint intervals, merging overlaps AND touching endpoints. Empty input returns []. Do not mutate the input. Preserve unrelated files. Use no dependencies.",
      files: [{ path: "intervals.js", content: "export default function merge(intervals) { return intervals.sort((a,b) => a[0]-b[0]); }\n" }],
      checks: ranges.map((input) => ({ input, expected: referenceIntervalUnion(input) })),
    },
    {
      id: "median-feature", entryPoint: "stats.js", allowedChanges: ["stats.js"],
      prompt: "Implement the default median(numbers) export in stats.js for finite integers, including negatives and duplicates. Return null for empty input; for even length return the arithmetic mean of the middle pair. Do not mutate input. Preserve unrelated files. Use no dependencies.",
      files: [{ path: "stats.js", content: "export default function median(numbers) { return 0; }\n" }],
      checks: numbers.map((input) => ({ input, expected: referenceMedian(input) })),
    },
    {
      id: "invoice-cents", entryPoint: "invoice.js", allowedChanges: ["invoice.js", "pricing.js"],
      prompt: "Fix default invoiceTotal(items) in invoice.js and the lineTotal helper in pricing.js. Each item is [quantity,unitCents], both nonnegative integers. Return total integer CENTS, not dollars. Empty input returns 0. Do not mutate input. Preserve unrelated files. Use no dependencies.",
      files: [
        { path: "pricing.js", content: "export const lineTotal = ([quantity, unitCents]) => unitCents;\n" },
        { path: "invoice.js", content: "import {lineTotal} from './pricing.js'; export default items => items.reduce((sum,item) => sum + lineTotal(item), 0) / 100;\n" },
      ],
      checks: invoices.map((input) => ({ input, expected: input.reduce((sum, [quantity, cents]) => sum + quantity * cents, 0) })),
    },
  ];
}

function referenceMedian(input: readonly number[]): number | null {
  const sorted = [...input].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const lower = sorted[Math.floor((sorted.length - 1) / middlePairSize)];
  const upper = sorted[Math.floor(sorted.length / middlePairSize)];
  if (lower === undefined || upper === undefined) throw new Error("Median reference lost a bounded middle index");
  return (lower + upper) / middlePairSize;
}

function referenceIntervalUnion(input: readonly (readonly [number, number])[]): readonly (readonly number[])[] {
  const output: [number, number][] = [];
  for (const pair of [...input].sort((a, b) => a[0] - b[0])) {
    const [start, end] = pair;
    const previous = output.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else output.push([start, end]);
  }
  return output;
}
