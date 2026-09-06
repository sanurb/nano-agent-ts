import { AgentHarness } from "./agent/agent-harness.ts";
import { parseCliConfiguration } from "./cli/cli-configuration.ts";
import { OpenRouterProvider } from "./providers/openrouter-provider.ts";
import { bashToolDefinition } from "./tools/bash-tool.ts";
import { LocalToolExecutor } from "./tools/local-tool-executor.ts";
import { readToolDefinition } from "./tools/read-tool.ts";
import { writeToolDefinition } from "./tools/write-tool.ts";

const configuration = parseCliConfiguration(process.argv.slice(2), {
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: process.env.OPENROUTER_BASE_URL,
});

if (!configuration.ok) {
  console.error(configuration.error.message);
  process.exitCode = 1;
} else {
  const provider = new OpenRouterProvider(configuration.value);
  const harness = new AgentHarness(provider, {
    model: "anthropic/claude-haiku-4.5",
    tools: [readToolDefinition, writeToolDefinition, bashToolDefinition],
    entryIds: { next: () => Bun.randomUUIDv7() },
  }, new LocalToolExecutor());
  const main = await harness.lane("main");
  if (!main.ok) {
    console.error(main.error.message);
    process.exitCode = 1;
  } else {
    const response = await main.value.run(configuration.value.prompt);
    if (!response.ok) {
      console.error(response.error.message);
      process.exitCode = 1;
    } else {
      console.log(response.value.content);
    }
  }
}
