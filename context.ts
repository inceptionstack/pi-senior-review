/**
 * context.ts — Build rich review context
 *
 * Gathers: file tree, changed files list, full file contents, git diff.
 * Falls back gracefully when git is unavailable.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateDiff } from "./helpers";
import { filterIgnored } from "./ignore";
import { log } from "./logger";
import {
  type TrackedToolCall,
  buildChangeSummary,
  collectModifiedPaths,
  isBinaryPath,
  MAX_NON_GIT_FILE_SIZE,
} from "./changes";

export interface ReviewContext {
  diff: string;
  changedFiles: string[];
  fileContents: Map<string, string>;
  fileTree: string;
  commitLog: string;
}

const MAX_FILE_SIZE = 10_000;
const MAX_TOTAL_CONTENT_SIZE = 60_000;

/**
 * Build full review context from the current working directory.
 */
export async function buildReviewContext(
  pi: ExtensionAPI,
  onStatus?: (msg: string) => void,
  ignorePatterns?: string[],
): Promise<ReviewContext | null> {
  onStatus?.("getting diff…");

  const fullDiffResult = await pi.exec("git", ["diff", "HEAD"], { timeout: 15000 });
  let diff = fullDiffResult.code === 0 ? fullDiffResult.stdout.trim() : "";

  onStatus?.("listing changed files…");
  const changedResult = await pi.exec("git", ["diff", "HEAD", "--name-only"], { timeout: 5000 });
  let changedFiles =
    changedResult.code === 0 ? changedResult.stdout.trim().split("\n").filter(Boolean) : [];

  // Include untracked (new) files
  const untrackedResult = await pi.exec(
    "git", ["ls-files", "--others", "--exclude-standard"],
    { timeout: 5000 },
  );
  if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
    const untracked = untrackedResult.stdout.trim().split("\n").filter(Boolean);
    const existing = new Set(changedFiles);
    for (const f of untracked) {
      if (!existing.has(f)) changedFiles.push(f);
    }
  }

  if (!diff && changedFiles.length === 0) return null;

  if (ignorePatterns && ignorePatterns.length > 0) {
    const before = changedFiles.length;
    changedFiles = filterIgnored(changedFiles, ignorePatterns);
    if (changedFiles.length < before) {
      onStatus?.(`filtered ${before - changedFiles.length} ignored files`);
    }
  }

  if (changedFiles.length === 0) return null;

  if (ignorePatterns && ignorePatterns.length > 0) {
    const filteredDiffResult = await pi.exec("git", ["diff", "HEAD", "--", ...changedFiles], {
      timeout: 15000,
    });
    if (filteredDiffResult.code === 0 && filteredDiffResult.stdout.trim()) {
      diff = filteredDiffResult.stdout.trim();
    }
  }

  const fileContents = new Map<string, string>();
  let totalContentSize = 0;

  for (const file of changedFiles) {
    if (totalContentSize >= MAX_TOTAL_CONTENT_SIZE) {
      fileContents.set(file, "(skipped — total content size limit reached)");
      continue;
    }

    onStatus?.(`reading ${file}…`);
    try {
      const readResult = await pi.exec("head", ["-c", String(MAX_FILE_SIZE + 100), file], {
        timeout: 5000,
      });

      if (readResult.code !== 0 || !readResult.stdout) {
        fileContents.set(file, "(could not read — file may be deleted)");
        continue;
      }

      let content = readResult.stdout;
      totalContentSize += content.length;

      if (content.length > MAX_FILE_SIZE) {
        content =
          content.slice(0, MAX_FILE_SIZE) + `\n\n... (truncated, ${content.length} total chars)`;
      }

      fileContents.set(file, content);
    } catch {
      fileContents.set(file, "(could not read — file may be deleted)");
    }
  }

  onStatus?.("scanning file tree…");
  const treeResult = await pi.exec(
    "find",
    [
      ".",
      "-maxdepth",
      "3",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
    ],
    { timeout: 5000 },
  );
  const fileTree = treeResult.code === 0 ? treeResult.stdout.trim() : "(file tree unavailable)";

  onStatus?.("getting commit history…");
  const commitLogResult = await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 5000 });
  const commitLog = commitLogResult.code === 0 ? commitLogResult.stdout.trim() : "";

  return { diff, changedFiles, fileContents, fileTree, commitLog };
}

/**
 * Format the review context into a prompt section.
 */
export function formatReviewContext(ctx: ReviewContext): string {
  const parts: string[] = [];

  parts.push(`## Changed files (${ctx.changedFiles.length})\n`);
  for (const f of ctx.changedFiles) {
    parts.push(`- ${f}`);
  }

  parts.push(`\n## Full file contents\n`);
  for (const [file, content] of ctx.fileContents) {
    parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  parts.push(`## Git diff\n\`\`\`diff\n${truncateDiff(ctx.diff, 30000)}\n\`\`\`\n`);

  if (ctx.commitLog) {
    parts.push(`## Recent commits\n\`\`\`\n${ctx.commitLog}\n\`\`\`\n`);
  }

  parts.push(`## Project file tree (depth 3)\n\`\`\`\n${ctx.fileTree.slice(0, 5000)}\n\`\`\`\n`);

  return parts.join("\n");
}

export interface ReviewContent {
  content: string;
  label: string;
  files: string[];
}

/**
 * Get the best available review content.
 * Tries: git diff from detected repos → git diff from cwd → tool call summaries.
 */
export async function getBestReviewContent(
  pi: ExtensionAPI,
  agentToolCalls: TrackedToolCall[],
  onStatus?: (msg: string) => void,
  ignorePatterns?: string[],
  gitRoots?: Set<string>,
): Promise<ReviewContent | null> {
  log("getBestReviewContent: gitRoots=", gitRoots ? [...gitRoots] : "none", "toolCalls=", agentToolCalls.length);
  // 1. Try each known git root
  if (gitRoots && gitRoots.size > 0) {
    const allContexts: string[] = [];
    const allFiles: string[] = [];

    for (const root of gitRoots) {
      onStatus?.(`checking ${root}…`);

      // Try uncommitted changes, then fall back to last commit
      let diff = "";
      let files: string[] = [];
      let commitLabel = "";
      const untrackedFiles = new Set<string>();

      const result = await pi.exec("git", ["-C", root, "diff", "HEAD"], { timeout: 15000 });
      if (result.code === 0 && result.stdout.trim()) {
        diff = result.stdout.trim();
        const nameResult = await pi.exec("git", ["-C", root, "diff", "HEAD", "--name-only"], {
          timeout: 5000,
        });
        files =
          nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];

        // Also include untracked (new) files — git diff HEAD misses them
        const untrackedResult = await pi.exec(
          "git", ["-C", root, "ls-files", "--others", "--exclude-standard"],
          { timeout: 5000 },
        );
        if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
          const untracked = untrackedResult.stdout.trim().split("\n").filter(Boolean);
          const existing = new Set(files);
          for (const f of untracked) {
            if (!existing.has(f)) {
              files.push(f);
              untrackedFiles.add(f);
            }
          }
        }
      } else {
        // Try last commit
        const lastResult = await pi.exec("git", ["-C", root, "diff", "HEAD~1", "HEAD"], {
          timeout: 15000,
        });
        if (lastResult.code === 0 && lastResult.stdout.trim()) {
          diff = lastResult.stdout.trim();
          const logResult = await pi.exec("git", ["-C", root, "log", "--oneline", "-1"], {
            timeout: 5000,
          });
          commitLabel = ` (last commit: ${logResult.stdout.trim()})`;
          const nameResult = await pi.exec(
            "git",
            ["-C", root, "diff", "HEAD~1", "HEAD", "--name-only"],
            { timeout: 5000 },
          );
          files =
            nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];
        }
      }

      // If no diff from tracked changes, check for untracked files only
      if (!diff) {
        const untrackedResult = await pi.exec(
          "git", ["-C", root, "ls-files", "--others", "--exclude-standard"],
          { timeout: 5000 },
        );
        if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
          files = untrackedResult.stdout.trim().split("\n").filter(Boolean);
          for (const f of files) untrackedFiles.add(f);
        }
        if (files.length === 0) continue;
      }

      const filteredFiles = ignorePatterns ? filterIgnored(files, ignorePatterns) : files;
      if (filteredFiles.length === 0) continue;

      allFiles.push(...filteredFiles.map((f) => `${root}/${f}`));

      // Read full contents of each changed file
      const fileSections: string[] = [];
      let totalContentSize = 0;
      for (const file of filteredFiles) {
        if (totalContentSize >= MAX_TOTAL_CONTENT_SIZE) {
          fileSections.push(`### ${file}\n(skipped — total content size limit reached)`);
          continue;
        }
        onStatus?.(`reading ${root}/${file}…`);
        const readResult = await pi.exec(
          "head", ["-c", String(MAX_FILE_SIZE + 100), `${root}/${file}`],
          { timeout: 5000 },
        );
        if (readResult.code !== 0 || !readResult.stdout) {
          fileSections.push(`### ${file}\n(could not read — file may be deleted)`);
          continue;
        }
        let content = readResult.stdout;
        totalContentSize += content.length;
        if (content.length > MAX_FILE_SIZE) {
          content = content.slice(0, MAX_FILE_SIZE) +
            `\n\n... (truncated, ${content.length} total chars)`;
        }
        const newLabel = untrackedFiles.has(file) ? " (new file)" : "";
        fileSections.push(`### ${file}${newLabel}\n\`\`\`\n${content}\n\`\`\``);
      }

      // Re-run diff scoped to filtered files only (use correct range)
      let scopedDiff = diff;
      if (ignorePatterns && filteredFiles.length < files.length) {
        const scopedArgs = commitLabel
          ? ["diff", "HEAD~1", "HEAD", "--", ...filteredFiles]   // last commit
          : ["diff", "HEAD", "--", ...filteredFiles];            // uncommitted
        const scopedResult = await pi.exec("git", ["-C", root, ...scopedArgs], { timeout: 15000 });
        if (scopedResult.code === 0 && scopedResult.stdout.trim()) {
          scopedDiff = scopedResult.stdout.trim();
        }
      }

      log("path1: root=", root, "diff=", diff.length, "files=", filteredFiles, "fileSections=", fileSections.length);

      // Get recent commit messages for context
      const commitLogResult = await pi.exec(
        "git", ["-C", root, "log", "--oneline", "-10"],
        { timeout: 5000 },
      );
      const commitLog = commitLogResult.code === 0 ? commitLogResult.stdout.trim() : "";
      const commitSection = commitLog
        ? `## Recent commits\n\`\`\`\n${commitLog}\n\`\`\`\n\n`
        : "";

      const fileList = filteredFiles
        .map(f => untrackedFiles.has(f) ? `${f} (new)` : f)
        .join(", ");

      allContexts.push(
        `## Repo: ${root}${commitLabel}\n\n` +
        `Changed files: ${fileList}\n\n` +
        commitSection +
        `## Full file contents\n\n${fileSections.join("\n\n")}\n\n` +
        `## Git diff\n\`\`\`diff\n${truncateDiff(scopedDiff, 30000)}\n\`\`\``,
      )
    }

    if (allContexts.length > 0) {
      // Append tool call summary so the reviewer sees exactly what edits were made
      const changeSummary = buildChangeSummary(agentToolCalls);
      const summarySection = changeSummary.trim()
        ? `\n\n---\n\n## Agent tool calls (what was changed)\n\n${changeSummary}`
        : "";
      log("path1: returning", allContexts.length, "repo(s)", "files=", allFiles);
      return {
        content: allContexts.join("\n\n---\n\n") + summarySection,
        label: `${allContexts.length} repo(s)`,
        files: allFiles,
      };
    }
  }

  // 2. Fallback: try cwd as git repo
  const reviewContext = await buildReviewContext(pi, onStatus, ignorePatterns);
  if (reviewContext) {
    log("path2: cwd git repo, files=", reviewContext.changedFiles);
    const changeSummary = buildChangeSummary(agentToolCalls);
    const summarySection = changeSummary.trim()
      ? `\n\n## Agent tool calls (what was changed)\n\n${changeSummary}`
      : "";
    return {
      content: formatReviewContext(reviewContext) + summarySection,
      label: "",
      files: reviewContext.changedFiles,
    };
  }

  // 3. Try last commit from cwd
  onStatus?.("checking last commit…");
  try {
    const lastCommitDiff = await pi.exec("git", ["diff", "HEAD~1", "HEAD"], { timeout: 15000 });
    if (lastCommitDiff.code === 0 && lastCommitDiff.stdout.trim()) {
      const truncated = truncateDiff(lastCommitDiff.stdout.trim(), 30000);
      const commitLog = (
        await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 5000 })
      ).stdout.trim();
      const nameResult = await pi.exec("git", ["diff", "HEAD~1", "HEAD", "--name-only"], {
        timeout: 5000,
      });
      const files =
        nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];

      // Read full contents of changed files
      const fileSections: string[] = [];
      let totalContentSize = 0;
      for (const file of files) {
        if (totalContentSize >= MAX_TOTAL_CONTENT_SIZE) break;
        onStatus?.(`reading ${file}…`);
        const readResult = await pi.exec(
          "head", ["-c", String(MAX_FILE_SIZE + 100), file],
          { timeout: 5000 },
        );
        if (readResult.code !== 0 || !readResult.stdout) continue;
        let content = readResult.stdout;
        totalContentSize += content.length;
        if (content.length > MAX_FILE_SIZE) {
          content = content.slice(0, MAX_FILE_SIZE) +
            `\n\n... (truncated, ${content.length} total chars)`;
        }
        fileSections.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
      }

      const changeSummary = buildChangeSummary(agentToolCalls);
      const summarySection = changeSummary.trim()
        ? `\n\n## Agent tool calls (what was changed)\n\n${changeSummary}`
        : "";
      const fileSection = fileSections.length > 0
        ? `\n\n## Full file contents\n\n${fileSections.join("\n\n")}`
        : "";

      log("path3: last commit, files=", files);

      return {
        content: `## Recent commits\n\`\`\`\n${commitLog}\n\`\`\`${fileSection}\n\n## Diff\n\`\`\`diff\n${truncated}\n\`\`\`${summarySection}`,
        label: "last commit",
        files,
      };
    }
  } catch {
    /* git not available */
  }

  // 4. Fall back: read files directly (no git available)
  // Collect all potential file paths from tool calls and read them
  if (agentToolCalls.length > 0) {
    const candidatePaths = collectModifiedPaths(agentToolCalls);

    const parts: string[] = [];
    const reviewedFiles: string[] = [];

    for (const filePath of candidatePaths) {
      if (isBinaryPath(filePath)) continue;

      onStatus?.(`reading ${filePath}…`);
      try {
        const result = await pi.exec(
          "head",
          ["-c", String(MAX_NON_GIT_FILE_SIZE + 100), filePath],
          { timeout: 5000 },
        );
        if (result.code !== 0 || !result.stdout) continue;

        // Skip files that look binary (contain null bytes)
        if (result.stdout.includes("\0")) continue;

        // Skip files larger than limit
        if (result.stdout.length > MAX_NON_GIT_FILE_SIZE) continue;

        reviewedFiles.push(filePath);
        const fileContent =
          result.stdout.length > 10000
            ? result.stdout.slice(0, 10000) +
              `\n\n... (truncated, ${result.stdout.length} total chars)`
            : result.stdout;
        parts.push(`### ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``);
      } catch {
        // File doesn't exist or can't be read — skip
      }
    }

    // Also include the tool call summary for context
    const summary = buildChangeSummary(agentToolCalls);

    if (parts.length > 0 || summary.trim()) {
      const content = [
        parts.length > 0 ? `## Files (read directly, no git)\n\n${parts.join("\n\n")}` : "",
        summary.trim() ? `## Tool call summary\n\n${summary}` : "",
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      return { content, label: "tracked changes", files: reviewedFiles };
    }
  }

  return null;
}
