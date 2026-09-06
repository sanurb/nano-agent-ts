import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CliEnvironment } from "./cli/cli-configuration.ts";

const cliPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const testApiKey = "test-key-never-use-real-credentials";

async function runCli(args: readonly string[], environment: CliEnvironment, cwd = process.cwd(), mode: "sandbox" | "unsafe-local" | "default" = "unsafe-local") {
  const state = await mkdtemp(join(tmpdir(), "nano-agent-cli-state-"));
  const child = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd,
    env: {
      OPENROUTER_API_KEY: environment.apiKey,
      OPENROUTER_BASE_URL: environment.baseURL,
      NANO_AGENT_EXECUTION: mode === "default" ? undefined : mode,
      NANO_AGENT_SANDBOX_IMAGE: "",
      NANO_AGENT_JOURNAL_PATH: join(state, "journal.sqlite"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    child.kill();
    await child.exited;
    await rm(state, { recursive: true, force: true });
  }
}

class LocalCompletionServer implements Disposable {
  readonly requests: { path: string; method: string; authorization: string | null; body: string }[] = [];
  readonly #server;

  constructor(body: string | readonly string[], status = 200) {
    const responses = [body].flat();
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        this.requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        });
        const response = responses.shift();
        return new Response(response ?? '{"error":"Unexpected extra model request"}', {
          status: response === undefined ? 400 : status,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  get baseURL(): string {
    return `${this.#server.url}api/v1`;
  }

  [Symbol.dispose](): void {
    this.#server.stop(true);
  }
}

function completionBody(content: string | null): string {
  return JSON.stringify({
    id: "completion-test",
    object: "chat.completion",
    created: 0,
    model: "anthropic/claude-haiku-4.5",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  });
}

const advertisedToolContract = [
  { name: "Read", properties: ["file_path", "offset", "limit"], required: ["file_path"] },
  { name: "Glob", properties: ["pattern", "path", "limit"], required: ["pattern"] },
  { name: "Grep", properties: ["pattern", "path", "glob", "ignore_case", "literal", "limit"], required: ["pattern"] },
  { name: "Edit", properties: ["file_path", "edits"], required: ["file_path", "edits"] },
  { name: "Write", properties: ["file_path", "content"], required: ["file_path", "content"] },
  { name: "Bash", properties: ["command"], required: ["command"] },
].map((tool) => ({ type: "function", described: true, parameterType: "object", ...tool }));

test("CLI advertises every local tool in wire order and prints only assistant text", async () => {
  using provider = new LocalCompletionServer(completionBody("Hello from the assistant"));
  const prompt = "  Inspect README.md\n日本語 🚀  ";
  const result = await runCli(["-p", prompt, "ignored"], {
    apiKey: testApiKey,
    baseURL: provider.baseURL,
  });

  expect(result).toEqual({ stdout: "Hello from the assistant\n", stderr: "", exitCode: 0 });
  expect(provider.requests).toHaveLength(1);
  const [request] = provider.requests;
  if (!request) throw new Error("CLI test missing expected provider request");
  expect(request.path).toBe("/api/v1/chat/completions");
  expect(request.method).toBe("POST");
  expect(request.authorization).toBe(`Bearer ${testApiKey}`);
  const payload = JSON.parse(request.body);
  expect(payload.model).toBe("anthropic/claude-haiku-4.5");
  expect(payload.messages).toEqual([{ role: "user", content: prompt }]);
  // Descriptions are prompt copy that interpolates the output limits; the wire contract is the envelope,
  // the advertised order, and each tool's parameter names.
  expect(payload.tools.map((advertised: any) => ({
    type: advertised.type,
    name: advertised.function.name,
    described: advertised.function.description.length > 0,
    parameterType: advertised.function.parameters.type,
    properties: Object.keys(advertised.function.parameters.properties),
    required: advertised.function.parameters.required,
  }))).toEqual(advertisedToolContract);
});

test.each(["", "Line one\nLine two", null])("CLI preserves nullable and multiline content: %j", async (content) => {
  using provider = new LocalCompletionServer(completionBody(content));
  const result = await runCli(["-p", "hello"], { apiKey: testApiKey, baseURL: provider.baseURL });
  expect(result).toEqual({ stdout: `${content}\n`, stderr: "", exitCode: 0 });
});

test.each([
  { name: "relative path without trailing newline", content: "print('Hello, program!')", absolute: false, assistantContent: null, expectedResult: undefined },
  { name: "absolute path and Unicode/CRLF contents", content: "  日本語 🚀\r\n\n", absolute: true, assistantContent: "must not print assistant text", expectedResult: undefined },
  { name: "empty file", content: "", absolute: false, assistantContent: null, expectedResult: undefined },
  {
    name: "large file capped at the line ceiling",
    content: "print('Hello, program!')\n".repeat(8192),
    absolute: false,
    assistantContent: null,
    expectedResult: `${Array.from({ length: 2000 }, () => "print('Hello, program!')").join("\n")}`
      + "\n\n[Showing lines 1-2000 of 8193. Use offset=2001 to continue.]",
  },
])("CLI sends each Read result to the model and prints only the final answer: $name", async ({ content, absolute, assistantContent, expectedResult }) => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-read-"));
  const fileName = absolute ? "strawberry ü ' space.py" : "strawberry.py";
  const filePath = absolute ? join(directory, fileName) : fileName;
  try {
    await writeFile(join(directory, fileName), content);
    await writeFile(join(directory, "second.py"), "second file contents");
    const toolResponse = {
      choices: [{
        message: {
          role: "assistant",
          content: assistantContent,
          tool_calls: [{
            id: "read-call",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: filePath }) },
          }, {
            id: "second-call",
            type: "function",
            function: { name: "Read", arguments: '{"file_path":"second.py"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    };
    using provider = new LocalCompletionServer([JSON.stringify(toolResponse), completionBody("6")]);
    const result = await runCli(["-p", "read strawberry.py"], {
      apiKey: testApiKey, baseURL: provider.baseURL,
    }, directory);
    expect(result).toEqual({ stdout: "6\n", stderr: "", exitCode: 0 });
    expect(provider.requests).toHaveLength(2);
    const request = provider.requests[1];
    if (!request) throw new Error("Agent loop test missing continuation request");
    expect(JSON.parse(request.body).messages).toEqual([
      { role: "user", content: "read strawberry.py" },
      toolResponse.choices[0]?.message,
      { role: "tool", tool_call_id: "read-call", content: expectedResult ?? content },
      { role: "tool", tool_call_id: "second-call", content: "second file contents" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI follows README references across multiple agent-loop iterations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-agent-loop-"));
  const files = [
    { path: "README.md", content: "See app/settings.py for the expiry configuration." },
    { path: "app/settings.py", content: "from app.constants import EXPIRY_MONTHS" },
    { path: "app/constants.py", content: "EXPIRY_MONTHS = 9" },
  ];
  const exchanges = files.map((file) => ({
    assistant: {
      role: "assistant", content: null,
      tool_calls: [{ id: "lookup", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: file.path }) } }],
    },
    tool: { role: "tool", tool_call_id: "lookup", content: file.content },
  }));
  try {
    await mkdir(join(directory, "app"));
    for (const file of files) await writeFile(join(directory, file.path), file.content);
    using provider = new LocalCompletionServer([
      ...exchanges.map((exchange) => JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: exchange.assistant }] })),
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "9", tool_calls: [] } }] }),
    ]);
    const prompt = "Use README.md to determine the chemical expiry period in months. Number only.";
    expect(await runCli(["-p", prompt], { apiKey: testApiKey, baseURL: provider.baseURL }, directory)).toEqual({
      stdout: "9\n", stderr: "", exitCode: 0,
    });
    expect(provider.requests).toHaveLength(4);
    for (const [index, request] of provider.requests.entries()) {
      expect(JSON.parse(request.body)).toMatchObject({
        messages: [{ role: "user", content: prompt }, ...exchanges.slice(0, index).flatMap((exchange) => [exchange.assistant, exchange.tool])],
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { toolName: "Read", toolArguments: { file_path: "README.md" }, expected: "must not be printed" },
  { toolName: "Write", toolArguments: { file_path: "README.md", content: "written contents" }, expected: "written contents" },
  {
    toolName: "Edit",
    toolArguments: { file_path: "README.md", edits: [{ old_string: "must not be printed", new_string: "written contents" }] },
    expected: "written contents",
  },
  { toolName: "Bash", toolArguments: { command: "printf 'written contents' > README.md" }, expected: "written contents" },
])("CLI retains completed $toolName effects without partial output when continuation fails", async ({ toolName, toolArguments, expected }) => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-loop-failure-"));
  try {
    await writeFile(join(directory, "README.md"), "must not be printed");
    using provider = new LocalCompletionServer([
      JSON.stringify({ choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant", content: "must not print intermediate text",
          tool_calls: [{ id: "file-call", type: "function", function: {
            name: toolName,
            arguments: JSON.stringify(toolArguments),
          } }],
        },
      }] }),
      '{"choices":[]}',
    ]);
    expect(await runCli(["-p", "read README"], { apiKey: testApiKey, baseURL: provider.baseURL }, directory)).toEqual({
      stdout: "", stderr: "no choices in response\n", exitCode: 1,
    });
    expect(provider.requests).toHaveLength(2);
    expect(await readFile(join(directory, "README.md"), "utf8")).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "create", initialContent: null, content: "print('Ready')", absolute: false },
  { name: "overwrite and truncate", initialContent: "long obsolete file contents", content: "x", absolute: true },
  { name: "empty overwrite", initialContent: "old contents", content: "", absolute: false },
  { name: "Unicode and CRLF", initialContent: null, content: "  日本語 🚀\r\n", absolute: true },
])("CLI reads instructions, executes Write, and returns its result to the model: $name", async ({ initialContent, content, absolute }) => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-write-"));
  const relativePath = "app/target ü ' file.py";
  const target = join(directory, relativePath);
  const filePath = absolute ? target : relativePath;
  const instructions = `Create ${relativePath} with the required contents.`;
  const readMessage = {
    role: "assistant", content: null,
    tool_calls: [{ id: "instructions", type: "function", function: { name: "Read", arguments: '{"file_path":"README.md"}' } }],
  };
  const writeMessage = {
    role: "assistant", content: "must not print intermediate text",
    tool_calls: [
      { id: "create-file", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: filePath, content }) } },
      { id: "verify-file", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: filePath }) } },
    ],
  };
  try {
    await mkdir(join(directory, "app"));
    await writeFile(join(directory, "README.md"), instructions);
    if (initialContent !== null) await writeFile(target, initialContent);
    using provider = new LocalCompletionServer([
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: readMessage }] }),
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: writeMessage }] }),
      completionBody("Created the file"),
    ]);
    const prompt = "Read README.md and create the required file. Reply with 'Created the file'";
    expect(await runCli(["-p", prompt], { apiKey: testApiKey, baseURL: provider.baseURL }, directory)).toEqual({
      stdout: "Created the file\n", stderr: "", exitCode: 0,
    });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(provider.requests).toHaveLength(3);
    const request = provider.requests[2];
    if (!request) throw new Error("Write test missing continuation request");
    expect(JSON.parse(request.body)).toMatchObject({ messages: [
      { role: "user", content: prompt },
      readMessage,
      { role: "tool", tool_call_id: "instructions", content: instructions },
      writeMessage,
      { role: "tool", tool_call_id: "create-file", content: "File written successfully." },
      { role: "tool", tool_call_id: "verify-file", content },
    ] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI executes Bash in the working directory and returns its output to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-bash-"));
  const files = [
    { path: "app/main.js", content: "console.log('Hello, program!');\n" },
    { path: "README.md", content: "Current readme\n" },
    { path: "README_old.md", content: "Old readme\n" },
  ];
  const listMessage = {
    role: "assistant", content: null,
    tool_calls: [{ id: "list-files", type: "function", function: { name: "Bash", arguments: '{"command":"ls README_old.md"}' } }],
  };
  const deleteMessage = {
    role: "assistant", content: "must not print intermediate text",
    tool_calls: [{ id: "delete-file", type: "function", function: { name: "Bash", arguments: '{"command":"rm README_old.md"}' } }],
  };
  try {
    await mkdir(join(directory, "app"));
    for (const file of files) await writeFile(join(directory, file.path), file.content);
    using provider = new LocalCompletionServer([
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: listMessage }] }),
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: deleteMessage }] }),
      completionBody("Deleted README_old.md"),
    ]);
    const prompt = "Delete the old readme file.";
    expect(await runCli(["-p", prompt], { apiKey: testApiKey, baseURL: provider.baseURL }, directory)).toEqual({
      stdout: "Deleted README_old.md\n", stderr: "", exitCode: 0,
    });
    expect(await Bun.file(join(directory, "README_old.md")).exists()).toBe(false);
    for (const file of files.slice(0, 2)) {
      expect(await readFile(join(directory, file.path), "utf8")).toBe(file.content);
    }
    expect(provider.requests).toHaveLength(3);
    const request = provider.requests[2];
    if (!request) throw new Error("Bash test missing continuation request");
    expect(JSON.parse(request.body)).toMatchObject({ messages: [
      { role: "user", content: prompt },
      listMessage,
      { role: "tool", tool_call_id: "list-files", content: "README_old.md\n" },
      deleteMessage,
      { role: "tool", tool_call_id: "delete-file", content: "(no output)" },
    ] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI returns a failed command's message to the model instead of ending the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-bash-failure-"));
  const failingMessage = {
    role: "assistant", content: null,
    tool_calls: [{ id: "missing-file", type: "function", function: { name: "Bash", arguments: '{"command":"cat missing.md 2>/dev/null; exit 1"}' } }],
  };
  try {
    using provider = new LocalCompletionServer([
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: failingMessage }] }),
      completionBody("There is no such file"),
    ]);
    expect(await runCli(["-p", "read the missing file"], { apiKey: testApiKey, baseURL: provider.baseURL }, directory)).toEqual({
      stdout: "There is no such file\n", stderr: "", exitCode: 0,
    });
    const request = provider.requests[1];
    if (!request) throw new Error("Bash failure test missing continuation request");
    expect(JSON.parse(request.body).messages).toContainEqual({
      role: "tool", tool_call_id: "missing-file", content: "Command exited with code 1",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "Edit", bad: { file_path: "source.txt", edits: [{ old_string: "absent", new_string: "new" }] }, good: { file_path: "source.txt", edits: [{ old_string: "old", new_string: "new" }] }, feedback: "Edit tool failed: edits[0] matches no text in the file", output: "Replaced 1 block(s) successfully." },
  { name: "Read", bad: { file_path: "source.txt", offset: 20 }, good: { file_path: "source.txt", offset: 1 }, feedback: "Read tool failed: offset is past the end of the file", output: "old" },
  { name: "Glob", bad: { path: "missing", pattern: "*.txt" }, good: { path: ".", pattern: "*.txt" }, feedback: "Glob tool failed: unable to search the requested path", output: "source.txt" },
])("CLI allows the model to correct a $name miss and retry", async ({ name, bad, good, feedback, output }) => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-tool-retry-"));
  const toolStep = (args: string) => JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "retry", type: "function", function: { name, arguments: args } }],
  } }] });
  try {
    await writeFile(join(directory, "source.txt"), "old");
    using provider = new LocalCompletionServer([toolStep(JSON.stringify(bad)), toolStep(JSON.stringify(good)), completionBody("Done")]);
    expect(await runCli(["-p", "fix the request"], { apiKey: testApiKey, baseURL: provider.baseURL }, directory))
      .toEqual({ stdout: "Done\n", stderr: "", exitCode: 0 });
    expect(provider.requests).toHaveLength(3);
    const [, retry, final] = provider.requests;
    if (!retry || !final) throw new Error("Tool retry test missing requests");
    expect(JSON.parse(retry.body).messages.at(-1)).toEqual({ role: "tool", tool_call_id: "retry", content: feedback });
    expect(JSON.parse(final.body).messages.at(-1)).toEqual({ role: "tool", tool_call_id: "retry", content: output });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const invalidReadArgumentsMessage =
  "Invalid Read arguments: expected JSON with a nonempty file_path without NUL characters, plus optional positive offset and limit";
const invalidBashArgumentsMessage = "Invalid Bash arguments: expected JSON with a nonempty command without NUL characters";
const invalidWriteArgumentsMessage = "Invalid Write arguments: expected JSON with a nonempty file_path without NUL characters and string content";

test.each([
  { name: "invalid JSON", toolName: "Read", arguments: testApiKey, message: invalidReadArgumentsMessage },
  { name: "null arguments", toolName: "Read", arguments: "null", message: invalidReadArgumentsMessage },
  { name: "array arguments", toolName: "Read", arguments: "[]", message: invalidReadArgumentsMessage },
  { name: "missing path", toolName: "Read", arguments: "{}", message: invalidReadArgumentsMessage },
  { name: "non-string path", toolName: "Read", arguments: '{"file_path":42}', message: invalidReadArgumentsMessage },
  { name: "empty path", toolName: "Read", arguments: '{"file_path":""}', message: invalidReadArgumentsMessage },
  { name: "NUL path", toolName: "Read", arguments: JSON.stringify({ file_path: "bad\u0000path" }), message: invalidReadArgumentsMessage },
  { name: "missing file", toolName: "Read", arguments: '{"file_path":"missing.py"}', message: "Read tool failed: unable to read file" },
  { name: "directory path", toolName: "Read", arguments: '{"file_path":"."}', message: "Read tool failed: unable to read file" },
  { name: "Write invalid JSON", toolName: "Write", arguments: testApiKey, message: invalidWriteArgumentsMessage },
  { name: "Write null arguments", toolName: "Write", arguments: "null", message: invalidWriteArgumentsMessage },
  { name: "Write array arguments", toolName: "Write", arguments: "[]", message: invalidWriteArgumentsMessage },
  { name: "Write missing path", toolName: "Write", arguments: '{"content":"new"}', message: invalidWriteArgumentsMessage },
  { name: "Write non-string path", toolName: "Write", arguments: '{"file_path":42,"content":"new"}', message: invalidWriteArgumentsMessage },
  { name: "Write empty path", toolName: "Write", arguments: '{"file_path":"","content":"new"}', message: invalidWriteArgumentsMessage },
  { name: "Write NUL path", toolName: "Write", arguments: JSON.stringify({ file_path: "bad\u0000path", content: "new" }), message: invalidWriteArgumentsMessage },
  { name: "Write missing content", toolName: "Write", arguments: '{"file_path":"protected.py"}', message: invalidWriteArgumentsMessage },
  { name: "Write non-string content", toolName: "Write", arguments: '{"file_path":"protected.py","content":42}', message: invalidWriteArgumentsMessage },
  { name: "Write directory path", toolName: "Write", arguments: '{"file_path":".","content":"new"}', message: "Write tool failed: unable to write file" },
  { name: "Write missing parent", toolName: "Write", arguments: '{"file_path":"missing/new.py","content":"new"}', message: "File mutation tool failed: unable to commit replacement; original file was not replaced" },
  { name: "Bash invalid JSON", toolName: "Bash", arguments: testApiKey, message: invalidBashArgumentsMessage },
  { name: "Bash null arguments", toolName: "Bash", arguments: "null", message: invalidBashArgumentsMessage },
  { name: "Bash missing command", toolName: "Bash", arguments: "{}", message: invalidBashArgumentsMessage },
  { name: "Bash non-string command", toolName: "Bash", arguments: '{"command":42}', message: invalidBashArgumentsMessage },
  { name: "Bash empty command", toolName: "Bash", arguments: '{"command":""}', message: invalidBashArgumentsMessage },
  { name: "Bash NUL command", toolName: "Bash", arguments: JSON.stringify({ command: "rm bad\u0000path" }), message: invalidBashArgumentsMessage },
])("CLI sends correctable tool failures back to the model: $name", async ({ toolName, arguments: toolArguments, message }) => {
  const directory = await mkdtemp(join(tmpdir(), "codecrafters-tool-errors-"));
  try {
    await writeFile(join(directory, "protected.py"), "unchanged");
    using provider = new LocalCompletionServer([JSON.stringify({
      choices: [{
        message: {
          role: "assistant", content: "must not print fallback text",
          tool_calls: [{ id: "tool-call", type: "function", function: { name: toolName, arguments: toolArguments } }],
        },
        finish_reason: "tool_calls",
      }],
    }), completionBody("Recovered")]);
    const result = await runCli(["-p", "read a file"], { apiKey: testApiKey, baseURL: provider.baseURL }, directory);
    expect(result).toEqual({ stdout: "Recovered\n", stderr: "", exitCode: 0 });
    expect(provider.requests).toHaveLength(2);
    const continuation = provider.requests[1];
    if (!continuation) throw new Error("Tool recovery test missing continuation");
    expect(JSON.parse(continuation.body).messages.at(-1)).toEqual({ role: "tool", tool_call_id: "tool-call", content: message });
    expect(message).not.toContain(testApiKey);
    expect(await readFile(join(directory, "protected.py"), "utf8")).toBe("unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects unadvertised tool admission without continuing or exposing the requested name", async () => {
  using provider = new LocalCompletionServer(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "denied", type: "function", function: { name: testApiKey, arguments: "{}" } }],
  } }] }));
  expect(await runCli(["-p", "run a tool"], { apiKey: testApiKey, baseURL: provider.baseURL })).toEqual({
    stdout: "", stderr: "Tool execution denied: tool is not active on this lane\n", exitCode: 1,
  });
  expect(provider.requests).toHaveLength(1);
});

test.each([
  { body: '{"choices":[]}', message: "no choices in response" },
  { body: '{}', message: "Invalid assistant response: expected choices with assistant text" },
  { body: '{"choices":[{"message":{"role":"assistant","content":42}}]}', message: "Invalid assistant response: expected choices with assistant text" },
  { body: '{"choices":[{"message":{"role":"user","content":"wrong role"}}]}', message: "Invalid assistant response: expected choices with assistant text" },
])("CLI reports invalid completion: $body", async ({ body, message }) => {
  using provider = new LocalCompletionServer(body);
  const result = await runCli(["-p", "hello"], { apiKey: testApiKey, baseURL: provider.baseURL });
  expect(result).toEqual({ stdout: "", stderr: `${message}\n`, exitCode: 1 });
});

test("CLI reports HTTP errors without exposing provider bodies or credentials", async () => {
  using provider = new LocalCompletionServer(JSON.stringify({ error: { message: testApiKey } }), 401);
  const result = await runCli(["-p", "hello"], { apiKey: testApiKey, baseURL: provider.baseURL });
  expect(result).toEqual({ stdout: "", stderr: "Assistant request failed: HTTP 401\n", exitCode: 1 });
  expect(result.stderr).not.toContain(testApiKey);
});

test("CLI interruption kills a Bash descendant that ignores SIGTERM before exiting", async () => {
  const ready = Promise.withResolvers<number>();
  let requests = 0;
  let command = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (new URL(request.url).pathname === "/ready") {
      ready.resolve(z.coerce.number().int().positive().parse(await request.text()));
      return new Response("ready");
    }
    requests++;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "long-command", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } }],
    } }] }), { headers: { "content-type": "application/json" } });
  } });
  const script = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await fetch(${JSON.stringify(`${server.url}ready`)}, {method: 'POST', body: String(process.pid)});`;
  command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} & wait`;
  const state = await mkdtemp(join(tmpdir(), "nano-agent-cli-cancel-state-"));
  const child = Bun.spawn([process.execPath, "run", cliPath, "-p", "run until interrupted"], {
    env: { OPENROUTER_API_KEY: testApiKey, OPENROUTER_BASE_URL: `${server.url}api/v1`, NANO_AGENT_EXECUTION: "unsafe-local", NANO_AGENT_JOURNAL_PATH: join(state, "journal.sqlite") },
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => ready.reject(new Error("Bash cancellation test readiness timed out")), 4000);
  let descendant: number | undefined;
  try {
    descendant = await ready.promise;
    child.kill("SIGINT");
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "", stderr: "Agent run cancelled: in-flight work settled; inspect interrupted effects before retrying\n", exitCode: 130,
    });
    expect(requests).toBe(1);
    const pid = descendant;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(timeout);
    child.kill();
    if (descendant !== undefined) {
      try { process.kill(descendant, "SIGKILL"); } catch { /* Already reaped is the expected successful path. */ }
    }
    server.stop(true);
    await child.exited;
    await rm(state, { recursive: true, force: true });
  }
}, 10_000);

test("CLI requires configured isolation by default and never falls back or contacts the provider", async () => {
  using provider = new LocalCompletionServer(completionBody("must not run"));
  const result = await runCli(["-p", "perform a task"], { apiKey: testApiKey, baseURL: provider.baseURL }, process.cwd(), "default");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("configure a digest-pinned sandbox image");
  expect(provider.requests).toHaveLength(0);
});

test("CLI reports a provider connection failure as a safe diagnostic", async () => {
  const provider = new LocalCompletionServer(completionBody("unreachable"));
  const baseURL = provider.baseURL;
  provider[Symbol.dispose]();
  const result = await runCli(["-p", "hello"], { apiKey: testApiKey, baseURL });
  expect(result).toEqual({
    stdout: "",
    stderr: "Assistant request failed: provider transport error\n",
    exitCode: 1,
  });
}, 15_000);

test.each([
  { args: [], apiKey: undefined, message: "OPENROUTER_API_KEY is not set" },
  { args: ["-p", "hello"], apiKey: "", message: "OPENROUTER_API_KEY is not set" },
  { args: [], apiKey: testApiKey, message: "error: -p flag is required" },
  { args: ["--wrong", "hello"], apiKey: testApiKey, message: "error: -p flag is required" },
  { args: ["-p", ""], apiKey: testApiKey, message: "error: -p flag is required" },
])("CLI rejects invalid startup input without contacting the provider: $message", async ({ args, apiKey, message }) => {
  using provider = new LocalCompletionServer(completionBody("must not run"));
  const result = await runCli(args, { apiKey, baseURL: provider.baseURL });
  expect(result).toEqual({ stdout: "", stderr: `${message}\n`, exitCode: 1 });
  expect(provider.requests).toHaveLength(0);
});

test.each(["not a url", "file:///etc/passwd", ""])('CLI rejects invalid base URL "%s" safely', async (baseURL) => {
  const result = await runCli(["-p", "hello"], { apiKey: testApiKey, baseURL });
  expect(result).toEqual({
    stdout: "",
    stderr: "Invalid OPENROUTER_BASE_URL: expected an HTTP or HTTPS URL\n",
    exitCode: 1,
  });
});
