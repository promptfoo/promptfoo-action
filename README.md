# Github Action for LLM Prompt Evaluation

This Github Action uses [promptfoo](https://www.promptfoo.dev) to produce a before/after view of edit prompts.

When you change a prompt, an eval will automatically be posted on the pull request:

<img width="650" alt="pull request llm eval" src="https://github.com/typpo/promptfoo-action/assets/310310/ec75fb39-c6b1-4395-9e41-6d66a7bf8657"/>

The provided link opens the promptfoo web viewer, which allows you to interactively explore the before vs. after:

<img width="650" alt="promptfoo web viewer" src="https://github.com/typpo/promptfoo-action/assets/310310/d0ef0497-0c1a-4886-b115-1ee92680891b"/>

## Supported Events

This action supports multiple GitHub event types:
- **Pull Request** (`pull_request`, `pull_request_target`) - Compares changes between base and head branches
- **Push** (`push`) - Compares changes between commits
- **Manual Trigger** (`workflow_dispatch`) - Allows manual evaluation with custom inputs

## Configuration

The action can be configured using the following inputs:

| Parameter            | Description                                                                                                                                               | Required |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `config`             | The path to the configuration file. This file contains settings for the action.                                                                           | Yes      |
| `github-token`       | The Github token. Used to authenticate requests to the Github API.                                                                                        | Yes      |
| `cache-path`         | The path to the cache. This is where the action stores temporary data.                                                                                    | No       |
| `no-share`           | No sharing option for promptfoo. Defaults to `false`                                                                                                      | No       |
| `promptfoo-version`  | The version of promptfoo to use. Defaults to `latest`                                                                                                     | No       |
| `working-directory`  | The working directory to run `promptfoo` in. Can be set to a location where `promptfoo` is already installed.                                             | No       |
| `prompts`            | The glob patterns for the prompt files. These patterns are used to find the prompt files that the action should evaluate.                                 | No       |
| `use-config-prompts` | Use prompt files set at config file. Defaults to `false`                                                                                                  | No       |
| `env-files`          | Comma-separated list of .env files to load (e.g. ".env,.env.test.local"). Environment variables from these files will be loaded before running promptfoo. | No       |
| `fail-on-threshold`  | Fail the action if the evaluation success rate is below this percentage (0-100). Example: `80` for 80% success rate.                                      | No       |
| `max-concurrency`    | Maximum number of concurrent API calls. Defaults to `4`. Useful for rate limiting.                                                                         | No       |
| `no-table`           | Run promptfoo with `--no-table` flag to keep output minimal. Defaults to `false`                                                                          | No       |
| `no-progress-bar`    | Run promptfoo with `--no-progress-bar` flag to keep output minimal. Defaults to `false`                                                                   | No       |
| `disable-comment`    | Disable posting comments to the PR. Defaults to `false`                                                                                                   | No       |
| `upload-artifact`    | Upload evaluation results as GitHub Action artifact. Defaults to `false`                                                                                  | No       |
| `artifact-name`      | Name for the uploaded artifact. Defaults to `promptfoo-eval-results`                                                                                      | No       |

The following API key parameters are supported:

| Parameter               | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `openai-api-key`        | The API key for OpenAI. Used to authenticate requests to the OpenAI API.             |
| `azure-api-key`         | The API key for Azure OpenAI. Used to authenticate requests to the Azure OpenAI API. |
| `anthropic-api-key`     | The API key for Anthropic. Used to authenticate requests to the Anthropic API.       |
| `huggingface-api-key`   | The API key for Hugging Face. Used to authenticate requests to the Hugging Face API. |
| `aws-access-key-id`     | The AWS access key ID. Used to authenticate requests to AWS services.                |
| `aws-secret-access-key` | The AWS secret access key. Used to authenticate requests to AWS services.            |
| `replicate-api-key`     | The API key for Replicate. Used to authenticate requests to the Replicate API.       |
| `palm-api-key`          | The API key for Palm. Used to authenticate requests to the Palm API.                 |
| `vertex-api-key`        | The API key for Vertex. Used to authenticate requests to the Vertex AI API.          |
| `cohere-api-key`        | The API key for Cohere. Used to authenticate requests to the Cohere API.             |
| `mistral-api-key`       | The API key for Mistral. Used to authenticate requests to the Mistral API.           |
| `groq-api-key`          | The API key for Groq. Used to authenticate requests to the Groq API.                 |

## Usage Examples

### Pull Request Evaluation

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
          config: 'prompts/promptfooconfig.yaml'
          cache-path: ~/.cache/promptfoo
```

### Manual Trigger (workflow_dispatch)

You can also trigger evaluations manually using workflow_dispatch:

```yaml
name: 'Prompt Evaluation - Manual'
on:
  workflow_dispatch:
    inputs:
      files:
        description: 'Files to evaluate (leave empty to auto-detect)'
        required: false
        type: string
      base:
        description: 'Base branch/commit to compare against'
        required: false
        default: 'HEAD~1'
        type: string

jobs:
  evaluate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write # Required for workflow summaries
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Fetch all history for comparisons

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'prompts/promptfooconfig.yaml'
```

When triggered manually:
- If `files` input is provided, only those files will be evaluated (one file per line)
- If `base` input is provided, it will compare against that branch/commit
- If no inputs are provided, it will compare against the previous commit (HEAD~1)
- Results will be displayed in the workflow summary instead of a PR comment
- **Important**: The `actions: write` permission is required for writing workflow summaries

#### Alternative: Using Action Inputs

You can also specify files and base directly as action inputs:

```yaml
- name: Run promptfoo evaluation
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'prompts/promptfooconfig.yaml'
    workflow-files: |
      prompts/prompt1.txt
      prompts/prompt2.txt
    workflow-base: 'main'
```

### Push Event Evaluation

Evaluate prompts on every push to the main branch:

```yaml
name: 'Prompt Evaluation - Push'
on:
  push:
    branches:
      - main
    paths:
      - 'prompts/**'

jobs:
  evaluate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write # Required for workflow summaries
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2 # Need at least 2 commits for comparison

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'prompts/promptfooconfig.yaml'
```

## Tips

If you are using an OpenAI model, remember to create the secret in Repository Settings > Secrets and Variables > Actions > New repository secret.

For more information on how to set up the promptfoo config, see [documentation](https://promptfoo.dev/docs/getting-started).

## Using .env Files

If your application uses `.env` files to store environment variables, you can load them before running promptfoo evaluations:

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
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'prompts/promptfooconfig.yaml'
          env-files: '.env,.env.test.local' # Load multiple .env files
```

This is particularly useful for Next.js applications or other frameworks that use `.env` files for configuration. The environment variables from these files will be available to promptfoo during evaluation.

## Artifact Support

The action can upload evaluation results as GitHub Action artifacts, allowing you to persist results beyond the 2-week lifespan of shareable URLs:

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
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - name: Run promptfoo evaluation
        id: promptfoo
        uses: promptfoo/promptfoo-action@main
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'prompts/promptfooconfig.yaml'
          upload-artifact: true
          artifact-name: 'eval-results-${{ github.run_number }}'

      # You can reference the outputs
      - name: Display artifact info
        run: |
          echo "Artifact name: ${{ steps.promptfoo.outputs.artifact-name }}"
          echo "Output path: ${{ steps.promptfoo.outputs.output-path }}"

      # Download and use the artifact in a later job
      - name: Download evaluation results
        uses: actions/download-artifact@v4
        with:
          name: ${{ steps.promptfoo.outputs.artifact-name }}
```

### Artifact Outputs

The action provides the following outputs when artifacts are enabled:

- `artifact-name`: The name of the uploaded artifact (only set if `upload-artifact` is true)
- `output-path`: The path to the evaluation results JSON file (always set)

Artifacts are retained for 90 days by default and can be downloaded from the GitHub Actions UI or via the API.

**Note**: Artifact names are automatically sanitized to remove invalid characters. If using the same artifact name across multiple workflow runs, newer artifacts will overwrite older ones. Consider including a unique identifier (like run number or timestamp) in the artifact name to preserve multiple versions.

## Minimal Output

To reduce console output in CI, set `no-table: true` and `no-progress-bar: true` in your action configuration.
