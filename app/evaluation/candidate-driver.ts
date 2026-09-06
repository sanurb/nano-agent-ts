import { resolve } from "node:path";
import { z } from "zod";

// This driver runs only inside the read-only sandbox. It contains no reference answers or pass/fail assertions.
// Capture serialization before loading candidate code; the controller independently grades the returned values.
const serialize = JSON.stringify;
import { processArgumentOffset } from "../shared/process-policy.ts";
import { maxEvaluationChecks, maxEvaluationInputCharacters } from "./evaluation-protocol.ts";

const [entryPoint, encodedInputs] = z.tuple([z.string().regex(/^[a-z-]+\.js$/), z.string().max(maxEvaluationInputCharacters)]).parse(process.argv.slice(processArgumentOffset));
const inputs = z.array(z.json()).max(maxEvaluationChecks).parse(JSON.parse(encodedInputs));
const candidate = z.object({ default: z.function({ input: [z.unknown()], output: z.unknown() }) }).parse(await import(resolve("/workspace", entryPoint)));
const results = inputs.map((input) => ({ value: candidate.default(input), inputAfter: input }));
console.log(serialize(results));
