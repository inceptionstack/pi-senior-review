import { describe, it, expect } from "vitest";
import { parseSettings, DEFAULT_SETTINGS, VALID_THINKING_LEVELS } from "../settings";

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
});
