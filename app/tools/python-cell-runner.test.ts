import { expect, setDefaultTimeout, test } from "bun:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const uv = Bun.which("uv");
const frameSchema = z.looseObject({});
type TestFrame = z.infer<typeof frameSchema>;
interface FramedJsonReader {
  readonly next: () => Promise<TestFrame>;
}
const runnerPath = fileURLToPath(new URL("./python-cell-runner.py", import.meta.url));
const requirementsPath = fileURLToPath(new URL("./ipython-requirements.txt", import.meta.url));
setDefaultTimeout(30_000);

test.skipIf(uv === null)("IPython runner retires after capability protocol synchronization is lost", async () => {
  if (!uv) throw new Error("IPython runner test requires uv");
  const process = Bun.spawn([
    uv,
    "run", "--quiet", "--no-progress", "--isolated", "--no-project",
    "--with-requirements", requirementsPath,
    "--python", "3.11",
    "--no-config",
    "python", "-I", "-u", runnerPath,
  ], {
    cwd: tmpdir(),
    env: {
      PATH: `${dirname(uv)}:/usr/bin:/bin`,
      HOME: tmpdir(),
      LANG: "C.UTF-8",
      UV_CACHE_DIR: join(tmpdir(), "nano-agent-ipython-test-cache"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const frames = framedJsonReader(process.stdout);
  try {
    expect(await frames.next()).toMatchObject({ type: "ready", seq: 1 });
    process.stdin.write(`${JSON.stringify({
      v: 2,
      type: "run",
      run_id: "protocol-loss",
      code: "try:\n    cap.read()\nexcept BaseException:\n    pass",
      tools: [{ alias: "read", name: "Read" }],
    })}\n`);
    const call = await frames.next();
    expect(call).toMatchObject({ type: "tool_call", run_id: "protocol-loss" });
    process.stdin.write(`${JSON.stringify({
      v: 2,
      type: "tool_reply",
      run_id: "protocol-loss",
      call_id: "wrong-call-id",
      ok: true,
      value: "untrusted",
    })}\n`);
    expect(await frames.next()).toMatchObject({
      type: "result",
      run_id: "protocol-loss",
      status: "protocol_error",
    });
    expect(await process.exited).toBe(2);
  } finally {
    process.stdin.end();
    process.kill();
    await process.exited;
  }
});

function framedJsonReader(
  stream: ReadableStream<Uint8Array>,
): FramedJsonReader {
  const reader = stream.getReader();
  let buffer = "";
  return {
    next: async () => {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return frameSchema.parse(JSON.parse(line));
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("IPython runner exited before the expected frame");
        buffer += new TextDecoder().decode(chunk.value, { stream: true });
      }
    },
  };
}
