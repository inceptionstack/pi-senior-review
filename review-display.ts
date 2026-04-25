/**
 * review-display.ts — Visual review progress widget
 *
 * Shows an animated ASCII art senior dev with a live file list
 * above the editor while a review is in progress.
 *
 * All mutable state (animation frames, timer) is per-instance inside
 * startReviewDisplay's closure — no module-level singletons.
 */

// ── ASCII art frames ─────────────────────────────────
// A senior dev peering at code through reading glasses.
// Two frames for a subtle animation (alternating the eyes/glasses).

// Senior: round head, round eyes, friendly smile.
// Frame 2 raises an eyebrow + enlarges one eye (curious/skeptical).
const SENIOR_FRAMES: string[][] = [
  [
    `    ╭─────────╮ `,
    `    │  ─   ─  │ `,
    `    │  ◉   ◉  │ `,
    `    │    ▽    │ `,
    `    │  ╰───╯  │ `,
    `    ╰────┬────╯ `,
    `    ╭────┴────╮ `,
    `   ╱│ SENIOR  │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
  [
    `    ╭─────────╮ `,
    `    │  ─   ╱  │ `,
    `    │  ◉   ⊙  │ `,
    `    │    ▽    │ `,
    `    │  ╰───╯  │ `,
    `    ╰────┬────╯ `,
    `    ╭────┴────╮ `,
    `   ╱│ SENIOR  │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
];

// Architect: angular head, double-line borders, square eyes, stern mouth.
// Frame 2 furrows an eyebrow + squints one eye (stern scrutiny).
const ARCHITECT_FRAMES: string[][] = [
  [
    `    ╱═════════╲ `,
    `    ║  ─   ─  ║ `,
    `    ║  ■   ■  ║ `,
    `    ║    △    ║ `,
    `    ║  ┗━━━┛  ║ `,
    `    ╲════╤════╱ `,
    `    ╭────┴────╮ `,
    `   ╱│ARCHITCT │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
  [
    `    ╱═════════╲ `,
    `    ║  ╲   ─  ║ `,
    `    ║  ▪   ■  ║ `,
    `    ║    △    ║ `,
    `    ║  ┗━━━┛  ║ `,
    `    ╲════╤════╱ `,
    `    ╭────┴────╮ `,
    `   ╱│ARCHITCT │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
];

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/**
 * Format a duration (seconds) compactly: `42s`, `2m`, `2m30s`, `1h5m`.
 * Used for the elapsed/timeout header — short enough to fit next to the model name.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return rem === 0 && m === 0 ? `${h}h` : `${h}h${m}m`;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

// ── Types ────────────────────────────────────────────

export interface ReviewDisplayState {
  files: string[];
  activeFile: string | null;
  activity: string;
  loopCount: number;
  maxLoops: number;
  model: string;
  startTime: number;
  /** Max wall-clock budget for this review in ms (shown in the header). */
  timeoutMs: number;
  /** Tool usage count per file (keyed by file path from files[]) */
  toolCounts: Map<string, number>;
  /** Last tool description per file */
  lastToolDesc: Map<string, string>;
  /** Total tool calls across all files */
  totalToolCalls: number;
  /** Whether this is an architect review */
  isArchitect: boolean;
  /** Architecture diagram lines (for architect review) */
  archDiagram: string[] | null;
  /** Currently highlighted module in the architecture diagram */
  archActiveModule: string | null;
}

export interface ReviewDisplayHandle {
  update(patch: Partial<ReviewDisplayState>): void;
  /** Record a tool call, associating it with the best-matching file. */
  recordToolCall(toolName: string, targetPath: string | null): void;
  /** Switch to architect mode with different ASCII art and the full session file list. */
  setArchitectMode(sessionFiles: string[], archDiagram?: string[], timeoutMs?: number): void;
  stop(): void;
}

// ── Helpers ──────────────────────────────────────────

/**
 * Find the best matching file in the file list for a given path.
 *
 * Matches are required to align on a path-segment boundary, so e.g. reading
 * `node_modules/pkg/index.ts` will NOT light up `src/index.ts` just because
 * both end in `index.ts` — the only boundary is between `pkg/` and `index.ts`
 * in the path, but the file ends in `src/index.ts` and the check `path.endsWith("/" + f)`
 * fails. Loose suffix matching used to cause spurious ✓ checkmarks on files the
 * reviewer only glanced at incidentally.
 *
 * Returns the matched file path from `files[]` or null.
 */
export function findMatchingFile(files: string[], path: string): string | null {
  if (!path) return null;
  // Exact match first
  const exact = files.find((f) => f === path);
  if (exact) return exact;
  // Path-segment-boundary suffix match — one side must be a proper tail of the other,
  // starting at a directory separator. This avoids `/foo/bar.ts` matching `r.ts`.
  for (const f of files) {
    if (path.endsWith("/" + f) || f.endsWith("/" + path)) return f;
  }
  return null;
}

/**
 * Infer which architecture module a file path belongs to.
 * Relativizes absolute paths against cwd first, then uses
 * the first meaningful directory component.
 */
function inferModuleFromPath(filePath: string): string | null {
  // Relativize absolute paths so we don't get "home" as a module
  let normalized = filePath;
  if (normalized.startsWith("/")) {
    try {
      const cwd = process.cwd();
      if (normalized.startsWith(cwd + "/")) {
        normalized = normalized.slice(cwd.length + 1);
      } else {
        // Not under cwd — use last 3 path segments as a reasonable scope
        const segs = normalized.split("/").filter(Boolean);
        normalized = segs.slice(-3).join("/");
      }
    } catch {
      // process.cwd() can fail in edge cases
      const segs = normalized.split("/").filter(Boolean);
      normalized = segs.slice(-3).join("/");
    }
  }
  const parts = normalized.split("/");
  // Skip common root dirs
  const skip = new Set(["src", "lib", "app", "packages", "."]);
  for (const p of parts.slice(0, -1)) {
    if (!skip.has(p) && p !== "") return p;
  }
  // Fallback: use the filename without extension
  const last = parts[parts.length - 1];
  if (last) return last.replace(/\.[^.]+$/, "");
  return null;
}

/**
 * Format a short tool description for display next to file counts.
 */
function formatToolDesc(toolName: string, targetPath: string | null): string {
  if (toolName === "read" && targetPath) {
    const short = targetPath.split("/").pop() ?? targetPath;
    return `read ${short}`;
  }
  if (toolName === "bash") {
    return `$ ${(targetPath ?? "").slice(0, 30)}`;
  }
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    return `${toolName} ${(targetPath ?? "").slice(0, 25)}`;
  }
  return `${toolName}…`;
}

// ── Architecture diagram builder ─────────────────────

/**
 * Build an ASCII architecture diagram from a list of modules.
 * Returns lines of text. Modules are shown as boxes in a grid.
 */
export function buildArchDiagram(
  modules: string[],
  activeModule: string | null,
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  },
): string[] {
  if (modules.length === 0) return [];

  const lines: string[] = [];
  const boxWidth = 16;
  const cols = Math.min(modules.length, 4);

  lines.push(theme.fg("dim", "Architecture:"));

  for (let i = 0; i < modules.length; i += cols) {
    const row = modules.slice(i, i + cols);
    // Top border
    const topLine = row
      .map((m) => {
        const isActive = m === activeModule;
        const border = isActive
          ? "┏" + "━".repeat(boxWidth) + "┓"
          : "┌" + "─".repeat(boxWidth) + "┐";
        return isActive ? theme.fg("warning", border) : theme.fg("dim", border);
      })
      .join(" ");
    lines.push(topLine);

    // Module name
    const nameLine = row
      .map((m) => {
        const isActive = m === activeModule;
        const label = m.length > boxWidth - 2 ? m.slice(0, boxWidth - 3) + "…" : m;
        const padded = label
          .padStart(Math.floor((boxWidth - label.length) / 2) + label.length)
          .padEnd(boxWidth);
        if (isActive) {
          return (
            theme.fg("warning", "┃") +
            theme.fg("warning", theme.bold(padded)) +
            theme.fg("warning", "┃")
          );
        }
        return theme.fg("dim", "│") + theme.fg("muted", padded) + theme.fg("dim", "│");
      })
      .join(" ");
    lines.push(nameLine);

    // Bottom border
    const botLine = row
      .map((m) => {
        const isActive = m === activeModule;
        const border = isActive
          ? "┗" + "━".repeat(boxWidth) + "┛"
          : "└" + "─".repeat(boxWidth) + "┘";
        return isActive ? theme.fg("warning", border) : theme.fg("dim", border);
      })
      .join(" ");
    lines.push(botLine);

    // Connection arrows between rows
    if (i + cols < modules.length) {
      const arrowLine = row
        .map(
          () =>
            " ".repeat(Math.floor(boxWidth / 2)) +
            theme.fg("dim", "│") +
            " ".repeat(Math.ceil(boxWidth / 2)),
        )
        .join(" ");
      lines.push(arrowLine);
    }
  }

  return lines;
}

/**
 * Infer architecture modules from a list of file paths.
 * Groups files by directory/module and returns unique module names.
 */
export function inferArchModules(files: string[]): string[] {
  const modules = new Set<string>();
  for (const f of files) {
    const mod = inferModuleFromPath(f);
    if (mod) modules.add(mod);
  }
  return [...modules].sort();
}

// ── Rendering ────────────────────────────────────────

/**
 * Build the widget lines for the review progress display.
 * Pure function — receives animation frame indices from caller.
 */
export function buildReviewWidget(
  state: ReviewDisplayState,
  animFrame: number,
  spinnerFrame: number,
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  },
): string[] {
  const lines: string[] = [];
  const artFrames = state.isArchitect ? ARCHITECT_FRAMES : SENIOR_FRAMES;
  const senior = artFrames[animFrame % artFrames.length];
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];

  // Top separator
  lines.push(theme.fg("dim", "─".repeat(60)));

  // Build info panel (right side)
  const infoLines: string[] = [];
  const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
  const modelShort = (state.model || "").split("/").pop() ?? "";
  const toolInfo =
    state.totalToolCalls > 0 ? theme.fg("dim", ` tools: ${state.totalToolCalls}`) : "";
  const reviewType = state.isArchitect ? "Architect Review" : "Reviewing";
  const timeoutStr =
    state.timeoutMs > 0
      ? ` ${formatDuration(elapsedSec)}/${formatDuration(Math.floor(state.timeoutMs / 1000))}`
      : ` ${formatDuration(elapsedSec)}`;

  infoLines.push(
    theme.fg("accent", theme.bold(`${spinner} ${reviewType}…`)) +
      theme.fg("dim", ` [${state.loopCount}/${state.maxLoops}]`) +
      theme.fg("dim", ` ${modelShort}`) +
      theme.fg("dim", timeoutStr) +
      toolInfo,
  );
  if (state.timeoutMs > 0) {
    infoLines.push(
      theme.fg(
        "dim",
        `  (reviewer may take up to ${formatDuration(Math.floor(state.timeoutMs / 1000))} — LLMs explore files out of list order)`,
      ),
    );
  }
  infoLines.push("");

  if (state.isArchitect && state.archDiagram && state.archDiagram.length > 0) {
    // Show architecture diagram for architect review
    for (const line of state.archDiagram) {
      infoLines.push(line);
    }
    infoLines.push("");
  }

  if (state.files.length > 0) {
    infoLines.push(theme.fg("muted", "Files:"));
    for (const f of state.files) {
      const shortPath = f.split("/").slice(-3).join("/");
      const count = state.toolCounts.get(f) ?? 0;
      const lastDesc = state.lastToolDesc.get(f) ?? "";
      const toolTag =
        count > 0
          ? theme.fg("dim", ` [${count}]`) + (lastDesc ? theme.fg("dim", ` ${lastDesc}`) : "")
          : "";

      // During a live review we cannot know when a file is "done" — the reviewer
      // LLM cross-references across files non-linearly. So we use three neutral states:
      //   ·  untouched        →  dim
      //   •  read at least once → muted
      //   ▸  currently being read (last tool target) → accent, with "← reading" label
      // No ✓ checkmark is shown during the review — it would be misleading.
      if (f === state.activeFile) {
        infoLines.push(
          `  ${theme.fg("accent", "▸")} ${theme.fg("warning", shortPath)}${toolTag} ${theme.fg("warning", "← reading")}`,
        );
      } else if (count > 0) {
        infoLines.push(`  ${theme.fg("muted", "•")} ${theme.fg("muted", shortPath)}${toolTag}`);
      } else {
        infoLines.push(`  ${theme.fg("dim", "·")} ${theme.fg("muted", shortPath)}`);
      }
    }
  }

  if (state.activity) {
    infoLines.push("");
    infoLines.push(theme.fg("dim", `  ${state.activity}`));
  }

  // Merge ASCII art (left) with info panel (right)
  const maxRows = Math.max(senior.length, infoLines.length);
  for (let i = 0; i < maxRows; i++) {
    const artPart = i < senior.length ? theme.fg("accent", senior[i]) : " ".repeat(18);
    const infoPart = i < infoLines.length ? infoLines[i] : "";
    lines.push(`${artPart}  ${infoPart}`);
  }

  // Bottom separator
  lines.push(theme.fg("dim", "─".repeat(60)));

  return lines;
}

// ── Widget lifecycle ─────────────────────────────────

/**
 * Start the review display widget.
 * Returns a handle to update state and stop the widget.
 * All animation state is per-instance (closure-scoped).
 */
export function startReviewDisplay(
  ui: {
    setWidget: (id: string, content: any, opts?: any) => void;
    theme: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
    };
  },
  initialState: ReviewDisplayState,
): ReviewDisplayHandle {
  // Bind theme methods at capture time to avoid lost-context errors
  // when the theme object's methods depend on `this`.
  const boundTheme = {
    fg: ui.theme.fg.bind(ui.theme) as (color: string, text: string) => string,
    bold: ui.theme.bold.bind(ui.theme) as (text: string) => string,
  };
  const boundSetWidget = ui.setWidget.bind(ui) as typeof ui.setWidget;

  const state: ReviewDisplayState = {
    ...initialState,
    toolCounts: new Map(initialState.toolCounts),
    lastToolDesc: new Map(initialState.lastToolDesc),
  };

  // Per-instance animation state
  let animFrame = 0;
  let spinnerFrame = 0;
  let tickCount = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function redraw() {
    try {
      const lines = buildReviewWidget(state, animFrame, spinnerFrame, boundTheme);
      boundSetWidget("lgtm-progress", lines, { placement: "belowEditor" });
    } catch {
      // UI may be stale after session replacement — stop silently
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  }

  // Animate: tick every 150ms for spinner, toggle senior art every ~600ms
  timer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    tickCount++;
    if (tickCount % 4 === 0) {
      animFrame =
        (animFrame + 1) % (state.isArchitect ? ARCHITECT_FRAMES.length : SENIOR_FRAMES.length);
    }
    redraw();
  }, 150);

  redraw();

  return {
    update(patch: Partial<ReviewDisplayState>) {
      if (patch.toolCounts) {
        state.toolCounts = new Map(patch.toolCounts);
        delete (patch as any).toolCounts;
      }
      if (patch.lastToolDesc) {
        state.lastToolDesc = new Map(patch.lastToolDesc);
        delete (patch as any).lastToolDesc;
      }
      Object.assign(state, patch);
      redraw();
    },
    recordToolCall(toolName: string, targetPath: string | null) {
      state.totalToolCalls++;
      const desc = formatToolDesc(toolName, targetPath);

      // Try to associate this tool call with a file — but only for file-reading tools.
      // For `bash`, targetPath is the full command string (e.g. `cat src/foo.ts`), which
      // can spuriously suffix-match filenames and cause the active-file indicator to
      // jump to unrelated entries. Leave activeFile unchanged in that case.
      const canMatchFile =
        toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls";
      const match = canMatchFile && targetPath ? findMatchingFile(state.files, targetPath) : null;
      if (match) {
        state.toolCounts.set(match, (state.toolCounts.get(match) ?? 0) + 1);
        state.lastToolDesc.set(match, desc);
        state.activeFile = match;
      }

      // For architect review, try to highlight the matching architecture module
      if (state.isArchitect && state.archDiagram && targetPath) {
        const mod = inferModuleFromPath(targetPath);
        if (mod && mod !== state.archActiveModule) {
          state.archActiveModule = mod;
          // Rebuild the diagram with the new active module
          const modules = inferArchModules(state.files);
          state.archDiagram = buildArchDiagram(modules, mod, boundTheme);
        }
      }

      // Set activity based on tool type
      if (toolName === "read" && targetPath) {
        const short = targetPath.split("/").slice(-3).join("/");
        state.activity = `reading ${short}`;
      } else if (toolName === "bash") {
        state.activity = `$ ${(targetPath ?? "").slice(0, 50)}`;
      } else if (toolName === "grep" || toolName === "find" || toolName === "ls") {
        state.activity = `${toolName} ${(targetPath ?? "").slice(0, 40)}`;
      } else {
        state.activity = `${toolName}…`;
      }

      redraw();
    },
    setArchitectMode(sessionFiles: string[], archDiagram?: string[], timeoutMs?: number) {
      state.isArchitect = true;
      state.files = sessionFiles;
      state.archDiagram = archDiagram ?? null;
      state.archActiveModule = null;
      // Reset tool counts for the architect phase
      state.toolCounts = new Map();
      state.lastToolDesc = new Map();
      state.totalToolCalls = 0;
      state.startTime = Date.now();
      state.activeFile = null;
      // Unconditionally reset the timeout budget — the architect phase has its own
      // budget distinct from the senior review. If the caller doesn't provide one,
      // fall back to 0 (header shows elapsed only) rather than leaking the stale
      // senior timeout into the architect display.
      state.timeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
      state.activity = "architecture review…";
      redraw();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      try {
        boundSetWidget("lgtm-progress", undefined);
      } catch {
        // UI may be stale — ignore
      }
    },
  };
}
