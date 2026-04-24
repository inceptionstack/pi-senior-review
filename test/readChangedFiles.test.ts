import { describe, it, expect } from "vitest";
import { readChangedFiles, FALLBACK_LIMITS } from "../context";

function makeMockPi(
  execHandler: (cmd: string, args: string[]) => { code: number; stdout: string },
) {
  const pi: any = {
    async exec(cmd: string, args: string[]) {
      const r = execHandler(cmd, args);
      return { code: r.code, stdout: r.stdout, stderr: "" };
    },
  };
  return pi;
}

describe("readChangedFiles", () => {
  it("readChangedFiles_SingleFile_ReadsContents", async () => {
    const pi = makeMockPi((_cmd, args) => {
      const file = args[args.length - 1];
      return { code: 0, stdout: `content of ${file}` };
    });
    const result = await readChangedFiles(pi, ["foo.ts"]);
    expect(result.sections.length).toBe(1);
    expect(result.sections[0]).toContain("### foo.ts");
    expect(result.sections[0]).toContain("content of foo.ts");
    expect(result.contents.get("foo.ts")).toBe("content of foo.ts");
    expect(result.totalSize).toBe("content of foo.ts".length);
  });

  it("readChangedFiles_MultipleFiles_ReadsAll", async () => {
    const pi = makeMockPi((_cmd, args) => ({ code: 0, stdout: `# ${args[args.length - 1]}` }));
    const result = await readChangedFiles(pi, ["a.ts", "b.ts", "c.ts"]);
    expect(result.sections.length).toBe(3);
    expect(result.contents.size).toBe(3);
  });

  it("readChangedFiles_WithRoot_PrefixesPaths", async () => {
    const calls: string[] = [];
    const pi: any = {
      async exec(_cmd: string, args: string[]) {
        calls.push(args[args.length - 1]);
        return { code: 0, stdout: "x", stderr: "" };
      },
    };
    await readChangedFiles(pi, ["foo.ts"], { root: "/my/repo" });
    expect(calls[0]).toBe("/my/repo/foo.ts");
  });

  it("readChangedFiles_ReadFails_RecordsError", async () => {
    const pi = makeMockPi(() => ({ code: 1, stdout: "" }));
    const result = await readChangedFiles(pi, ["missing.ts"]);
    expect(result.sections[0]).toContain("(could not read");
    expect(result.contents.get("missing.ts")).toContain("(could not read");
  });

  it("readChangedFiles_NewFilesLabeled", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "new content" }));
    const result = await readChangedFiles(pi, ["new.ts"], { newFiles: new Set(["new.ts"]) });
    expect(result.sections[0]).toContain("(new file)");
  });

  it("readChangedFiles_ExistingFileNotLabeled", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "existing" }));
    const result = await readChangedFiles(pi, ["old.ts"], { newFiles: new Set(["new.ts"]) });
    expect(result.sections[0]).not.toContain("(new file)");
  });

  it("readChangedFiles_LargeFile_Truncated", async () => {
    const bigContent = "x".repeat(15000);
    const pi = makeMockPi(() => ({ code: 0, stdout: bigContent }));
    const result = await readChangedFiles(pi, ["huge.ts"], { limits: FALLBACK_LIMITS });
    expect(result.sections[0]).toContain("truncated");
    const stored = result.contents.get("huge.ts")!;
    expect(stored.length).toBeLessThan(bigContent.length);
  });

  it("readChangedFiles_ExceedsTotalSize_SkipsRemaining", async () => {
    const big = "x".repeat(10000);
    const pi = makeMockPi(() => ({ code: 0, stdout: big }));
    const files = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
    const result = await readChangedFiles(pi, files, { limits: FALLBACK_LIMITS });
    // Some files should be marked as skipped
    const skipped = result.sections.filter((s) => s.includes("skipped"));
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("readChangedFiles_OnStatus_Called", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "x" }));
    const statuses: string[] = [];
    await readChangedFiles(pi, ["foo.ts"], { onStatus: (msg) => statuses.push(msg) });
    expect(statuses.some((s) => s.includes("foo.ts"))).toBe(true);
  });

  it("readChangedFiles_EmptyFileList_ReturnsEmpty", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "" }));
    const result = await readChangedFiles(pi, []);
    expect(result.sections).toEqual([]);
    expect(result.contents.size).toBe(0);
    expect(result.totalSize).toBe(0);
  });

  it("readChangedFiles_EmptyStdout_RecordsReadError", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "" }));
    const result = await readChangedFiles(pi, ["empty.ts"]);
    expect(result.sections[0]).toContain("(could not read");
  });

  it("readChangedFiles_SectionFormat_HasCodeFence", async () => {
    const pi = makeMockPi(() => ({ code: 0, stdout: "const x = 1;" }));
    const result = await readChangedFiles(pi, ["a.ts"]);
    expect(result.sections[0]).toContain("```");
    expect(result.sections[0]).toContain("const x = 1;");
  });
});
