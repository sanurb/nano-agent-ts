import { z } from "zod";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { LocalToolExecutor } from "./local-tool-executor.ts";
import { localTools } from "./local-tools.ts";
import { WorkspaceToolExecutor } from "./workspace-tool-executor.ts";

import { maxToolArgumentCharacters, maxToolNameCharacters } from "../agent/tool-executor.ts";
import { sandboxWorkerDeadlineMs } from "./sandbox-runtime-policy.ts";

const requestSchema = z.object({ id: toolCallIdSchema, name: z.string().min(1).max(maxToolNameCharacters), arguments: z.string().max(maxToolArgumentCharacters) });
const input = await Bun.stdin.text(); // Private bounded host-to-container IPC, never an open network endpoint.
const request = requestSchema.parse(JSON.parse(input));
const executor = await WorkspaceToolExecutor.create("/workspace", new LocalToolExecutor(localTools), { write: true, shell: true });
if (!executor.ok) throw executor.error;
const result = await executor.value.executeTool(request, AbortSignal.timeout(sandboxWorkerDeadlineMs));
console.log(JSON.stringify(result));
