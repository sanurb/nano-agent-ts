import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const evaluationCli = fileURLToPath(new URL("./main.ts", import.meta.url));

test.each([
  { name: "missing paid-run consent", consent: false, requests: "6", seed: "42", repeats: "1", suite: "coding" },
  { name: "too few requests", consent: true, requests: "5", seed: "42", repeats: "1", suite: "coding" },
  { name: "too many requests", consent: true, requests: "257", seed: "42", repeats: "1", suite: "coding" },
  { name: "fractional requests", consent: true, requests: "6.5", seed: "42", repeats: "1", suite: "coding" },
  { name: "out-of-range seed", consent: true, requests: "6", seed: "2147483648", repeats: "1", suite: "coding" },
  { name: "too many repetitions", consent: true, requests: "6", seed: "42", repeats: "6", suite: "coding" },
  { name: "instruction trials without consent", consent: false, requests: "120", seed: "42", repeats: "1", suite: "instructions" },
  { name: "instruction trials without a complete paired budget", consent: true, requests: "11", seed: "42", repeats: "1", suite: "instructions" },
  { name: "unknown suite", consent: true, requests: "120", seed: "42", repeats: "1", suite: "unknown" },
])("evaluation CLI rejects $name before provider requests or artifacts", async ({ consent, requests, seed, repeats, suite }) => {
  const root = await mkdtemp(join(tmpdir(), "nano-evaluation-admission-"));
  let providerRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    providerRequests++;
    return new Response("Unexpected provider request", { status: 500 });
  } });
  const child = Bun.spawn([
    process.execPath, "run", evaluationCli, ...(consent ? ["--allow-live"] : []),
    "--model", "test-model", "--max-requests", requests, "--seed", seed, "--repeats", repeats,
    "--output", join(root, "experiment"), "--suite", suite,
  ], { env: { OPENROUTER_API_KEY: "test-key", OPENROUTER_BASE_URL: server.url.href }, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Live evaluation requires");
    expect(providerRequests).toBe(0);
    expect(await readdir(root)).toEqual([]);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

const sandboxImage = process.env.NANO_AGENT_TEST_SANDBOX_IMAGE;

test.skipIf(sandboxImage === undefined)("instruction evaluation CLI retains private policy identities and inconclusive probes with a real sandbox and local HTTP fixture", async () => {
  if (!sandboxImage) throw new Error("Instruction evaluation integration requires an explicit sandbox image");
  const root = await mkdtemp(join(tmpdir(), "nano-instruction-evaluation-"));
  const output = join(root, "experiment");
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    bodies.push(await request.text());
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Fixture response: no work or checks performed." } }] });
  } });
  const child = Bun.spawn([process.execPath, "run", evaluationCli, "--allow-live", "--suite", "instructions", "--model", "fixture",
    "--max-requests", "12", "--seed", "42", "--output", output], {
    env: { OPENROUTER_API_KEY: "private-evaluation-fixture-key", OPENROUTER_BASE_URL: server.url.href, NANO_AGENT_SANDBOX_IMAGE: sandboxImage },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 170_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(bodies).toHaveLength(12);
    const wireSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string().nullable() })) });
    for (const body of bodies) {
      const wire = wireSchema.parse(JSON.parse(body));
      expect(wire.messages.filter((message) => message.role === "system")).toHaveLength(1);
      expect(wire.messages[0]?.content).toContain("workspace is mounted read-only");
      expect(wire.messages[0]?.content).toContain("ephemeral /tmp");
    }
    const resultSchema = z.object({
      instructionMetadata: z.object({ promptVersion: z.string(), contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
      instructionGrade: z.object({ observedInjectionResistance: z.null(), manualReviewRequired: z.literal(true) }),
    });
    const versions = new Set<string>();
    const trials = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    expect(trials).toHaveLength(12);
    for (const trial of trials) {
      const resultPath = join(output, trial.name, "result.json");
      const result = resultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
      versions.add(result.instructionMetadata.promptVersion);
      expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
      const trace = await readFile(join(output, trial.name, "trace.json"), "utf8");
      expect(trace).not.toContain("Act as a careful coding agent");
      expect(trace).not.toContain("private-evaluation-fixture-key");
    }
    expect([...versions].sort()).toEqual(["coding-agent-v1", "minimal-control-v1"]);
    // This checks evaluation plumbing, not model effectiveness: the local fixture deliberately does no work.
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
