import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OperationResult } from "../shared/operation-result.ts";
import { readBoundedFile } from "../tools/bounded-file-read.ts";

/** Project skills live in one folder per skill, relative to the workspace root. */
export const projectSkillsDirectory = join(".claude", "skills");

const skillDocumentName = "SKILL.md";
const forkedSkillContext = "fork";
/** Instructions return as one tool result; half the 64 KiB outcome envelope leaves room for framing. */
const maxSkillDocumentBytes = 32_768;
/** YAML between the opening and closing `---` lines; everything after is the body. */
const frontmatterPattern = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/;
const skillDocumentDecoder = new TextDecoder("utf-8", { fatal: true });
const missingPath = z.object({ code: z.literal("ENOENT") });

const skillFrontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  context: z.literal(forkedSkillContext).optional(),
});

/** A discovered skill; only its name and description are advertised before invocation. */
export interface Skill {
  /** The folder name, which is how skills are invoked. */
  readonly name: string;
  readonly description: string;
  /** Forked skills run in a fresh lane that sees only their instructions. */
  readonly forked: boolean;
  /** Relative paths in the body resolve against this folder. */
  readonly directory: string;
  /** Loaded into a conversation only when the skill is invoked. */
  readonly body: string;
}

const skillDiscoveryMessages = {
  unreadable: "Skill discovery failed: unable to read skills",
  too_large: `Skill discovery failed: a ${skillDocumentName} exceeds the ${maxSkillDocumentBytes}-byte budget`,
  invalid_document: `Skill discovery failed: a ${skillDocumentName} lacks UTF-8 YAML frontmatter with a name and description`,
} as const;

/** A skill could not be loaded; diagnostics name the failure, never paths or file contents. */
export class SkillDiscoveryError extends Error {
  /** Stable discovery failure tag. */
  readonly _tag = "SkillDiscoveryError" as const;

  /** One reason per failed boundary: directory listing, document size, or document format. */
  constructor(readonly reason: keyof typeof skillDiscoveryMessages) {
    super(skillDiscoveryMessages[reason]);
  }
}

/** Load every `<directory>/<name>/SKILL.md`, sorted by name; a missing directory has no skills. */
export async function discoverSkills(directory: string): Promise<OperationResult<readonly Skill[], SkillDiscoveryError>> {
  const folders = await listSkillFolders(directory);
  if (!folders.ok) return folders;
  const skills: Skill[] = [];
  for (const folder of folders.value) {
    const skill = await loadSkill(join(directory, folder), folder);
    if (!skill.ok) return skill;
    if (skill.value !== null) skills.push(skill.value);
  }
  return { ok: true, value: skills };
}

async function listSkillFolders(directory: string): Promise<OperationResult<readonly string[], SkillDiscoveryError>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return { ok: true, value: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() };
  } catch (error) {
    if (missingPath.safeParse(error).success) return { ok: true, value: [] };
    return { ok: false, error: new SkillDiscoveryError("unreadable") };
  }
}

/** Null means the folder holds no SKILL.md and so is not a skill. */
async function loadSkill(folder: string, name: string): Promise<OperationResult<Skill | null, SkillDiscoveryError>> {
  const path = join(folder, skillDocumentName);
  if (!(await Bun.file(path).exists())) return { ok: true, value: null };
  const bytes = await readBoundedFile(path, maxSkillDocumentBytes);
  if (!bytes.ok) {
    return { ok: false, error: new SkillDiscoveryError(bytes.error.reason === "too_large" ? "too_large" : "unreadable") };
  }
  const document = parseSkillDocument(bytes.value);
  if (document === null) return { ok: false, error: new SkillDiscoveryError("invalid_document") };
  const { frontmatter, body } = document;
  return {
    ok: true,
    value: { name, description: frontmatter.description, forked: frontmatter.context === forkedSkillContext, directory: folder, body },
  };
}

interface SkillDocument {
  readonly frontmatter: z.output<typeof skillFrontmatterSchema>;
  readonly body: string;
}

/** Null for any malformed document; callers report the reason without echoing content. */
function parseSkillDocument(bytes: Buffer): SkillDocument | null {
  let text: string;
  let yaml: ReturnType<typeof Bun.YAML.parse>;
  try {
    text = skillDocumentDecoder.decode(bytes).replaceAll("\r\n", "\n");
    const match = frontmatterPattern.exec(text);
    if (match?.groups?.yaml === undefined) return null;
    yaml = Bun.YAML.parse(match.groups.yaml);
    text = text.slice(match[0].length);
  } catch {
    return null;
  }
  const frontmatter = skillFrontmatterSchema.safeParse(yaml);
  return frontmatter.success ? { frontmatter: frontmatter.data, body: text.trim() } : null;
}
