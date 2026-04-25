import { createHash } from "node:crypto";

import { type ContentSizeLimits, FALLBACK_LIMITS, type ReviewContent } from "./context";
import { hasFileChanges, isFormattingOnlyTurn, collectModifiedPaths } from "./changes";
import type { TrackedToolCall } from "./changes";
import { createReviewId, computeReviewTimeoutMs } from "./helpers";
import type { BashClassification } from "./judge";
import { buildReviewPrompt } from "./prompt";
import type { AutoReviewSettings } from "./settings";
import { runArchitectReview, shouldRunArchitectReview } from "./architect";
import type { ReviewResult, ReviewRunner } from "./reviewer";
import { log } from "./logger";

const MIN_REVIEW_CONTENT_LENGTH = 50;

export type ReviewStepResult = {
  result: ReviewResult;
  label?: string;
  loopInfo?: string;
  /** Unique id for this review step (senior review cycle or architect review). */
  reviewId: string;
};

export type ReviewOutcome =
  | { type: "skipped"; reason: string }
  | { type: "cancelled" }
  | { type: "error"; error: Error }
  | { type: "max_loops" }
  | {
      type: "completed";
      senior: ReviewStepResult;
      architect?: ReviewStepResult;
      /** Populated when architect was supposed to run but failed (timeout, error).
       *  Distinct from `architect` being undefined because it was skipped by the trigger logic. */
      architectFailure?: { reviewId: string; error: Error };
      files: string[];
    };

export interface ContentBuilderInput {
  agentToolCalls: TrackedToolCall[];
  onStatus?: (msg: string) => void;
  ignorePatterns?: string[];
  gitRoots?: Set<string>;
  limits?: ContentSizeLimits;
}

export type ContentBuilder = (input: ContentBuilderInput) => Promise<ReviewContent | null>;

export interface ReviewOrchestratorInput {
  agentToolCalls: TrackedToolCall[];
  modifiedFiles: Set<string>;
  gitRoots: Set<string>;
  cwd: string;
  settings: AutoReviewSettings;
  customRules: string | null;
  autoReviewRules: string | null;
  ignorePatterns: string[] | null;
  architectRules: string | null;
  lastUserMessage: string | null;
  onActivity?: (description: string) => void;
  onToolCall?: (toolName: string, targetPath: string | null) => void;
  onArchitectActivity?: (description: string) => void;
  onArchitectToolCall?: (toolName: string, targetPath: string | null) => void;
  onContentReady?: (files: string[], loopCount: number, timeoutMs: number) => void;
  onArchitectStart?: (files: string[], timeoutMs: number) => void;
  /** Check if a file still exists on disk. Used to prune deleted files from architect review. */
  fileExists?: (path: string) => Promise<boolean>;
}

export interface ReviewOrchestratorOptions {
  runner: ReviewRunner;
  contentBuilder: ContentBuilder;
  /**
   * Optional duplicate-review suppressor ("judge"). When provided AND
   * `settings.judgeEnabled` is true, the orchestrator asks the judge to
   * classify each bash tool call before building content. If ALL bash calls
   * classify as `inspection_vcs_noop` and no write/edit tool calls happened,
   * the review is skipped with reason="judge_read_only".
   *
   * Injected (not hard-imported) so tests can mock without touching the SDK.
   * Fail-open: missing judge, judge throws, or judge returns `modifying`/`unsure`
   * for any command → the review runs as normal.
   */
  judge?: JudgeClassifier;
}

/**
 * Classifier contract the orchestrator expects. Implementations must always
 * resolve (never reject); failures map to `"unsure"` which is treated as
 * "run the review". See `judge.ts` for the production implementation.
 */
export type JudgeClassifier = (
  command: string,
  opts: { signal: AbortSignal; cwd: string; model: string; timeoutMs: number },
) => Promise<BashClassification>;

export class ReviewOrchestrator {
  private readonly runner: ReviewRunner;
  private readonly contentBuilder: ContentBuilder;
  private readonly judge?: JudgeClassifier;

  private reviewAbort: AbortController | null = null;
  private isReviewingValue = false;
  private reviewEnabled = true;
  private loopCount = 0;
  private peakReviewLoopCount = 0;
  private lastReviewedContentHash = "";
  private architectDone = false;
  private sessionChangeSummaries: string[] = [];
  private sessionChangedFiles = new Set<string>();
  private sessionHasGitContent = false;
  private lastReviewHadIssues = false;

  constructor(opts: ReviewOrchestratorOptions) {
    this.runner = opts.runner;
    this.contentBuilder = opts.contentBuilder;
    this.judge = opts.judge;
  }

  get isReviewing(): boolean {
    return this.isReviewingValue;
  }

  get isEnabled(): boolean {
    return this.reviewEnabled;
  }

  get lastHadIssues(): boolean {
    return this.lastReviewHadIssues;
  }

  get currentLoopCount(): number {
    return this.loopCount;
  }

  get abortSignal(): AbortSignal | null {
    return this.reviewAbort?.signal ?? null;
  }

  setEnabled(enabled: boolean): void {
    this.reviewEnabled = enabled;
    if (enabled) this.resetCycleState();
  }

  reset(): void {
    this.reviewAbort?.abort();
    this.reviewAbort = null;
    this.isReviewingValue = false;
    this.resetCycleState();
    this.lastReviewHadIssues = false;
  }

  cancel(): void {
    this.reviewAbort?.abort();
  }

  async handleAgentEnd(input: ReviewOrchestratorInput): Promise<ReviewOutcome> {
    if (!this.reviewEnabled) return { type: "skipped", reason: "disabled" };

    if (this.loopCount >= input.settings.maxReviewLoops) {
      return { type: "max_loops" };
    }

    if (!hasFileChanges(input.agentToolCalls)) {
      return { type: "skipped", reason: "no_file_changes" };
    }

    if (isFormattingOnlyTurn(input.agentToolCalls)) {
      log("skipping review: formatting/linting only");
      return { type: "skipped", reason: "formatting_only" };
    }

    const realFiles = new Set([
      ...[...input.modifiedFiles].filter((f) => f !== "(bash file op)"),
      ...collectModifiedPaths(input.agentToolCalls),
    ]);
    if (realFiles.size === 0) {
      log("skipping review: no real file paths found");
      return { type: "skipped", reason: "no_real_files" };
    }

    // Judge gate: if enabled, ask a cheap LLM to classify each bash command.
    // If they're all read-only AND no write/edit tool call ran, skip the
    // full review entirely. See judge.ts + eval/RESULTS.md for the pick.
    if (input.settings.judgeEnabled && this.judge) {
      const abort = (this.reviewAbort = new AbortController());
      try {
        const skip = await this.isTurnReadOnlyViaJudge(input, abort.signal);
        if (skip) {
          log("skipping review: judge classified turn as read-only");
          return { type: "skipped", reason: "judge_read_only" };
        }
      } catch (err: any) {
        // Fail-open: any judge-gate error → proceed with the normal review.
        log(`judge gate failed (${err?.message ?? err}) — proceeding with review`);
      } finally {
        this.reviewAbort = null;
      }
    }

    this.loopCount++;
    this.isReviewingValue = true;
    this.reviewAbort = new AbortController();

    const seniorReviewId = createReviewId();
    log(
      `[${seniorReviewId}] review cycle started (loop ${this.loopCount}/${input.settings.maxReviewLoops})`,
    );

    try {
      let best = await this.buildContent(input);

      if (
        !best ||
        best.files.length === 0 ||
        best.content.trim().length < MIN_REVIEW_CONTENT_LENGTH
      ) {
        log(`[${seniorReviewId}] no meaningful changes, skipping`);
        // Previous issues are resolved (files deleted/changes gone) — clear indicators
        this.lastReviewHadIssues = false;
        this.loopCount = 0;
        return { type: "skipped", reason: "no_meaningful_changes" };
      }

      log(`[${seniorReviewId}] best:`, {
        label: best.label,
        files: best.files,
        contentLen: best.content.length,
      });

      const contentHash = hashContent(best.content);
      if (contentHash === this.lastReviewedContentHash) {
        log(`[${seniorReviewId}] Skipping — same content as last review`);
        return { type: "skipped", reason: "duplicate_content" };
      }

      const seniorTimeoutMs = computeReviewTimeoutMs(
        input.settings.reviewTimeoutMs,
        best.files.length,
      );
      input.onContentReady?.(best.files, this.loopCount, seniorTimeoutMs);
      log(
        `[${seniorReviewId}] Reviewing ${best.files.length} files via ${best.label || "git diff"}: ${best.files.join(", ")}`,
      );

      let result: ReviewResult;
      try {
        result = await this.runSeniorReview(input, best, seniorReviewId);
      } catch (retryErr: any) {
        if (!isContextOverflowError(retryErr)) throw retryErr;
        log(`[${seniorReviewId}] Context overflow, retrying with fallback limits`);
        input.onActivity?.("retrying with smaller context…");
        const smallBest = await this.buildContent(input, FALLBACK_LIMITS);
        if (
          !smallBest ||
          smallBest.files.length === 0 ||
          smallBest.content.trim().length < MIN_REVIEW_CONTENT_LENGTH
        ) {
          log(`[${seniorReviewId}] Fallback content too small, skipping review`);
          this.lastReviewHadIssues = false;
          this.loopCount = 0;
          return { type: "skipped", reason: "fallback_too_small" };
        }
        best = smallBest;
        result = await this.runSeniorReview(input, best, seniorReviewId);
      }

      // Check for late cancellation: if abort fired while runSeniorReview was
      // settling, discard the result instead of feeding it back to the agent.
      if (this.reviewAbort?.signal.aborted) {
        log(`[${seniorReviewId}] Review cancelled after review completed (race window)`);
        return { type: "cancelled" };
      }

      this.sessionChangeSummaries.push(best.content.slice(0, 5000));
      for (const f of best.files) this.sessionChangedFiles.add(f);
      if (best.isGitBased) this.sessionHasGitContent = true;
      this.lastReviewedContentHash = hashContent(best.content);

      const senior: ReviewStepResult = {
        result,
        label: "",
        loopInfo: undefined,
        reviewId: seniorReviewId,
      };

      if (result.isLgtm) {
        this.lastReviewHadIssues = false;
        this.loopCount = 0;

        const architectOutcome = await this.runArchitectIfNeeded(input);
        if (architectOutcome && "step" in architectOutcome) {
          return {
            type: "completed",
            senior,
            architect: architectOutcome.step,
            files: best.files,
          };
        }
        if (architectOutcome && "failure" in architectOutcome) {
          // Architect attempted but failed (timeout, error). Surface to the caller
          // so the user sees a message instead of a silent swallow.
          return {
            type: "completed",
            senior,
            architectFailure: architectOutcome.failure,
            files: best.files,
          };
        }
        // No architect ran — clear session accumulators so stale files
        // from this cycle don't leak into a future unrelated cycle.
        this.resetCycleState();
        return { type: "completed", senior, files: best.files };
      }

      this.peakReviewLoopCount = Math.max(this.peakReviewLoopCount, this.loopCount);
      this.lastReviewHadIssues = true;
      senior.loopInfo = `loop ${this.loopCount}/${input.settings.maxReviewLoops}`;
      return { type: "completed", senior, files: best.files };
    } catch (err: any) {
      if (err?.message === "Review cancelled") return { type: "cancelled" };
      return { type: "error", error: toError(err) };
    } finally {
      this.isReviewingValue = false;
      this.reviewAbort = null;
    }
  }

  private async buildContent(
    input: ReviewOrchestratorInput,
    limits?: ContentSizeLimits,
  ): Promise<ReviewContent | null> {
    return await this.contentBuilder({
      agentToolCalls: input.agentToolCalls,
      ignorePatterns: input.ignorePatterns ?? undefined,
      gitRoots: input.gitRoots,
      limits,
    });
  }

  private async runSeniorReview(
    input: ReviewOrchestratorInput,
    content: ReviewContent,
    reviewId: string,
  ): Promise<ReviewResult> {
    const prompt = `${buildReviewPrompt(input.autoReviewRules, input.customRules, input.lastUserMessage)}\n\n---\n\n${content.content}`;
    log(`[${reviewId}] prompt length:`, prompt.length);
    const result = await this.runner(prompt, {
      signal: this.requiredSignal(),
      cwd: input.cwd,
      model: input.settings.model,
      thinkingLevel: input.settings.thinkingLevel,
      timeoutMs: computeReviewTimeoutMs(input.settings.reviewTimeoutMs, content.files.length),
      filesReviewed: content.files,
      reviewId,
      onActivity: input.onActivity,
      onToolCall: input.onToolCall,
    });
    log(`[${reviewId}] result:`, {
      isLgtm: result.isLgtm,
      durationMs: result.durationMs,
      textLen: result.text.length,
    });
    return result;
  }

  private async runArchitectIfNeeded(
    input: ReviewOrchestratorInput,
  ): Promise<
    { step: ReviewStepResult } | { failure: { reviewId: string; error: Error } } | undefined
  > {
    // Prune deleted files from session accumulator before checking architect trigger
    if (input.fileExists) {
      const existing = new Set<string>();
      for (const f of this.sessionChangedFiles) {
        if (await input.fileExists(f)) existing.add(f);
      }
      this.sessionChangedFiles = existing;
    }

    const willRunArchitect =
      input.settings.architectEnabled &&
      !this.architectDone &&
      shouldRunArchitectReview([...this.sessionChangedFiles], this.sessionHasGitContent);

    if (!willRunArchitect) return undefined;

    this.architectDone = true;
    const architectReviewId = createReviewId();
    const fileCount = this.sessionChangedFiles.size;
    // Architect explores the codebase with grep/read across many files; scale the timeout
    // with session file count like the senior review does.
    const architectTimeoutMs = computeReviewTimeoutMs(input.settings.reviewTimeoutMs, fileCount);
    log(
      `[${architectReviewId}] architect: running — ${fileCount} files reviewed across session (timeoutMs=${architectTimeoutMs})`,
    );
    input.onArchitectStart?.([...this.sessionChangedFiles], architectTimeoutMs);

    try {
      const summaryText = this.sessionChangeSummaries.join("\n\n---\n\n");
      const result = await runArchitectReview(this.runner, {
        signal: this.requiredSignal(),
        cwd: input.cwd,
        model: input.settings.model,
        customRules: input.architectRules,
        sessionChangeSummary: summaryText,
        reviewId: architectReviewId,
        timeoutMs: architectTimeoutMs,
        onActivity: input.onArchitectActivity,
        onToolCall: input.onArchitectToolCall,
      });
      return { step: { result, label: "Architect Review", reviewId: architectReviewId } };
    } catch (err: any) {
      if (err?.message === "Review cancelled") throw err;
      log(`[${architectReviewId}] ERROR: Architect review failed: ${err?.message ?? err}`);
      return { failure: { reviewId: architectReviewId, error: toError(err) } };
    } finally {
      this.sessionChangeSummaries = [];
      this.sessionChangedFiles = new Set();
      this.peakReviewLoopCount = 0;
      this.architectDone = false;
      this.sessionHasGitContent = false;
    }
  }

  /**
   * Ask the judge to classify each bash tool call in this turn. Returns true
   * only if the turn is confidently read-only:
   *   - No write/edit tool calls happened.
   *   - Every bash command classified as `inspection_vcs_noop`.
   *
   * Fail-open: any individual classification that returns `unsure` or
   * `modifying` (or throws, which is mapped to `unsure` inside
   * `classifyBashCommand`) flips the answer back to "run the review".
   *
   * Serial invocation keeps rate-limit risk low. Most real turns have <5
   * bash calls, so the latency cost is <~5s for the skip case — negligible
   * compared to the 30-90s main review we're avoiding.
   */
  private async isTurnReadOnlyViaJudge(
    input: ReviewOrchestratorInput,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.judge) return false;

    // Any explicit write/edit tool call is an unambiguous modification.
    // Don't waste a judge call on those — go straight to review.
    for (const tc of input.agentToolCalls) {
      if (tc.name === "write" || tc.name === "edit") return false;
    }

    const bashCalls = input.agentToolCalls.filter((tc) => tc.name === "bash");
    if (bashCalls.length === 0) {
      // No bash and no write/edit, but we got past `realFiles.size === 0`,
      // so something else pushed files into the set. Safer to review.
      return false;
    }

    let classifiedAny = false;

    for (const tc of bashCalls) {
      const cmd = String(tc.input?.command ?? "").trim();
      if (!cmd) continue;
      const classification = await this.judge(cmd, {
        signal,
        cwd: input.cwd,
        model: input.settings.judgeModel,
        timeoutMs: input.settings.judgeTimeoutMs,
      });
      log(`judge: ${classification} ← ${cmd.slice(0, 80).replace(/\n/g, " ")}`);
      if (classification !== "inspection_vcs_noop") return false;
      if (signal.aborted) return false;
      classifiedAny = true;
    }
    // Safety: only return true if we actually classified at least one command.
    // A turn with bash calls that all have empty command strings shouldn't be
    // treated as "confidently read-only" — bail to review instead.
    return classifiedAny;
  }

  private resetCycleState(): void {
    this.loopCount = 0;
    this.peakReviewLoopCount = 0;
    this.lastReviewedContentHash = "";
    this.architectDone = false;
    this.sessionChangeSummaries = [];
    this.sessionChangedFiles = new Set();
    this.sessionHasGitContent = false;
  }

  private requiredSignal(): AbortSignal {
    if (!this.reviewAbort) throw new Error("Review cancelled");
    return this.reviewAbort.signal;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isContextOverflowError(err: any): boolean {
  const msg = (err?.message ?? String(err)).toLowerCase();
  return (
    msg.includes("too many tokens") ||
    (msg.includes("context") && msg.includes("length")) ||
    (msg.includes("context") && msg.includes("window")) ||
    (msg.includes("context") && msg.includes("too long")) ||
    (msg.includes("maximum") && msg.includes("token")) ||
    (msg.includes("input") && msg.includes("too large")) ||
    (msg.includes("prompt") && msg.includes("too long")) ||
    (msg.includes("exceeds") && msg.includes("context")) ||
    (msg.includes("exceeds") && msg.includes("token")) ||
    msg.includes("payload too large") ||
    msg.includes("request too large")
  );
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}
