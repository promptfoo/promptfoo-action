# Github Action for LLM Prompt Evaluation

This Github Action uses [promptfoo](https://www.promptfoo.dev) to produce a before/after view of edit prompts.

When you change a prompt, an eval will automatically be posted on the pull request:

<img width="650" alt="pull request llm eval" src="https://github.com/typpo/promptfoo-action/assets/310310/ec75fb39-c6b1-4395-9e41-6d66a7bf8657"/>

The provided link opens the promptfoo web viewer, which allows you to interactively explore the before vs. after:

<img width="650" alt="promptfoo web viewer" src="https://github.com/typpo/promptfoo-action/assets/310310/d0ef0497-0c1a-4886-b115-1ee92680891b"/>


## Configuration

The action can be configured using the following inputs:

| Parameter | Description | Required |
| --- | --- | --- |
| `github-token` | The Github token. Used to authenticate requests to the Github API. | Yes |
| `prompts` | The glob patterns for the prompt files. These patterns are used to find the prompt files that the action should evaluate. | Yes |
| `config` | The path to the configuration file. This file contains settings for the action. | Yes |
| `openai-api-key` | The API key for OpenAI. Used to authenticate requests to the OpenAI API. | No |
| `cache-path` | The path to the cache. This is where the action stores temporary data. | No |

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
      # This cache is optional, but you'll save money and time by setting it up!
      - name: Set up promptfoo cache
        uses: actions/cache@v2
        with:
          path: ~/.cache/promptfoo
          key: ${{ runner.os }}-promptfoo-v1
          restore-keys: |
            ${{ runner.os }}-promptfoo-

      # This step will actually run the before/after evaluation
      - name: Run promptfoo evaluation
        uses: typpo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          prompts: 'prompts/**/*.json'
          config: 'prompts/promptfooconfig.yaml'
          cache-path: ~/.cache/promptfoo
```

For more information on how to set up the promptfoo config, see [documentation](https://promptfoo.dev/docs/getting-started).
