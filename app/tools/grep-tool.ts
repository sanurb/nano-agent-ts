import { join } from "node:path";
import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError } from "../agent/tool-executor.ts";
import { defineTool } from "./agent-tool.ts";
import { formatSize, maxMatchLineLength, pathArgumentSchema, truncateHead } from "./tool-output.ts";
import { readBoundedFile } from "./bounded-file-read.ts";
import { GrepMatcher } from "./grep-matcher.ts";
import { walkWorkspaceFiles } from "./workspace-file-walk.ts";

import type { OperationResult } from "../shared/operation-result.ts";
import { maxGrepFileBytes, maxSearchMatches, maxSearchPatternCharacters, searchDeadlineMs } from "./search-policy.ts";

const defaultMatchLimit = 100;
/** Bound the walk so a search in a large tree cannot run unbounded before reporting anything. */
const maxFilesScanned = 5000;
/** A decoded file containing this never round-tripped as text, so treat it as binary. */
const replacementCharacter = "\uFFFD";

/** Directories whose contents are derived or version-control internals, never source the model should read. */
const ignoredDirectories = new Set([".git", "node_modules"]);

const grepToolArgumentsSchema = z.object({
  pattern: z.string().min(1).max(maxSearchPatternCharacters),
  path: pathArgumentSchema.optional(),
  glob: z.string().min(1).max(maxSearchPatternCharacters).optional(),
  ignore_case: z.boolean().optional(),
  literal: z.boolean().optional(),
  limit: z.number().int().positive().max(maxSearchMatches).optional(),
});

/** Advertise Grep as content search returning located lines, distinct from Glob's name search. */
export const grepToolDefinition = {
  name: "Grep",
  description:
    `Search file contents, returning matches as path:line:text. Skips ${[...ignoredDirectories].join(" and ")}, `
    + `binary files, and files over ${formatSize(maxGrepFileBytes)}. Returns at most ${defaultMatchLimit} matches and `
    + `truncates lines longer than ${maxMatchLineLength} characters.`,
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Regular expression, or literal text when literal is true" },
      path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
      glob: { type: "string", description: "Restrict the search to files matching this glob, such as '**/*.ts'" },
      ignore_case: { type: "boolean", description: "Match case-insensitively. Defaults to false." },
      literal: { type: "boolean", description: "Treat pattern as literal text rather than a regex. Defaults to false." },
      limit: { type: "number", description: `Maximum number of matches. Defaults to ${defaultMatchLimit}.` },
    },
  },
} satisfies AgentToolDefinition;

/** Search matching files line by line; a search that matches nothing still succeeds. */
export const grepTool = defineTool({
  definition: grepToolDefinition,
  executionMode: "parallel",
  argumentsSchema: grepToolArgumentsSchema,
  argumentsExpectation:
    "JSON with a nonempty pattern, plus optional path, glob, ignore_case, literal, and positive limit",
  run: async (args, signal) => {
    const source = args.literal ? escapeRegExp(args.pattern) : args.pattern;
    const deadline = AbortSignal.timeout(searchDeadlineMs);
    const searchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const matcher = new GrepMatcher(source, args.ignore_case ?? false);
    const interrupted = () => signal?.aborted ? cancelledToolResult() : failedToolResult(failure("search execution budget exceeded"));
    try {
      const compilation = await matcher.match("", 1, searchSignal);
      if (!compilation.ok) return searchSignal.aborted ? interrupted()
        : failedToolResult(failure("pattern is not a valid regular expression"));
      const found = await collectGrepMatches(args, matcher, searchSignal);
      if (searchSignal.aborted) return interrupted();
      if (!found.ok) return failedToolResult(found.error);
      const { matches, incomplete, limit } = found.value;
      const truncated = truncateHead(matches.join("\n"));
      if (matches.length === 0) return successfulToolResult(incomplete
        ? "No matches found in the scanned subset. Search incomplete: input or traversal budget reached, or files unreadable. Narrow the search."
        : "No matches found.");
      if (!incomplete && truncated.boundBy === null) return successfulToolResult(truncated.text);
      return successfulToolResult(`${truncated.text}\n\n[Showing ${truncated.outputLines} matches, capped at ${limit}. `
        + "Search incomplete or output capped. Narrow the pattern or glob, or raise limit within the allowed budget.]");
    } finally {
      await matcher.close();
    }
  },
});

interface GrepMatches {
  readonly matches: readonly string[];
  readonly incomplete: boolean;
  readonly limit: number;
}

/** Collect bounded matches; worker ownership and interruption classification remain with the caller. */
async function collectGrepMatches(args: z.infer<typeof grepToolArgumentsSchema>, matcher: GrepMatcher, signal: AbortSignal): Promise<OperationResult<GrepMatches, ToolExecutionError<"execution_failed">>> {
  const root = args.path ?? ".";
  const limit = args.limit ?? defaultMatchLimit;
  const filter = new Bun.Glob(args.glob ?? "**/*");
  const matches: string[] = [];
  let filesScanned = 0;
  let incomplete = false;
  for await (const entry of walkWorkspaceFiles(root, signal)) {
    if (signal.aborted) break;
    if (entry.kind === "unavailable") return { ok: false, error: failure("unable to search the requested path") };
    if (entry.kind === "incomplete") { incomplete = true; break; }
    if (!filter.match(entry.path)) continue;
    if (filesScanned++ >= maxFilesScanned) { incomplete = true; break; }
    const bytes = await readBoundedFile(join(root, entry.path), maxGrepFileBytes, signal);
    if (!bytes.ok) { incomplete = true; continue; }
    const text = new TextDecoder().decode(bytes.value);
    if (text.includes(replacementCharacter) || text.includes("\u0000")) continue;
    const result = await matcher.match(text, limit - matches.length, signal);
    if (!result.ok) return { ok: false, error: failure("pattern exceeded matching budget or worker failed") };
    for (const match of result.value) matches.push(`${entry.path}:${match.line}:${match.text}`);
    if (matches.length >= limit) { incomplete = true; break; }
  }
  return { ok: true, value: { matches, incomplete, limit } };
}

/** Escape every character the regex engine would otherwise treat as syntax. */
function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failure(cause: string): ToolExecutionError<"execution_failed"> {
  return ToolExecutionError.executionFailed(grepToolDefinition.name, cause);
}
