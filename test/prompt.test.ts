import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  DEFAULT_REVIEW_PROMPT,
  DEFAULT_AUTO_REVIEW_RULES,
  PROMPT_PREFIX,
  PROMPT_SUFFIX,
} from "../prompt";

describe("buildReviewPrompt", () => {
  it("buildReviewPrompt_NoArgs_ReturnsDefault", () => {
    expect(buildReviewPrompt()).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_NullArgs_ReturnsDefault", () => {
    expect(buildReviewPrompt(null, null)).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_EmptyStrings_ReturnsDefault", () => {
    expect(buildReviewPrompt("", "")).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("buildReviewPrompt_WithCustomRules_AppendsRules", () => {
    const result = buildReviewPrompt(null, "No console.log in production code");
    expect(result).toContain(DEFAULT_AUTO_REVIEW_RULES);
    expect(result).toContain("## Additional project-specific rules");
    expect(result).toContain("No console.log in production code");
  });

  it("buildReviewPrompt_WithAutoReviewRules_ReplacesMiddleSection", () => {
    const customAutoReview = "## Custom focus\n- Only check for SQL injection";
    const result = buildReviewPrompt(customAutoReview);
    expect(result).toContain(PROMPT_PREFIX);
    expect(result).toContain(PROMPT_SUFFIX);
    expect(result).toContain("## Custom focus");
    expect(result).toContain("Only check for SQL injection");
    // Default auto-review rules should NOT be present
    expect(result).not.toContain("### Correctness bugs");
  });

  it("buildReviewPrompt_WithBothArgs_ReplacesMiddleAndAppendsRules", () => {
    const customAutoReview = "## My review focus\n- Performance only";
    const customRules = "Always check BigO complexity";
    const result = buildReviewPrompt(customAutoReview, customRules);
    expect(result).toContain(PROMPT_PREFIX);
    expect(result).toContain(PROMPT_SUFFIX);
    expect(result).toContain("## My review focus");
    expect(result).toContain("## Additional project-specific rules");
    expect(result).toContain("Always check BigO complexity");
    expect(result).not.toContain("### Correctness bugs");
  });

  it("buildReviewPrompt_DefaultPromptContainsToolBudget", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("15 tool calls per file");
  });

  it("buildReviewPrompt_DefaultPromptContainsCaughtBugsMantra", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("Caught bugs");
  });

  it("buildReviewPrompt_DefaultPromptContainsLGTM", () => {
    expect(DEFAULT_REVIEW_PROMPT).toContain("LGTM");
  });

  it("buildReviewPrompt_DefaultAutoReviewRulesContainsExpectedSections", () => {
    expect(DEFAULT_AUTO_REVIEW_RULES).toContain("## What to review");
    expect(DEFAULT_AUTO_REVIEW_RULES).toContain("### Correctness bugs");
    expect(DEFAULT_AUTO_REVIEW_RULES).toContain("### Security");
    expect(DEFAULT_AUTO_REVIEW_RULES).toContain("## What NOT to report");
  });

  it("buildReviewPrompt_PrefixDoesNotContainReviewCriteria", () => {
    expect(PROMPT_PREFIX).not.toContain("Correctness bugs");
    expect(PROMPT_PREFIX).not.toContain("What NOT to report");
  });

  it("buildReviewPrompt_SuffixDoesNotContainReviewCriteria", () => {
    expect(PROMPT_SUFFIX).not.toContain("Correctness bugs");
    expect(PROMPT_SUFFIX).not.toContain("What NOT to report");
  });

  it("buildReviewPrompt_WithUserRequest_IncludesUserMessage", () => {
    const result = buildReviewPrompt(null, null, "Fix the login bug");
    expect(result).toContain("## User request");
    expect(result).toContain("Fix the login bug");
  });

  it("buildReviewPrompt_NullUserRequest_OmitsSection", () => {
    const result = buildReviewPrompt(null, null, null);
    expect(result).not.toContain("## User request");
  });

  it("buildReviewPrompt_MultilineUserRequest_BlockQuoted", () => {
    const result = buildReviewPrompt(null, null, "Fix the bug\nAlso add tests");
    expect(result).toContain("> Fix the bug");
    expect(result).toContain("> Also add tests");
  });
});
