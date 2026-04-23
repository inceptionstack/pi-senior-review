import { describe, it, expect } from "vitest";
import { parseIgnoreFile, shouldIgnore, filterIgnored } from "../ignore";

describe("parseIgnoreFile", () => {
  it("parseIgnoreFile_EmptyContent_ReturnsEmptyArray", () => {
    expect(parseIgnoreFile("")).toEqual([]);
  });

  it("parseIgnoreFile_CommentsAndBlanks_FiltersThemOut", () => {
    const result = parseIgnoreFile("# comment\n\n*.log\n  # indented comment\nnode_modules\n");
    expect(result).toEqual(["*.log", "node_modules"]);
  });

  it("parseIgnoreFile_TrimsWhitespace", () => {
    const result = parseIgnoreFile("  *.log  \n  dist/  ");
    expect(result).toEqual(["*.log", "dist/"]);
  });
});

describe("shouldIgnore", () => {
  it("shouldIgnore_ExactFilename_MatchesAnywhere", () => {
    expect(shouldIgnore("package-lock.json", ["package-lock.json"])).toBe(true);
    expect(shouldIgnore("src/package-lock.json", ["package-lock.json"])).toBe(true);
  });

  it("shouldIgnore_WildcardExtension_MatchesAllWithExtension", () => {
    expect(shouldIgnore("debug.log", ["*.log"])).toBe(true);
    expect(shouldIgnore("src/app.log", ["*.log"])).toBe(true);
    expect(shouldIgnore("src/app.ts", ["*.log"])).toBe(false);
  });

  it("shouldIgnore_DirectoryPattern_MatchesFilesInsideIt", () => {
    expect(shouldIgnore("dist/bundle.js", ["dist/**"])).toBe(true);
    expect(shouldIgnore("dist/sub/file.js", ["dist/**"])).toBe(true);
    expect(shouldIgnore("src/dist.ts", ["dist/**"])).toBe(false);
  });

  it("shouldIgnore_TrailingSlash_TreatedAsDirectory", () => {
    expect(shouldIgnore("dist/bundle.js", ["dist/"])).toBe(true);
    expect(shouldIgnore("dist/sub/file.js", ["dist/"])).toBe(true);
    expect(shouldIgnore("src/dist.ts", ["dist/"])).toBe(false);
  });

  it("shouldIgnore_PathPatternWithStar_DoesNotMatchNested", () => {
    expect(shouldIgnore("src/generated/types.ts", ["src/generated/*"])).toBe(true);
    expect(shouldIgnore("src/generated/deep/nested.ts", ["src/generated/*"])).toBe(false);
    expect(shouldIgnore("lib/generated/types.ts", ["src/generated/*"])).toBe(false);
  });

  it("shouldIgnore_NegationPattern_Unignores", () => {
    const patterns = ["*.md", "!README.md"];
    expect(shouldIgnore("CHANGELOG.md", patterns)).toBe(true);
    expect(shouldIgnore("README.md", patterns)).toBe(false);
  });

  it("shouldIgnore_NoMatch_ReturnsFalse", () => {
    expect(shouldIgnore("src/index.ts", ["*.log", "dist/**"])).toBe(false);
  });

  it("shouldIgnore_SnapshotFiles_Matched", () => {
    expect(shouldIgnore("test/__snapshots__/foo.snap", ["*.snap"])).toBe(true);
  });
});

describe("filterIgnored", () => {
  it("filterIgnored_MixedFiles_RemovesIgnored", () => {
    const files = ["src/index.ts", "package-lock.json", "README.md", "src/app.ts", "debug.log"];
    const patterns = ["package-lock.json", "*.log", "*.md"];
    const result = filterIgnored(files, patterns);
    expect(result).toEqual(["src/index.ts", "src/app.ts"]);
  });

  it("filterIgnored_NoPatterns_ReturnsAll", () => {
    const files = ["a.ts", "b.ts"];
    expect(filterIgnored(files, [])).toEqual(["a.ts", "b.ts"]);
  });

  it("filterIgnored_NegationKeepsSpecificFile", () => {
    const files = ["README.md", "CHANGELOG.md", "src/index.ts"];
    const patterns = ["*.md", "!README.md"];
    const result = filterIgnored(files, patterns);
    expect(result).toEqual(["README.md", "src/index.ts"]);
  });
});
