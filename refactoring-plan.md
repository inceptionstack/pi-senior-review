# Orchestrator Refactoring Plan (v2)

## Goal

Extract review orchestration from `index.ts` (~1327 lines) into a clean separation:

```
index.ts (pi wiring + UI + renderOutcome)
    │
    ▼
ReviewOrchestrator (state machine + sequencing)
    │
    ├── runReviewSession()  ← existing function, injected as dependency
    ├── getBestReviewContent()  ← injected content builder
    ├── buildReviewPrompt()  ← senior prompt
    └── buildArchitectPrompt()  ← architect prompt
```

## Design Decisions (from Codex review)

### 1. Runner: function, not class

`runReviewSession` stays as a function. No class needed — it's already stateless per-call. Inject it into the orchestrator as a `ReviewRunner` type for testability:

```ts
type ReviewRunner = (prompt: string, opts: ReviewOptions) => Promise<ReviewResult>;
```

### 2. Orchestrator owns content building decisions

`getBestReviewContent` is part of the orchestration decision tree (skip empty, hash dedup, fallback retry, architect eligibility). Inject as a dependency for testability:

```ts
type ContentBuilder = (input: ContentInput) => Promise<ReviewContent | null>;
```

### 3. UI callbacks: pass-through

Callbacks (`onActivity`, `onToolCall`) pass through the orchestrator to the runner. No event emitter — too much ceremony for the current needs.

### 4. Manual commands stay separate

`/review N` and `/review-all` bypass the orchestrator. They share the runner and rendering utilities but don't affect auto-review loop state or architect triggers.

### 5. Senior + architect: share runner, separate prompts

Both use `runReviewSession()` for execution. Prompt building stays separate (`buildReviewPrompt` vs `buildArchitectPrompt`). The orchestrator sequences them.

### 6. Outcome type: compositional, not combinatorial

```ts
type ReviewOutcome =
  | { type: "skipped"; reason: string }
  | { type: "cancelled" }
  | { type: "error"; error: Error }
  | { type: "max_loops" }
  | {
      type: "completed";
      senior: ReviewStepResult;
      architect?: ReviewStepResult; // only if architect ran
      files: string[];
    };

type ReviewStepResult = {
  result: ReviewResult;
  label?: string;
  loopInfo?: string;
};
```

`triggerTurn` logic is trivial in renderOutcome: the last message gets `true`.

## Refactoring Steps

### Step 1: Extract message rendering from reviewer.ts

- Move `sendReviewResult()` and `formatFileTree()` to `message-sender.ts`
- Remove `pi.sendMessage` from `architect.ts` (`runArchitectReview`)
- `runArchitectReview` returns `ReviewResult` only, no message sending
- Update imports in index.ts
- **All tests pass, no behavior change**

### Step 2: Define ReviewRunner type + extract architect from execution

- Create `ReviewRunner` type alias in reviewer.ts
- `runArchitectReview` becomes: build prompt → call runner → return result
- No `pi.sendMessage` in architect.ts (done in step 1)
- architect.ts exports: `loadArchitectRules`, `buildArchitectPrompt`, `shouldRunArchitectReview`
- **All tests pass, no behavior change**

### Step 3: Extract ReviewOrchestrator class (orchestrator.ts)

- Move all cycle state from index.ts closure: loopCount, contentHash, architectDone, sessionChangedFiles, sessionHasGitContent, peakReviewLoopCount, sessionChangeSummaries
- Move skip-decision logic: hasFileChanges check, isFormattingOnlyTurn check, hash dedup, loop counting, min content length check
- Move content gathering + fallback retry (context overflow → FALLBACK_LIMITS)
- Move senior → architect sequencing
- Constructor takes injected dependencies: runner, content builder, settings
- `handleAgentEnd(input) → Promise<ReviewOutcome>`
- `reset()`, `cancel()`, getters for isReviewing/isEnabled
- **All tests pass, index.ts still works (wires orchestrator internally)**

### Step 4: Add orchestrator unit tests

- Test skip decisions (no changes, formatting-only, max loops, hash dedup)
- Test senior LGTM → architect trigger conditions
- Test senior issues → loop increment
- Test cancellation mid-review
- Test error handling (context overflow retry, runner failure)
- Mock ReviewRunner and ContentBuilder
- **High confidence before slimming index.ts**

### Step 5: Slim index.ts to wiring + renderOutcome

- agent_end becomes: `const outcome = await orchestrator.handleAgentEnd(input); renderOutcome(outcome);`
- renderOutcome: one switch, trivial triggerTurn (last message = true)
- Remove all state variables now owned by orchestrator
- Keep: event handlers, commands, shortcuts, UI helpers, widget management
- Target: ~400-500 lines

### Step 6: Clean up — update AGENTS.md, ARCHITECTURE.md, plan.md

- Document the new module structure
- Update dependency graph
- Remove refactoring-plan.md (or keep as historical reference)

## Risks & Mitigations

| Risk                                                              | Mitigation                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 3 is large (most state + logic moves)                        | Add orchestrator tests immediately in Step 4. Consider splitting Step 3 into 3a (state + skip logic) and 3b (content + runner + architect sequencing) |
| Widget callbacks need ctx — orchestrator shouldn't know about ctx | index.ts creates callbacks that close over ctx, passes them to orchestrator. Orchestrator passes through to runner.                                   |
| Manual commands (/review N, /review-all) share reviewer infra     | They use runner + message-sender directly, not the orchestrator. Extract shared helpers if needed.                                                    |
| Cancellation touches both orchestrator state and index.ts UI      | Orchestrator.cancel() aborts the signal. index.ts handles UI cleanup in finally blocks.                                                               |

## Rules

- Each step: extract → verify all tests pass → commit
- Don't refactor and add features in the same step
- Keep every commit pushable
- Never amend commits, always append
