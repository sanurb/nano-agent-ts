import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PythonKernelRegistry } from "./python-kernel-registry.ts";
import type { PythonCellRunner } from "./python-cell-tool.ts";

const runnerPath = fileURLToPath(new URL("./python-cell-runner.py", import.meta.url));
const requirementsPath = fileURLToPath(new URL("./ipython-requirements.txt", import.meta.url));
const localKernelCache = join(tmpdir(), "nano-agent-ipython-cache");

/** Create an unsafe-local IPython runner from the repository's pinned dependency set. */
export function createLocalPythonCellRunner(): PythonCellRunner | null {
  const uv = [
    Bun.which("uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    join(homedir(), ".local", "bin", "uv"),
    join(homedir(), ".nix-profile", "bin", "uv"),
    "/run/current-system/sw/bin/uv",
  ].find((candidate): candidate is string => candidate !== null && existsSync(candidate));
  if (!uv) return null;
  return new PythonKernelRegistry({
    capabilityDescription: "IPython persists per agent lane with rich displays, history, magics, and top-level await. Unsafe-local mode runs it as the host user without OS isolation; host credentials are removed from the runner environment.",
    createCommand: () => ({
      executable: uv,
      arguments: [
        "run", "--quiet", "--no-progress", "--isolated", "--no-project",
        "--with-requirements", requirementsPath,
        "--python", "3.11",
        "--no-config",
        "python", "-I", "-u", runnerPath,
      ],
      cwd: tmpdir(),
      env: {
        PATH: `${dirname(uv)}:/usr/bin:/bin`,
        HOME: tmpdir(),
        LANG: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        UV_CACHE_DIR: localKernelCache,
      },
    }),
  });
}
