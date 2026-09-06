import { opendir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";

const maxWalkDepth = 64;
const maxVisitedEntries = 20_000;
const directoryBufferEntries = 32;
const ignoredSearchEntries = new Set([".git", "node_modules"]);

/** A walk reports incomplete coverage explicitly instead of implying that an exhausted budget means no matches. */
export type FileWalkEvent =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "incomplete" }
  | { readonly kind: "unavailable" };

/** Prune ignored directories before descent; bound total visited entries and depth, and never follow symlinks. */
export async function* walkWorkspaceFiles(root: string, signal?: AbortSignal, visibility: "search" | "sandbox-admission" = "search"): AsyncGenerator<FileWalkEvent> {
  let visited = 0;
  let exhausted = false;

  // Own each directory handle until enumeration settles, with one entry budget shared by the entire walk.
  async function readDirectory(relative: string) {
    const opened = await opendir(join(root, relative), { bufferSize: directoryBufferEntries }).then(
      (directory) => ({ ok: true, directory }) as const,
      () => ({ ok: false }) as const,
    );
    if (!opened.ok) return { kind: "unavailable" } as const;
    const entries: Dirent[] = [];
    try {
      // for-await closes the directory on completion, abort, or early return.
      for await (const entry of opened.directory) {
        if (signal?.aborted) return { kind: "cancelled" } as const;
        if (++visited > maxVisitedEntries) {
          exhausted = true;
          return { kind: "incomplete" } as const;
        }
        if (visibility === "sandbox-admission" || !ignoredSearchEntries.has(entry.name)) entries.push(entry);
      }
    } catch { return { kind: "unavailable" } as const; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { kind: "entries", entries } as const;
  }

  async function* descend(relative: string, depth: number): AsyncGenerator<FileWalkEvent> {
    if (signal?.aborted || exhausted) return;
    if (depth > maxWalkDepth) { yield { kind: "incomplete" }; return; }
    const directory = await readDirectory(relative);
    if (directory.kind === "cancelled") return;
    if (directory.kind !== "entries") { yield directory; return; }
    for (const entry of directory.entries) {
      if (signal?.aborted || exhausted) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) yield* descend(path, depth + 1);
      else if (entry.isFile()) yield { kind: "file", path };
      else if (visibility === "sandbox-admission" && !entry.isSymbolicLink()) yield { kind: "unavailable" };
    }
  }
  yield* descend("", 0);
}
