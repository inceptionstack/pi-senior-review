# Example: Review Rules

Place this file at `.lgtm/review-rules.md` in your project root to add project-specific rules to every mini-review.

---

# Project review rules

## Architecture

- All API routes must go through the middleware chain
- Database access only via the repository layer, never direct queries
- No business logic in controllers — delegate to services

## Code standards

- All public functions must have JSDoc comments
- No `console.log` in production code — use the logger
- All API endpoints must validate input with zod schemas
- React components must have TypeScript props interface

## Testing

- Every new service method needs a corresponding test
- Integration tests required for API routes
- Mock external services, never call them in tests

## Security

- No secrets in code — use environment variables
- All user input must be sanitized before database queries
- Authentication required on all non-public routes
