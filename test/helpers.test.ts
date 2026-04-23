import { describe, it, expect } from "vitest";
import { clampCommitCount, shouldDiffAllCommits, truncateDiff } from "../helpers";

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
