/** Node/Bun argv begins with the executable and script path, before user arguments. */
export const processArgumentOffset = 2;

/** Conventional shell status for an interrupted process (SIGINT). */
export const interruptedExitCode = 130;

/** Conventional shell status for a terminated process (SIGTERM). */
export const terminatedExitCode = 143;

/** Conventional timeout status, distinct from a user interruption. */
export const timedOutExitCode = 124;

/** Give owned processes 100 ms to settle SIGTERM before escalating to SIGKILL. */
export const processTerminationGraceMs = 100;
