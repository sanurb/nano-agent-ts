import { z } from "zod";
import type { AgentToolDefinition } from "../agent/assistant-provider.ts";
import { cancelledToolResult, failedToolResult, successfulToolResult, ToolExecutionError } from "../agent/tool-executor.ts";
import type { OperationResult } from "../shared/operation-result.ts";
import { defineTool } from "./agent-tool.ts";
import { walkWorkspaceFiles } from "./workspace-file-walk.ts";
import { pathArgumentSchema, truncateHead } from "./tool-output.ts";

import { maxSearchMatches, maxSearchPatternCharacters, searchDeadlineMs } from "./search-policy.ts";

const defaultMatchLimit = maxSearchMatches;

/** Directories whose contents are derived or version-control internals, never source the model should read. */
const ignoredDirectories = new Set([".git", "node_modules"]);

const globToolArgumentsSchema = z.object({
  pattern: z.string().min(1).max(maxSearchPatternCharacters),
  path: pathArgumentSchema.optional(),
  limit: z.number().int().positive().max(maxSearchMatches).optional(),
});

/** Advertise Glob as name-based discovery, distinct from Grep's content search. */
export const globToolDefinition = {
  name: "Glob",
  description:
    `Find files by glob pattern, returning paths relative to the search directory in alphabetical order. `
    + `Skips ${[...ignoredDirectories].join(" and ")}. Returns at most ${defaultMatchLimit} paths.`,
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Glob pattern such as '*.ts' or 'src/**/*.test.ts'" },
      path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
      limit: { type: "number", description: `Maximum number of paths to return. Defaults to ${defaultMatchLimit}.` },
    },
  },
} satisfies AgentToolDefinition;

/** List matching paths without reading any file; a search that matches nothing still succeeds. */
export const globTool = defineTool({
  definition: globToolDefinition,
  executionMode: "parallel",
  argumentsSchema: globToolArgumentsSchema,
  argumentsExpectation: "JSON with a nonempty pattern, plus optional path and positive limit",
  run: async (args, signal) => {
    const limit = args.limit ?? defaultMatchLimit;
    const deadline = AbortSignal.timeout(searchDeadlineMs);
    const searchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const found = await collectMatches(args.pattern, args.path ?? ".", limit, searchSignal);
    if (deadline.aborted) return failedToolResult(ToolExecutionError.executionFailed("Glob", "search execution budget exceeded"));
    if (signal?.aborted) return cancelledToolResult();
    if (!found.ok) return failedToolResult(found.error);

    const capped = found.value.incomplete || found.value.paths.length > limit;
    const matches = [...found.value.paths].slice(0, limit).sort();
    if (matches.length === 0) return successfulToolResult(capped
      ? "No files matched in the scanned subset. Search incomplete: traversal budget reached. Narrow the search."
      : "No files matched.");
    const truncated = truncateHead(matches.join("\n"));
    if (!capped && truncated.outputLines >= matches.length) return successfulToolResult(truncated.text);
    const total = capped ? `${limit}+` : `${matches.length}`;
    return successfulToolResult(`${truncated.text}\n\n[Showing ${truncated.outputLines} of ${total} matches. `
      + "Search incomplete or output capped. Narrow the pattern or raise limit within the allowed budget.]");
  },
});

/** Stop one past the limit so the caller can tell a full result from a capped one. */
async function collectMatches(
  pattern: string,
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<OperationResult<{ readonly paths: readonly string[]; readonly incomplete: boolean }, ToolExecutionError<"execution_failed">>> {
  const matches: string[] = [];
  let incomplete = false;
  try {
    const filter = new Bun.Glob(pattern);
    for await (const entry of walkWorkspaceFiles(root, signal)) {
      if (signal?.aborted) break;
      if (entry.kind === "unavailable") return { ok: false, error: ToolExecutionError.executionFailed("Glob", "unable to search the requested path") };
      if (entry.kind === "incomplete") { incomplete = true; break; }
      if (!filter.match(entry.path)) continue;
      matches.push(entry.path);
      if (matches.length > limit) break;
    }
  } catch {
    return {
      ok: false,
      error: ToolExecutionError.executionFailed(globToolDefinition.name, "unable to search the requested path"),
    };
  }
  return { ok: true, value: { paths: matches, incomplete } };
}
