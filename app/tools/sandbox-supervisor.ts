import { spawn } from "node:child_process";
import { z } from "zod";
import { processArgumentOffset, terminatedExitCode, timedOutExitCode } from "../shared/process-policy.ts";
import { sandboxSupervisorDeadlineMs } from "./sandbox-runtime-policy.ts";

// Trusted image entrypoint: PID 1 owns the wall-clock lease independently of the host coordinator.
// Only SETUID/SETGID are granted so model-controlled children cannot signal or stop this root watchdog.
const identity = z.tuple([z.coerce.number().int().positive(), z.coerce.number().int().nonnegative()]).parse(process.argv.slice(processArgumentOffset));
if (process.getuid?.() !== 0 || !process.setgroups) throw new Error("Sandbox supervisor requires its restricted root identity");
process.setgroups([]);
const worker = spawn(process.execPath, ["run", "/agent/app/tools/tool-worker-main.ts"], {
  uid: identity[0], gid: identity[1], stdio: ["pipe", "inherit", "inherit"],
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
});
const deadline = setTimeout(() => process.exit(timedOutExitCode), sandboxSupervisorDeadlineMs);
process.on("SIGTERM", () => process.exit(terminatedExitCode));
worker.stdin.on("error", () => {});
process.stdin.pipe(worker.stdin);
worker.on("error", () => { clearTimeout(deadline); process.exit(1); });
worker.on("close", (code) => { clearTimeout(deadline); process.exit(code ?? 1); });
