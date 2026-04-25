# Example: Ignore patterns

Place this file at `.lgtm/ignore` in your project root. Same syntax as `.gitignore`.

```
# Dependencies
package-lock.json
yarn.lock
pnpm-lock.yaml

# Build output
dist/**
build/**
*.min.js
*.min.css

# Snapshots
*.snap

# Documentation (unless you want it reviewed)
*.md
!README.md

# Generated files
*.generated.ts
*.d.ts

# Config files
.eslintrc*
.prettierrc*
tsconfig.json
```
