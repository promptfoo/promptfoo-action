# Github Action for LLM Prompt Evaluation

This Github Action runs `promptfoo eval` to produce a before/after view of prompts modified in a Pull Request.

## Configuration

The action can be configured using the following inputs:

- `openai-api-key`: The API key for OpenAI. This is optional.
- `github-token`: The Github token. This is required.
- `prompts`: The glob patterns for the prompt files. This is required.
- `config`: The path to the configuration file. This is required.
- `cache-path`: The path to the cache. This is optional.

Here is a generic Github Action configuration using "typpo/promptfoo-action@v1" with a cache step:

```yaml
name: 'Prompt Evaluation'
on:
  pull_request:
    paths:
      - 'prompts/**'

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Cache promptfoo
        uses: actions/cache@v2
        with:
          path: ~/.cache/promptfoo
          key: ${{ runner.os }}-promptfoo-v1
          restore-keys: |
            ${{ runner.os }}-promptfoo-
      - name: Run promptfoo evaluation
        uses: typpo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          prompts: 'prompts/**/*.json'
          config: 'prompts/promptfooconfig.yaml'
          cache-path: ~/.cache/promptfoo
```
