# Security Considerations

This document outlines the security measures implemented in the promptfoo GitHub Action.

## API Key Handling

### Validation

All API keys are validated before use to ensure they meet provider-specific requirements:

- **Format validation**: Keys must match expected patterns (e.g., OpenAI keys start with `sk-`)
- **Length validation**: Keys must meet minimum and maximum length requirements
- **Placeholder detection**: Common placeholder values are rejected (e.g., `YOUR_API_KEY`, `xxx`)
- **Whitespace detection**: Keys containing spaces, tabs, or newlines are rejected

### Masking

All API keys are automatically masked in GitHub Actions logs using `core.setSecret()`. This prevents accidental exposure in:
- Console output
- Error messages
- Debug logs

### Supported Providers

| Provider | Environment Variable | Pattern | Min Length |
|----------|---------------------|---------|------------|
| OpenAI | `OPENAI_API_KEY` | `sk-[a-zA-Z0-9]{48,}` | 51 |
| Anthropic | `ANTHROPIC_API_KEY` | `sk-ant-[a-zA-Z0-9-_]{90,}` | 95 |
| Hugging Face | `HF_API_TOKEN` | `hf_[a-zA-Z0-9]{30,}` | 33 |
| AWS Access Key | `AWS_ACCESS_KEY_ID` | `[A-Z0-9]{16,}` | 16 |
| Replicate | `REPLICATE_API_KEY` | `r8_[a-zA-Z0-9]{37}` | 40 |

## Input Validation

### Git References

Git references are validated to prevent command injection:
- Only alphanumeric characters, hyphens, underscores, dots, and slashes are allowed
- References starting with `--` are rejected to prevent git option injection

### File Paths

File paths should be validated to prevent directory traversal attacks:
- Paths are resolved relative to the working directory
- Absolute paths outside the workspace should be rejected

## Best Practices

### For Action Users

1. **Use GitHub Secrets**: Always store API keys in GitHub Secrets, never in plain text
2. **Minimal Permissions**: Use API keys with minimal required permissions
3. **Rotate Keys**: Regularly rotate API keys
4. **Audit Usage**: Monitor API key usage through provider dashboards

### For Contributors

1. **Never Log Sensitive Data**: Always use `core.setSecret()` before logging
2. **Validate All Inputs**: Never trust user input without validation
3. **Use Secure Defaults**: Default to the most secure configuration
4. **Document Security**: Keep this document updated with security changes

## Reporting Security Issues

If you discover a security vulnerability, please:

1. **Do NOT** create a public GitHub issue
2. Email security concerns to [maintainer email]
3. Include detailed steps to reproduce the issue
4. Allow time for a fix before public disclosure

## Audit Logging

The action logs security-relevant events for debugging:
- API key configuration (with masked values)
- Validation failures
- Provider usage

These logs help identify configuration issues without exposing sensitive data.