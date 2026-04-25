import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { type AutoReviewSettings, configDirs } from "./settings";
import { buildReviewPrompt } from "./prompt";
import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "./helpers";
import { runReviewSession } from "./reviewer";
import { sendReviewResult } from "./message-sender";
import { isBinaryPath } from "./changes";
import { LARGE_LIMITS, buildPerFileContext } from "./context";
import { filterIgnored } from "./ignore";
import { log } from "./logger";
import {
  SCAFFOLD_SETTINGS,
  SCAFFOLD_REVIEW_RULES,
  SCAFFOLD_AUTO_REVIEW,
  SCAFFOLD_ARCHITECT_RULES,
  SCAFFOLD_IGNORE,
} from "./scaffold";

type ReviewCallbacks = {
  onActivity: (desc: string) => void;
  onToolCall: (toolName: string, targetPath: string | null) => void;
};

type CommandContext = {
  ui: any;
  hasUI?: boolean;
  cwd: string;
};

export type ManualReviewController = {
  readonly isReviewing: boolean;
  cancel: () => void;
  reset: (ctx: CommandContext) => void;
};

export interface RegisterCommandsOptions {
  pi: ExtensionAPI;
  getSettings: () => AutoReviewSettings;
  getCustomRules: () => string | null;
  setCustomRules: (rules: string | null) => void;
  getAutoReviewRules: () => string | null;
  getIgnorePatterns: () => string[] | null;
  getLastUserMessage: () => string | null;
  getDetectedGitRoots: () => Set<string>;
  toggleReview: (ctx: CommandContext) => void | Promise<void>;
  startReviewWidget: (ctx: CommandContext, files: string[]) => ReviewCallbacks;
  finishReview: (ctx: CommandContext, resetTracking?: boolean) => void;
  updateStatus: (ctx: CommandContext) => void;
}

export function registerReviewCommands(opts: RegisterCommandsOptions): ManualReviewController {
  let reviewAbort: AbortController | null = null;
  let isReviewing = false;

  function buildReviewOptions(
    signal: AbortSignal,
    cwd: string,
    filesReviewed: string[],
    onActivity?: (desc: string) => void,
    onToolCall?: (toolName: string, targetPath: string | null) => void,
  ) {
    const settings = opts.getSettings();
    return {
      signal,
      cwd,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      timeoutMs: Math.max(settings.reviewTimeoutMs, filesReviewed.length * 120_000),
      filesReviewed,
      onActivity,
      onToolCall,
    };
  }

  function beginManualReview(ctx: CommandContext) {
    isReviewing = true;
    reviewAbort = new AbortController();
    opts.updateStatus(ctx);
  }

  function finishManualReview(ctx: CommandContext) {
    isReviewing = false;
    reviewAbort = null;
    opts.finishReview(ctx, false);
  }

  function cancelInProgress() {
    if (!reviewAbort) return;
    reviewAbort.abort();
    isReviewing = false;
    reviewAbort = null;
  }

  registerConfigCommands(opts);

  opts.pi.registerCommand("review", {
    description: "Toggle senior review, or '/review <N>' to review last N commits",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed || !/^\d+$/.test(trimmed)) {
        await opts.toggleReview(ctx);
        return;
      }

      const count = parseInt(trimmed, 10);
      if (count <= 0) {
        ctx.ui.notify("Usage: /review <N> where N > 0", "warning");
        return;
      }

      ctx.ui.notify("Reviewing commits…", "info");

      if (isReviewing && reviewAbort) {
        log("Cancelling in-progress review for /review N");
        cancelInProgress();
      }

      beginManualReview(ctx);

      try {
        const countResult = await opts.pi.exec("git", ["rev-list", "--count", "HEAD"], {
          timeout: 5000,
        });
        if (countResult.code !== 0) log(`git rev-list failed: ${countResult.stderr.trim()}`);

        const totalCommits = parseInt(countResult.stdout.trim(), 10) || 0;
        if (totalCommits === 0) {
          ctx.ui.notify("No commits found in this repo.", "warning");
          return;
        }

        const { effectiveCount, wasClamped } = clampCommitCount(count, totalCommits);
        if (wasClamped) ctx.ui.notify(`Repo has ${totalCommits} commits. Reviewing all.`, "info");

        const diffArgs: string[] = [];
        if (shouldDiffAllCommits(effectiveCount, totalCommits)) {
          const emptyTree = (
            await opts.pi.exec("git", ["hash-object", "-t", "tree", "/dev/null"], {
              timeout: 5000,
            })
          ).stdout.trim();
          diffArgs.push("diff", emptyTree, "HEAD");
        } else {
          diffArgs.push("diff", `HEAD~${effectiveCount}`, "HEAD");
        }

        const nameArgs = [...diffArgs, "--name-only"];
        const nameResult = await opts.pi.exec("git", nameArgs, { timeout: 5000 });
        let changedFiles =
          nameResult.code === 0 ? nameResult.stdout.trim().split("\n").filter(Boolean) : [];

        const ignorePatterns = opts.getIgnorePatterns();
        if (ignorePatterns && ignorePatterns.length > 0) {
          const before = changedFiles.length;
          changedFiles = filterIgnored(changedFiles, ignorePatterns);
          if (changedFiles.length < before) {
            const skipped = before - changedFiles.length;
            ctx.ui.notify(`Filtered ${skipped} ignored file(s)`, "info");
          }
        }

        if (changedFiles.length === 0) {
          ctx.ui.notify(
            `No reviewable changes in last ${effectiveCount} commit(s) (all ignored).`,
            "info",
          );
          return;
        }

        const scopedDiffArgs = [...diffArgs, "--", ...changedFiles];
        const diffResult = await opts.pi.exec("git", scopedDiffArgs, { timeout: 15000 });
        if (diffResult.code !== 0) {
          ctx.ui.notify(`git diff failed: ${diffResult.stderr.slice(0, 200)}`, "error");
          return;
        }

        const diff = diffResult.stdout.trim();
        if (!diff) {
          ctx.ui.notify(`No changes in last ${effectiveCount} commit(s).`, "info");
          return;
        }

        const commitLog = (
          await opts.pi.exec("git", ["log", "--oneline", `-${effectiveCount}`], {
            timeout: 5000,
          })
        ).stdout.trim();
        const truncatedDiff = truncateDiff(diff, LARGE_LIMITS.maxDiffSize);
        const commitLabel = `last ${effectiveCount} commit${effectiveCount > 1 ? "s" : ""}`;

        const prompt = `${buildReviewPrompt(opts.getAutoReviewRules(), opts.getCustomRules(), opts.getLastUserMessage())}\n\n---\n\nReview the following git diff (${commitLabel}):\n\nCommits:\n${commitLog}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
        const { onActivity, onToolCall } = opts.startReviewWidget(ctx, changedFiles);
        const result = await runReviewSession(
          prompt,
          buildReviewOptions(reviewAbort!.signal, ctx.cwd, changedFiles, onActivity, onToolCall),
        );

        sendReviewResult(opts.pi, result, commitLabel);
      } catch (err: any) {
        if (err?.message === "Review cancelled") {
          ctx.ui.notify("Review cancelled", "info");
        } else {
          log(`ERROR: commit review failed: ${err?.message ?? err}`);
          ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
        }
      } finally {
        finishManualReview(ctx);
      }
    },
  });

  opts.pi.registerCommand("review-all", {
    description: "Review all changes in the repo (pending diff, last commit, or all files in cwd)",
    handler: async (_args, ctx) => {
      if (isReviewing && reviewAbort) {
        log("Cancelling in-progress review for /review-all");
        cancelInProgress();
      }

      beginManualReview(ctx);

      try {
        const { resolve } = await import("node:path");

        const gitCheck = await opts.pi.exec("git", ["rev-parse", "--show-toplevel"], {
          timeout: 5000,
        });
        let isGitRepo = gitCheck.code === 0;
        let gitRoot = isGitRepo ? gitCheck.stdout.trim() : null;

        // If cwd isn't a git repo, try the first detected git root from the session
        // (e.g. the agent was working in ~/some-repo but cwd is ~)
        if (!isGitRepo) {
          const detectedRoots = opts.getDetectedGitRoots();
          if (detectedRoots.size > 0) {
            gitRoot = [...detectedRoots][0];
            isGitRepo = true;
            log(`review-all: cwd is not a git repo, using detected root: ${gitRoot}`);
          }
        }

        let reviewFiles: string[] = [];
        let prompt: string;

        if (isGitRepo && gitRoot) {
          const pendingDiff = await opts.pi.exec("git", ["diff", "HEAD"], { timeout: 15000 });
          const hasPendingDiff = pendingDiff.code === 0 && pendingDiff.stdout.trim();

          const pendingNames = await opts.pi.exec("git", ["diff", "HEAD", "--name-only"], {
            timeout: 5000,
          });
          const pendingFiles =
            pendingNames.code === 0 ? pendingNames.stdout.trim().split("\n").filter(Boolean) : [];

          const untrackedResult = await opts.pi.exec(
            "git",
            ["ls-files", "--others", "--exclude-standard"],
            { timeout: 5000 },
          );
          if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
            const untracked = untrackedResult.stdout.trim().split("\n").filter(Boolean);
            const existing = new Set(pendingFiles);
            for (const f of untracked) {
              if (!existing.has(f)) pendingFiles.push(f);
            }
          }

          if (hasPendingDiff || pendingFiles.length > 0) {
            reviewFiles = pendingFiles;
            const ignorePatterns = opts.getIgnorePatterns();
            if (ignorePatterns && ignorePatterns.length > 0) {
              reviewFiles = filterIgnored(reviewFiles, ignorePatterns);
            }

            if (reviewFiles.length === 0) {
              ctx.ui.notify("No reviewable pending changes (all ignored).", "info");
              return;
            }

            const fileSections = await buildPerFileContext(
              opts.pi,
              gitRoot,
              reviewFiles,
              ["HEAD"],
              new Set(),
              LARGE_LIMITS,
            );

            ctx.ui.notify(`Reviewing ${reviewFiles.length} pending file(s)…`, "info");
            prompt = `${buildReviewPrompt(opts.getAutoReviewRules(), opts.getCustomRules(), opts.getLastUserMessage())}\n\n---\n\nReview all pending changes in the repo.\n\n## Files to review\n\nRead each file with read(path) to see its full contents.\n\n${fileSections.join("\n\n---\n\n")}`;
          } else {
            const countResult = await opts.pi.exec("git", ["rev-list", "--count", "HEAD"], {
              timeout: 5000,
            });
            const totalCommits = parseInt(countResult.stdout.trim(), 10) || 0;
            if (totalCommits === 0) {
              ctx.ui.notify("No pending changes and no commits to review.", "info");
              return;
            }

            let diffArgs: string[];
            if (totalCommits === 1) {
              const emptyTree = (
                await opts.pi.exec("git", ["hash-object", "-t", "tree", "/dev/null"], {
                  timeout: 5000,
                })
              ).stdout.trim();
              diffArgs = [emptyTree, "HEAD"];
            } else {
              diffArgs = ["HEAD~1", "HEAD"];
            }

            const lastNames = await opts.pi.exec("git", ["diff", ...diffArgs, "--name-only"], {
              timeout: 5000,
            });
            reviewFiles =
              lastNames.code === 0 ? lastNames.stdout.trim().split("\n").filter(Boolean) : [];

            const ignorePatterns = opts.getIgnorePatterns();
            if (ignorePatterns && ignorePatterns.length > 0) {
              reviewFiles = filterIgnored(reviewFiles, ignorePatterns);
            }

            if (reviewFiles.length === 0) {
              ctx.ui.notify("No reviewable files in last commit (all ignored).", "info");
              return;
            }

            const commitLog = (
              await opts.pi.exec("git", ["log", "--oneline", "-1"], { timeout: 5000 })
            ).stdout.trim();

            const fileSections = await buildPerFileContext(
              opts.pi,
              gitRoot,
              reviewFiles,
              diffArgs,
              new Set(),
              LARGE_LIMITS,
            );

            ctx.ui.notify(`Reviewing last commit (${commitLog})…`, "info");
            prompt = `${buildReviewPrompt(opts.getAutoReviewRules(), opts.getCustomRules(), opts.getLastUserMessage())}\n\n---\n\nReview the last commit: ${commitLog}\n\n## Files to review\n\nRead each file with read(path) to see its full contents.\n\n${fileSections.join("\n\n---\n\n")}`;
          }
        } else {
          // ── Path C: not a git repo — refuse to scan home or root directories ──
          const { homedir } = await import("node:os");
          const home = homedir();
          if (ctx.cwd === home || ctx.cwd === "/" || ctx.cwd === "/tmp") {
            ctx.ui.notify(
              `Cannot review: cwd is ${ctx.cwd} (not a project directory).\n\n` +
                `Run /review-all from inside a git repo, or use /review <N> to review specific commits.`,
              "warning",
            );
            return;
          }

          const findResult = await opts.pi.exec(
            "find",
            [
              ".",
              "-maxdepth",
              "5",
              "-type",
              "f",
              "-not",
              "-path",
              "*/node_modules/*",
              "-not",
              "-path",
              "*/.git/*",
              "-not",
              "-path",
              "*/dist/*",
              "-not",
              "-path",
              "*/build/*",
              "-not",
              "-name",
              "*.min.*",
            ],
            { timeout: 10000 },
          );
          if (findResult.code !== 0 || !findResult.stdout.trim()) {
            ctx.ui.notify("No files found in current directory.", "warning");
            return;
          }

          reviewFiles = findResult.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .filter((f) => !isBinaryPath(f));

          const ignorePatterns = opts.getIgnorePatterns();
          if (ignorePatterns && ignorePatterns.length > 0) {
            reviewFiles = filterIgnored(reviewFiles, ignorePatterns);
          }

          if (reviewFiles.length === 0) {
            ctx.ui.notify("No reviewable files found (all ignored or binary).", "info");
            return;
          }

          const fileSections = reviewFiles.map((f) => {
            const fullPath = resolve(ctx.cwd, f);
            return `### ${fullPath}\n**Full path:** \`${fullPath}\``;
          });

          ctx.ui.notify(`Reviewing ${reviewFiles.length} file(s) in cwd…`, "info");
          prompt = `${buildReviewPrompt(opts.getAutoReviewRules(), opts.getCustomRules(), opts.getLastUserMessage())}\n\n---\n\nReview all files in the project (not a git repo, no diffs available).\n\n## Files to review\n\nRead each file with read(path) to see its full contents.\n\n${fileSections.join("\n\n---\n\n")}`;
        }

        const fullPaths = reviewFiles.map((f) => {
          if (f.startsWith("/")) return f;
          return gitRoot ? `${gitRoot}/${f}` : resolve(ctx.cwd, f);
        });

        const { onActivity, onToolCall } = opts.startReviewWidget(ctx, fullPaths);
        const result = await runReviewSession(
          prompt,
          buildReviewOptions(reviewAbort!.signal, ctx.cwd, fullPaths, onActivity, onToolCall),
        );

        sendReviewResult(opts.pi, result, "all changes");
      } catch (err: any) {
        if (err?.message === "Review cancelled") {
          ctx.ui.notify("Review cancelled", "info");
        } else {
          log(`ERROR: review-all failed: ${err?.message ?? err}`);
          ctx.ui.notify(`Review failed: ${err?.message ?? err}`, "error");
        }
      } finally {
        finishManualReview(ctx);
      }
    },
  });

  return {
    get isReviewing() {
      return isReviewing;
    },
    cancel: cancelInProgress,
    reset: (ctx: CommandContext) => {
      cancelInProgress();
      opts.finishReview(ctx, false);
    },
  };
}

function registerConfigCommands(opts: RegisterCommandsOptions) {
  opts.pi.registerCommand("scaffold-review-files", {
    description:
      "Create .senior-review/ config templates in a git repo. Usage: /scaffold-review-files [path]",
    handler: async (args, ctx) => {
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");

      const targetBase = args?.trim() ? resolve(ctx.cwd, args.trim()) : ctx.cwd;

      const gitCheck = await opts.pi.exec(
        "git",
        ["-C", targetBase, "rev-parse", "--show-toplevel"],
        {
          timeout: 5000,
        },
      );
      if (gitCheck.code !== 0) {
        const msg =
          `Not a git repository: ${targetBase}\n\n` +
          `Usage:\n` +
          `  /scaffold-review-files              — scaffold in current directory\n` +
          `  /scaffold-review-files /path/to/repo — scaffold in a specific git repo`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        log(`scaffold: refused — not a git repo: ${targetBase}`);
        return;
      }

      const gitRoot = gitCheck.stdout.trim();
      const dir = join(gitRoot, ".senior-review");
      mkdirSync(dir, { recursive: true });

      const files: Record<string, string> = {
        "settings.json": SCAFFOLD_SETTINGS,
        "auto-review.md": SCAFFOLD_AUTO_REVIEW,
        "review-rules.md": SCAFFOLD_REVIEW_RULES,
        "architect.md": SCAFFOLD_ARCHITECT_RULES,
        ignore: SCAFFOLD_IGNORE,
      };

      let created = 0;
      let skipped = 0;
      for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        if (existsSync(path)) {
          skipped++;
          log(`scaffold: skipped ${name} (already exists)`);
        } else {
          writeFileSync(path, content);
          created++;
          log(`scaffold: created ${name}`);
        }
      }

      const msg =
        created > 0
          ? `Created ${created} file(s) in ${dir}${skipped > 0 ? ` (${skipped} already existed)` : ""}`
          : `All files already exist in ${dir}`;

      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      log(`scaffold: ${msg}`);
    },
  });

  opts.pi.registerCommand("senior-edit-review-rules", {
    description: "Edit .senior-review/review-rules.md in pi's built-in editor",
    handler: async (_args, ctx) => {
      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const [localDir, globalDir] = configDirs(ctx.cwd);
      let filePath: string | null = null;
      let fileContent: string | null = null;

      for (const dir of [localDir, globalDir]) {
        const candidate = join(dir, "review-rules.md");
        if (existsSync(candidate)) {
          filePath = candidate;
          try {
            fileContent = readFileSync(candidate, "utf8");
          } catch (err: any) {
            log(`senior-edit-review-rules: cannot read ${candidate}: ${err?.message}`);
            if (ctx.hasUI) ctx.ui.notify(`Cannot read ${candidate}: ${err?.message}`, "error");
            return;
          }
          break;
        }
      }

      if (!filePath) {
        if (!ctx.hasUI) return;
        const ok = await ctx.ui.confirm(
          "No review-rules.md found",
          `Create ${localDir}/review-rules.md from template?`,
        );
        if (!ok) return;

        mkdirSync(localDir, { recursive: true });
        filePath = join(localDir, "review-rules.md");
        fileContent = SCAFFOLD_REVIEW_RULES;
        writeFileSync(filePath, fileContent);
        log(`senior-edit-review-rules: created ${filePath}`);
      }

      if (!ctx.hasUI) return;

      const edited = await ctx.ui.editor(`Edit ${filePath}`, fileContent!);

      if (edited === undefined) {
        ctx.ui.notify("Cancelled — no changes saved", "info");
        return;
      }

      if (edited === fileContent) {
        ctx.ui.notify("No changes made", "info");
        return;
      }

      writeFileSync(filePath, edited);
      opts.setCustomRules(edited.trim() || null);
      log(`senior-edit-review-rules: saved and reloaded ${filePath}`);
      ctx.ui.notify(`Saved ${filePath}`, "info");
    },
  });

  opts.pi.registerCommand("add-review-rule", {
    description: "Prepend a custom rule to .senior-review/review-rules.md",
    handler: async (args, ctx) => {
      const rule = (args ?? "").trim();
      if (!rule) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /add-review-rule <rule text>", "warning");
        return;
      }

      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const [localDir] = configDirs(ctx.cwd);
      const filePath = join(localDir, "review-rules.md");

      let existing = "";
      if (existsSync(filePath)) {
        try {
          existing = readFileSync(filePath, "utf8");
        } catch (err: any) {
          log(`add-review-rule: cannot read ${filePath}: ${err?.message}`);
          if (ctx.hasUI) ctx.ui.notify(`Cannot read ${filePath}: ${err?.message}`, "error");
          return;
        }
      } else {
        mkdirSync(localDir, { recursive: true });
      }

      const newContent = `- ${rule}\n${existing}`;
      writeFileSync(filePath, newContent);
      opts.setCustomRules(newContent.trim() || null);
      log(`add-review-rule: prepended rule to ${filePath}`);

      const lines = newContent.split("\n");
      const preview = lines.slice(0, 10).join("\n");
      const ellipsis = lines.length > 10 ? "\n. . ." : "";

      if (ctx.hasUI) {
        ctx.ui.notify(`Rule added to ${filePath}\n\n${preview}${ellipsis}`, "info");
      }
    },
  });
}
