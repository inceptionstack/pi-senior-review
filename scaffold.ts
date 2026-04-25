/**
 * scaffold.ts — Template content for /scaffold-review-files
 *
 * Contains the actual default prompts used by the extension so users
 * can see and customise exactly what the reviewer sees.
 *
 * The default review rules live in default-review-rules.md (plain markdown,
 * no code). scaffold.ts reads that file at import time so the content is
 * available as SCAFFOLD_REVIEW_RULES for copying into the user's config dir.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_REVIEW_RULES } from "./prompt";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── auto-review.md ───────────────────────────────────
// The review criteria: what to look for and what to skip.
// This is the ONLY part of the review prompt that users override directly.
// The surrounding prompt (tools, budget, workflow, response format) is always
// included automatically and cannot be changed.

export const SCAFFOLD_AUTO_REVIEW = `${DEFAULT_AUTO_REVIEW_RULES}
`;

// ── review-rules.md ──────────────────────────────────
// Loaded from default-review-rules.md — pure review criteria, no operational instructions.
// The markdown file is the single source of truth; scaffold copies it to the user's config dir.

let _scaffoldReviewRules: string;
try {
  _scaffoldReviewRules = readFileSync(join(__dirname, "default-review-rules.md"), "utf8");
} catch (err: any) {
  console.error(
    `[senior-review] Failed to read default-review-rules.md: ${err?.message ?? err}. ` +
    `Scaffold will create an empty review-rules.md. ` +
    `Expected at: ${join(__dirname, "default-review-rules.md")}`,
  );
  _scaffoldReviewRules = "";
}
export const SCAFFOLD_REVIEW_RULES: string = _scaffoldReviewRules;

// ── architect.md ─────────────────────────────────────

export const SCAFFOLD_ARCHITECT_RULES = `## Architecture

- Verify the module dependency graph has no unexpected cycles
- Check that layering is respected (e.g. UI → Service → Repository → Database)
- Flag any god-objects or god-modules that accumulated too many responsibilities

## Cross-cutting concerns

- Error handling strategy consistent across all modules
- Logging follows the same patterns everywhere
- Configuration accessed the same way in all files

## Technical debt

- Flag any TODO/FIXME/HACK comments that were added
- Identify code that was clearly written in haste during fix loops
- Check for dead code or unused imports that accumulated

## Documentation

- README still accurate after all changes
- Architecture docs reflect current state
- Changed public APIs have updated JSDoc/comments
`;

// ── ignore ───────────────────────────────────────────

export const SCAFFOLD_IGNORE = `# Files to skip during review (gitignore syntax)
# Blank lines and lines starting with # are ignored.
# Patterns follow .gitignore rules: *, **, ?, !, trailing /

# Dependencies & lock files
package-lock.json
yarn.lock
pnpm-lock.yaml
bun.lockb

# Build output
dist/**
build/**
out/**
*.min.js
*.min.css

# Generated files
*.generated.ts
*.d.ts

# Snapshots
*.snap

# Large data / assets
*.csv
*.parquet
`;

// ── settings.json ────────────────────────────────────

export const SCAFFOLD_SETTINGS = JSON.stringify(
  {
    maxReviewLoops: 100,
    model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
    thinkingLevel: "off",
    architectEnabled: true,
    reviewTimeoutMs: 120000,
    toggleShortcut: "alt+r",
    cancelShortcut: "",
  },
  null,
  2,
);
