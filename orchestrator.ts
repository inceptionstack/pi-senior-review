import { createHash } from "node:crypto";

import { type ContentSizeLimits, FALLBACK_LIMITS, type ReviewContent } from "./context";
import { hasFileChanges, isFormattingOnlyTurn, collectModifiedPaths } from "./changes";
import type { TrackedToolCall } from "./changes";
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
  onContentReady?: (files: string[], loopCount: number) => void;
  onArchitectStart?: (files: string[]) => void;
}

export interface ReviewOrchestratorOptions {
  runner: ReviewRunner;
  contentBuilder: ContentBuilder;
}

export class ReviewOrchestrator {
  private readonly runner: ReviewRunner;
  private readonly contentBuilder: ContentBuilder;

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

    this.loopCount++;
    this.isReviewingValue = true;
    this.reviewAbort = new AbortController();

    try {
      let best = await this.buildContent(input);

      if (!best || best.content.trim().length < MIN_REVIEW_CONTENT_LENGTH) {
        log("no meaningful changes, skipping");
        return { type: "skipped", reason: "no_meaningful_changes" };
      }

      log("best:", { label: best.label, files: best.files, contentLen: best.content.length });

      const contentHash = hashContent(best.content);
      if (contentHash === this.lastReviewedContentHash) {
        log("Skipping — same content as last review");
        return { type: "skipped", reason: "duplicate_content" };
      }

      input.onContentReady?.(best.files, this.loopCount);
      log(
        `Reviewing ${best.files.length} files via ${best.label || "git diff"}: ${best.files.join(", ")}`,
      );

      let result: ReviewResult;
      try {
        result = await this.runSeniorReview(input, best);
      } catch (retryErr: any) {
        if (!isContextOverflowError(retryErr)) throw retryErr;
        log("Context overflow, retrying with fallback limits");
        input.onActivity?.("retrying with smaller context…");
        const smallBest = await this.buildContent(input, FALLBACK_LIMITS);
        if (!smallBest || smallBest.content.trim().length < MIN_REVIEW_CONTENT_LENGTH) {
          log("Fallback content too small, skipping review");
          return { type: "skipped", reason: "fallback_too_small" };
        }
        best = smallBest;
        result = await this.runSeniorReview(input, best);
      }

      // Check for late cancellation: if abort fired while runSeniorReview was
      // settling, discard the result instead of feeding it back to the agent.
      if (this.reviewAbort?.signal.aborted) {
        log("Review cancelled after senior review completed (race window)");
        return { type: "cancelled" };
      }

      this.sessionChangeSummaries.push(best.content.slice(0, 5000));
      for (const f of best.files) this.sessionChangedFiles.add(f);
      if (best.isGitBased) this.sessionHasGitContent = true;
      this.lastReviewedContentHash = hashContent(best.content);

      const senior: ReviewStepResult = { result, label: "", loopInfo: undefined };

      if (result.isLgtm) {
        this.lastReviewHadIssues = false;
        this.loopCount = 0;

        const architect = await this.runArchitectIfNeeded(input);
        return architect
          ? { type: "completed", senior, architect, files: best.files }
          : { type: "completed", senior, files: best.files };
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
  ): Promise<ReviewResult> {
    const prompt = `${buildReviewPrompt(input.autoReviewRules, input.customRules, input.lastUserMessage)}\n\n---\n\n${content.content}`;
    log("prompt length:", prompt.length);
    const result = await this.runner(prompt, {
      signal: this.requiredSignal(),
      cwd: input.cwd,
      model: input.settings.model,
      thinkingLevel: input.settings.thinkingLevel,
      timeoutMs: Math.max(input.settings.reviewTimeoutMs, content.files.length * 120_000),
      filesReviewed: content.files,
      onActivity: input.onActivity,
      onToolCall: input.onToolCall,
    });
    log("result:", {
      isLgtm: result.isLgtm,
      durationMs: result.durationMs,
      textLen: result.text.length,
    });
    return result;
  }

  private async runArchitectIfNeeded(
    input: ReviewOrchestratorInput,
  ): Promise<ReviewStepResult | undefined> {
    const willRunArchitect =
      input.settings.architectEnabled &&
      !this.architectDone &&
      shouldRunArchitectReview([...this.sessionChangedFiles], this.sessionHasGitContent);

    if (!willRunArchitect) return undefined;

    this.architectDone = true;
    log(`architect: running — ${this.sessionChangedFiles.size} files reviewed across session`);
    input.onArchitectStart?.([...this.sessionChangedFiles]);

    try {
      const summaryText = this.sessionChangeSummaries.join("\n\n---\n\n");
      const result = await runArchitectReview(this.runner, {
        signal: this.requiredSignal(),
        cwd: input.cwd,
        model: input.settings.model,
        customRules: input.architectRules,
        sessionChangeSummary: summaryText,
        onActivity: input.onArchitectActivity,
        onToolCall: input.onArchitectToolCall,
      });
      return { result, label: "Architect Review" };
    } catch (err: any) {
      if (err?.message === "Review cancelled") throw err;
      log(`ERROR: Architect review failed: ${err?.message ?? err}`);
      return undefined;
    } finally {
      this.sessionChangeSummaries = [];
      this.sessionChangedFiles = new Set();
      this.peakReviewLoopCount = 0;
      this.architectDone = false;
      this.sessionHasGitContent = false;
    }
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
