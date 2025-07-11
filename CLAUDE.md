# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a GitHub Action that evaluates LLM outputs using promptfoo. It runs before/after comparisons of prompt changes in pull requests and posts results as PR comments.

Note: This repository includes a copy of the promptfoo source code in the `/promptfoo/` directory. This is used for analyzing and understanding promptfoo's capabilities during development but is not included in the distributed action.

## Commands

### Build and Development

- `npm run build` - Compile TypeScript to JavaScript
- `npm run build:watch` - Watch mode for TypeScript compilation
- `npm run package` - Bundle the action with @vercel/ncc for distribution
- `npm run all` - Full build pipeline (build → lint → package → test)

### Code Quality

- `npm run lint` - Run Biome linter
- `npm run format` - Format code with Biome
- `npm run biome` - Run both format and lint

### Testing

- `npm test` - Run all tests with coverage
- `npm test -- __tests__/main.test.ts` - Run a specific test file
- `npm test -- --watch` - Run tests in watch mode

## Architecture

### Core Workflow (src/main.ts)

1. Parse inputs from action.yml (API keys, config paths, options)
2. Load .env files if specified in inputs
3. Validate the event is a pull request
4. Use git to get changed files between base and head branches
5. Filter for prompt/config files that changed
6. Run promptfoo evaluation on changed files
7. Post evaluation results as a PR comment

### Key Components

- **src/main.ts**: Entry point, orchestrates the entire workflow
- **src/utils/git.ts**: Git operations for detecting changed files
- **src/utils/promptfoo.ts**: Wrapper for promptfoo evaluation
- **src/utils/github.ts**: GitHub API interactions for PR comments
- **src/utils/env.ts**: Environment file loading

### Security Considerations

- All git refs must be validated before use in commands (see validateGitRef in git.ts)
- API keys are masked using core.setSecret() to prevent exposure in logs
- Path inputs should be validated to prevent directory traversal

## Development Guidelines

### TypeScript

- Strict mode is enabled - avoid `any` types
- Target ES6, output CommonJS modules
- Source in `/src/`, compiled to `/lib/`

### Code Style

- Biome enforces: 2 spaces, single quotes, trailing commas
- Line width: 80 characters
- Prefer const and arrow functions
- No unused imports or variables

### Testing

- Jest with TypeScript support
- Mock external dependencies (GitHub API, file system, git)
- Coverage reports generated in `/coverage/`

### Building for Release

1. Make changes and test locally
2. Run `npm run all` to build, lint, and test
3. Commit both source and `/dist/` folder
4. Tag release following semantic versioning

## Important Notes

- The action currently uses node16 runtime but needs updating to node20
- Bundle size in dist/ is ~1.5MB - consider optimization if it grows
- See TODO.md for planned improvements and known issues
- When modifying git operations, ensure proper ref validation to prevent command injection
