import { readFileForMutation, replaceFileAtomically } from "../tools/atomic-file-mutation.ts";

/** Private JSON artifacts use consistent human-readable indentation. */
export const evaluationJsonIndentSpaces = 2;

/** Commit evaluation evidence atomically; uncertain publication stops the experiment rather than losing evidence. */
export async function writeEvaluationArtifact(path: string, content: string): Promise<void> {
  const snapshot = await readFileForMutation(path);
  if (!snapshot.ok) throw snapshot.error;
  const result = await replaceFileAtomically(path, content, snapshot.value);
  if (!result.ok || result.value.status !== "success") throw new Error("Evaluation artifact commit failed; retain existing evidence");
}
