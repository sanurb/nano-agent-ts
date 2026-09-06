import { AgentHarness } from "./agent/agent-harness.ts";
import { JournaledToolExecutor } from "./agent/journaled-tool-executor.ts";
import { parseCliConfiguration } from "./cli/cli-configuration.ts";
import { createExecutionConfiguration } from "./cli/execution-configuration.ts";
import { renderTerminalText } from "./cli/terminal-text.ts";
import { OpenRouterProvider } from "./providers/openrouter-provider.ts";
import { SqliteExecutionJournal } from "./session/sqlite-execution-journal.ts";
import { localTools } from "./tools/local-tools.ts";
import { interruptedExitCode, processArgumentOffset, terminatedExitCode } from "./shared/process-policy.ts";

async function runAgentCli(): Promise<void> {
  const configuration = parseCliConfiguration(process.argv.slice(processArgumentOffset), {
    apiKey: process.env.OPENROUTER_API_KEY, baseURL: process.env.OPENROUTER_BASE_URL,
  });
  if (!configuration.ok) { console.error(configuration.error.message); process.exitCode = 1; return; }
  const execution = await createExecutionConfiguration(process.cwd(), {
    mode: process.env.NANO_AGENT_EXECUTION,
    image: process.env.NANO_AGENT_SANDBOX_IMAGE,
    journalPath: process.env.NANO_AGENT_JOURNAL_PATH,
  });
  if (!execution.ok) { console.error(execution.error.message); process.exitCode = 1; return; }
  const journal = await SqliteExecutionJournal.open(execution.value.journalPath);
  if (!journal.ok) { console.error(journal.error.message); process.exitCode = 1; return; }
  const cancellation = new AbortController();
  let cancellationExitCode = interruptedExitCode;
  const interrupt = () => { cancellation.abort(); };
  const terminate = () => { cancellationExitCode = terminatedExitCode; cancellation.abort(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const unresolved = journal.value.unresolved();
    if (!unresolved.ok || unresolved.value.length > 0) {
      console.error("Tool recovery required: inspect and reconcile the execution journal before starting a new run");
      process.exitCode = 1;
      return;
    }
    const provider = new OpenRouterProvider(configuration.value);
    const harness = new AgentHarness(provider, {
      model: "anthropic/claude-haiku-4.5", tools: localTools.map((tool) => tool.definition),
      entryIds: { next: () => Bun.randomUUIDv7() },
    }, new JournaledToolExecutor(execution.value.executor, journal.value));
    const lane = await harness.lane("main");
    if (!lane.ok) { console.error(lane.error.message); process.exitCode = 1; return; }
    const result = await lane.value.run(configuration.value.prompt, { signal: cancellation.signal });
    if (!result.ok) {
      console.error(result.error.message);
      process.exitCode = result.error._tag === "AgentRunCancelled" ? cancellationExitCode : 1;
    } else if (result.value.stopReason !== "tool_termination") console.log(result.value.content === null ? null : renderTerminalText(result.value.content));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    const closed = journal.value.close();
    if (!closed.ok) { console.error(closed.error.message); process.exitCode = 1; }
  }
}

try { await runAgentCli(); }
catch {
  console.error("Agent runtime defect: execution stopped; inspect the private journal before retrying");
  process.exitCode = 1;
}
