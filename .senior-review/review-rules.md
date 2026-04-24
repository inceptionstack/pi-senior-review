- code shoud use CLEAN CODE rules and DRY principles. do not repat yourself.
## Correctness & Bugs

- **Off-by-one errors**: wrong loop bounds (< vs <=, 0-indexed vs 1-indexed), fence-post errors in slicing/substring, incorrect range endpoints
- **Null / undefined / nil access**: dereferencing values that can be absent, missing nil checks before member access, optional chaining gaps
- **Type mismatches**: wrong argument types, implicit coercions that change behavior (string ↔ number, truthy/falsy surprises), incorrect casts
- **Logic errors**: inverted conditions, wrong boolean operator (AND vs OR), negation errors, swapped arguments, wrong variable used in expression
- **Boundary conditions**: empty collections, zero-length strings, negative numbers, integer overflow/underflow, maximum-size inputs
- **Error handling**: missing error checks on fallible operations, swallowed exceptions, catch blocks that hide root causes, error paths that leave state inconsistent
- **Resource leaks**: opened files/connections/handles never closed, missing cleanup in error paths, missing try-finally or equivalent
- **Concurrency**: race conditions on shared mutable state, missing synchronization, non-atomic check-then-act patterns, deadlock potential
- **Async correctness**: missing await on async calls, unhandled promise rejections, callbacks that can fire multiple times, event listener leaks
- **Data flow**: variables written but never read, stale values used after mutation elsewhere, aliasing bugs where two references unexpectedly share state
- **API contract violations**: passing values outside documented valid range, ignoring return values that signal errors, misusing library APIs
- **Partial failure**: operations that can half-complete (write 3 of 5 records), leaving data in an inconsistent state — flag missing transactions or rollback logic
- Each flagged bug must be **discrete and actionable** — identify the specific location, the trigger condition, and the concrete consequence
- Do not speculate about what might break in other parts of the codebase without evidence — prove the issue from the code under review
- Match the level of rigor to the codebase: do not demand production-grade defensive coding in one-off scripts or prototypes

## Clean Architecture

- Enforce dependency rule: dependencies point inward (UI → Application → Domain → Infrastructure inverts via ports)
- Business logic must not depend on frameworks, databases, or external services directly
- Use cases / application services must orchestrate domain objects, not contain domain logic themselves
- Domain entities and value objects must be pure — no I/O, no framework imports
- Adapters (controllers, repositories, gateways) must implement ports defined by inner layers
- Flag any layer-skipping: UI calling infrastructure directly, domain importing from UI, etc.
- Configuration and wiring belong at the composition root, not scattered across layers

## SOLID Principles

- **Single Responsibility**: each module/class/function should have one reason to change — flag god-classes and functions doing unrelated things
- **Open/Closed**: prefer extension over modification — flag changes that require editing existing working code when a plugin/strategy/decorator pattern would suffice
- **Liskov Substitution**: subtypes must be substitutable for their base types — flag overrides that narrow preconditions or weaken postconditions
- **Interface Segregation**: clients should not depend on methods they don't use — flag fat interfaces that force implementors to stub unused methods
- **Dependency Inversion**: high-level modules must not depend on low-level modules; both should depend on abstractions — flag direct instantiation of infrastructure in business logic

## DRY — Don't Repeat Yourself

- Flag duplicated logic across files (copy-paste code with minor variations)
- Flag duplicated constants, magic numbers, and magic strings — extract to named constants
- Flag repeated conditional patterns that should be polymorphism or lookup tables
- Exception: test code may duplicate setup for readability — do not flag test helpers that are intentionally explicit

## Clean Code

- Functions should do one thing, do it well, and do it only
- Functions should be short and operate at a single level of abstraction
- Flag deep nesting (more than 2-3 levels) — suggest early returns or extraction
- Flag functions with more than 3 parameters — suggest parameter objects
- Flag boolean parameters that switch behavior — suggest separate functions
- Names must reveal intent — flag cryptic abbreviations, single-letter variables (except conventional loop counters), and misleading names
- Flag dead code: unreachable branches, unused variables, commented-out code
- Flag side effects hidden in functions whose names suggest pure computation
- Error handling must be explicit — flag swallowed exceptions, empty catch blocks, and generic error messages that hide root causes

## Pragmatic Programmer

- Flag violations of the principle of least surprise — code should behave as readers expect
- Flag broken windows: sloppy code left alongside clean code signals that quality doesn't matter
- Flag shotgun surgery: a single change requiring edits across many unrelated files
- Flag feature envy: a function that uses more data from another module than its own
- Prefer composition over inheritance — flag deep inheritance hierarchies (more than 2 levels)
- Flag primitive obsession: using raw strings/numbers/booleans where a value object or enum would add safety
- Orthogonality: modules should be independent — changing one should not require changing others

## Domain-Driven Design

- Ubiquitous language: code names should match domain terminology — flag technical jargon where domain terms exist
- Bounded contexts must have clear boundaries — flag domain concepts leaking across context boundaries
- Aggregates must enforce their own invariants — flag external code that manipulates aggregate internals directly
- Value objects must be immutable — flag mutable value objects
- Domain events should be used for cross-aggregate side effects, not direct coupling
- Repositories must only exist for aggregate roots, not for every entity
- Flag anemic domain models: entities that are just data bags with getters/setters while logic lives in services

## Security — OWASP Top 10 (Web / General)

- **Broken Access Control**: missing authorization checks, IDOR (direct object references without ownership validation), privilege escalation paths, missing CORS configuration
- **Cryptographic Failures**: hardcoded secrets, API keys, passwords, or tokens in code; weak hashing (MD5, SHA1 for passwords); missing encryption for sensitive data at rest or in transit
- **Injection**: SQL injection via string concatenation, command injection via unsanitized shell arguments, XSS via unescaped user input in HTML/templates, LDAP/XML/path injection
- **Insecure Design**: missing rate limiting on sensitive endpoints, no account lockout, missing input validation at trust boundaries, business logic flaws
- **Security Misconfiguration**: verbose error messages exposing internals, default credentials, unnecessary features enabled, missing security headers
- **Vulnerable Components**: known-vulnerable dependency versions, unmaintained libraries, dependencies with known CVEs
- **Authentication Failures**: weak password policies, missing MFA where appropriate, session tokens in URLs, missing session invalidation on logout/password change
- **Data Integrity Failures**: missing integrity checks on critical data, unsigned/unverified updates, deserialization of untrusted data without validation
- **Logging & Monitoring Failures**: missing audit logs for security-relevant actions, logging sensitive data (passwords, tokens, PII), insufficient error logging for incident response
- **SSRF**: server-side requests using user-supplied URLs without allowlist validation, internal service URLs exposed

## Security — OWASP Top 10 for LLM / AI Applications

- **Prompt Injection**: user input concatenated directly into LLM prompts without sanitization, missing input/output boundaries, indirect injection via retrieved documents or tool outputs
- **Sensitive Information Disclosure**: PII, credentials, or proprietary data included in prompts, model responses, or training data; missing output filtering; conversation history leaking across users
- **Supply Chain Vulnerabilities**: untrusted model sources, unverified model weights, poisoned training data pipelines, compromised fine-tuning datasets
- **Data and Model Poisoning**: training or fine-tuning on unvalidated user-generated content, no data provenance tracking, missing anomaly detection on training inputs
- **Improper Output Handling**: LLM output used directly in SQL queries, shell commands, code execution, or HTML rendering without sanitization — treat all model output as untrusted
- **Excessive Agency**: LLM given write/execute/delete capabilities without human-in-the-loop confirmation, missing scope restrictions on tool access, no action audit trail
- **System Prompt Leakage**: system prompts retrievable via adversarial queries, sensitive instructions or architecture details in prompts, no prompt confidentiality controls
- **Vector and Embedding Weaknesses**: RAG retrieval without access control (users retrieving documents they shouldn't see), embedding injection, poisoned vector store entries
- **Misinformation**: no fact-checking or grounding for critical outputs, model hallucinations presented as authoritative, missing disclaimers on generated content
- **Unbounded Consumption**: missing token/cost limits per request or user, recursive agent loops without caps, no rate limiting on AI endpoints

## AI Trifecta — Critical AI Security Intersection

- **Prompt Injection + Data Poisoning + Tool Use**: the most dangerous combination — poisoned retrieval data triggers prompt injection that invokes privileged tools; flag any path where untrusted data flows into prompts that have access to sensitive tools
- Flag chains where: retrieval → prompt → tool execution has no trust boundary validation at each step
- Flag missing sandboxing for AI-invoked code execution or file system access
- Flag AI systems that can modify their own instructions, training data, or retrieval sources

## Unit Testing — Osherove's Art of Unit Testing

### Naming

- Test names must describe: unit of work, scenario/input, and expected result
- Pattern: `[UnitOfWork]_[Scenario]_[ExpectedBehavior]` or equivalent readable form
- Flag cryptic test names like `test1`, `testIt`, `shouldWork`, or names that don't describe the scenario
- Test names should read as specifications — a non-developer should understand what is being tested

### Trustworthiness

- Each test must have exactly one logical assertion (one reason to fail) — flag tests with multiple unrelated assertions
- No logic in tests: no if/else, loops, switch, or try/catch in test code — these make tests unreliable
- Flag tests that test implementation details (private methods, internal state) instead of observable behavior
- Flag tests without assertions (passing tests that verify nothing)
- Flag flaky patterns: time-dependent tests, order-dependent tests, tests sharing mutable state
- Tests must fail for the right reason — flag assertions that would pass even if the code were broken

### Readability

- Tests should follow Arrange-Act-Assert (or Given-When-Then) structure clearly
- Flag excessive setup that obscures what is being tested — prefer factory methods or builders
- Flag shared mutable test fixtures — prefer fresh setup per test
- Magic values must be explained or extracted to named constants
- The entire test should be readable without scrolling — if it's long, it's testing too much

### Maintainability

- Flag over-mocking: tests that mock everything except the unit under test lose integration confidence
- Flag brittle tests: tests that break when implementation changes but behavior doesn't
- Flag test duplication: identical test logic copy-pasted across files — extract shared test utilities
- Test helpers and custom matchers are encouraged when they improve clarity
- Flag missing edge case tests for: null/empty inputs, boundary values, error paths, concurrent access
