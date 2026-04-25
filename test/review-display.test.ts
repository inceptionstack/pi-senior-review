/**
 * review-display.test.ts — unit tests for review-display helpers
 *
 * Focus on the two pure helpers recently made stricter / added:
 *   - findMatchingFile: avoids spurious suffix matches that used to cause
 *     ✓ checkmarks on files the reviewer only glanced at incidentally.
 *   - formatDuration: compact elapsed/timeout display.
 */

import { describe, it, expect } from "vitest";

import { findMatchingFile, formatDuration } from "../review-display";

describe("findMatchingFile", () => {
  describe("exact match", () => {
    it("returns the file when the tool path equals a listed file exactly", () => {
      const files = ["src/index.ts", "src/util.ts"];
      expect(findMatchingFile(files, "src/index.ts")).toBe("src/index.ts");
    });

    it("returns null when neither path nor list overlaps", () => {
      expect(findMatchingFile(["src/a.ts"], "lib/b.ts")).toBeNull();
    });

    it("returns null for an empty / nullish path", () => {
      expect(findMatchingFile(["src/a.ts"], "")).toBeNull();
    });
  });

  describe("path-segment-boundary matching", () => {
    it("matches a relative file when the tool path is the absolute form", () => {
      const files = ["src/index.ts"];
      expect(findMatchingFile(files, "/home/user/proj/src/index.ts")).toBe("src/index.ts");
    });

    it("matches a bare filename in the list when the tool path includes directories", () => {
      const files = ["index.ts"];
      expect(findMatchingFile(files, "/abs/path/to/index.ts")).toBe("index.ts");
    });

    it("matches when the list has absolute paths and the tool path is relative", () => {
      const files = ["/abs/proj/src/index.ts"];
      expect(findMatchingFile(files, "src/index.ts")).toBe("/abs/proj/src/index.ts");
    });
  });

  describe("no spurious suffix matches", () => {
    it("does NOT match when only the trailing basename overlaps at a non-boundary", () => {
      // Without the boundary rule, `foo.ts` and `barfoo.ts` would false-match.
      const files = ["src/foo.ts"];
      expect(findMatchingFile(files, "src/barfoo.ts")).toBeNull();
    });

    it("does NOT match an unrelated file that happens to share a basename across different dirs", () => {
      // Prior loose logic: path.endsWith(f) was true for f="index.ts" vs path="node_modules/pkg/index.ts".
      // New logic still allows that (bare filename in list should match) — but NOT if the listed file is
      // a full path in a different directory.
      const files = ["src/index.ts"];
      expect(findMatchingFile(files, "node_modules/pkg/index.ts")).toBeNull();
    });

    it("does NOT match a bash command that happens to end with a listed filename", () => {
      // `cat src/foo.ts` is the whole command string passed as targetPath for bash.
      // This should not match because findMatchingFile shouldn't be called for bash,
      // but even if it were, the command isn't a valid path-segment suffix of the file.
      // (f.endsWith("/" + path) would require the file to end with "/cat src/foo.ts".)
      const files = ["src/foo.ts"];
      expect(findMatchingFile(files, "cat src/foo.ts")).toBeNull();
    });
  });

  describe("match precedence", () => {
    it("prefers an exact match over a boundary suffix match", () => {
      const files = ["src/index.ts", "index.ts"];
      // Exact match should win even though both would satisfy the boundary suffix rule.
      expect(findMatchingFile(files, "src/index.ts")).toBe("src/index.ts");
    });

    it("returns the first file matching when multiple candidates satisfy the boundary rule", () => {
      // Both files end with "index.ts"; reviewer reads a concrete absolute path matching the first.
      const files = ["a/index.ts", "b/index.ts"];
      expect(findMatchingFile(files, "/root/a/index.ts")).toBe("a/index.ts");
      expect(findMatchingFile(files, "/root/b/index.ts")).toBe("b/index.ts");
    });
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats whole minutes without a seconds suffix", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(120)).toBe("2m");
  });

  it("formats minutes+seconds when non-whole", () => {
    expect(formatDuration(65)).toBe("1m5s");
    expect(formatDuration(125)).toBe("2m5s");
  });

  it("formats whole hours compactly", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(7200)).toBe("2h");
  });

  it("formats hours+minutes, dropping seconds for brevity", () => {
    expect(formatDuration(3660)).toBe("1h1m");
    expect(formatDuration(3720)).toBe("1h2m");
    // Seconds get absorbed — we don't want "1h2m3s" cluttering the header.
    expect(formatDuration(3723)).toBe("1h2m");
  });

  it("clamps negative inputs to 0s", () => {
    expect(formatDuration(-10)).toBe("0s");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("59s");
  });
});
