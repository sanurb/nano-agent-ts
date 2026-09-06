/** Controller and candidate driver agree on a bounded number of input/output observations. */
export const maxEvaluationChecks = 100;

/** Candidate input JSON is capped at 64 Ki UTF-16 code units before parsing. */
export const maxEvaluationInputCharacters = 65_536;
