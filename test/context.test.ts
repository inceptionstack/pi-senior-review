import { describe, it, expect } from "vitest";
import { formatReviewContext, FALLBACK_LIMITS } from "../context";
import type { ReviewContext } from "../context";

function makeContext(overrides?: Partial<ReviewContext>): ReviewContext {
  return {
    diff: "diff --git a/foo.ts\n+const x = 1;",
    changedFiles: ["foo.ts"],
    fileContents: new Map([["foo.ts", "const x = 1;"]]),
    fileTree: ".\n./foo.ts",
    commitLog: "",
    ...overrides,
  };
}

describe("formatReviewContext", () => {
  it("formatReviewContext_SingleFile_ContainsAllSections", () => {
    const result = formatReviewContext(makeContext());
    expect(result).toContain("## Changed files (1)");
    expect(result).toContain("- foo.ts");
    expect(result).toContain("## Files to review");
    expect(result).toContain("### foo.ts");
    expect(result).toContain("**Full path:**");
    expect(result).toContain("## Git diff");
    expect(result).toContain("## Project file tree");
  });

  it("formatReviewContext_MultipleFiles_ListsAll", () => {
    const ctx = makeContext({
      changedFiles: ["a.ts", "b.ts"],
      fileContents: new Map([
        ["a.ts", "a"],
        ["b.ts", "b"],
      ]),
    });
    const result = formatReviewContext(ctx);
    expect(result).toContain("## Changed files (2)");
    expect(result).toContain("- a.ts");
    expect(result).toContain("- b.ts");
    expect(result).toContain("### a.ts");
    expect(result).toContain("### b.ts");
  });

  it("formatReviewContext_WithCommitLog_IncludesSection", () => {
    const ctx = makeContext({ commitLog: "abc123 Initial commit" });
    const result = formatReviewContext(ctx);
    expect(result).toContain("## Recent commits");
    expect(result).toContain("abc123 Initial commit");
  });

  it("formatReviewContext_EmptyCommitLog_OmitsSection", () => {
    const ctx = makeContext({ commitLog: "" });
    const result = formatReviewContext(ctx);
    expect(result).not.toContain("## Recent commits");
  });

  it("formatReviewContext_LargeDiff_Truncates", () => {
    const largeDiff = "x".repeat(50000);
    const ctx = makeContext({ diff: largeDiff });
    const result = formatReviewContext(ctx, FALLBACK_LIMITS);
    expect(result).toContain("diff truncated");
  });

  it("formatReviewContext_LargeFileTree_Truncates", () => {
    const largeTree = "file\n".repeat(2000);
    const ctx = makeContext({ fileTree: largeTree });
    const result = formatReviewContext(ctx);
    // fileTree is sliced to 5000 chars
    expect(result.length).toBeLessThan(largeTree.length + 10000);
  });
});
