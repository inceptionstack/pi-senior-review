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

  it("buildReviewPrompt_DefaultPromptContainsToolBudget", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("5 tool calls");
  });

  it("buildReviewPrompt_DefaultPromptContainsCaughtBugsMantra", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("Caught bugs");
  });

  it("buildReviewPrompt_DefaultPromptContainsLGTM", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("LGTM");
  });
});
