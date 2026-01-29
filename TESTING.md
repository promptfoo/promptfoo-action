# Testing Guide

This guide explains how to test the action both locally and in CI.

## Quick Start

**Local testing:**
```bash
# Run everything (recommended before pushing)
npm run all
```

**CI testing (recommended):**
```bash
# Push to a PR - the E2E test will run automatically
git checkout -b test/my-feature
git push origin test/my-feature
gh pr create --draft
```

## Testing Strategy: CI-First Approach

**Local:** Fast feedback on code quality
```bash
npm run all  # Compile, lint, bundle, unit test
```

**CI (GitHub Actions):** Real end-to-end validation
```bash
git push origin my-branch  # Triggers automatic E2E test
```

### Why CI-First?

The action runs in GitHub's environment with:
- Real GitHub context and secrets
- Actual node24 runtime
- Real PR comment posting
- Exact production conditions

**You cannot fully replicate this locally.** The best test is a real PR.

### What Each Level Tests

| Level | Where | What | Time |
|-------|-------|------|------|
| Unit Tests | Local | Logic, functions, modules | 5s |
| Build/Lint | Local | TypeScript, formatting | 5s |
| Bundle Check | Local | `dist/` is current | 1s |
| **E2E Test** | **CI** | **Full action execution** | **60s** |

**Bottom line:** `npm run all` locally, then push to PR for E2E validation.

## Testing Levels

### Level 1: Build Pipeline ✅ (Always Run)

```bash
npm run all
```

**What it tests:**
- ✅ TypeScript compiles without errors
- ✅ Code passes Biome linting/formatting
- ✅ Bundle is created successfully with ncc
- ✅ All 89 unit tests pass
- ✅ Code coverage is adequate

**When to run:** Before every commit

**Time:** ~5 seconds

### Level 2: Promptfoo Config ✅ (Requires API Key)

```bash
# Set your OpenAI API key
export OPENAI_API_KEY=sk-...

# Run promptfoo directly
cd test-prompts
npx promptfoo@latest eval -c promptfooconfig.yaml
```

**What it tests:**
- ✅ Test fixtures are valid
- ✅ Promptfoo can parse the config
- ✅ Evaluation runs successfully
- ✅ Test prompts work

**When to run:** Before pushing, when changing test fixtures

**Time:** ~10-30 seconds (depends on LLM API)

**Cost:** ~$0.01 (uses gpt-4o-mini)

### Level 3: CI End-to-End Test ✅ (Recommended)

Push to a branch and open a PR (can be draft):

```bash
git checkout -b test/my-changes
git add -A
git commit -m "test: my changes"
git push origin test/my-changes

# Open draft PR on GitHub
gh pr create --draft --title "Test: My Changes" --body "Testing changes"
```

**What it tests:**
- ✅ Action runs in real GitHub Actions environment
- ✅ Executes `dist/index.js` from your PR branch
- ✅ Tests with real promptfoo evaluation
- ✅ Actual PR comment posting (if not draft)
- ✅ Real secrets/tokens
- ✅ Exact node24 runtime that will be used in production

**When to run:**
- Before merging any PR
- When changing action code, workflow files, or test fixtures
- When unsure if changes will work in CI

**Time:** ~1-2 minutes (GitHub Actions queue + run time)

**How it works:**
1. PR opened → `.github/workflows/test.yml` triggers
2. `test-e2e` job runs: `uses: ./` (your PR code)
3. Action evaluates `test-prompts/promptfooconfig.yaml`
4. Posts results as PR comment
5. Verifies action works end-to-end

**This is the BEST way to test the action** - it uses the exact same environment as production.

## Individual Component Testing

### Just TypeScript Compilation

```bash
npm run build
# Check lib/ directory
ls -lh lib/
```

### Just Linting/Formatting

```bash
# Check only (no changes)
npm run biome:check

# Auto-fix issues
npm run biome
```

### Just Bundling

```bash
npm run package
# Check dist/ directory
ls -lh dist/
```

### Just Unit Tests

```bash
# All tests
npm test

# Specific test file
npm test -- __tests__/main.test.ts

# Watch mode (re-run on changes)
npm test -- --watch

# With UI
npm test -- --ui
```

### Just Check dist/ is Current

```bash
npm run build
npm run package
git diff dist/

# Should show no changes if dist/ is up to date
```

## Pre-Commit Checklist

Before committing changes:

- [ ] `npm run all` passes
- [ ] No uncommitted changes to `dist/` (run `git diff dist/`)
- [ ] Test config works: `npx promptfoo@latest eval -c test-prompts/promptfooconfig.yaml`
- [ ] Reviewed `git diff` for unintended changes

## Pre-Push Checklist

Before pushing to a PR:

- [ ] All commits have clean history
- [ ] Branch is up to date with main: `git pull origin main`
- [ ] `npm run all` still passes after merge
- [ ] Rebuilt dist/ after merge if needed
- [ ] Tested promptfoo config still works

## Debugging Failures

### Unit Tests Failing

```bash
# Run in watch mode to debug
npm test -- --watch

# Run specific test
npm test -- __tests__/main.test.ts

# See detailed output
npm test -- --reporter=verbose
```

### Build Failing

```bash
# Check TypeScript errors
npm run build

# Check for syntax errors
npx tsc --noEmit
```

### Lint/Format Failing

```bash
# See what's wrong
npm run biome:check

# Auto-fix
npm run biome

# Check specific file
npx biome check src/main.ts
```

### Bundle Failing

```bash
# Try rebuilding from scratch
rm -rf node_modules lib dist
npm ci
npm run build
npm run package
```

### Promptfoo Config Failing

```bash
# Check config syntax
npx promptfoo@latest config validate test-prompts/promptfooconfig.yaml

# Run with verbose output
cd test-prompts
npx promptfoo@latest eval -c promptfooconfig.yaml --verbose

# Check for missing files
ls -la test-prompts/
```

## CI/CD Workflows

### Workflows on Every PR

When you open a PR, these workflows run automatically:

#### 1. **check-dist** (Critical)
- **File:** `.github/workflows/check-dist.yml`
- **Purpose:** Verifies `dist/` matches current source code
- **Prevents:** Deploying outdated/missing bundle
- **Runs:** `npm run build && npm run package`, then checks for git diffs

#### 2. **build**
- **File:** `.github/workflows/test.yml`
- **Purpose:** Validates code compiles, lints, tests pass
- **Runs:** `npm run all` (build → lint → package → test)

#### 3. **style-check**
- **File:** `.github/workflows/test.yml`
- **Purpose:** Enforces code formatting/linting
- **Runs:** `npm run biome:check`

#### 4. **test-e2e** ⭐ (End-to-End Test)
- **File:** `.github/workflows/test.yml`
- **Purpose:** Tests the actual action in real GitHub Actions environment
- **How:** Runs `uses: ./` which executes `dist/index.js` from your PR
- **Tests:**
  - Action can start and run without errors
  - Can parse promptfoo configs
  - Can run evaluations with real LLM API
  - Can post PR comments
  - ESM bundle works correctly
  - node24 runtime compatibility
- **Requires:** `OPENAI_API_KEY` secret set in repo
- **Time:** ~30-60 seconds
- **This is the REAL test** - if this passes, your action works!

### Ensuring CI Success

**Most common CI failures:**

| Failure | Cause | Fix |
|---------|-------|-----|
| `check-dist` fails | `dist/` out of date | `npm run package && git add dist/` |
| `build` fails | TypeScript errors | Fix errors, run `npm run build` |
| `style-check` fails | Formatting issues | Run `npm run biome` |
| `test` (E2E) fails | Promptfoo config issue | Test locally with API key |
| Unit tests fail | Logic errors | Fix code, run `npm test` |

## GitHub Secrets Required

For E2E testing in CI, these secrets must be set in the repo:

- `OPENAI_API_KEY` - OpenAI API key for promptfoo evaluations

To add secrets:
```bash
gh secret set OPENAI_API_KEY
# Paste your key when prompted
```

## Tips

### Fast Iteration

```bash
# Start test watcher
npm test -- --watch

# Make changes to src/
# Tests auto-run on save

# When done, rebuild bundle
npm run build && npm run package
```

### Testing ESM Compatibility

```bash
# Check for CommonJS patterns that break ESM
grep -r "require(" src/
grep -r "__dirname" src/
grep -r "__filename" src/
grep -r "module.exports" src/

# Should all return no results
```

### Testing Import Paths

```bash
# All relative imports should end in .js
grep -r "from '\\./" src/ | grep -v "\.js'"

# Should return no results
```

### Verify Bundle Uses ESM

```bash
# Check dist/index.js starts with ESM import
head -2 dist/index.js

# Should show: import './sourcemap-register.cjs';
```

**Note about `sourcemap-register.cjs`:**
- This is a CommonJS file created by ncc (the bundler)
- It's needed for source map support in the bundle
- ESM can import CJS (but not vice versa), so this is fine
- It's loaded before the main bundle executes
- Your action code is still pure ESM (all in `dist/index.js`)
- **This is normal and expected** - don't try to convert it to .js

## Common Questions

### Why is `action.yml` showing as red/invalid in VSCode?

The file is valid YAML (verified with `npx js-yaml action.yml`). VSCode may show it as red because:

1. **Missing GitHub Actions extension:**
   - Install: [GitHub Actions Extension](https://marketplace.visualstudio.com/items?itemName=github.vscode-github-actions)

2. **No schema validation configured:**
   - The extension auto-configures schema validation for action.yml files

3. **VSCode cache issue:**
   - Reload window: `Cmd+Shift+P` → "Developer: Reload Window"

**To verify it's valid:**
```bash
npx js-yaml action.yml > /dev/null && echo "✅ Valid"
```

### Why is there a `.cjs` file in `dist/`?

`dist/sourcemap-register.cjs` is created by ncc (the bundler) for source map support. This is normal:

- Your action code is ESM (`dist/index.js` uses `import`/`export`)
- ESM can import CommonJS (allowed)
- The `.cjs` file loads before your bundle executes
- **Do not convert it to `.js`** - it must be CommonJS

## Troubleshooting

### "Cannot find module" errors

You probably forgot `.js` extension:

```typescript
// ❌ Wrong
import { foo } from './utils/bar';

// ✅ Correct
import { foo } from './utils/bar.js';
```

### "require is not defined" errors

You're using CommonJS in ESM:

```typescript
// ❌ Wrong
const foo = require('./bar');

// ✅ Correct
import foo from './bar.js';
```

### Tests pass but action fails in CI

Probably forgot to rebuild `dist/`:

```bash
npm run build && npm run package
git add dist/
git commit -m "fix: rebuild dist"
```

### act fails with Docker errors

Make sure Docker is running:

```bash
docker ps
# Should not error
```

## Additional Resources

- [Vitest Documentation](https://vitest.dev/)
- [act Documentation](https://github.com/nektos/act)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Promptfoo Documentation](https://www.promptfoo.dev/docs/)
