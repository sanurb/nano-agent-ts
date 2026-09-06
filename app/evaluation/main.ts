import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AgentHarness } from "../agent/agent-harness.ts";
import { JournaledToolExecutor } from "../agent/journaled-tool-executor.ts";
import type { ExecutionJournalError } from "../agent/tool-execution-journal.ts";
import type { AssistantProvider } from "../agent/assistant-provider.ts";
import type { AgentToolExecutor } from "../agent/tool-executor.ts";
import { parseCliConfiguration } from "../cli/cli-configuration.ts";
import { OpenRouterProvider } from "../providers/openrouter-provider.ts";
import { SqliteExecutionJournal } from "../session/sqlite-execution-journal.ts";
import { DockerToolExecutor } from "../tools/docker-tool-executor.ts";
import { localTools } from "../tools/local-tools.ts";
import { privateDirectoryMode, privateFileMode } from "../shared/file-permissions.ts";
import { interruptedExitCode } from "../shared/process-policy.ts";
import { codingEvaluationTasks, type CodingEvaluationTask } from "./coding-tasks.ts";
import { fingerprintWorkspace, gradeCodingTask, unexpectedChanges } from "./coding-grader.ts";
import { evaluationJsonIndentSpaces, writeEvaluationArtifact } from "./evaluation-artifact.ts";

const evaluationManifestVersion = 1;
const maxEvaluationModelCharacters = 256;
const maxEvaluationOutputPathCharacters = 4096;
const minimumEvaluationRequests = 6; // One step for each of three tasks under both policies.
const maximumEvaluationRequests = 256;
const defaultEvaluationSeed = 42;
const maximumEvaluationSeed = 2_147_483_647;
const maximumEvaluationRepeats = 5;
const maxTrialToolCalls = 64;
const policies = ["serial", "adjacent"] as const;
type EvaluationPolicy = typeof policies[number];

const optionsSchema = z.object({
  "allow-live": z.literal(true),
  model: z.string().min(1).max(maxEvaluationModelCharacters),
  output: z.string().min(1).max(maxEvaluationOutputPathCharacters),
  "max-requests": z.coerce.number().int().min(minimumEvaluationRequests).max(maximumEvaluationRequests),
  seed: z.coerce.number().int().min(0).max(maximumEvaluationSeed).default(defaultEvaluationSeed),
  repeats: z.coerce.number().int().min(1).max(maximumEvaluationRepeats).default(1),
});

interface PolicyMeasurements {
  trials: number;
  verified: number;
  requests: number;
  agentDurationMs: number;
  costCredits: number | null;
}

interface EvaluationTrial {
  readonly directory: string;
  readonly task: CodingEvaluationTask;
  readonly policy: EvaluationPolicy;
  readonly repetition: number;
  readonly model: string;
  readonly image: string;
  readonly maxAssistantSteps: number;
  readonly signal: AbortSignal;
}

interface TrialMeasurements {
  readonly verified: boolean;
  readonly requests: number;
  readonly agentDurationMs: number;
  readonly costCredits: number | null;
}

function summarizePolicy(policy: EvaluationPolicy, measured: PolicyMeasurements) {
  return {
    policy, trials: measured.trials, verifiedTasks: measured.verified, modelRequests: measured.requests,
    meanAgentDurationMs: measured.trials > 0 ? measured.agentDurationMs / measured.trials : null,
    costCredits: measured.costCredits,
    costCreditsPerVerifiedTask: measured.costCredits !== null && measured.verified > 0 ? measured.costCredits / measured.verified : null,
  };
}

function recordTrialMeasurements(measured: PolicyMeasurements, trial: TrialMeasurements): void {
  measured.trials++;
  measured.verified += trial.verified ? 1 : 0;
  measured.requests += trial.requests;
  measured.agentDurationMs += trial.agentDurationMs;
  measured.costCredits = measured.costCredits === null || trial.costCredits === null ? null : measured.costCredits + trial.costCredits;
}

/** Counters include failed provider requests; missing usage stays unknown instead of becoming zero cost. */
function measureProviderRequests(provider: AssistantProvider) {
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, credits: 0, tokenResponses: 0, costResponses: 0 };
  const measured: AssistantProvider = {
    requestAssistant: async (request, signal) => {
      usage.requests++;
      const result = await provider.requestAssistant(request, signal);
      if (result.ok && result.value.usage) {
        usage.tokenResponses++;
        usage.inputTokens += result.value.usage.inputTokens;
        usage.outputTokens += result.value.usage.outputTokens;
        if (result.value.usage.costCredits !== undefined) {
          usage.costResponses++;
          usage.credits += result.value.usage.costCredits;
        }
      }
      return result;
    },
  };
  return { provider: measured, usage };
}

/** One isolated trial owns its workspace, journal, independent grading, and retained evidence. */
async function runEvaluationTrial(trial: EvaluationTrial, provider: AssistantProvider): Promise<TrialMeasurements> {
  const { task, signal } = trial;
  const workspace = join(trial.directory, "workspace");
  await mkdir(workspace, { recursive: true, mode: privateDirectoryMode });
  await writeFile(join(workspace, "package.json"), '{"type":"module"}\n', { mode: privateFileMode });
  for (const file of task.files) await writeFile(join(workspace, file.path), file.content, { mode: privateFileMode });
  const baseline = await fingerprintWorkspace(workspace);
  const sandbox = await DockerToolExecutor.create(workspace, trial.image);
  if (!sandbox.ok) throw sandbox.error;
  const opened = await SqliteExecutionJournal.open(join(trial.directory, "journal.sqlite"));
  if (!opened.ok) throw opened.error;
  const journal = opened.value;
  let journalCloseFailure: ExecutionJournalError | undefined;
  // Cleanup starts immediately after acquisition, including failed harness/lane construction.
  const perform = async () => {
    const execution: AgentToolExecutor = {
      executionModeFor: (name) => trial.policy === "serial" ? "sequential" : sandbox.value.executionModeFor(name),
      executeTool: (call, abort, context) => sandbox.value.executeTool(call, abort, context),
    };
    const measured = measureProviderRequests(provider);
    const { usage } = measured;
    const harness = new AgentHarness(measured.provider, {
      model: trial.model, tools: localTools.map((tool) => tool.definition), entryIds: { next: () => Bun.randomUUIDv7() },
    }, new JournaledToolExecutor(execution, journal));
    const lane = await harness.lane("evaluation");
    if (!lane.ok) throw lane.error;
    try {
      const started = performance.now();
      const result = await lane.value.run(task.prompt, { maxAssistantSteps: trial.maxAssistantSteps, maxToolCalls: maxTrialToolCalls, signal });
      const agentDurationMs = performance.now() - started;
      const pending = journal.unresolved();
      const grade = pending.ok && pending.value.length === 0 && !signal.aborted
        ? await gradeCodingTask(new JournaledToolExecutor(sandbox.value, journal), task, signal)
        : { available: false, verified: false, passedChecks: 0, totalChecks: task.checks.length };
      const unexpected = unexpectedChanges(baseline, await fingerprintWorkspace(workspace), task.allowedChanges);
      const verified = grade.verified && unexpected.length === 0;
      const costCredits = usage.costResponses === usage.requests ? usage.credits : null;
      await writeEvaluationArtifact(join(trial.directory, "result.json"), JSON.stringify({
        task: task.id, policy: trial.policy, repetition: trial.repetition, verified, grade, unexpectedChanges: unexpected,
        runStatus: result.ok ? result.value.stopReason : result.error._tag, agentDurationMs, modelRequests: usage.requests,
        inputTokens: usage.tokenResponses === usage.requests ? usage.inputTokens : null,
        outputTokens: usage.tokenResponses === usage.requests ? usage.outputTokens : null, costCredits,
      }, null, evaluationJsonIndentSpaces));
      return { verified, requests: usage.requests, agentDurationMs, costCredits };
    } finally {
      const snapshot = await lane.value.getSnapshot();
      await writeEvaluationArtifact(join(trial.directory, "trace.json"), JSON.stringify({
        name: snapshot.name, tipId: snapshot.tipId, status: snapshot.status,
        configuration: snapshot.configuration, transcript: snapshot.transcript,
      }, null, evaluationJsonIndentSpaces));
    }
  };
  const result = await perform().finally(() => {
    const closed = journal.close();
    if (!closed.ok) journalCloseFailure = closed.error;
  });
  if (journalCloseFailure) throw journalCloseFailure;
  return result;
}

async function runEvaluation(signal: AbortSignal): Promise<void> {
  const args = parseArgs({
    options: {
      "allow-live": { type: "boolean" }, model: { type: "string" }, output: { type: "string" },
      "max-requests": { type: "string" }, seed: { type: "string" }, repeats: { type: "string" },
    }, strict: true,
  });
  const options = optionsSchema.safeParse(args.values);
  if (!options.success) {
    console.error("Live evaluation requires --allow-live --model <id> --max-requests <6..256> --output <new-directory> [--seed 42] [--repeats 1]. Use a credit-limited API key; a request cap is not a currency cap.");
    process.exitCode = 1;
    return;
  }
  const connection = parseCliConfiguration(["-p", "evaluation"], { apiKey: process.env.OPENROUTER_API_KEY, baseURL: process.env.OPENROUTER_BASE_URL });
  if (!connection.ok) { console.error(connection.error.message); process.exitCode = 1; return; }
  const image = process.env.NANO_AGENT_SANDBOX_IMAGE ?? "";
  const tasks = codingEvaluationTasks(options.data.seed);
  const plannedTrials = tasks.length * policies.length * options.data.repeats;
  const stepsPerTrial = Math.floor(options.data["max-requests"] / plannedTrials);
  if (stepsPerTrial < 1) throw new Error("Evaluation request budget cannot cover every planned trial equally");
  const output = resolve(options.data.output);
  await mkdir(output, { mode: privateDirectoryMode }); // Exclusive: never mix experiments with prior evidence.
  const source = await fingerprintWorkspace(fileURLToPath(new URL("../", import.meta.url)));
  const appSourceSha256 = createHash("sha256").update(JSON.stringify([...source.entries()])).digest("hex");
  const manifest = {
    schemaVersion: evaluationManifestVersion, model: options.data.model, image, bunVersion: Bun.version, appSourceSha256,
    seed: options.data.seed, repeats: options.data.repeats, plannedTrials, stepsPerTrial, maxRequests: options.data["max-requests"],
    costUnit: "openrouter_credits", suite: "three starter fixtures; not a SOTA benchmark", startedAt: new Date().toISOString(),
  };
  await writeEvaluationArtifact(join(output, "manifest.json"), JSON.stringify(manifest, null, evaluationJsonIndentSpaces));
  const provider = new OpenRouterProvider(connection.value);
  const byPolicy: Record<EvaluationPolicy, PolicyMeasurements> = {
    serial: { trials: 0, verified: 0, requests: 0, agentDurationMs: 0, costCredits: 0 },
    adjacent: { trials: 0, verified: 0, requests: 0, agentDurationMs: 0, costCredits: 0 },
  };
  const totals: PolicyMeasurements = { trials: 0, verified: 0, requests: 0, agentDurationMs: 0, costCredits: 0 };
  for (let repetition = 0; repetition < options.data.repeats; repetition++) {
    for (const [index, task] of tasks.entries()) {
      const orderedPolicies = (index + repetition) % policies.length === 0 ? policies : [...policies].reverse();
      for (const policy of orderedPolicies) {
        if (signal.aborted) break;
        const trial = await runEvaluationTrial({
          directory: join(output, `${task.id}-${policy}-${repetition}`), task, policy, repetition,
          model: options.data.model, image, maxAssistantSteps: stepsPerTrial, signal,
        }, provider);
        recordTrialMeasurements(byPolicy[policy], trial);
        recordTrialMeasurements(totals, trial);
        await writeEvaluationArtifact(join(output, "summary.json"), JSON.stringify({
          ...manifest, completedTrials: totals.trials, verifiedTasks: totals.verified, attemptedRequests: totals.requests,
          totalCostCredits: totals.costCredits,
          costCreditsPerVerifiedTask: totals.costCredits !== null && totals.verified > 0 ? totals.costCredits / totals.verified : null,
          complete: totals.trials === plannedTrials,
          policySummaries: policies.map((policy) => summarizePolicy(policy, byPolicy[policy])),
        }, null, evaluationJsonIndentSpaces));
      }
    }
  }
  if (signal.aborted) process.exitCode = interruptedExitCode;
}

const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try { await runEvaluation(cancellation.signal); }
catch { console.error("Evaluation stopped; retained private artifacts may require reconciliation. No SOTA result is claimed."); process.exitCode = 1; }
finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
