import { describe, it, expect } from "vitest";
import { buildRoundupPrompt } from "../roundup";

describe("buildRoundupPrompt", () => {
  it("buildRoundupPrompt_NoCustomRules_ReturnsDefault", () => {
    const result = buildRoundupPrompt(null);
    expect(result).toContain("senior architect");
    expect(result).toContain("zoom out");
  });

  it("buildRoundupPrompt_WithCustomRules_AppendsRules", () => {
    const result = buildRoundupPrompt("Always check for memory leaks");
    expect(result).toContain("senior architect");
    expect(result).toContain("## Additional project-specific roundup rules");
    expect(result).toContain("Always check for memory leaks");
  });

  it("buildRoundupPrompt_ContainsArchitectureSection", () => {
    const result = buildRoundupPrompt(null);
    expect(result).toContain("Architecture coherence");
  });

  it("buildRoundupPrompt_ContainsCrossFileSection", () => {
    const result = buildRoundupPrompt(null);
    expect(result).toContain("Cross-file consistency");
  });

  it("buildRoundupPrompt_ContainsLGTMFormat", () => {
    const result = buildRoundupPrompt(null);
    expect(result).toContain("LGTM");
  });
});
