import { describe, it, expect, vi } from "vitest";

import {
  ReviewOrchestrator,
  type ContentBuilder,
  type ReviewOrchestratorInput,
} from "../orchestrator";
import { FALLBACK_LIMITS } from "../context";
import { DEFAULT_SETTINGS, type AutoReviewSettings } from "../settings";
import type { TrackedToolCall } from "../changes";
import type { ReviewResult, ReviewRunner } from "../reviewer";

function reviewResult(isLgtm: boolean, text = isLgtm ? "LGTM" : "- **High:** issue"): ReviewResult {
  return {
    text,
    rawText: text,
    isLgtm,
    durationMs: 1,
    toolCalls: [],
    model: "test/model",
    thinkingLevel: "off",
  };
}

function mockRunner(isLgtm: boolean, text?: string): ReviewRunner {
  return vi.fn(async () => reviewResult(isLgtm, text));
}

function mockContentBuilder(
  content: string | null,
  files = ["src/file.ts"],
  isGitBased = false,
): ContentBuilder {
  return vi.fn(async () =>
    content === null
      ? null
      : {
          content,
          files,
          isGitBased,
          label: isGitBased ? "git" : "tool calls",
        },
  );
}

function baseSettings(overrides: Partial<AutoReviewSettings> = {}): AutoReviewSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function baseToolCalls(): TrackedToolCall[] {
  return [{ name: "edit", input: { path: "src/file.ts", edits: [] } }];
}

function baseInput(overrides: Partial<ReviewOrchestratorInput> = {}): ReviewOrchestratorInput {
  return {
    agentToolCalls: baseToolCalls(),
    modifiedFiles: new Set(["src/file.ts"]),
    gitRoots: new Set(),
    cwd: "/repo",
    settings: baseSettings(),
    customRules: null,
    autoReviewRules: null,
    ignorePatterns: null,
    architectRules: null,
    lastUserMessage: null,
    ...overrides,
  };
}

function longContent(label = "content"): string {
  return `## Review content ${label}\n${"meaningful changed code ".repeat(12)}`;
}

describe("ReviewOrchestrator", () => {
  it("Skip: returns skipped when disabled", async () => {
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(true),
      contentBuilder: mockContentBuilder(longContent()),
    });
    orchestrator.setEnabled(false);

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome).toEqual({ type: "skipped", reason: "disabled" });
  });

  it("Skip: returns skipped when no file changes in tool calls", async () => {
    const contentBuilder = mockContentBuilder(longContent());
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(true),
      contentBuilder,
    });

    const outcome = await orchestrator.handleAgentEnd(
      baseInput({
        agentToolCalls: [{ name: "bash", input: { command: "git status" } }],
      }),
    );

    expect(outcome).toEqual({ type: "skipped", reason: "no_file_changes" });
    expect(contentBuilder).not.toHaveBeenCalled();
  });

  it("Skip: returns skipped when formatting-only turn", async () => {
    const contentBuilder = mockContentBuilder(longContent());
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(true),
      contentBuilder,
    });

    const outcome = await orchestrator.handleAgentEnd(
      baseInput({
        agentToolCalls: [{ name: "bash", input: { command: "npm run format" } }],
      }),
    );

    expect(outcome).toEqual({ type: "skipped", reason: "formatting_only" });
    expect(contentBuilder).not.toHaveBeenCalled();
  });

  it("Skip: returns skipped when no real file paths", async () => {
    const contentBuilder = mockContentBuilder(longContent());
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(true),
      contentBuilder,
    });

    const outcome = await orchestrator.handleAgentEnd(
      baseInput({
        agentToolCalls: [{ name: "bash", input: { command: "touch README" } }],
        modifiedFiles: new Set(["(bash file op)"]),
      }),
    );

    expect(outcome).toEqual({ type: "skipped", reason: "no_real_files" });
    expect(contentBuilder).not.toHaveBeenCalled();
  });

  it("Skip: returns skipped when content is null (no meaningful changes)", async () => {
    const runner = mockRunner(true);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(null),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome).toEqual({ type: "skipped", reason: "no_meaningful_changes" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("Skip: returns skipped when content hash matches last review", async () => {
    const runner = mockRunner(false);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent()),
    });

    const first = await orchestrator.handleAgentEnd(baseInput());
    const second = await orchestrator.handleAgentEnd(baseInput());

    expect(first.type).toBe("completed");
    expect(second).toEqual({ type: "skipped", reason: "duplicate_content" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("Max loops: returns max_loops when loopCount >= maxReviewLoops", async () => {
    const contentBuilder = vi.fn(async () => ({
      content: longContent(`${contentBuilder.mock.calls.length}`),
      files: ["src/file.ts"],
      isGitBased: false,
      label: "tool calls",
    }));
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(false),
      contentBuilder,
    });
    const input = baseInput({ settings: baseSettings({ maxReviewLoops: 1 }) });

    const first = await orchestrator.handleAgentEnd(input);
    const second = await orchestrator.handleAgentEnd(input);

    expect(first.type).toBe("completed");
    expect(second).toEqual({ type: "max_loops" });
  });

  it("Senior LGTM: returns completed with LGTM result, no architect (single file, non-git)", async () => {
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(true, "LGTM senior"),
      contentBuilder: mockContentBuilder(longContent(), ["src/file.ts"], false),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") return;
    expect(outcome.senior.result.isLgtm).toBe(true);
    expect(outcome.senior.result.text).toBe("LGTM senior");
    expect(outcome.architect).toBeUndefined();
    expect(outcome.files).toEqual(["src/file.ts"]);
  });

  it("Senior issues: returns completed with issues, loopInfo shows loop count", async () => {
    const orchestrator = new ReviewOrchestrator({
      runner: mockRunner(false, "- **High:** senior issue"),
      contentBuilder: mockContentBuilder(longContent()),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") return;
    expect(outcome.senior.result.isLgtm).toBe(false);
    expect(outcome.senior.loopInfo).toBe("loop 1/100");
    expect(orchestrator.lastHadIssues).toBe(true);
  });

  it("Senior LGTM + architect LGTM: returns completed with both (>1 file, git-based content)", async () => {
    const runner = mockRunner(true);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent(), ["src/a.ts", "src/b.ts"], true),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") return;
    expect(outcome.senior.result.isLgtm).toBe(true);
    expect(outcome.architect?.result.isLgtm).toBe(true);
    expect(outcome.architect?.label).toBe("Architect Review");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("Architect timeout scales with session file count (not fixed at default)", async () => {
    // Architect's timeoutMs should be max(reviewTimeoutMs, fileCount * 120_000) so that
    // codebase-wide exploration doesn't hit a tight 120s default on multi-file changes.
    const runner = vi.fn<ReviewRunner>().mockResolvedValue(reviewResult(true));
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent(), ["src/a.ts", "src/b.ts", "src/c.ts"], true),
    });

    await orchestrator.handleAgentEnd(
      baseInput({ settings: baseSettings({ reviewTimeoutMs: 60_000 }) }),
    );

    // Second call is the architect; expect its timeoutMs to be >= 3 * 120_000 ms
    expect(runner).toHaveBeenCalledTimes(2);
    const architectCallOpts = runner.mock.calls[1][1];
    expect(architectCallOpts.timeoutMs).toBeGreaterThanOrEqual(360_000);
  });

  it("Senior LGTM + architect issues: returns completed with both", async () => {
    const runner = vi
      .fn<ReviewRunner>()
      .mockResolvedValueOnce(reviewResult(true, "LGTM senior"))
      .mockResolvedValueOnce(reviewResult(false, "- **Medium:** architect issue"));
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent(), ["src/a.ts", "src/b.ts"], true),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") return;
    expect(outcome.senior.result.isLgtm).toBe(true);
    expect(outcome.architect?.result.isLgtm).toBe(false);
    expect(outcome.architect?.result.text).toBe("- **Medium:** architect issue");
  });

  it("Senior LGTM + architect fails: returns completed with senior + architectFailure (error surfaced, not silently dropped)", async () => {
    const runner = vi
      .fn<ReviewRunner>()
      .mockResolvedValueOnce(reviewResult(true, "LGTM senior"))
      .mockRejectedValueOnce(new Error("architect failed"));
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent(), ["src/a.ts", "src/b.ts"], true),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") return;
    expect(outcome.senior.result.isLgtm).toBe(true);
    expect(outcome.architect).toBeUndefined();
    expect(outcome.architectFailure).toBeDefined();
    expect(outcome.architectFailure?.error.message).toBe("architect failed");
    expect(outcome.architectFailure?.reviewId).toMatch(/^r-[a-f0-9]{8}$/);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("Cancellation: returns cancelled when abort fires during review", async () => {
    const runner = vi.fn<ReviewRunner>(
      async (_prompt, opts) =>
        await new Promise<ReviewResult>((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("Review cancelled")));
        }),
    );
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent()),
    });

    const promise = orchestrator.handleAgentEnd(baseInput());
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    orchestrator.cancel();

    await expect(promise).resolves.toEqual({ type: "cancelled" });
    expect(orchestrator.isReviewing).toBe(false);
  });

  it("Error: returns error for non-cancellation runner errors", async () => {
    const orchestrator = new ReviewOrchestrator({
      runner: vi.fn<ReviewRunner>().mockRejectedValue(new Error("runner failed")),
      contentBuilder: mockContentBuilder(longContent()),
    });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("error");
    if (outcome.type !== "error") return;
    expect(outcome.error.message).toBe("runner failed");
  });

  it("Context overflow retry: falls back to smaller limits on context overflow error", async () => {
    const runner = vi
      .fn<ReviewRunner>()
      .mockRejectedValueOnce(new Error("context length exceeded"))
      .mockResolvedValueOnce(reviewResult(true));
    const contentBuilder = vi.fn<ContentBuilder>(async (input) => ({
      content: input.limits ? longContent("small") : longContent("large"),
      files: ["src/file.ts"],
      isGitBased: false,
      label: input.limits ? "small" : "large",
    }));
    const orchestrator = new ReviewOrchestrator({ runner, contentBuilder });

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome.type).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(contentBuilder).toHaveBeenCalledTimes(2);
    expect(contentBuilder.mock.calls[0][0].limits).toBeUndefined();
    expect(contentBuilder.mock.calls[1][0].limits).toEqual(FALLBACK_LIMITS);
  });

  it("Loop counter: increments on each call, resets to 0 on LGTM", async () => {
    const runner = vi
      .fn<ReviewRunner>()
      .mockResolvedValueOnce(reviewResult(false, "issue 1"))
      .mockResolvedValueOnce(reviewResult(false, "issue 2"))
      .mockResolvedValueOnce(reviewResult(true, "LGTM"));
    const contents = [longContent("one"), longContent("two"), longContent("three")];
    const contentBuilder = vi.fn<ContentBuilder>(async () => ({
      content: contents.shift() ?? longContent("fallback"),
      files: ["src/file.ts"],
      isGitBased: false,
      label: "tool calls",
    }));
    const orchestrator = new ReviewOrchestrator({ runner, contentBuilder });

    await orchestrator.handleAgentEnd(baseInput());
    expect(orchestrator.currentLoopCount).toBe(1);
    await orchestrator.handleAgentEnd(baseInput());
    expect(orchestrator.currentLoopCount).toBe(2);
    await orchestrator.handleAgentEnd(baseInput());
    expect(orchestrator.currentLoopCount).toBe(0);
  });

  it("Content hash dedup: second call with same content returns skipped", async () => {
    const runner = mockRunner(false);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent("same")),
    });

    await orchestrator.handleAgentEnd(baseInput());
    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(outcome).toEqual({ type: "skipped", reason: "duplicate_content" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("reset(): clears all cycle state", async () => {
    const runner = mockRunner(false);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent("same")),
    });

    await orchestrator.handleAgentEnd(baseInput());
    orchestrator.reset();
    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(orchestrator.currentLoopCount).toBe(1);
    expect(outcome.type).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("setEnabled(): toggles isEnabled and resets cycle state", async () => {
    const runner = mockRunner(false);
    const orchestrator = new ReviewOrchestrator({
      runner,
      contentBuilder: mockContentBuilder(longContent("same")),
    });

    await orchestrator.handleAgentEnd(baseInput());
    orchestrator.setEnabled(false);
    expect(orchestrator.isEnabled).toBe(false);
    expect(await orchestrator.handleAgentEnd(baseInput())).toEqual({
      type: "skipped",
      reason: "disabled",
    });
    orchestrator.setEnabled(true);

    const outcome = await orchestrator.handleAgentEnd(baseInput());

    expect(orchestrator.isEnabled).toBe(true);
    expect(outcome.type).toBe("completed");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  describe("judge gate", () => {
    it("does nothing when judgeEnabled=false (default)", async () => {
      const judge = vi.fn(async () => "inspection_vcs_noop" as const);
      const orchestrator = new ReviewOrchestrator({
        runner: mockRunner(true),
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          // Compound with `echo` — static classifier flags as modifying (echo
          // isn't in its allowlist) so we do reach the judge gate.
          agentToolCalls: [
            { name: "bash", input: { command: 'git status && echo "---" && git log' } },
          ],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: false }),
        }),
      );
      // Judge should NOT be called when the feature is off.
      expect(judge).not.toHaveBeenCalled();
      expect(outcome.type).toBe("completed");
    });

    it("skips when all bash commands classify as inspection_vcs_noop", async () => {
      const judge = vi.fn(async () => "inspection_vcs_noop" as const);
      const runner = mockRunner(true);
      const orchestrator = new ReviewOrchestrator({
        runner,
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          // Two compounds with `echo` — both deterministic-flag as modifying,
          // both actually safe. The judge is supposed to override here.
          agentToolCalls: [
            { name: "bash", input: { command: 'echo "start" && git status' } },
            { name: "bash", input: { command: 'git log --oneline -5 && echo "done"' } },
          ],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      expect(outcome).toEqual({ type: "skipped", reason: "judge_read_only" });
      expect(judge).toHaveBeenCalledTimes(2);
      expect(runner).not.toHaveBeenCalled();
    });

    it("runs the review when any command classifies as modifying", async () => {
      const calls: string[] = [];
      const judge: import("../orchestrator").JudgeClassifier = async (cmd) => {
        calls.push(cmd);
        return calls.length === 1 ? "inspection_vcs_noop" : "modifying";
      };
      const runner = mockRunner(true);
      const orchestrator = new ReviewOrchestrator({
        runner,
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          agentToolCalls: [
            { name: "bash", input: { command: "echo ok && git status" } },
            { name: "bash", input: { command: "npm run build" } },
          ],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      expect(outcome.type).toBe("completed");
      expect(runner).toHaveBeenCalledTimes(1);
      // Short-circuits once `modifying` is seen; doesn't classify later commands.
      expect(calls).toEqual(["echo ok && git status", "npm run build"]);
    });

    it("runs the review when any command classifies as unsure (fail-open)", async () => {
      const judge = vi.fn(async () => "unsure" as const);
      const runner = mockRunner(true);
      const orchestrator = new ReviewOrchestrator({
        runner,
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          agentToolCalls: [{ name: "bash", input: { command: "./deploy.sh" } }],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      expect(outcome.type).toBe("completed");
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("bypasses the judge when any write/edit tool call happened", async () => {
      const judge = vi.fn(async () => "inspection_vcs_noop" as const);
      const runner = mockRunner(true);
      const orchestrator = new ReviewOrchestrator({
        runner,
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          agentToolCalls: [
            { name: "write", input: { path: "src/new.ts", content: "export {};" } },
            { name: "bash", input: { command: "echo hi && git status" } },
          ],
          modifiedFiles: new Set(["src/new.ts", "src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      // write+edit means we're definitely modifying; skip the judge entirely.
      expect(judge).not.toHaveBeenCalled();
      expect(outcome.type).toBe("completed");
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("fails open and runs the review when the judge throws", async () => {
      // The judge's public contract is to never reject (fail-safe to `unsure`).
      // Simulate a broken judge that DOES reject to verify the orchestrator's
      // try/catch around the gate catches the error and proceeds with review.
      const judge = vi.fn(async () => {
        throw new Error("judge crashed");
      });
      const runner = mockRunner(true);
      const orchestrator = new ReviewOrchestrator({
        runner,
        contentBuilder: mockContentBuilder(longContent()),
        judge,
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          agentToolCalls: [{ name: "bash", input: { command: "echo hi && git status" } }],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      expect(outcome.type).toBe("completed");
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it("does not run when no judge is injected, even if judgeEnabled=true", async () => {
      const orchestrator = new ReviewOrchestrator({
        runner: mockRunner(true),
        contentBuilder: mockContentBuilder(longContent()),
        // no `judge` key
      });
      const outcome = await orchestrator.handleAgentEnd(
        baseInput({
          agentToolCalls: [{ name: "bash", input: { command: "echo hi && git status" } }],
          modifiedFiles: new Set(["src/file.ts"]),
          settings: baseSettings({ judgeEnabled: true }),
        }),
      );
      // No judge fn means we simply can't gate. Proceed with review.
      expect(outcome.type).toBe("completed");
    });
  });
});
