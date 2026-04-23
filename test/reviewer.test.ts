import { describe, it, expect } from "vitest";
import { cleanReviewText, isLgtmResult } from "../reviewer";

describe("cleanReviewText", () => {
  it("cleanReviewText_PureReviewText_ReturnsUnchanged", () => {
    const text = "- **High:** Bug in foo.ts line 42";
    expect(cleanReviewText(text)).toBe(text);
  });

  it("cleanReviewText_ToolNoiseBeforeReview_StripsNoise", () => {
    const text = "Let me check the code.\n\n## Review\n\n- **High:** Bug found";
    expect(cleanReviewText(text)).toBe("## Review\n\n- **High:** Bug found");
  });

  it("cleanReviewText_ToolNoiseBeforeIssues_StripsNoise", () => {
    const text = "I'll explore first.\n\n## Issues\n\nSome issue here";
    expect(cleanReviewText(text)).toBe("## Issues\n\nSome issue here");
  });

  it("cleanReviewText_HeresMyReviewMarker_StripsPrefix", () => {
    const text = "Reading files...\n\nHere's my review:\n\n- Low: minor issue";
    expect(cleanReviewText(text)).toBe("Here's my review:\n\n- Low: minor issue");
  });

  it("cleanReviewText_BulletWithSeverity_StripsPrefix", () => {
    const text = "Checking...\n- **High** something bad\n- **Low** minor";
    expect(cleanReviewText(text)).toBe("- **High** something bad\n- **Low** minor");
  });

  it("cleanReviewText_LGTMMarker_StripsPrefix", () => {
    const text = "I read everything.\n\nLGTM — no issues found.";
    expect(cleanReviewText(text)).toContain("LGTM");
  });

  it("cleanReviewText_XmlBashTags_Stripped", () => {
    const text = "<bash>ls -la</bash>\n\n## Review\n\nAll good";
    const result = cleanReviewText(text);
    expect(result).not.toContain("<bash>");
    expect(result).toContain("## Review");
  });

  it("cleanReviewText_SelfClosingXmlTags_Stripped", () => {
    const text = "<read_file path='foo.ts'/>\n\nLGTM";
    const result = cleanReviewText(text);
    expect(result).not.toContain("<read_file");
    expect(result).toContain("LGTM");
  });

  it("cleanReviewText_EmptyString_ReturnsEmpty", () => {
    expect(cleanReviewText("")).toBe("");
  });

  it("cleanReviewText_OnlyWhitespace_ReturnsEmpty", () => {
    expect(cleanReviewText("   \n\n  ")).toBe("");
  });
});

describe("isLgtmResult", () => {
  it("isLgtmResult_ContainsLGTM_ReturnsTrue", () => {
    expect(isLgtmResult("LGTM — no issues found.")).toBe(true);
  });

  it("isLgtmResult_EmptyString_ReturnsTrue", () => {
    expect(isLgtmResult("")).toBe(true);
  });

  it("isLgtmResult_OnlyWhitespace_ReturnsTrue", () => {
    expect(isLgtmResult("   ")).toBe(true);
  });

  it("isLgtmResult_IssuesFound_ReturnsFalse", () => {
    expect(isLgtmResult("- **High:** Bug in foo.ts")).toBe(false);
  });

  it("isLgtmResult_LGTMInsideLongerText_ReturnsTrue", () => {
    expect(isLgtmResult("Review complete. LGTM — all good.")).toBe(true);
  });
});
