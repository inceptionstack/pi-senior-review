import { describe, it, expect } from "vitest";
import { buildArchitectPrompt, shouldRunArchitectReview } from "../architect";

describe("buildArchitectPrompt", () => {
  it("buildArchitectPrompt_NoCustomRules_ReturnsDefault", () => {
    const result = buildArchitectPrompt(null);
    expect(result).toContain("senior architect");
    expect(result).toContain("zoom out");
  });

  it("buildArchitectPrompt_WithCustomRules_AppendsRules", () => {
    const result = buildArchitectPrompt("Always check for memory leaks");
    expect(result).toContain("senior architect");
    expect(result).toContain("## Additional project-specific architect review rules");
    expect(result).toContain("Always check for memory leaks");
  });

  it("buildArchitectPrompt_ContainsArchitectureSection", () => {
    const result = buildArchitectPrompt(null);
    expect(result).toContain("Architecture coherence");
  });

  it("buildArchitectPrompt_ContainsCrossFileSection", () => {
    const result = buildArchitectPrompt(null);
    expect(result).toContain("Cross-file consistency");
  });

  it("buildArchitectPrompt_ContainsLGTMFormat", () => {
    const result = buildArchitectPrompt(null);
    expect(result).toContain("LGTM");
  });
});

describe("shouldRunArchitectReview", () => {
  it("skip when only 1 file reviewed", () => {
    expect(shouldRunArchitectReview(["src/index.ts"], true)).toBe(false);
  });

  it("skip when 0 files reviewed", () => {
    expect(shouldRunArchitectReview([], true)).toBe(false);
  });

  it("run when 2 files reviewed from git", () => {
    expect(shouldRunArchitectReview(["src/a.ts", "src/b.ts"], true)).toBe(true);
  });

  it("run when many files reviewed from git", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/mod${i}.ts`);
    expect(shouldRunArchitectReview(files, true)).toBe(true);
  });

  it("skip when 2 files but not git-based", () => {
    expect(shouldRunArchitectReview(["src/a.ts", "src/b.ts"], false)).toBe(false);
  });

  it("skip when many files but not git-based", () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/mod${i}.ts`);
    expect(shouldRunArchitectReview(files, false)).toBe(false);
  });

  it("skip when 1 file and not git-based", () => {
    expect(shouldRunArchitectReview(["src/index.ts"], false)).toBe(false);
  });
});
