import { describe, it, expect } from "vitest";
import {
  hasFileChanges,
  isFileModifyingTool,
  buildChangeSummary,
  isBinaryPath,
  extractPathsFromBashCommand,
  collectModifiedPaths,
  isNonFileModifyingCommand,
  isFormatterCommand,
  isFormattingOnlyTurn,
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

describe("isNonFileModifyingCommand", () => {
  it("isNonFileModifyingCommand_GitPush_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("git push origin main")).toBe(true);
  });

  it("isNonFileModifyingCommand_GitCommit_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand('git commit -m "fix: bug"')).toBe(true);
  });

  it("isNonFileModifyingCommand_GitAddCommitPush_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand('git add -A && git commit -m "msg" && git push')).toBe(true);
  });

  it("isNonFileModifyingCommand_CdThenGitOps_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("cd /tmp/repo && git log --oneline")).toBe(true);
  });

  it("isNonFileModifyingCommand_GitStatusDiff_ReturnsTrue", () => {
    expect(isNonFileModifyingCommand("git status && git diff")).toBe(true);
  });

  it("isNonFileModifyingCommand_NonGitCommand_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("npm test")).toBe(false);
  });

  it("isNonFileModifyingCommand_MixedGitAndShell_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("git status && rm -rf /tmp/foo")).toBe(false);
  });

  it("isNonFileModifyingCommand_GitCheckout_ReturnsFalse", () => {
    // checkout modifies working tree
    expect(isNonFileModifyingCommand("git checkout main")).toBe(false);
  });

  it("isNonFileModifyingCommand_GitMerge_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("git merge feature")).toBe(false);
  });

  it("isNonFileModifyingCommand_GitReset_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("git reset --hard")).toBe(false);
  });

  it("isNonFileModifyingCommand_EmptyString_ReturnsFalse", () => {
    expect(isNonFileModifyingCommand("")).toBe(false);
  });

  it("isNonFileModifyingCommand_EchoThenGit_ReturnsFalse", () => {
    // echo can redirect to files, so anything with echo is not pure git
    expect(isNonFileModifyingCommand('echo "starting" && git push')).toBe(false);
  });

  it("isNonFileModifyingCommand_GitWithCFlag_Recognized", () => {
    expect(isNonFileModifyingCommand("git -C /tmp/repo push origin main")).toBe(true);
  });
});

describe("hasFileChanges_withPureGitOps", () => {
  it("hasFileChanges_OnlyGitPush_ReturnsFalse", () => {
    expect(hasFileChanges([{ name: "bash", input: { command: "git push origin main" } }])).toBe(
      false,
    );
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
    expect(hasFileChanges([{ name: "bash", input: { command: "curl https://api.com" } }])).toBe(
      false,
    );
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

describe("isFormatterCommand", () => {
  // JavaScript / TypeScript
  it("prettier", () => expect(isFormatterCommand("prettier --write .")).toBe(true));
  it("npx prettier", () => expect(isFormatterCommand("npx prettier --write src/")).toBe(true));
  it("eslint --fix", () => expect(isFormatterCommand("eslint . --fix")).toBe(true));
  it("eslint without fix", () => expect(isFormatterCommand("eslint .")).toBe(false));
  it("biome format", () => expect(isFormatterCommand("biome format .")).toBe(true));
  it("biome check --fix", () => expect(isFormatterCommand("biome check --fix")).toBe(true));
  it("npm run format", () => expect(isFormatterCommand("npm run format")).toBe(true));
  it("npm run lint:fix", () => expect(isFormatterCommand("npm run lint:fix")).toBe(true));
  it("yarn fix", () => expect(isFormatterCommand("yarn fix")).toBe(true));
  it("pnpm format", () => expect(isFormatterCommand("pnpm format")).toBe(true));

  // Python
  it("black", () => expect(isFormatterCommand("black src/")).toBe(true));
  it("ruff format", () => expect(isFormatterCommand("ruff format .")).toBe(true));
  it("ruff check --fix", () => expect(isFormatterCommand("ruff check --fix")).toBe(true));
  it("isort", () => expect(isFormatterCommand("isort .")).toBe(true));
  it("autopep8", () => expect(isFormatterCommand("autopep8 --in-place file.py")).toBe(true));

  // Go
  it("gofmt", () => expect(isFormatterCommand("gofmt -w .")).toBe(true));
  it("goimports", () => expect(isFormatterCommand("goimports -w .")).toBe(true));

  // Rust
  it("rustfmt", () => expect(isFormatterCommand("rustfmt src/main.rs")).toBe(true));
  it("cargo fmt", () => expect(isFormatterCommand("cargo fmt")).toBe(true));
  it("cargo clippy --fix", () => expect(isFormatterCommand("cargo clippy --fix")).toBe(true));

  // C / C++
  it("clang-format", () => expect(isFormatterCommand("clang-format -i src/*.c")).toBe(true));

  // Java
  it("google-java-format", () =>
    expect(isFormatterCommand("google-java-format -i Foo.java")).toBe(true));

  // Ruby
  it("rubocop -a", () => expect(isFormatterCommand("rubocop -a")).toBe(true));
  it("rubocop --auto-correct", () =>
    expect(isFormatterCommand("rubocop --auto-correct")).toBe(true));

  // Non-formatters
  it("node script", () => expect(isFormatterCommand("node build.js")).toBe(false));
  it("rm file", () => expect(isFormatterCommand("rm -rf dist")).toBe(false));
  it("empty", () => expect(isFormatterCommand("")).toBe(false));
  it("tsc", () => expect(isFormatterCommand("tsc --noEmit")).toBe(false));
});

describe("isFormattingOnlyTurn", () => {
  it("true when all bash calls are formatters", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "prettier --write ." } },
        { name: "bash", input: { command: "eslint . --fix" } },
      ]),
    ).toBe(true);
  });

  it("true when mix of formatters and non-modifying commands", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "prettier --write ." } },
        { name: "bash", input: { command: "git add -A" } },
        { name: "bash", input: { command: "git status" } },
      ]),
    ).toBe(true);
  });

  it("false when write tool is used", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "prettier --write ." } },
        { name: "write", input: { path: "foo.ts" } },
      ]),
    ).toBe(false);
  });

  it("false when edit tool is used", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "npm run format" } },
        { name: "edit", input: { path: "foo.ts" } },
      ]),
    ).toBe(false);
  });

  it("false when unknown bash command present", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "prettier --write ." } },
        { name: "bash", input: { command: "node build.js" } },
      ]),
    ).toBe(false);
  });

  it("false when empty", () => {
    expect(isFormattingOnlyTurn([])).toBe(false);
  });

  it("false when only non-modifying commands (no formatter)", () => {
    expect(
      isFormattingOnlyTurn([
        { name: "bash", input: { command: "git status" } },
        { name: "bash", input: { command: "ls -la" } },
      ]),
    ).toBe(false);
  });

  it("true with npm run format only", () => {
    expect(isFormattingOnlyTurn([{ name: "bash", input: { command: "npm run format" } }])).toBe(
      true,
    );
  });
});
