import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCallIdSchema } from "../agent/agent-message.ts";
import { executeBashTool } from "./bash-tool.ts";

function bashCall(command: string) {
  return { id: toolCallIdSchema.parse("bash-call"), name: "Bash", arguments: JSON.stringify({ command }) };
}

test("Bash returns the stdout of a successful command", async () => {
  const result = await executeBashTool(bashCall("echo out"));
  expect(result).toEqual({ ok: true, value: "out\n" });
});

test("Bash captures stderr so the model sees why a command failed", async () => {
  const result = await executeBashTool(bashCall("echo denied 1>&2; exit 1"));
  expect(result).toEqual({ ok: true, value: "denied\n\nCommand exited with code 1" });
});

test("Bash reports a nonzero exit as a tool result instead of a run failure", async () => {
  const result = await executeBashTool(bashCall("echo before; exit 3"));
  expect(result).toEqual({ ok: true, value: "before\n\nCommand exited with code 3" });
});

test("Bash marks silent success so an empty result stays distinguishable", async () => {
  const result = await executeBashTool(bashCall("true"));
  expect(result).toEqual({ ok: true, value: "(no output)" });
});

test("Bash applies filesystem effects such as deleting a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-bash-effect-"));
  const filePath = join(directory, "README_old.md");
  try {
    await writeFile(filePath, "old", "utf8");
    const result = await executeBashTool(bashCall(`rm ${JSON.stringify(filePath)}`));
    expect(result.ok).toBe(true);
    expect(await Bun.file(filePath).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bash rejects malformed arguments before running anything", async () => {
  for (const argumentsText of ["not json", JSON.stringify({}), JSON.stringify({ command: "" }), JSON.stringify({ command: 7 })]) {
    const result = await executeBashTool({ id: toolCallIdSchema.parse("bash-invalid"), name: "Bash", arguments: argumentsText });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_bash_arguments");
  }
});

test("Bash refuses calls addressed to another tool", async () => {
  const result = await executeBashTool({ id: toolCallIdSchema.parse("bash-foreign"), name: "Read", arguments: JSON.stringify({ command: "true" }) });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.reason).toBe("unsupported_tool");
});
