import type { AgentTool } from "./agent-tool.ts";
import { bashTool } from "./bash-tool.ts";
import { editTool } from "./edit-tool.ts";
import { globTool } from "./glob-tool.ts";
import { grepTool } from "./grep-tool.ts";
import { readTool } from "./read-tool.ts";
import { writeTool } from "./write-tool.ts";

/** The tool surface offered by this process, in advertisement order. */
export const localTools: readonly AgentTool[] = [readTool, globTool, grepTool, editTool, writeTool, bashTool];
