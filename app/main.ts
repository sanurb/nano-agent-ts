import { AgentHarness } from "./agent/agent-harness.ts";
import { AgentToolRuntime } from "./agent/agent-tool-runtime.ts";
import { JournaledToolExecutor } from "./agent/journaled-tool-executor.ts";
import { parseCliConfiguration } from "./cli/cli-configuration.ts";
import { createExecutionConfiguration } from "./cli/execution-configuration.ts";
import { renderTerminalText } from "./cli/terminal-text.ts";
import { OpenRouterProvider } from "./providers/openrouter-provider.ts";
import { SqliteExecutionJournal } from "./session/sqlite-execution-journal.ts";
import { createForkedSkillRunner } from "./skills/forked-skill.ts";
import { discoverSkills, projectSkillsDirectory } from "./skills/skill-catalog.ts";
import { expandSkillInvocations } from "./skills/skill-invocation.ts";
import { createSkillTool, skillCatalogGuidance, SkillToolExecutor, skillToolDefinition } from "./skills/skill-tool.ts";
import { localTools } from "./tools/local-tools.ts";
import { evalToolDefinition, PythonCellToolExecutor } from "./tools/python-cell-tool.ts";
import { interruptedExitCode, processArgumentOffset, terminatedExitCode } from "./shared/process-policy.ts";

const agentModel = "anthropic/claude-haiku-4.5";

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
  const skills = await discoverSkills(projectSkillsDirectory);
  if (!skills.ok) { console.error(skills.error.message); process.exitCode = 1; return; }
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
    const executionToolDefinitions = [...localTools.map((tool) => tool.definition), evalToolDefinition];
    // A fork gets the local tools but not Skill, so a forked skill cannot fork again.
    const runForkedSkill = createForkedSkillRunner(() => harness, { model: agentModel, tools: executionToolDefinitions });
    const skillExecutor = new SkillToolExecutor(execution.value.executor, createSkillTool(skills.value, runForkedSkill));
    let toolRuntime: AgentToolRuntime | undefined;
    const executor = new PythonCellToolExecutor(
      skillExecutor,
      execution.value.pythonCellRunner,
      () => toolRuntime,
    );
    const journaledExecutor = new JournaledToolExecutor(executor, journal.value);
    toolRuntime = new AgentToolRuntime(journaledExecutor);
    const harness = new AgentHarness(provider, {
      model: agentModel,
      tools: skills.value.length > 0
        ? [...executionToolDefinitions, skillToolDefinition]
        : executionToolDefinitions,
      projectGuidance: skillCatalogGuidance(skills.value),
      entryIds: { next: () => Bun.randomUUIDv7() },
    }, journaledExecutor);
    const lane = await harness.lane("main");
    if (!lane.ok) { console.error(lane.error.message); process.exitCode = 1; return; }
    const prompts = expandSkillInvocations(configuration.value.prompt, skills.value);
    const result = await lane.value.run(prompts, { signal: cancellation.signal });
    if (!result.ok) {
      console.error(result.error.message);
      process.exitCode = result.error._tag === "AgentRunCancelled" ? cancellationExitCode : 1;
    } else if (result.value.stopReason !== "tool_termination") console.log(result.value.content === null ? null : renderTerminalText(result.value.content));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    await execution.value.pythonCellRunner.close();
    const closed = journal.value.close();
    if (!closed.ok) { console.error(closed.error.message); process.exitCode = 1; }
  }
}

try { await runAgentCli(); }
catch {
  console.error("Agent runtime defect: execution stopped; inspect the private journal before retrying");
  process.exitCode = 1;
}
