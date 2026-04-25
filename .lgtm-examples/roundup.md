# Example: Roundup Review Rules

Place this file at `.lgtm/roundup.md` (or `.lgtm/architect.md`) in your project root to customize the final "zoom out" review that runs after all mini-review loops complete.

---

# Roundup review rules

## Architecture coherence

- Verify the module dependency graph has no unexpected cycles
- Check that the layering is respected (e.g. UI → Service → Repository → Database)
- Flag any god-objects or god-modules that accumulated too many responsibilities

## Cross-cutting concerns

- Error handling strategy consistent across all modules
- Logging follows the same patterns everywhere
- Configuration accessed the same way in all files

## API surface

- Public exports make sense — no internal helpers accidentally exported
- Types/interfaces are consistent and not duplicated across modules
- Breaking changes to public APIs are documented

## Technical debt

- Flag any TODO/FIXME/HACK comments that were added
- Identify code that was clearly written in haste during fix loops
- Check for dead code or unused imports that accumulated

## Documentation

- README still accurate after all changes
- Architecture docs reflect current state
- Changed public APIs have updated JSDoc/comments
