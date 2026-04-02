# AGENTS.md

Canonical guidance for AI agents working in this repository.

## Overview

This repository contains a GitHub Action that evaluates prompt changes with Promptfoo, compares before/after behavior on pull requests, and posts the results as PR comments.

The repository also includes a local copy of Promptfoo source under `/promptfoo/` for development/reference. That copy is not included in the distributed action package.

## Commands

### Build and package

- `npm run build` - Compile TypeScript to JavaScript
- `npm run build:watch` - Compile in watch mode
- `npm run package` - Bundle the action with `@vercel/ncc`
- `npm run all` - Run build, lint, package, and tests

### Code quality

- `npm run lint` - Run Biome lint
- `npm run format` - Format with Biome
- `npm run biome` - Run format and lint

### Testing

- `npm test` - Run all tests with coverage
- `npm test -- __tests__/main.test.ts` - Run one test file
- `npm test -- --watch` - Run tests in watch mode

## Architecture

### Core workflow

`src/main.ts`:

1. Parses inputs from `action.yml`
2. Loads `.env` files if requested
3. Validates the GitHub event is a pull request
4. Detects changed files between base and head refs
5. Filters for changed prompt/config files
6. Runs Promptfoo evaluation on those files
7. Posts a PR comment with the results

### Key files

- `src/main.ts` - Action entry point and orchestration
- `src/utils/git.ts` - Git diff and ref handling
- `src/utils/promptfoo.ts` - Promptfoo evaluation wrapper
- `src/utils/github.ts` - GitHub API / PR comment logic
- `src/utils/env.ts` - Environment loading

## Security Requirements

- Validate all git refs before using them in shell commands.
- Mask API keys with `core.setSecret()`.
- Validate path inputs to avoid directory traversal issues.

## Development Guidelines

### TypeScript

- Strict mode is enabled; avoid `any`.
- Source lives in `/src/`; compiled output goes to `/lib/`.
- Target ES6 and CommonJS output.

### Style

- Biome formatting: 2 spaces, single quotes, trailing commas.
- Line width: 80 characters.
- Prefer `const` and arrow functions.
- Remove unused imports and variables.

### Tests

- Jest is used for tests.
- Mock external boundaries such as GitHub, filesystem, and git execution.
- Coverage output is written to `/coverage/`.

## Release Workflow

1. Make changes and test locally
2. Run `npm run all`
3. Commit both source changes and generated `/dist/`
4. Tag releases using semantic versioning

## Merge Conflict Workflow

When merging `main` into a feature branch:

```bash
git checkout feature/branch-name
git pull origin feature/branch-name
git merge main
```

Conflict-resolution notes:

- `action.yml`: keep all input additions and preserve alphabetical order
- `src/main.ts`: preserve logic from both branches
- `__tests__/main.test.ts`: keep test coverage for both branches
- `README.md`: preserve docs for all features
- `dist/`: regenerate after conflict resolution

After resolving conflicts:

```bash
git add .
git commit
npm ci
npm run build
npm run package
git add dist/
git commit -m "fix: rebuild dist files after merge"
git push origin feature/branch-name
```

## Common CI Failures

- `check-dist` failure: regenerate `dist/` after merges
- Test failures: verify test suites from both branches were preserved
- Formatting failures: run `npm run format`

## Notes

- The action currently uses Node 16 runtime and should be updated to Node 20.
- Bundle size is around 1.5 MB; avoid unnecessary growth.
- Review `TODO.md` before planning larger improvements.
