# AGENTS.md

This file provides guidance to AI agents (Claude, GPT, etc.) when working with code in this repository.

## Overview

This is a GitHub Action that evaluates LLM outputs using promptfoo. It runs before/after comparisons of prompt changes in pull requests and posts results as PR comments.

**Key Features:**
- Automatic detection of changed prompt files in PRs
- Evaluation using promptfoo's testing framework
- Results posted as PR comments with pass/fail status
- Support for multiple LLM providers (OpenAI, Anthropic, etc.)
- Caching support for faster evaluations

**Note:** This repository includes a copy of the promptfoo source code in the `/promptfoo/` directory. This is used for analyzing and understanding promptfoo's capabilities during development but is not included in the distributed action.

## Module System: ESM

**CRITICAL:** This project uses **ES Modules (ESM)**, not CommonJS.

### What This Means

✅ **DO:**
- Use `import` and `export` statements
- Add `.js` extensions to relative imports (even for `.ts` files)
- Use `import.meta.url` instead of `__filename`
- Use `fileURLToPath(import.meta.url)` for `__dirname` equivalent
- Check if file is main with: `import.meta.url === \`file://\${process.argv[1]}\``

❌ **DON'T:**
- Use `require()` - will throw ReferenceError at runtime
- Use `module.exports` - won't work in ESM
- Use `__dirname` or `__filename` directly
- Use `require.main === module`
- Omit `.js` extensions from relative imports

### Example: Correct ESM Imports

```typescript
// ✅ Correct - includes .js extension
import { validateGitRef } from './utils/git.js';
import * as core from '@actions/core';

// ❌ Wrong - missing .js extension
import { validateGitRef } from './utils/git';
```

### Migration History

This project was migrated from CommonJS to ESM in January 2026 to support:
- `@actions/core` v3.0.0 (ESM-only)
- `@actions/exec` v3.0.0 (ESM-only)
- `@actions/github` v9.0.0 (ESM-only)
- `@actions/io` v3.0.0 (ESM-only)

## Commands

### Build and Development

- `npm run build` - Compile TypeScript to JavaScript (outputs to `lib/`)
- `npm run build:watch` - Watch mode for TypeScript compilation
- `npm run package` - Bundle the action with @vercel/ncc (outputs to `dist/`)
- `npm run all` - Full build pipeline: build → lint → package → test

### Code Quality

- `npm run lint` - Run Biome linter (check only)
- `npm run lint:fix` - Run Biome linter with auto-fix
- `npm run format` - Format code with Biome
- `npm run biome` - Run both format and lint with auto-fix
- `npm run biome:check` - Check format and lint without changes

### Testing

This project uses **Vitest** (not Jest).

- `npm test` - Run all tests with coverage
- `npm test -- __tests__/main.test.ts` - Run a specific test file
- `npm test -- --watch` - Run tests in watch mode

**Testing Framework:**
- Vitest 3.x with native ESM support
- Coverage via `@vitest/coverage-v8`
- No transpilation needed - runs TypeScript directly

### End-to-End Testing

The action is tested end-to-end on every PR using `test-prompts/`:

**How It Works:**
1. PR is opened with code changes
2. GitHub Actions runs `.github/workflows/test.yml`
3. The `test` job runs: `uses: ./` (uses your PR code)
4. Action evaluates prompts in `test-prompts/`
5. Verifies action can execute, parse configs, and post results

**Test Files:**
- `test-prompts/promptfooconfig.yaml` - Minimal config (gpt-4o-mini, 1 test)
- `test-prompts/test-prompt.txt` - Simple prompt with variable
- `test-prompts/README.md` - Documentation

**Why This Matters:**
- Unit tests verify logic, E2E tests verify the action actually works
- Tests run against your PR branch code (not main)
- Catches issues like missing `dist/` rebuilds, runtime errors, config parsing bugs

**Testing Approach:**

This project uses **CI-first testing**:
1. Local: `npm run all` (unit tests, linting, bundling)
2. CI: Push to PR → automatic E2E test with `uses: ./`

**Local Testing:**
```bash
# Run everything before committing
npm run all

# Optionally test promptfoo config (requires OPENAI_API_KEY)
export OPENAI_API_KEY=your-key
npx promptfoo@latest eval -c test-prompts/promptfooconfig.yaml
```

**CI E2E Testing (Recommended):**
```bash
# Push to PR - E2E test runs automatically
git push origin my-branch
gh pr create --draft

# Check workflow: test-e2e job
# This runs the actual action in GitHub Actions
```

See [TESTING.md](./TESTING.md) for complete testing guide.

## Architecture

### Build System: `lib/` vs `dist/`

**IMPORTANT:** This project has TWO output directories with different purposes:

#### `lib/` Directory (TypeScript Compilation)
- **Created by:** `npm run build` (runs `tsc`)
- **Contents:** Multiple JS files matching `src/` structure
- **Size:** ~25KB for main.js
- **Dependencies:** External (uses `import` statements referencing `node_modules`)
- **Purpose:** Local development, testing, intermediate build step
- **Git Status:** ❌ **IGNORED** (not committed)
- **Used by:** Tests, ncc bundler

Example `lib/main.js`:
```javascript
import * as core from '@actions/core';
import * as exec from '@actions/exec';
// ... external dependencies
```

#### `dist/` Directory (Production Bundle)
- **Created by:** `npm run package` (runs `ncc build`)
- **Contents:** Single bundled `index.js` file (~1.8MB)
- **Size:** 1.8MB (all dependencies included)
- **Dependencies:** Bundled (self-contained, no external imports)
- **Purpose:** GitHub Actions runtime (what actually executes)
- **Git Status:** ✅ **COMMITTED** (required for action to work)
- **Used by:** GitHub Actions runners

Example `dist/index.js`:
```javascript
/******/ var __webpack_modules__ = ({
// All dependencies are webpack-bundled here
```

#### Build Pipeline Flow

```
Source Code (src/*.ts)
        ↓
    npm run build (tsc)
        ↓
Compiled Code (lib/*.js) ← Tests run against this
        ↓
    npm run package (ncc)
        ↓
Bundled Action (dist/index.js) ← GitHub Actions runs this
```

#### Why Both Exist?

1. **`lib/`** - Faster iteration for testing (no bundling step)
2. **`dist/`** - GitHub Actions has no `node_modules`, needs self-contained bundle
3. **Tests** - Run against `lib/` (faster, clearer stack traces)
4. **Production** - Runs `dist/index.js` (single file, all deps included)

#### What to Commit?

| Directory | Commit? | Why |
|-----------|---------|-----|
| `src/` | ✅ Yes | Source code |
| `lib/` | ❌ No | Build artifact (ignored) |
| `dist/` | ✅ Yes | Required by GitHub Actions |
| `__tests__/` | ✅ Yes | Test code |

### Core Workflow (src/main.ts)

1. Parse inputs from action.yml (API keys, config paths, options)
2. Load .env files if specified in inputs
3. Validate the event type (pull_request, push, or workflow_dispatch)
4. Use git to get changed files between base and head refs
5. Filter for prompt/config files that changed
6. Extract file dependencies from promptfoo config
7. Set up caching environment (optional)
8. Run promptfoo evaluation on changed files
9. Parse evaluation results from JSON output
10. Post results as a PR comment (if enabled)
11. Check success rate against threshold (if configured)
12. Write workflow summary

### Key Components

- **src/main.ts**: Entry point, orchestrates the entire workflow
- **src/utils/auth.ts**: Promptfoo API key validation for cloud features
- **src/utils/cache.ts**: Disk cache management for faster evaluations
- **src/utils/config.ts**: Promptfoo config parsing and dependency extraction
- **src/utils/errors.ts**: Custom error types with error codes
- **src/utils/logger.ts**: Logging utilities (currently unused)

### Security Considerations

- **Git ref validation**: All git refs are validated before use to prevent option injection (see `validateGitRef` in main.ts)
- **API key masking**: API keys are masked using `core.setSecret()` to prevent exposure in logs
- **Path validation**: Should validate path inputs to prevent directory traversal
- **Command injection**: Always use `simple-git` library, never shell out to git commands directly
- **No force operations**: Never run destructive git commands without explicit user request

## Development Guidelines

### TypeScript Configuration

- **Module System:** ES2022 modules (ESM)
- **Module Resolution:** Bundler mode (for ncc compatibility)
- **Target:** ES2022
- **Strict Mode:** Enabled - avoid `any` types
- **Source:** `/src/`
- **Output:** `/lib/`

### Code Style (Biome)

- **Indentation:** 2 spaces
- **Quotes:** Single quotes
- **Trailing Commas:** Required
- **Line Width:** 80 characters
- **Import Order:** Automatically organized
- **Prefer:** const and arrow functions
- **No:** Unused imports or variables

### Testing with Vitest

#### Test Structure

```typescript
import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('feature name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('should do something', () => {
    // Test code
    expect(result).toBe(expected);
  });
});
```

#### Mocking

```typescript
// Mock modules
vi.mock('@actions/core');
vi.mock('./utils/auth.js'); // Note .js extension!

// Mock functions
const mockFn = vi.fn();
mockFn.mockReturnValue('value');
mockFn.mockResolvedValue('async value');

// Access actual implementations
const actual = await vi.importActual('module-name');
```

#### Coverage

- Run with `npm test`
- Reports generated in `/coverage/`
- Minimum coverage: ~82% (current)
- Test files: `__tests__/**/*.ts`

### Building for Release

1. **Make changes** and test locally
2. **Run full build:** `npm run all`
   - This runs: build → biome:check → package → test
3. **Commit changes:**
   - Source code (`src/**/*.ts`)
   - Tests (`__tests__/**/*.ts`)
   - **Bundle** (`dist/index.js`, `dist/index.js.map`, etc.)
   - Config files if changed
4. **Never commit** `lib/` directory (auto-generated, gitignored)
5. **Tag release** following semantic versioning

#### Critical: Always Rebuild `dist/`

The `check-dist` CI workflow will fail if `dist/` is not rebuilt after changes.

**After any code change:**
```bash
npm run build
npm run package
git add dist/
```

## Node.js Version

**Current Runtime:** `node24`

- **action.yml:** `runs.using: 'node24'`
- **Workflows:** Use Node.js 24.x
- **Migration:** Upgraded from node20 (January 2026)
- **Reason:** GitHub Actions is deprecating node20 (March 2026)

**Timeline:**
- Node22 is being skipped by GitHub Actions
- Node20 becomes EOL in April 2026
- All actions must use node24 by March 4, 2026

## Resolving Merge Conflicts

When merging branches (especially main into feature branches):

### 1. Checkout and Update

```bash
git checkout feature/branch-name
git pull origin feature/branch-name
```

### 2. Merge main

```bash
git merge main
```

### 3. Resolve Conflicts

**For different file types:**

| File | Strategy |
|------|----------|
| `action.yml` | Keep both sets of inputs, maintain alphabetical order |
| `src/main.ts` | Include all feature additions (inputs, logic) |
| `__tests__/*.ts` | Merge test suites to include tests for all features |
| `README.md` | Include documentation for all features |
| `dist/` files | Accept either, will be regenerated |
| `lib/` files | Ignore, will be regenerated (not committed) |

### 4. Complete the Merge

```bash
git add .
git commit  # This completes the merge
```

### 5. Rebuild dist/ (CRITICAL!)

This step is **required** for passing the `check-dist` CI workflow:

```bash
npm ci  # Clean install to ensure consistency
npm run build && npm run package
git add dist/
git commit -m "fix: Rebuild dist files after merge"
```

### 6. Push Changes

```bash
git push origin feature/branch-name
```

### Common CI Failures After Merge

| Failure | Cause | Fix |
|---------|-------|-----|
| `check-dist` workflow | `dist/` not rebuilt | `npm run build && npm run package` |
| Test failures | Tests not merged properly | Include all tests from both branches |
| Formatting issues | Code not formatted | `npm run format` |
| Linting errors | Code doesn't match style | `npm run lint:fix` |
| Type errors | TypeScript compilation failed | Check for missing imports, type errors |

## Common Pitfalls

### 1. Missing `.js` Extensions

❌ **Wrong:**
```typescript
import { foo } from './utils/bar';
```

✅ **Correct:**
```typescript
import { foo } from './utils/bar.js';
```

### 2. Using CommonJS Patterns

❌ **Wrong:**
```typescript
const foo = require('./bar');
if (require.main === module) { /* ... */ }
```

✅ **Correct:**
```typescript
import { foo } from './bar.js';
if (import.meta.url === `file://${process.argv[1]}`) { /* ... */ }
```

### 3. Forgetting to Rebuild dist/

After making changes to `src/`:
```bash
# ❌ Committing without rebuild
git add src/main.ts
git commit -m "fix: update logic"
# CI will fail!

# ✅ Rebuild first
npm run build && npm run package
git add src/main.ts dist/
git commit -m "fix: update logic"
```

### 4. Using Jest Instead of Vitest

❌ **Wrong:**
```typescript
import { jest } from '@jest/globals';
jest.mock('./module');
```

✅ **Correct:**
```typescript
import { vi } from 'vitest';
vi.mock('./module.js');
```

### 5. Committing lib/ Directory

The `lib/` directory should never be committed:
```bash
# ❌ Wrong
git add lib/

# ✅ Correct - it's already in .gitignore
# Only commit src/ and dist/
```

## Important Notes

- **Runtime:** Uses node24 (required by GitHub Actions as of 2026)
- **Bundle Size:** ~1.8MB in dist/ (consider optimization if it grows significantly)
- **Module System:** Pure ESM - no CommonJS compatibility
- **Testing:** Vitest 3.x with native ESM support
- **Dependencies:** All `@actions/*` packages are ESM-only (v3/v9)
- **Git Operations:** Always validate refs before use to prevent option injection
- **Caching:** Optional disk cache for faster evaluations
- **API Keys:** Masked in logs for security

## Additional Resources

- **Promptfoo Documentation:** https://www.promptfoo.dev/docs/
- **GitHub Actions Toolkit:** https://github.com/actions/toolkit
- **Vitest Documentation:** https://vitest.dev/
- **Biome Documentation:** https://biomejs.dev/

## Debugging Tips

### Check TypeScript Compilation

```bash
npm run build
# Check lib/ for compilation output
ls -lh lib/
```

### Check Bundled Output

```bash
npm run package
# Check dist/ for bundled output
ls -lh dist/
```

### Run Tests in Watch Mode

```bash
npm test -- --watch
```

### Check Test Coverage

```bash
npm test
# Open coverage/index.html in browser
```

### Debug CI Failures

1. Check GitHub Actions logs
2. Run `npm run all` locally to reproduce
3. Common issues:
   - `dist/` not rebuilt
   - Linting/formatting errors
   - Test failures
   - Type errors

### Verify Bundle is ESM

```bash
head -20 dist/index.js
# Should see: import './sourcemap-register.cjs'
# Should NOT see: module.exports or require() at top level
```
