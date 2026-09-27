import type { Skill } from "./skill-catalog.ts";

const slashCommandPrefix = "/";
/** `$ARGUMENTS[n]` and `$n` select one argument by zero-based position; bare `$ARGUMENTS` is all of them. */
const argumentPlaceholder = /\$ARGUMENTS\[(\d+)\]|\$(\d+)|\$ARGUMENTS/g;
const whitespace = /\s+/;
const word = /\S+/g;
const relativePathsNote = "Paths in the instructions below are relative to that folder.";

/** Fill a skill body's argument placeholders; a missing argument becomes the empty string. */
export function substituteArguments(body: string, argumentText: string): string {
  const allArguments = argumentText.trim();
  const positional = allArguments === "" ? [] : allArguments.split(whitespace);
  return body.replace(argumentPlaceholder, (_placeholder, indexed?: string, shorthand?: string) => {
    const position = indexed ?? shorthand;
    return position === undefined ? allArguments : (positional[Number(position)] ?? "");
  });
}

/** An invoked skill's instructions, preceded by the folder that its relative paths resolve against. */
export function renderSkillInstructions(skill: Skill, argumentText: string): string {
  return `Skill: ${skill.name} (located at ${skill.directory})\n${relativePathsNote}\n\n`
    + substituteArguments(skill.body, argumentText);
}

/** The skills named at the start of a prompt, and the text after them that every one receives. */
export interface SkillInvocation {
  readonly skills: readonly Skill[];
  readonly argumentText: string;
}

/**
 * Read leading `/name` words that name skills. The first word that does not ends the run, and it
 * and everything after it become the argument text.
 */
export function parseSkillInvocation(prompt: string, skills: readonly Skill[]): SkillInvocation {
  const invoked: Skill[] = [];
  for (const match of prompt.matchAll(word)) {
    const skill = skills.find((candidate) => slashCommandPrefix + candidate.name === match[0]);
    if (skill === undefined || !canStack(invoked, skill)) {
      return { skills: invoked, argumentText: prompt.slice(match.index).trim() };
    }
    invoked.push(skill);
  }
  return { skills: invoked, argumentText: "" };
}

/** One user message per invoked skill, or the prompt itself when it invokes none. */
export function expandSkillInvocations(prompt: string, skills: readonly Skill[]): readonly string[] {
  const invocation = parseSkillInvocation(prompt, skills);
  if (invocation.skills.length === 0) return [prompt];
  return invocation.skills.map((skill) => renderSkillInstructions(skill, invocation.argumentText));
}

/** A forked skill runs alone: it neither joins a stack nor lets another skill join it. */
function canStack(invoked: readonly Skill[], next: Skill): boolean {
  return invoked.length === 0 || (!next.forked && !invoked.some((skill) => skill.forked));
}
