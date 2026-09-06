import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { maxGrepFileBytes, maxSearchMatches } from "./search-policy.ts";
import { truncateLine } from "./tool-output.ts";

// Escaping a literal search pattern may double the source pattern's length.
const maxWorkerPatternCharacters = 8192;
const configuration = z.object({ pattern: z.string().max(maxWorkerPatternCharacters), ignoreCase: z.boolean() }).parse(workerData);
const requestSchema = z.object({ content: z.string().max(maxGrepFileBytes), limit: z.number().int().positive().max(maxSearchMatches) });
const port = parentPort;
if (!port) throw new Error("Grep matcher worker requires a parent port");
let matcher: RegExp | null = null;
try { matcher = new RegExp(configuration.pattern, configuration.ignoreCase ? "i" : ""); } catch { /* Report syntax, never echo the pattern. */ }
port.on("message", (input) => {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || !matcher) { port.postMessage({ ok: false }); return; }
  const matches: { line: number; text: string }[] = [];
  for (const [index, line] of parsed.data.content.split("\n").entries()) {
    if (matcher.test(line)) matches.push({ line: index + 1, text: truncateLine(line) });
    if (matches.length >= parsed.data.limit) break;
  }
  port.postMessage({ ok: true, matches });
});
