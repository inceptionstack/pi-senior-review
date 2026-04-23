import { describe, it, expect } from "vitest";
import { buildReviewPrompt, DEFAULT_REVIEW_PROMPT } from "../prompt";

describe("buildReviewPrompt", () => {
  it("buildReviewPrompt_NoCustomRules_ReturnsDefault", () => {
    expect(buildReviewPrompt()).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_NullCustomRules_ReturnsDefault", () => {
    expect(buildReviewPrompt(null)).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_EmptyStringCustomRules_ReturnsDefault", () => {
    expect(buildReviewPrompt("")).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_WithCustomRules_AppendsRules", () => {
    const result = buildReviewPrompt("No console.log in production code");
    expect(result).toContain(DEFAULT_REVIEW_PROMPT);
    expect(result).toContain("## Additional project-specific rules");
    expect(result).toContain("No console.log in production code");
  });

  it("buildReviewPrompt_DefaultPromptContainsVerifyBeforeFlagging", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("Verify before flagging");
  });

  it("buildReviewPrompt_DefaultPromptContainsWorkflow", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("Explore");
    expect(DEFAULT_REVIEW_PROMPT).toContain("Analyze");
    expect(DEFAULT_REVIEW_PROMPT).toContain("Report");
  });

  it("buildReviewPrompt_DefaultPromptContainsLGTM", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("LGTM");
  });
});
