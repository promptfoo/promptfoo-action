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
| `promptfoo-version` | The version of promptfoo to use. Defaults to `latest` | No |

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
    permissions:
      contents: read # Required for actions/checkout
      pull-requests: write # Ability to post comments on Pull Requests
    steps:
      # Required for promptfoo-action's git usage
      - uses: actions/checkout@v4

      # This cache is optional, but you'll save money and time by setting it up!
      - name: Set up promptfoo cache
        uses: actions/cache@v3
        with:
          path: ~/.cache/promptfoo
          key: ${{ runner.os }}-promptfoo-v1
          restore-keys: |
            ${{ runner.os }}-promptfoo-

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          prompts: 'prompts/**/*.json'
          config: 'prompts/promptfooconfig.yaml'
          cache-path: ~/.cache/promptfoo
```

If you are using an OpenAI model, remember to create the secret in Repository Settings > Secrets and Variables > Actions > New repository secret.

For more information on how to set up the promptfoo config, see [documentation](https://promptfoo.dev/docs/getting-started).
