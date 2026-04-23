import { describe, it, expect } from "vitest";
import {
  hasFileChanges,
  isFileModifyingTool,
  buildChangeSummary,
  isBinaryPath,
  extractPathsFromBashCommand,
  collectModifiedPaths,
  isPureGitOperation,
  isNonFileModifyingCommand,
} from "../changes";

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
    expect(result).toContain("OLD: old");
    expect(result).toContain("NEW: new");
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

describe("isBinaryPath", () => {
  it("isBinaryPath_PngFile_ReturnsTrue", () => {
    expect(isBinaryPath("image.png")).toBe(true);
  });

  it("isBinaryPath_TypeScriptFile_ReturnsFalse", () => {
    expect(isBinaryPath("src/index.ts")).toBe(false);
  });

  it("isBinaryPath_WasmFile_ReturnsTrue", () => {
    expect(isBinaryPath("module.wasm")).toBe(true);
  });
});

describe("extractPathsFromBashCommand", () => {
  it("extractPathsFromBashCommand_RedirectToFile_ExtractsPath", () => {
    const paths = extractPathsFromBashCommand('echo "hello" > /tmp/output.txt');
    expect(paths.some((p) => p.includes("output.txt"))).toBe(true);
  });

  it("extractPathsFromBashCommand_QuotedPath_ExtractsPath", () => {
    const paths = extractPathsFromBashCommand('cat "src/index.ts"');
    expect(paths).toContain("src/index.ts");
  });

  it("extractPathsFromBashCommand_NoPaths_ReturnsEmpty", () => {
    const paths = extractPathsFromBashCommand("echo hello");
    expect(paths).toEqual([]);
  });

  it("extractPathsFromBashCommand_SkipsBinaryPaths", () => {
    const paths = extractPathsFromBashCommand("cp image.png /tmp/image.png");
    expect(paths).toEqual([]);
  });
});

describe("collectModifiedPaths", () => {
  it("collectModifiedPaths_WriteAndEdit_CollectsPaths", () => {
    const paths = collectModifiedPaths([
      { name: "write", input: { path: "foo.ts" } },
      { name: "edit", input: { path: "bar.ts" } },
    ]);
    expect(paths).toContain("foo.ts");
    expect(paths).toContain("bar.ts");
  });

  it("collectModifiedPaths_BashWithPaths_ExtractsThem", () => {
    const paths = collectModifiedPaths([
      { name: "bash", input: { command: "python3 -c \"open('config.json', 'w')\"" } },
    ]);
    expect(paths).toContain("config.json");
  });

  it("collectModifiedPaths_Deduplicates", () => {
    const paths = collectModifiedPaths([
      { name: "write", input: { path: "foo.ts" } },
      { name: "edit", input: { path: "foo.ts" } },
    ]);
    expect(paths).toEqual(["foo.ts"]);
  });
});

describe("isPureGitOperation", () => {
  it("isPureGitOperation_GitPush_ReturnsTrue", () => {
    expect(isPureGitOperation("git push origin main")).toBe(true);
  });

  it("isPureGitOperation_GitCommit_ReturnsTrue", () => {
    expect(isPureGitOperation('git commit -m "fix: bug"')).toBe(true);
  });

  it("isPureGitOperation_GitAddCommitPush_ReturnsTrue", () => {
    expect(isPureGitOperation('git add -A && git commit -m "msg" && git push')).toBe(true);
  });

  it("isPureGitOperation_CdThenGitOps_ReturnsTrue", () => {
    expect(isPureGitOperation("cd /tmp/repo && git log --oneline")).toBe(true);
  });

  it("isPureGitOperation_GitStatusDiff_ReturnsTrue", () => {
    expect(isPureGitOperation("git status && git diff")).toBe(true);
  });

  it("isPureGitOperation_NonGitCommand_ReturnsFalse", () => {
    expect(isPureGitOperation("npm test")).toBe(false);
  });

  it("isPureGitOperation_MixedGitAndShell_ReturnsFalse", () => {
    expect(isPureGitOperation("git status && rm -rf /tmp/foo")).toBe(false);
  });

  it("isPureGitOperation_GitCheckout_ReturnsFalse", () => {
    // checkout modifies working tree
    expect(isPureGitOperation("git checkout main")).toBe(false);
  });

  it("isPureGitOperation_GitMerge_ReturnsFalse", () => {
    expect(isPureGitOperation("git merge feature")).toBe(false);
  });

  it("isPureGitOperation_GitReset_ReturnsFalse", () => {
    expect(isPureGitOperation("git reset --hard")).toBe(false);
  });

  it("isPureGitOperation_EmptyString_ReturnsFalse", () => {
    expect(isPureGitOperation("")).toBe(false);
  });

  it("isPureGitOperation_EchoThenGit_ReturnsFalse", () => {
    // echo can redirect to files, so anything with echo is not pure git
    expect(isPureGitOperation('echo "starting" && git push')).toBe(false);
  });

  it("isPureGitOperation_GitWithCFlag_Recognized", () => {
    expect(isPureGitOperation("git -C /tmp/repo push origin main")).toBe(true);
  });
});

describe("hasFileChanges_withPureGitOps", () => {
  it("hasFileChanges_OnlyGitPush_ReturnsFalse", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "git push origin main" } }])).toBe(false);
  });

  it("hasFileChanges_GitCommitAndPush_ReturnsFalse", () => {
    expect(
      hasFileChanges([
        { name: "bash", input: { command: 'git add -A && git commit -m "fix" && git push' } },
      ]),
    ).toBe(false);
  });

  it("hasFileChanges_MixedGitAndWrite_ReturnsTrue", () => {
    expect(
      hasFileChanges([
        { name: "bash", input: { command: "git push" } },
        { name: "write", input: { path: "foo.ts", content: "x" } },
      ]),
    ).toBe(true);
  });

  it("hasFileChanges_NpmTest_ReturnsTrue", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "npm test" } }])).toBe(true);
  });
});

describe("collectModifiedPaths_withPureGitOps", () => {
  it("collectModifiedPaths_GitCommitMessage_DoesNotExtractPaths", () => {
    // Commit messages often contain text like "fix foo.ts" — don't match those
    const paths = collectModifiedPaths([
      {
        name: "bash",
        input: { command: 'git commit -m "refactor: extract settings.ts and prompt.ts"' },
      },
    ]);
    expect(paths).toEqual([]);
  });

  it("collectModifiedPaths_NonGitBash_StillExtracts", () => {
    const paths = collectModifiedPaths([
      { name: "bash", input: { command: 'echo "hello" > /tmp/output.txt' } },
    ]);
    expect(paths.some((p) => p.includes("output.txt"))).toBe(true);
  });
});

describe("isNonFileModifyingCommand", () => {
  it("aws_S3_Ls_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("aws s3 ls")).toBe(true);
  });

  it("aws_WithArgs_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("aws ec2 describe-instances --region us-east-1")).toBe(true);
  });

  it("curl_ApiCall_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("curl https://api.example.com/data")).toBe(true);
  });

  it("curl_WithPipe_ReturnsFalse", () => {
    // Pipes not supported in current splitter, and other commands could be anything
    expect(isNonFileModifyingCommand("curl https://x.com && npm install")).toBe(false);
  });

  it("mixed_GitAndAws_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("git status && aws s3 ls")).toBe(true);
  });

  it("mixed_CurlAndGit_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("curl https://api.com && git push")).toBe(true);
  });

  it("ping_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("ping -c 3 example.com")).toBe(true);
  });

  it("rm_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("rm foo.txt")).toBe(false);
  });

  it("npm_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("npm test")).toBe(false);
  });

  it("env_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("env")).toBe(true);
  });
});

describe("hasFileChanges_withAwsCurl", () => {
  it("hasFileChanges_OnlyAws_ReturnsFalse", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "aws s3 ls" } }])).toBe(false);
  });

  it("hasFileChanges_OnlyCurl_ReturnsFalse", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "curl https://api.com" } }])).toBe(false);
  });

  it("hasFileChanges_MixedAwsAndEdit_ReturnsTrue", () => {
    expect(
      hasFileChanges([
        { name: "bash", input: { command: "aws s3 ls" } },
        { name: "edit", input: { path: "foo.ts" } },
      ]),
    ).toBe(true);
  });
});
