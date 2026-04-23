import { describe, it, expect } from "vitest";
import { cleanReviewText, isLgtmResult, parseVerdict, stripVerdict } from "../reviewer";

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

  it("cleanReviewText_NoIssuesFoundMarker_StripsPrefix", () => {
    const text = "I read everything.\n\nNo issues found.";
    const result = cleanReviewText(text);
    expect(result).toContain("No issues found");
  });

  it("cleanReviewText_VerdictTagRemoved", () => {
    const text = "No issues found.\n\n<verdict>LGTM</verdict>";
    const result = cleanReviewText(text);
    expect(result).not.toContain("<verdict>");
    expect(result).not.toContain("</verdict>");
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
  it("isLgtmResult_StartsWithLGTM_ReturnsTrue", () => {
    expect(isLgtmResult("LGTM — no issues found.")).toBe(true);
  });

  it("isLgtmResult_EmptyString_ReturnsTrue", () => {
    expect(isLgtmResult("")).toBe(true);
  });

  it("isLgtmResult_OnlyWhitespace_ReturnsTrue", () => {
    expect(isLgtmResult("   \n  ")).toBe(true);
  });

  it("isLgtmResult_HighSeverityBullet_ReturnsFalse", () => {
    expect(isLgtmResult("- **High:** Bug in foo.ts")).toBe(false);
  });

  it("isLgtmResult_MediumDashSeparator_ReturnsFalse", () => {
    expect(isLgtmResult("- **Medium —** Null check missing")).toBe(false);
  });

  it("isLgtmResult_MentionsLGTMButFlagsIssue_ReturnsFalse", () => {
    // The original bug — review mentions LGTM but lists real issues
    const text = `- **Medium — Something is broken** see line 42

The reviewer would have written "LGTM" if fine, but it isn't.`;
    expect(isLgtmResult(text)).toBe(false);
  });

  it("isLgtmResult_IssuesFoundMarker_ReturnsFalse", () => {
    expect(isLgtmResult("**Issues found:**\n- foo")).toBe(false);
  });

  it("isLgtmResult_HeadingSeverity_ReturnsFalse", () => {
    expect(isLgtmResult("## High Severity\nSomething bad")).toBe(false);
  });

  it("isLgtmResult_AmbiguousText_ReturnsFalseDefault", () => {
    // Text without clear LGTM and without severity markers — default to NOT LGTM
    // so we don't silently swallow potentially-real findings
    expect(isLgtmResult("I looked at the code and it seems okay.")).toBe(false);
  });

  it("isLgtmResult_LGTMWithBullets_ReturnsTrue", () => {
    // "LGTM" at start, no severity markers
    expect(isLgtmResult("LGTM\n\nAll good, clean refactor.")).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("parseVerdict_LGTMTag_ReturnsLgtm", () => {
    expect(parseVerdict("No issues found.\n\n<verdict>LGTM</verdict>")).toBe("lgtm");
  });

  it("parseVerdict_IssuesFoundTag_ReturnsIssues", () => {
    expect(parseVerdict("- **High:** bug\n\n<verdict>ISSUES_FOUND</verdict>")).toBe("issues");
  });

  it("parseVerdict_NoTag_ReturnsNull", () => {
    expect(parseVerdict("No issues found.")).toBeNull();
  });

  it("parseVerdict_CaseInsensitive", () => {
    expect(parseVerdict("<Verdict>lgtm</Verdict>")).toBe("lgtm");
  });

  it("parseVerdict_WhitespaceInTag_Tolerated", () => {
    expect(parseVerdict("<verdict>  LGTM  </verdict>")).toBe("lgtm");
  });

  it("parseVerdict_InMiddleOfText_StillFound", () => {
    expect(parseVerdict("Some review here.\n<verdict>ISSUES_FOUND</verdict>\nMore.")).toBe("issues");
  });

  it("parseVerdict_EmptyString_ReturnsNull", () => {
    expect(parseVerdict("")).toBeNull();
  });
});

describe("stripVerdict", () => {
  it("stripVerdict_RemovesTag", () => {
    expect(stripVerdict("Review text\n\n<verdict>LGTM</verdict>")).toBe("Review text");
  });

  it("stripVerdict_NoTag_ReturnsTrimmedText", () => {
    expect(stripVerdict("  Review text  ")).toBe("Review text");
  });

  it("stripVerdict_MultipleVerdictTags_RemovesAll", () => {
    expect(stripVerdict("A\n<verdict>LGTM</verdict>\nB\n<verdict>ISSUES_FOUND</verdict>")).toBe("A\n\nB");
  });
});
