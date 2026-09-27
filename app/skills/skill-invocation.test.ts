import { expect, test } from "bun:test";
import type { Skill } from "./skill-catalog.ts";
import { expandSkillInvocations, renderSkillInstructions, substituteArguments } from "./skill-invocation.ts";

function skill(name: string, body: string, forked = false): Skill {
  return { name, description: `The ${name} skill.`, forked, directory: `.claude/skills/${name}`, body };
}

const header = (name: string) =>
  `Skill: ${name} (located at .claude/skills/${name})\nPaths in the instructions below are relative to that folder.\n\n`;

test.each([
  ["Deploy to $0 in region $1. Full request was: $ARGUMENTS", "staging eu-west", "Deploy to staging in region eu-west. Full request was: staging eu-west"],
  ["$1 $0", "mango pear", "pear mango"],
  ["$ARGUMENTS[1]-$ARGUMENTS[0]-$ARGUMENTS", "a b", "b-a-a b"],
  ["[$ARGUMENTS] [$0] [$ARGUMENTS[3]]", "", "[] [] []"],
  ["$0 and $0 again", "  spaced   out  ", "spaced and spaced again"],
  ["$10 is the eleventh", "a b c d e f g h i j k", "k is the eleventh"],
])("substitutes %j with %j", (body, argumentText, expected) => {
  expect(substituteArguments(body, argumentText)).toBe(expected);
});

test("rendered instructions name the folder that relative paths resolve against", () => {
  expect(renderSkillInstructions(skill("apple", "Run `scripts/checksum.sh` for $0."), "prod")).toBe(
    `${header("apple")}Run \`scripts/checksum.sh\` for prod.`,
  );
});

const skills = [
  skill("apple", "blueberry-$ARGUMENTS"),
  skill("grape", "cherry-$ARGUMENTS"),
  skill("kiwi", "forked-$ARGUMENTS", true),
];

test.each([
  ["/apple", [["apple", "blueberry-"]]],
  ["/apple /grape 4127", [["apple", "blueberry-4127"], ["grape", "cherry-4127"]]],
  ["/apple 4127 /grape", [["apple", "blueberry-4127 /grape"]]],
  ["/apple /pear 4127", [["apple", "blueberry-/pear 4127"]]],
  ["/apple /kiwi 4127", [["apple", "blueberry-/kiwi 4127"]]],
  ["/kiwi /apple 4127", [["kiwi", "forked-/apple 4127"]]],
] as const)("expands %j", (prompt, expected) => {
  expect(expandSkillInvocations(prompt, skills)).toEqual(expected.map(([name, body]) => `${header(name)}${body}`));
});

test.each(["What is the migration status?", "/pear 4127", "apple /apple", "/applesauce"])(
  "leaves %j unchanged when it does not start with a skill",
  (prompt) => {
    expect(expandSkillInvocations(prompt, skills)).toEqual([prompt]);
  },
);
