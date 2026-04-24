import { describe, it, expect } from "vitest";
import {
  parseSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TOGGLE_SHORTCUT,
  DEFAULT_CANCEL_SHORTCUT,
  VALID_THINKING_LEVELS,
  loadShortcutSettingsSync,
  configDirs,
  readConfigFile,
} from "../settings";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

describe("parseSettings", () => {
  it("parseSettings_EmptyObject_ReturnsDefaults", () => {
    const { settings, errors } = parseSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(errors).toEqual([]);
  });

  it("parseSettings_ValidMaxReviewLoops_Applies", () => {
    const { settings, errors } = parseSettings({ maxReviewLoops: 5 });
    expect(settings.maxReviewLoops).toBe(5);
    expect(errors).toEqual([]);
  });

  it("parseSettings_ZeroMaxReviewLoops_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ maxReviewLoops: 0 });
    expect(settings.maxReviewLoops).toBe(DEFAULT_SETTINGS.maxReviewLoops);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("maxReviewLoops");
  });

  it("parseSettings_NegativeMaxReviewLoops_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ maxReviewLoops: -1 });
    expect(settings.maxReviewLoops).toBe(DEFAULT_SETTINGS.maxReviewLoops);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_FloatMaxReviewLoops_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ maxReviewLoops: 3.5 });
    expect(settings.maxReviewLoops).toBe(DEFAULT_SETTINGS.maxReviewLoops);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_StringMaxReviewLoops_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ maxReviewLoops: "10" });
    expect(settings.maxReviewLoops).toBe(DEFAULT_SETTINGS.maxReviewLoops);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_ValidModel_Applies", () => {
    const { settings, errors } = parseSettings({ model: "anthropic/claude-sonnet-4" });
    expect(settings.model).toBe("anthropic/claude-sonnet-4");
    expect(errors).toEqual([]);
  });

  it("parseSettings_ModelWithoutSlash_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ model: "claude-sonnet" });
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("provider/model-id");
  });

  it("parseSettings_NonStringModel_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ model: 123 });
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_ValidThinkingLevels_AllAccepted", () => {
    for (const level of VALID_THINKING_LEVELS) {
      const { settings, errors } = parseSettings({ thinkingLevel: level });
      expect(settings.thinkingLevel).toBe(level);
      expect(errors).toEqual([]);
    }
  });

  it("parseSettings_InvalidThinkingLevel_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ thinkingLevel: "turbo" });
    expect(settings.thinkingLevel).toBe(DEFAULT_SETTINGS.thinkingLevel);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("thinkingLevel");
  });

  it("parseSettings_RoundupEnabledTrue_Applies", () => {
    const { settings, errors } = parseSettings({ roundupEnabled: true });
    expect(settings.roundupEnabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it("parseSettings_RoundupEnabledFalse_Applies", () => {
    const { settings, errors } = parseSettings({ roundupEnabled: false });
    expect(settings.roundupEnabled).toBe(false);
    expect(errors).toEqual([]);
  });

  it("parseSettings_NonBooleanRoundupEnabled_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ roundupEnabled: "yes" });
    expect(settings.roundupEnabled).toBe(DEFAULT_SETTINGS.roundupEnabled);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_UnknownKey_WarnsButDoesNotFail", () => {
    const { settings, errors } = parseSettings({ unknownOption: true });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("unknownOption");
    expect(errors[0]).toContain("ignored");
  });

  it("parseSettings_MultipleUnknownKeys_WarnsEach", () => {
    const { errors } = parseSettings({ foo: 1, bar: 2 });
    expect(errors.length).toBe(2);
  });

  it("parseSettings_AllValidFields_AppliesAll", () => {
    const input = {
      maxReviewLoops: 10,
      model: "openai/gpt-5",
      thinkingLevel: "high",
      roundupEnabled: true,
    };
    const { settings, errors } = parseSettings(input);
    expect(errors).toEqual([]);
    expect(settings.maxReviewLoops).toBe(10);
    expect(settings.model).toBe("openai/gpt-5");
    expect(settings.thinkingLevel).toBe("high");
    expect(settings.roundupEnabled).toBe(true);
  });

  it("parseSettings_MixOfValidAndInvalid_AppliesValidRejectsInvalid", () => {
    const { settings, errors } = parseSettings({
      maxReviewLoops: 5,
      model: "no-slash",
      thinkingLevel: "low",
    });
    expect(settings.maxReviewLoops).toBe(5);
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.thinkingLevel).toBe("low");
    expect(errors.length).toBe(1);
  });

  it("parseSettings_DoesNotMutateDefaults", () => {
    const before = { ...DEFAULT_SETTINGS };
    parseSettings({ maxReviewLoops: 999 });
    expect(DEFAULT_SETTINGS).toEqual(before);
  });

  it("parseSettings_ValidReviewTimeoutMs_Applies", () => {
    const { settings, errors } = parseSettings({ reviewTimeoutMs: 300_000 });
    expect(settings.reviewTimeoutMs).toBe(300_000);
    expect(errors).toEqual([]);
  });

  it("parseSettings_ZeroReviewTimeoutMs_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ reviewTimeoutMs: 0 });
    expect(settings.reviewTimeoutMs).toBe(DEFAULT_SETTINGS.reviewTimeoutMs);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_NegativeReviewTimeoutMs_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ reviewTimeoutMs: -1 });
    expect(settings.reviewTimeoutMs).toBe(DEFAULT_SETTINGS.reviewTimeoutMs);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_NonNumericReviewTimeoutMs_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ reviewTimeoutMs: "5000" });
    expect(settings.reviewTimeoutMs).toBe(DEFAULT_SETTINGS.reviewTimeoutMs);
    expect(errors.length).toBe(1);
  });

  // ── toggleShortcut ──

  it("parseSettings_ValidToggleShortcut_Applies", () => {
    const { settings, errors } = parseSettings({ toggleShortcut: "ctrl+r" });
    expect(settings.toggleShortcut).toBe("ctrl+r");
    expect(errors).toEqual([]);
  });

  it("parseSettings_EmptyToggleShortcut_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ toggleShortcut: "" });
    expect(settings.toggleShortcut).toBe(DEFAULT_SETTINGS.toggleShortcut);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("toggleShortcut");
  });

  it("parseSettings_NonStringToggleShortcut_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ toggleShortcut: 42 });
    expect(settings.toggleShortcut).toBe(DEFAULT_SETTINGS.toggleShortcut);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_ToggleShortcutTrimsWhitespace", () => {
    const { settings, errors } = parseSettings({ toggleShortcut: "  ctrl+t  " });
    expect(settings.toggleShortcut).toBe("ctrl+t");
    expect(errors).toEqual([]);
  });

  // ── cancelShortcut ──

  it("parseSettings_ValidCancelShortcut_Applies", () => {
    const { settings, errors } = parseSettings({ cancelShortcut: "ctrl+shift+x" });
    expect(settings.cancelShortcut).toBe("ctrl+shift+x");
    expect(errors).toEqual([]);
  });

  it("parseSettings_EmptyCancelShortcut_AcceptsAsNoShortcut", () => {
    const { settings, errors } = parseSettings({ cancelShortcut: "" });
    expect(settings.cancelShortcut).toBe("");
    expect(errors.length).toBe(0);
  });

  it("parseSettings_NonStringCancelShortcut_RejectsWithError", () => {
    const { settings, errors } = parseSettings({ cancelShortcut: true });
    expect(settings.cancelShortcut).toBe(DEFAULT_SETTINGS.cancelShortcut);
    expect(errors.length).toBe(1);
  });

  it("parseSettings_CancelShortcutTrimsWhitespace", () => {
    const { settings, errors } = parseSettings({ cancelShortcut: "  alt+c  " });
    expect(settings.cancelShortcut).toBe("alt+c");
    expect(errors).toEqual([]);
  });

  it("parseSettings_BothShortcutsConfigured_AppliesBoth", () => {
    const { settings, errors } = parseSettings({
      toggleShortcut: "ctrl+r",
      cancelShortcut: "ctrl+q",
    });
    expect(settings.toggleShortcut).toBe("ctrl+r");
    expect(settings.cancelShortcut).toBe("ctrl+q");
    expect(errors).toEqual([]);
  });
});

describe("loadShortcutSettingsSync", () => {
  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "senior-review-test-"));
    return {
      dir,
      writeSettings(obj: Record<string, unknown>) {
        const settingsDir = join(dir, ".senior-review");
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(obj));
      },
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("returns defaults when no settings file exists", () => {
    const tmp = makeTmpDir();
    try {
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("returns defaults when settings file is invalid JSON", () => {
    const tmp = makeTmpDir();
    try {
      const settingsDir = join(tmp.dir, ".senior-review");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(join(settingsDir, "settings.json"), "not json");
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("returns defaults when settings has no shortcut keys", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ maxReviewLoops: 5 });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("reads custom toggleShortcut", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ toggleShortcut: "ctrl+r" });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe("ctrl+r");
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("reads custom cancelShortcut", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ cancelShortcut: "ctrl+q" });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe("ctrl+q");
    } finally {
      tmp.cleanup();
    }
  });

  it("reads both custom shortcuts", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ toggleShortcut: "f5", cancelShortcut: "f6" });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe("f5");
      expect(result.cancelShortcut).toBe("f6");
    } finally {
      tmp.cleanup();
    }
  });

  it("ignores non-string shortcut values and uses defaults", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ toggleShortcut: 123, cancelShortcut: false });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("ignores empty string shortcuts and uses defaults", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ toggleShortcut: "", cancelShortcut: "  " });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
      expect(result.cancelShortcut).toBe(DEFAULT_CANCEL_SHORTCUT);
    } finally {
      tmp.cleanup();
    }
  });

  it("trims whitespace from shortcut values", () => {
    const tmp = makeTmpDir();
    try {
      tmp.writeSettings({ cancelShortcut: "  ctrl+x  " });
      const result = loadShortcutSettingsSync(tmp.dir);
      expect(result.cancelShortcut).toBe("ctrl+x");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("configDirs", () => {
  it("returns local and global dirs", () => {
    const [local, global] = configDirs("/project");
    expect(local).toBe(join("/project", ".senior-review"));
    expect(global).toBe(join(homedir(), ".pi", ".senior-review"));
  });

  it("accepts custom home override", () => {
    const [local, global] = configDirs("/project", "/fakehome");
    expect(local).toBe(join("/project", ".senior-review"));
    expect(global).toBe(join("/fakehome", ".pi", ".senior-review"));
  });
});

describe("readConfigFile", () => {
  function makeDirs() {
    const root = mkdtempSync(join(tmpdir(), "senior-review-cfg-"));
    const localDir = join(root, "project");
    const fakeHome = join(root, "home");
    const localCfg = join(localDir, ".senior-review");
    const globalCfg = join(fakeHome, ".pi", ".senior-review");
    mkdirSync(localCfg, { recursive: true });
    mkdirSync(globalCfg, { recursive: true });
    return {
      root,
      localDir,
      fakeHome,
      localCfg,
      globalCfg,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it("returns null when file not in either location", async () => {
    const d = makeDirs();
    try {
      const result = await readConfigFile(d.localDir, "missing.json", d.fakeHome);
      expect(result).toBeNull();
    } finally {
      d.cleanup();
    }
  });

  it("reads from global when local missing", async () => {
    const d = makeDirs();
    try {
      writeFileSync(join(d.globalCfg, "test.txt"), "global-content");
      const result = await readConfigFile(d.localDir, "test.txt", d.fakeHome);
      expect(result).toBe("global-content");
    } finally {
      d.cleanup();
    }
  });

  it("reads from local when both exist (local takes precedence)", async () => {
    const d = makeDirs();
    try {
      writeFileSync(join(d.localCfg, "test.txt"), "local-content");
      writeFileSync(join(d.globalCfg, "test.txt"), "global-content");
      const result = await readConfigFile(d.localDir, "test.txt", d.fakeHome);
      expect(result).toBe("local-content");
    } finally {
      d.cleanup();
    }
  });

  it("reads from local when only local exists", async () => {
    const d = makeDirs();
    try {
      writeFileSync(join(d.localCfg, "test.txt"), "local-only");
      const result = await readConfigFile(d.localDir, "test.txt", d.fakeHome);
      expect(result).toBe("local-only");
    } finally {
      d.cleanup();
    }
  });
});
