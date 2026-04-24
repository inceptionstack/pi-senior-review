/**
 * context.ts — Build rich review context
 *
 * Gathers: file tree, changed files list, full file contents, git diff.
 * Falls back gracefully when git is unavailable.
 *
 * All size limits are threaded explicitly through function parameters —
 * no module-level mutable state.
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

/**
 * Size limits for content gathering.
 * The "large" profile targets ~800k chars (~200k tokens) for models with 1M+ context.
 * The "fallback" profile targets ~120k chars (~30k tokens) for 200k context models
 * or when the large profile triggers a context-too-long error.
 */
export interface ContentSizeLimits {
  maxFileSize: number;
  maxTotalContentSize: number;
  maxDiffSize: number;
}

export const LARGE_LIMITS: ContentSizeLimits = {
  maxFileSize: 80_000,
  maxTotalContentSize: 400_000,
  maxDiffSize: 200_000,
};

export const FALLBACK_LIMITS: ContentSizeLimits = {
  maxFileSize: 10_000,
  maxTotalContentSize: 60_000,
  maxDiffSize: 30_000,
};

export interface ReadFilesResult {
  sections: string[];
  contents: Map<string, string>;
  totalSize: number;
}

/**
 * Read changed files and return formatted sections + raw contents.
 * Shared by all review paths to avoid duplication.
 */
export async function readChangedFiles(
  pi: ExtensionAPI,
  files: string[],
  opts?: {
    root?: string;
    newFiles?: Set<string>;
    onStatus?: (msg: string) => void;
    limits?: ContentSizeLimits;
  },
): Promise<ReadFilesResult> {
  const sections: string[] = [];
  const contents = new Map<string, string>();
  let totalSize = 0;
  const root = opts?.root;
  const limits = opts?.limits ?? LARGE_LIMITS;

  for (const file of files) {
    if (totalSize >= limits.maxTotalContentSize) {
      sections.push(`### ${file}\n(skipped — total content size limit reached)`);
      contents.set(file, "(skipped — total content size limit reached)");
      continue;
    }

    const fullPath = root ? `${root}/${file}` : file;
    opts?.onStatus?.(`reading ${fullPath}…`);

    const readResult = await pi.exec("head", ["-c", String(limits.maxFileSize + 100), fullPath], {
      timeout: 5000,
    });

    if (readResult.code !== 0 || !readResult.stdout) {
      sections.push(`### ${file}\n(could not read — file may be deleted)`);
      contents.set(file, "(could not read — file may be deleted)");
      continue;
    }

    let content = readResult.stdout;
    totalSize += content.length;

    if (content.length > limits.maxFileSize) {
      content =
        content.slice(0, limits.maxFileSize) + `\n\n... (truncated, ${content.length} total chars)`;
    }

    const newLabel = opts?.newFiles?.has(file) ? " (new file)" : "";
    sections.push(`### ${file}${newLabel}\n\`\`\`\n${content}\n\`\`\``);
    contents.set(file, content);
  }

  return { sections, contents, totalSize };
}

/**
 * Build full review context from the current working directory.
 */
export async function buildReviewContext(
  pi: ExtensionAPI,
  onStatus?: (msg: string) => void,
  ignorePatterns?: string[],
  limits?: ContentSizeLimits,
): Promise<ReviewContext | null> {
  const lim = limits ?? LARGE_LIMITS;
  onStatus?.("getting diff…");

  const fullDiffResult = await pi.exec("git", ["diff", "HEAD"], { timeout: 15000 });
  let diff = fullDiffResult.code === 0 ? fullDiffResult.stdout.trim() : "";

  onStatus?.("listing changed files…");
  const changedResult = await pi.exec("git", ["diff", "HEAD", "--name-only"], { timeout: 5000 });
  let changedFiles =
    changedResult.code === 0 ? changedResult.stdout.trim().split("\n").filter(Boolean) : [];

  // Include untracked (new) files
  const untrackedResult = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], {
    timeout: 5000,
  });
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

  const { contents: fileContents } = await readChangedFiles(pi, changedFiles, {
    onStatus,
    limits: lim,
  });

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
export function formatReviewContext(ctx: ReviewContext, limits?: ContentSizeLimits): string {
  const maxDiff = (limits ?? LARGE_LIMITS).maxDiffSize;
  const parts: string[] = [];

  parts.push(`## Changed files (${ctx.changedFiles.length})\n`);
  for (const f of ctx.changedFiles) {
    parts.push(`- ${f}`);
  }

  parts.push(`\n## Full file contents\n`);
  for (const [file, content] of ctx.fileContents) {
    parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  parts.push(`## Git diff\n\`\`\`diff\n${truncateDiff(ctx.diff, maxDiff)}\n\`\`\`\n`);

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

// ── Helper: format tool call summary section ────────

function buildSummarySection(agentToolCalls: TrackedToolCall[]): {
  summarySection: string;
  changeSummary: string;
} {
  const changeSummary = buildChangeSummary(agentToolCalls);
  const summarySection = changeSummary.trim()
    ? `\n\n---\n\n## Agent tool calls (what was changed)\n\n${changeSummary}`
    : "";
  return { summarySection, changeSummary };
}

// ── Path 1: git diff from known git roots ───────────

/**
 * Try to build review content from each known git root.
 * For each root: get diff + untracked files, read full contents, include commit log.
 */
export async function getContentFromGitRoots(
  pi: ExtensionAPI,
  gitRoots: Set<string>,
  ignorePatterns: string[] | undefined,
  summarySection: string,
  onStatus?: (msg: string) => void,
  limits?: ContentSizeLimits,
): Promise<ReviewContent | null> {
  const allContexts: string[] = [];
  const allFiles: string[] = [];

  for (const root of gitRoots) {
    onStatus?.(`checking ${root}…`);
    const repoContext = await buildRepoContext(pi, root, ignorePatterns, onStatus, limits);
    if (!repoContext) continue;

    allFiles.push(...repoContext.files.map((f) => `${root}/${f}`));
    allContexts.push(repoContext.text);
  }

  if (allContexts.length === 0) return null;

  log("path1: returning", allContexts.length, "repo(s)", "files=", allFiles);
  return {
    content: allContexts.join("\n\n---\n\n") + summarySection,
    label: `${allContexts.length} repo(s)`,
    files: allFiles,
  };
}

/**
 * Build context text for a single git repo.
 * Tries uncommitted changes first, falls back to last commit, then untracked-only.
 */
async function buildRepoContext(
  pi: ExtensionAPI,
  root: string,
  ignorePatterns: string[] | undefined,
  onStatus?: (msg: string) => void,
  limits?: ContentSizeLimits,
): Promise<{ text: string; files: string[] } | null> {
  const lim = limits ?? LARGE_LIMITS;
  let diff = "";
  let files: string[] = [];
  let commitLabel = "";
  const untrackedFiles = new Set<string>();

  // Always check for untracked (new) files first — these are invisible to git diff
  const untracked = await listUntrackedFiles(pi, root);
  for (const f of untracked) untrackedFiles.add(f);

  // Try uncommitted changes (staged + unstaged vs HEAD)
  const result = await pi.exec("git", ["-C", root, "diff", "HEAD"], { timeout: 15000 });
  if (result.code === 0 && result.stdout.trim()) {
    diff = result.stdout.trim();
    files = await listDiffFiles(pi, root, "HEAD");

    // Merge in untracked files
    const existing = new Set(files);
    for (const f of untracked) {
      if (!existing.has(f)) files.push(f);
    }
  } else if (untracked.length > 0) {
    // No tracked changes but we have untracked files — use those directly
    // (don't fall through to last-commit which would review stale files)
    files = [...untracked];
  } else {
    // No uncommitted changes AND no untracked files — fall back to last commit
    const lastResult = await pi.exec("git", ["-C", root, "diff", "HEAD~1", "HEAD"], {
      timeout: 15000,
    });
    if (lastResult.code === 0 && lastResult.stdout.trim()) {
      diff = lastResult.stdout.trim();
      const logResult = await pi.exec("git", ["-C", root, "log", "--oneline", "-1"], {
        timeout: 5000,
      });
      commitLabel = ` (last commit: ${logResult.stdout.trim()})`;
      files = await listDiffFiles(pi, root, "HEAD~1", "HEAD");
    }
  }

  // If still nothing found, bail out
  if (files.length === 0 && !diff) return null;

  const filteredFiles = ignorePatterns ? filterIgnored(files, ignorePatterns) : files;
  if (filteredFiles.length === 0) return null;

  // Read full contents of each changed file
  const { sections: fileSections } = await readChangedFiles(pi, filteredFiles, {
    root,
    newFiles: untrackedFiles,
    onStatus,
    limits: lim,
  });

  // Re-run diff scoped to filtered files only (use correct range)
  let scopedDiff = diff;
  if (ignorePatterns && filteredFiles.length < files.length) {
    const scopedArgs = commitLabel
      ? ["diff", "HEAD~1", "HEAD", "--", ...filteredFiles]
      : ["diff", "HEAD", "--", ...filteredFiles];
    const scopedResult = await pi.exec("git", ["-C", root, ...scopedArgs], { timeout: 15000 });
    if (scopedResult.code === 0 && scopedResult.stdout.trim()) {
      scopedDiff = scopedResult.stdout.trim();
    }
  }

  log(
    "path1: root=",
    root,
    "diff=",
    diff.length,
    "files=",
    filteredFiles,
    "fileSections=",
    fileSections.length,
  );

  // Get recent commit messages for context
  const commitLogResult = await pi.exec("git", ["-C", root, "log", "--oneline", "-10"], {
    timeout: 5000,
  });
  const commitLog = commitLogResult.code === 0 ? commitLogResult.stdout.trim() : "";
  const commitSection = commitLog ? `## Recent commits\n\`\`\`\n${commitLog}\n\`\`\`\n\n` : "";

  const fileList = filteredFiles.map((f) => (untrackedFiles.has(f) ? `${f} (new)` : f)).join(", ");

  const text =
    `## Repo: ${root}${commitLabel}\n\n` +
    `Changed files: ${fileList}\n\n` +
    commitSection +
    `## Full file contents\n\n${fileSections.join("\n\n")}\n\n` +
    `## Git diff\n\`\`\`diff\n${truncateDiff(scopedDiff, lim.maxDiffSize)}\n\`\`\``;

  return { text, files: filteredFiles };
}

/** List files changed in a git diff range. */
async function listDiffFiles(
  pi: ExtensionAPI,
  root: string,
  ...range: string[]
): Promise<string[]> {
  const result = await pi.exec("git", ["-C", root, "diff", ...range, "--name-only"], {
    timeout: 5000,
  });
  return result.code === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
}

/** List untracked files in a git repo. */
async function listUntrackedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await pi.exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], {
    timeout: 5000,
  });
  return result.code === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
}

// ── Path 2: cwd as git repo (full buildReviewContext) ──

export async function getContentFromCwd(
  pi: ExtensionAPI,
  ignorePatterns: string[] | undefined,
  summarySection: string,
  onStatus?: (msg: string) => void,
  limits?: ContentSizeLimits,
): Promise<ReviewContent | null> {
  const lim = limits ?? LARGE_LIMITS;
  const reviewContext = await buildReviewContext(pi, onStatus, ignorePatterns, lim);
  if (!reviewContext) return null;

  log("path2: cwd git repo, files=", reviewContext.changedFiles);
  return {
    content: formatReviewContext(reviewContext, lim) + summarySection,
    label: "",
    files: reviewContext.changedFiles,
  };
}

// ── Path 3: last commit from cwd ─────────────────────

export async function getContentFromLastCommit(
  pi: ExtensionAPI,
  ignorePatterns: string[] | undefined,
  summarySection: string,
  onStatus?: (msg: string) => void,
  limits?: ContentSizeLimits,
): Promise<ReviewContent | null> {
  const lim = limits ?? LARGE_LIMITS;
  onStatus?.("checking last commit…");
  try {
    const lastCommitDiff = await pi.exec("git", ["diff", "HEAD~1", "HEAD"], { timeout: 15000 });
    if (lastCommitDiff.code !== 0 || !lastCommitDiff.stdout.trim()) return null;

    const commitLog = (
      await pi.exec("git", ["log", "--oneline", "-10"], { timeout: 5000 })
    ).stdout.trim();
    const nameResult = await pi.exec("git", ["diff", "HEAD~1", "HEAD", "--name-only"], {
      timeout: 5000,
    });
    let files = nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];

    // Apply ignore patterns so the last-commit fallback respects .senior-review/ignore
    if (ignorePatterns && ignorePatterns.length > 0) {
      files = filterIgnored(files, ignorePatterns);
    }
    if (files.length === 0) return null;

    // Re-scope diff to filtered files only
    let diff = lastCommitDiff.stdout.trim();
    if (ignorePatterns && ignorePatterns.length > 0) {
      const scopedResult = await pi.exec("git", ["diff", "HEAD~1", "HEAD", "--", ...files], {
        timeout: 15000,
      });
      if (scopedResult.code === 0 && scopedResult.stdout.trim()) {
        diff = scopedResult.stdout.trim();
      }
    }

    const truncated = truncateDiff(diff, lim.maxDiffSize);

    const { sections: fileSections } = await readChangedFiles(pi, files, {
      onStatus,
      limits: lim,
    });
    const fileSection =
      fileSections.length > 0 ? `\n\n## Full file contents\n\n${fileSections.join("\n\n")}` : "";

    log("path3: last commit, files=", files);
    return {
      content: `## Recent commits\n\`\`\`\n${commitLog}\n\`\`\`${fileSection}\n\n## Diff\n\`\`\`diff\n${truncated}\n\`\`\`${summarySection}`,
      label: "last commit",
      files,
    };
  } catch {
    return null;
  }
}

// ── Path 4: read files directly from tool calls (no git) ──

export async function getContentFromToolCalls(
  pi: ExtensionAPI,
  agentToolCalls: TrackedToolCall[],
  changeSummary: string,
  onStatus?: (msg: string) => void,
  limits?: ContentSizeLimits,
): Promise<ReviewContent | null> {
  const lim = limits ?? LARGE_LIMITS;
  if (agentToolCalls.length === 0) return null;

  const candidatePaths = collectModifiedPaths(agentToolCalls);
  const parts: string[] = [];
  const reviewedFiles: string[] = [];

  for (const filePath of candidatePaths) {
    if (isBinaryPath(filePath)) continue;

    onStatus?.(`reading ${filePath}…`);
    try {
      const result = await pi.exec("head", ["-c", String(MAX_NON_GIT_FILE_SIZE + 100), filePath], {
        timeout: 5000,
      });
      if (result.code !== 0 || !result.stdout) continue;
      if (result.stdout.includes("\0")) continue;
      if (result.stdout.length > MAX_NON_GIT_FILE_SIZE) continue;

      reviewedFiles.push(filePath);
      const fileContent =
        result.stdout.length > lim.maxFileSize
          ? result.stdout.slice(0, lim.maxFileSize) +
            `\n\n... (truncated, ${result.stdout.length} total chars)`
          : result.stdout;
      parts.push(`### ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``);
    } catch {
      // skip unreadable files
    }
  }

  if (parts.length === 0 && !changeSummary.trim()) return null;

  const content = [
    parts.length > 0 ? `## Files (read directly, no git)\n\n${parts.join("\n\n")}` : "",
    changeSummary.trim() ? `## Tool call summary\n\n${changeSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return { content, label: "tracked changes", files: reviewedFiles };
}

// ── Main entry: try each path in order ───────────────

/**
 * Get the best available review content.
 * Tries: git roots → cwd git repo → last commit → tool call summaries.
 * All size limits are threaded explicitly to sub-functions.
 */
export async function getBestReviewContent(
  pi: ExtensionAPI,
  agentToolCalls: TrackedToolCall[],
  onStatus?: (msg: string) => void,
  ignorePatterns?: string[],
  gitRoots?: Set<string>,
  limits?: ContentSizeLimits,
): Promise<ReviewContent | null> {
  const lim = limits ?? LARGE_LIMITS;

  log(
    "getBestReviewContent: gitRoots=",
    gitRoots ? [...gitRoots] : "none",
    "toolCalls=",
    agentToolCalls.length,
  );

  const { summarySection, changeSummary } = buildSummarySection(agentToolCalls);

  if (gitRoots && gitRoots.size > 0) {
    const result = await getContentFromGitRoots(
      pi,
      gitRoots,
      ignorePatterns,
      summarySection,
      onStatus,
      lim,
    );
    if (result) return result;
  }

  const cwdResult = await getContentFromCwd(pi, ignorePatterns, summarySection, onStatus, lim);
  if (cwdResult) return cwdResult;

  const lastCommitResult = await getContentFromLastCommit(
    pi,
    ignorePatterns,
    summarySection,
    onStatus,
    lim,
  );
  if (lastCommitResult) return lastCommitResult;

  return getContentFromToolCalls(pi, agentToolCalls, changeSummary, onStatus, lim);
}
