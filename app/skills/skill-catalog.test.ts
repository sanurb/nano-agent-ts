import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "./skill-catalog.ts";

async function withSkillsDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nano-agent-skills-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSkill(directory: string, folder: string, document: string | Uint8Array): Promise<void> {
  await mkdir(join(directory, folder), { recursive: true });
  await writeFile(join(directory, folder, "SKILL.md"), document);
}

test("loads every skill folder sorted by name, keeping bodies for later invocation", async () => {
  await withSkillsDirectory(async (directory) => {
    await writeSkill(directory, "grape", "---\nname: grape\ndescription: Runs the grape test suite.\n---\n\nGrape body");
    await writeSkill(directory, "apple", "---\r\nname: apple\r\ndescription: \"Deploys apple: to production.\"\r\n---\r\nLine one\r\n\r\nLine two\r\n");
    await mkdir(join(directory, "not-a-skill"));
    await writeFile(join(directory, "stray.md"), "ignored");

    expect(await discoverSkills(directory)).toEqual({
      ok: true,
      value: [
        { name: "apple", description: "Deploys apple: to production.", forked: false, directory: join(directory, "apple"), body: "Line one\n\nLine two" },
        { name: "grape", description: "Runs the grape test suite.", forked: false, directory: join(directory, "grape"), body: "Grape body" },
      ],
    });
  });
});

test("marks a skill with context: fork as forked", async () => {
  await withSkillsDirectory(async (directory) => {
    await writeSkill(directory, "apple", "---\nname: apple\ndescription: On-call rotation.\ncontext: fork\n---\nSay blueberry");
    expect(await discoverSkills(directory)).toMatchObject({ ok: true, value: [{ name: "apple", forked: true }] });
  });
});

test("a missing skills directory has no skills", async () => {
  await withSkillsDirectory(async (directory) => {
    expect(await discoverSkills(join(directory, "absent"))).toEqual({ ok: true, value: [] });
  });
});

test.each([
  "no frontmatter here",
  "---\nname: apple\n---\nbody",
  "---\nname: apple\ndescription: [unterminated\n---\nbody",
  "---\nname: apple\ndescription: Deploys apple.\ncontext: inline\n---\nbody",
  new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
])("rejects a malformed skill document without echoing it: %#", async (document) => {
  await withSkillsDirectory(async (directory) => {
    await writeSkill(directory, "apple", document);
    const skills = await discoverSkills(directory);
    expect(skills).toMatchObject({ ok: false, error: { _tag: "SkillDiscoveryError", reason: "invalid_document" } });
    if (skills.ok) throw new Error("expected discovery to fail");
    expect(skills.error.message).not.toContain("apple");
  });
});

test("rejects a skill document over the size budget before parsing it", async () => {
  await withSkillsDirectory(async (directory) => {
    await writeSkill(directory, "apple", `---\nname: apple\ndescription: Big.\n---\n${"x".repeat(40_000)}`);
    expect(await discoverSkills(directory)).toMatchObject({ ok: false, error: { reason: "too_large" } });
  });
});
