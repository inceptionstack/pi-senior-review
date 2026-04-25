import { describe, it, expect } from "vitest";
import {
  clampCommitCount,
  computeReviewTimeoutMs,
  createReviewId,
  REVIEW_PER_FILE_BUDGET_MS,
  shouldDiffAllCommits,
  truncateDiff,
} from "../helpers";

describe("createReviewId", () => {
  it("createReviewId_Default_ReturnsExpectedFormat", () => {
    const id = createReviewId();
    expect(id).toMatch(/^r-[a-f0-9]{8}$/);
  });

  it("createReviewId_CalledMultipleTimes_ReturnsDistinctValues", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createReviewId()));
    // 100 random 32-bit IDs should not collide; if they do, something is wrong.
    expect(ids.size).toBe(100);
  });
});

describe("clampCommitCount", () => {
  it("clampCommitCount_RequestedWithinRange_ReturnsRequestedCount", () => {
    const result = clampCommitCount(3, 10);
    expect(result.effectiveCount).toBe(3);
    expect(result.wasClamped).toBe(false);
  });

  it("clampCommitCount_RequestedExceedsTotal_ClampsToTotal", () => {
    const result = clampCommitCount(10, 3);
    expect(result.effectiveCount).toBe(3);
    expect(result.wasClamped).toBe(true);
  });

  it("clampCommitCount_RequestedEqualsTotal_ReturnsExactCount", () => {
    const result = clampCommitCount(5, 5);
    expect(result.effectiveCount).toBe(5);
    expect(result.wasClamped).toBe(false);
  });

  it("clampCommitCount_ZeroTotalCommits_ReturnsZeroClamped", () => {
    const result = clampCommitCount(3, 0);
    expect(result.effectiveCount).toBe(0);
    expect(result.wasClamped).toBe(true);
  });

  it("clampCommitCount_NegativeTotalCommits_ReturnsZeroClamped", () => {
    const result = clampCommitCount(3, -1);
    expect(result.effectiveCount).toBe(0);
    expect(result.wasClamped).toBe(true);
  });
});

describe("shouldDiffAllCommits", () => {
  it("shouldDiffAllCommits_EffectiveCountEqualsTotal_ReturnsTrue", () => {
    expect(shouldDiffAllCommits(5, 5)).toBe(true);
  });

  it("shouldDiffAllCommits_EffectiveCountExceedsTotal_ReturnsTrue", () => {
    expect(shouldDiffAllCommits(10, 5)).toBe(true);
  });

  it("shouldDiffAllCommits_EffectiveCountLessThanTotal_ReturnsFalse", () => {
    expect(shouldDiffAllCommits(3, 10)).toBe(false);
  });
});

describe("truncateDiff", () => {
  it("truncateDiff_ShortDiff_ReturnsUnchanged", () => {
    expect(truncateDiff("short diff", 100)).toBe("short diff");
  });

  it("truncateDiff_ExactlyAtLimit_ReturnsUnchanged", () => {
    const diff = "a".repeat(100);
    expect(truncateDiff(diff, 100)).toBe(diff);
  });

  it("truncateDiff_ExceedsLimit_TruncatesWithNote", () => {
    const diff = "a".repeat(150);
    const result = truncateDiff(diff, 100);
    expect(result.length).toBeGreaterThan(100); // includes the note
    expect(result).toContain("... (diff truncated, 50 chars omitted)");
    expect(result.startsWith("a".repeat(100))).toBe(true);
  });
});

describe("computeReviewTimeoutMs", () => {
  it("returns the user-configured minimum when no files are being reviewed", () => {
    // Scaled component is 0 * 120_000 = 0, so min wins.
    expect(computeReviewTimeoutMs(30_000, 0)).toBe(30_000);
  });

  it("returns the user-configured minimum when it exceeds the per-file scaling", () => {
    // 10 min vs 2 files * 2 min = 4 min — user floor wins.
    expect(computeReviewTimeoutMs(600_000, 2)).toBe(600_000);
  });

  it("scales up with file count when the per-file budget dominates", () => {
    // 5 files * 120s = 600s > 120s default.
    expect(computeReviewTimeoutMs(120_000, 5)).toBe(5 * REVIEW_PER_FILE_BUDGET_MS);
  });

  it("treats negative file counts as zero (defensive)", () => {
    expect(computeReviewTimeoutMs(30_000, -3)).toBe(30_000);
  });

  it("per-file budget constant is 120s", () => {
    // Lock in the documented budget so a careless change trips this test.
    expect(REVIEW_PER_FILE_BUDGET_MS).toBe(120_000);
  });
});
