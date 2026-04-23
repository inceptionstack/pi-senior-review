import { describe, it, expect } from "vitest";
import { hasFileChanges, isFileModifyingTool, buildChangeSummary } from "../changes";

describe("hasFileChanges", () => {
  it("hasFileChanges_WriteToolCall_ReturnsTrue", () => {
    expect(hasFileChanges([{ name: "write", input: { path: "foo.ts" } }])).toBe(true);
  });

  it("hasFileChanges_EditToolCall_ReturnsTrue", () => {
    expect(hasFileChanges([{ name: "edit", input: { path: "foo.ts" } }])).toBe(true);
  });

  it("hasFileChanges_AnyBashToolCall_ReturnsTrue", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "ls" } }])).toBe(true);
  });

  it("hasFileChanges_ReadOnlyTools_ReturnsFalse", () => {
    expect(
      hasFileChanges([
        { name: "read", input: { path: "foo.ts" } },
        { name: "grep", input: { pattern: "foo" } },
        { name: "find", input: { path: "." } },
      ]),
    ).toBe(false);
  });

  it("hasFileChanges_EmptyArray_ReturnsFalse", () => {
    expect(hasFileChanges([])).toBe(false);
  });
});

describe("isFileModifyingTool", () => {
  it("isFileModifyingTool_Write_ReturnsTrue", () => {
    expect(isFileModifyingTool("write")).toBe(true);
  });

  it("isFileModifyingTool_Edit_ReturnsTrue", () => {
    expect(isFileModifyingTool("edit")).toBe(true);
  });

  it("isFileModifyingTool_Bash_ReturnsTrue", () => {
    expect(isFileModifyingTool("bash")).toBe(true);
  });

  it("isFileModifyingTool_Read_ReturnsFalse", () => {
    expect(isFileModifyingTool("read")).toBe(false);
  });

  it("isFileModifyingTool_Grep_ReturnsFalse", () => {
    expect(isFileModifyingTool("grep")).toBe(false);
  });
});

describe("buildChangeSummary", () => {
  it("buildChangeSummary_WriteCall_IncludesFilePathAndContent", () => {
    const result = buildChangeSummary([
      { name: "write", input: { path: "foo.ts", content: "const x = 1;" } },
    ]);
    expect(result).toContain("WROTE file: foo.ts");
    expect(result).toContain("const x = 1;");
  });

  it("buildChangeSummary_EditCall_IncludesEdits", () => {
    const result = buildChangeSummary([
      {
        name: "edit",
        input: { path: "foo.ts", edits: [{ oldText: "old", newText: "new" }] },
      },
    ]);
    expect(result).toContain("EDITED file: foo.ts");
    expect(result).toContain('replaced "old"');
  });

  it("buildChangeSummary_BashCall_IncludesCommandAndResult", () => {
    const result = buildChangeSummary([
      { name: "bash", input: { command: "npm test" }, result: "all passed" },
    ]);
    expect(result).toContain("BASH: npm test");
    expect(result).toContain("all passed");
  });

  it("buildChangeSummary_ReadOnlyCalls_ReturnsEmpty", () => {
    const result = buildChangeSummary([{ name: "read", input: { path: "foo.ts" } }]);
    expect(result).toBe("");
  });
});
