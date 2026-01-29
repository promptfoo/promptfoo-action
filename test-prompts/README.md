# Test Prompts

This directory contains minimal test fixtures for end-to-end testing of the promptfoo-action.

## Purpose

When a PR is opened, the `test` job in `.github/workflows/test.yml` runs the action using these files to verify:
- The action can execute successfully
- It can parse promptfoo configs
- It can run evaluations
- It can post results (in PR context)

## Files

- `promptfooconfig.yaml` - Minimal promptfoo configuration
- `test-prompt.txt` - Simple test prompt with a variable

## Testing Locally

To test the action with these files:

```bash
# Set required environment variables
export OPENAI_API_KEY=your-key-here

# Run promptfoo eval
npx promptfoo@latest eval -c test-prompts/promptfooconfig.yaml
```

## Modifying Tests

Keep this configuration minimal and fast:
- Use `openai:gpt-4o-mini` (cheapest, fastest)
- Single test case only
- Simple assertion (just verify it runs)

The goal is to verify the **action works**, not to extensively test promptfoo itself.
