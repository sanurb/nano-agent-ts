/** Worker cancellation starts first, leaving the supervisor time to settle or kill descendants. */
export const sandboxWorkerDeadlineMs = 55_000;

/** PID 1 owns this hard container deadline even if the attached Docker client disappears. */
export const sandboxSupervisorDeadlineMs = 60_000;

/** Persistent kernel session lease; individual cells retain the shorter worker deadline. */
export const sandboxKernelDeadlineMs = 1_800_000;

/** Client deadline exceeds the supervisor watchdog; client cancellation alone is not confirmed cleanup. */
export const sandboxClientDeadlineMs = 70_000;
