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
# Run promptfoo eval (no API keys needed - uses echo provider)
npx promptfoo@latest eval -c test-prompts/promptfooconfig.yaml
```

## Modifying Tests

Keep this configuration minimal and fast:
- Use `echo` provider (no API keys required, instant response)
- Single test case only
- Simple assertion (just verify it runs)

The goal is to verify the **action works**, not to extensively test promptfoo itself.

## Why Echo Provider?

The E2E test uses the `echo` provider instead of real LLM APIs because:
- ✅ No API keys required in CI
- ✅ Instant execution (no API latency)
- ✅ No API costs
- ✅ Tests action functionality without external dependencies
- ✅ Reliable (no API rate limits or quota issues)
