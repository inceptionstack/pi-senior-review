/**
 * git-roots.ts — Detect git repo roots from modified file paths
 * Expands ~ to homedir for correct path resolution.
 * Caches resolved roots to avoid repeated git calls.
 */

import { dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Find the git repo root for a given directory.
 * Returns null if not in a git repo.
 */
export async function findGitRoot(pi: ExtensionAPI, dir: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
    });
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch { /* not in a git repo */ }
  return null;
}

/**
 * Given a set of modified file paths and pi's cwd, find all unique
 * git repo roots that contain the modified files.
 *
 * Returns a map of gitRoot → list of files in that repo.
 * Files not in any git repo are grouped under the key "(no-git)".
 */
export async function resolveGitRoots(
  pi: ExtensionAPI,
  cwd: string,
  modifiedFiles: Set<string>,
): Promise<Map<string, string[]>> {
  const roots = new Map<string, string[]>();
  const resolvedCache = new Map<string, string | null>(); // dir → gitRoot cache

  for (const file of modifiedFiles) {
    if (file === "(bash file op)") continue;

    // Expand ~ to homedir
    const expanded = file.startsWith("~/") ? resolve(homedir(), file.slice(2)) : file;
    const absPath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const dir = dirname(absPath);

    // Check cache first
    let gitRoot: string | null | undefined = resolvedCache.get(dir);
    if (gitRoot === undefined) {
      gitRoot = await findGitRoot(pi, dir);
      resolvedCache.set(dir, gitRoot);
    }

    const key = gitRoot ?? "(no-git)";
    const list = roots.get(key) ?? [];
    list.push(file);
    roots.set(key, list);
  }

  // Also try cwd itself if no files resolved to repos
  if (roots.size === 0) {
    const cwdRoot = await findGitRoot(pi, cwd);
    if (cwdRoot) {
      roots.set(cwdRoot, []);
    }
  }

  return roots;
}

/**
 * Resolve all git roots from multiple sources:
 * tracked modified files, tool call paths, and detected bash git roots.
 */
export async function resolveAllGitRoots(
  pi: ExtensionAPI,
  cwd: string,
  modifiedFiles: Set<string>,
  toolCallPaths: string[],
  detectedGitRoots: Set<string>,
): Promise<Set<string>> {
  const allRoots = new Set(detectedGitRoots);
  const combinedFiles = new Set([...modifiedFiles, ...toolCallPaths]);
  const fileRoots = await resolveGitRoots(pi, cwd, combinedFiles);
  for (const root of fileRoots.keys()) {
    if (root !== "(no-git)") allRoots.add(root);
  }
  return allRoots;
}
