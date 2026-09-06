/** Glob and Grep share a bounded search-pattern input, measured in UTF-16 code units. */
export const maxSearchPatternCharacters = 4096;

/** A requested match limit cannot grow either search result beyond this count. */
export const maxSearchMatches = 1000;

/** Bound each complete search, separately from Grep's per-file regex deadline. */
export const searchDeadlineMs = 10_000;

/** Grep reads at most 1 MiB from a file; Read/Edit have a separate, larger budget. */
export const maxGrepFileBytes = 1_048_576;
