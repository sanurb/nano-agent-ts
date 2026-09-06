import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const evaluationCli = fileURLToPath(new URL("./main.ts", import.meta.url));

test.each([
  { name: "missing paid-run consent", consent: false, requests: "6", seed: "42", repeats: "1" },
  { name: "too few requests", consent: true, requests: "5", seed: "42", repeats: "1" },
  { name: "too many requests", consent: true, requests: "257", seed: "42", repeats: "1" },
  { name: "fractional requests", consent: true, requests: "6.5", seed: "42", repeats: "1" },
  { name: "out-of-range seed", consent: true, requests: "6", seed: "2147483648", repeats: "1" },
  { name: "too many repetitions", consent: true, requests: "6", seed: "42", repeats: "6" },
])("evaluation CLI rejects $name before provider requests or artifacts", async ({ consent, requests, seed, repeats }) => {
  const root = await mkdtemp(join(tmpdir(), "nano-evaluation-admission-"));
  let providerRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    providerRequests++;
    return new Response("Unexpected provider request", { status: 500 });
  } });
  const child = Bun.spawn([
    process.execPath, "run", evaluationCli, ...(consent ? ["--allow-live"] : []),
    "--model", "test-model", "--max-requests", requests, "--seed", seed, "--repeats", repeats,
    "--output", join(root, "experiment"),
  ], { env: { OPENROUTER_API_KEY: "test-key", OPENROUTER_BASE_URL: server.url.href }, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Live evaluation requires --allow-live");
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
