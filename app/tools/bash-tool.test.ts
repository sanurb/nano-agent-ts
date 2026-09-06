import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash-tool.ts";

function run(command: string) {
  return bashTool.execute(JSON.stringify({ command }));
}

test("Bash never inherits arbitrary parent credentials", async () => {
  const script = `const {bashTool}=await import(${JSON.stringify(new URL("./bash-tool.ts", import.meta.url).href)}); console.log(JSON.stringify(await bashTool.execute('{"command":"env"}')));`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: { OPENROUTER_API_KEY: "test-secret-must-not-escape", CUSTOM_CREDENTIAL: "another-test-secret" } });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  expect(output).not.toContain("OPENROUTER_API_KEY");
  expect(output).not.toContain("CUSTOM_CREDENTIAL");
  expect(output).not.toContain("test-secret");
});

test("Bash returns the stdout of a successful command", async () => {
  const result = await run("echo out");
  expect(result).toEqual({ ok: true, value: { status: "success", content: "out\n" } });
});

test("Bash captures stderr so the model sees why a command failed", async () => {
  const result = await run("echo denied 1>&2; exit 1");
  expect(result).toEqual({ ok: true, value: { status: "error", content: "denied\n\nCommand exited with code 1" } });
});

test("Bash reports a nonzero exit as a tool result instead of a run failure", async () => {
  const result = await run("echo before; exit 3");
  expect(result).toEqual({ ok: true, value: { status: "error", content: "before\n\nCommand exited with code 3" } });
});

test("Bash marks silent success so an empty result stays distinguishable", async () => {
  const result = await run("true");
  expect(result).toEqual({ ok: true, value: { status: "success", content: "(no output)" } });
});

test("Bash applies filesystem effects such as deleting a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-bash-effect-"));
  const filePath = join(directory, "README_old.md");
  try {
    await writeFile(filePath, "old", "utf8");
    const result = await run(`rm ${JSON.stringify(filePath)}`);
    expect(result.ok).toBe(true);
    expect(await Bun.file(filePath).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bash rejects malformed arguments before running anything", async () => {
  for (const argumentsText of ["not json", JSON.stringify({}), JSON.stringify({ command: "" }), JSON.stringify({ command: 7 })]) {
    const result = await bashTool.execute(argumentsText);
    expect(result).toEqual({
      ok: true,
      value: { status: "error", content: "Invalid Bash arguments: expected JSON with a nonempty command without NUL characters" },
    });
  }
});

test("Bash caps a flood of output and says the result is incomplete", async () => {
  const result = await run("seq 1 5000");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const [body, notice] = result.value.content.split("\n\n");
  expect(body?.split("\n")).toHaveLength(2000);
  expect(body?.split("\n").at(-1)).toBe("2000");
  expect(notice).toBe("[Output truncated at 2000 lines of 5001 lines. Narrow the command to see the rest.]");
});
