# Github Action for LLM Prompt Evaluation

This Github Action uses [promptfoo](https://www.promptfoo.dev) to produce a before/after view of edit prompts.

When you change a prompt, an eval will automatically be posted on the pull request:

<img width="650" alt="pull request llm eval" src="https://github.com/typpo/promptfoo-action/assets/310310/ec75fb39-c6b1-4395-9e41-6d66a7bf8657"/>

The provided link opens the promptfoo web viewer, which allows you to interactively explore the before vs. after:

<img width="650" alt="promptfoo web viewer" src="https://github.com/typpo/promptfoo-action/assets/310310/d0ef0497-0c1a-4886-b115-1ee92680891b"/>

## Supported Events

This action supports multiple GitHub event types:
- **Pull Request** (`pull_request`, `pull_request_target`) - Compares changes between base and head branches
- **Push** (`push`) - Compares changes between commits *(requires v1.1.0+)*
- **Manual Trigger** (`workflow_dispatch`) - Allows manual evaluation with custom inputs *(requires v1.1.0+)*

> **Note:** Version v1.0.0 only supports `pull_request` events. To use `push` or `workflow_dispatch` events, please use `@v1` (which now points to v1.1.0+) or explicitly use `@v1.1.0`.

## Configuration

The action can be configured using the following inputs:

| Parameter            | Description                                                                                                                                               | Required |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `config`             | The path to the configuration file. This file contains settings for the action.                                                                           | Yes      |
| `github-token`       | The Github token. Used to authenticate requests to the Github API.                                                                                        | Yes      |
| `cache-path`         | The path to the cache. This is where the action stores temporary data.                                                                                    | No       |
| `no-share`           | Disable sharing of evaluation results. Defaults to `false` (sharing enabled). See [Sharing Results](#sharing-results) for details.                       | No       |
| `promptfoo-version`  | The version of promptfoo to use. Defaults to `latest`                                                                                                     | No       |
| `working-directory`  | The working directory to run `promptfoo` in. Can be set to a location where `promptfoo` is already installed.                                             | No       |
| `prompts`            | The glob patterns for the prompt files. These patterns are used to find the prompt files that the action should evaluate.                                 | No       |
| `use-config-prompts` | Use prompt files set at config file. Defaults to `false`                                                                                                  | No       |
| `env-files`          | Comma-separated list of .env files to load (e.g. ".env,.env.test.local"). Environment variables from these files will be loaded before running promptfoo. | No       |
| `fail-on-threshold`  | Fail the action if the evaluation success rate is below this percentage (0-100). Example: `80` for 80% success rate.                                      | No       |
| `max-concurrency`    | Maximum number of concurrent API calls. Defaults to `4`. Useful for rate limiting.                                                                         | No       |
| `no-table`           | Run promptfoo with `--no-table` flag to keep output minimal. Defaults to `false`                                                                          | No       |
| `no-progress-bar`    | Run promptfoo with `--no-progress-bar` flag to keep output minimal. Defaults to `false`                                                                   | No       |
| `no-cache`           | Run promptfoo with `--no-cache` flag to avoid reading or writing results to the disk cache. Defaults to `false`                                             | No       |
| `disable-comment`    | Disable posting comments to the PR. Defaults to `false`                                                                                                   | No       |
| `force-run`          | Force evaluation to run even if no files changed. Defaults to `false`                                                                                      | No       |

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

### Environment Variables

All workflow environment variables are passed through to promptfoo. You can set API keys at the job/workflow level instead of as action inputs:

```yaml
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

steps:
  - uses: promptfoo/promptfoo-action@v1
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      config: 'promptfooconfig.yaml'
```

Action inputs take precedence over environment variables. See action.yml for the complete mapping of input parameters to environment variables.

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
      # IMPORTANT: Use actions/cache@v4 or later (required after Feb 1, 2025)
      - name: Set up promptfoo cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.promptfoo/cache
            .promptfoo-cache
          key: ${{ runner.os }}-promptfoo-${{ hashFiles('prompts/**') }}-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-promptfoo-${{ hashFiles('prompts/**') }}-
            ${{ runner.os }}-promptfoo-

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
          cache-path: '.promptfoo-cache'
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
        uses: promptfoo/promptfoo-action@main
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
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
  uses: promptfoo/promptfoo-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
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
        uses: promptfoo/promptfoo-action@main
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
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
          config: 'promptfooconfig.yaml'
          env-files: '.env,.env.test.local' # Load multiple .env files
```

This is particularly useful for Next.js applications or other frameworks that use `.env` files for configuration. The environment variables from these files will be available to promptfoo during evaluation.

## Custom Provider Detection

The action automatically detects changes to custom provider files referenced in your promptfoo configuration. When you use custom providers with `file://` URLs, the action will trigger evaluations when these files change.

### Supported Patterns

1. **Direct file references:**
   ```yaml
   providers:
     - file://custom_provider.py
     - id: file://providers/my_provider.js
   ```

2. **Wildcard patterns:**
   ```yaml
   providers:
     - file://providers/*.py          # All Python files in providers/
     - file://lib/**/*.js            # All JS files recursively in lib/
   ```

3. **Directory watching:**
   ```yaml
   providers:
     - file://providers/             # Watch entire directory
   ```

### How It Works

- When you specify a wildcard pattern (e.g., `file://providers/*.py`), the action watches the entire directory
- Changes to any file matching the pattern will trigger evaluation
- Directory paths automatically watch all files within that directory
- This works for providers, prompts, test data files, and assertion files

### Example Configuration

```yaml
# promptfooconfig.yaml
providers:
  - file://providers/**/*.py      # Watch all Python files recursively
  
prompts:
  - file://prompts/               # Watch entire prompts directory

tests:
  - vars:
      context: file://data/*.json # Watch all JSON files in data/
    assert:
      - type: javascript
        value: file://validators/ # Watch all files in validators/
```

### Force Running Evaluations

If you need to run evaluations regardless of file changes, use the `force-run` option:

```yaml
- name: Run promptfoo evaluation
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
    force-run: true
```

## Caching for Better Performance

promptfoo-action integrates with both GitHub Actions caching and promptfoo's internal caching to significantly reduce API costs and evaluation time. 

### Why Caching Matters

- **Cost Savings**: Avoid redundant API calls to OpenAI, Anthropic, and other providers
- **Speed**: Cached evaluations complete in seconds vs. minutes
- **Reliability**: Reduce dependency on external API availability
- **Consistency**: Ensure reproducible results across runs

### How It Works

The action uses a multi-layer caching strategy:

1. **promptfoo Internal Cache**: Caches individual API responses (default: 1 day TTL in CI)
2. **GitHub Actions Cache**: Persists the cache across workflow runs
3. **Smart Invalidation**: Cache keys include content hashes for automatic invalidation

### Basic Setup

```yaml
name: 'Prompt Evaluation with Caching'
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
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0  # Required for git diff comparisons

      # IMPORTANT: Use actions/cache@v4 or later (required after Feb 1, 2025)
      - name: Cache promptfoo evaluations
        uses: actions/cache@v4
        with:
          path: |
            ~/.promptfoo/cache
            .promptfoo-cache
          # Cache key includes content hash for automatic invalidation
          key: ${{ runner.os }}-promptfoo-${{ hashFiles('prompts/**') }}-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-promptfoo-${{ hashFiles('prompts/**') }}-
            ${{ runner.os }}-promptfoo-

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          config: 'promptfooconfig.yaml'
          cache-path: '.promptfoo-cache'  # Local cache directory
```

### Advanced Caching with Weekly Rotation

For better cache freshness while maintaining efficiency:

```yaml
- name: Get cache rotation key
  id: cache-key
  run: echo "week=$(date +%Y-W%U)" >> $GITHUB_OUTPUT

- name: Cache with weekly rotation
  uses: actions/cache@v4
  with:
    path: ~/.promptfoo/cache
    # Weekly rotation ensures fresh results
    key: promptfoo-${{ runner.os }}-${{ hashFiles('prompts/**') }}-${{ steps.cache-key.outputs.week }}
    restore-keys: |
      promptfoo-${{ runner.os }}-${{ hashFiles('prompts/**') }}-
```

### Environment Variables for Cache Control

The action automatically configures optimal caching settings for CI:

```yaml
- name: Configure cache environment
  run: |
    echo "PROMPTFOO_CACHE_ENABLED=true" >> $GITHUB_ENV
    echo "PROMPTFOO_CACHE_TYPE=disk" >> $GITHUB_ENV
    echo "PROMPTFOO_CACHE_PATH=$HOME/.promptfoo/cache" >> $GITHUB_ENV
    echo "PROMPTFOO_CACHE_TTL=86400" >> $GITHUB_ENV  # 1 day for CI
    echo "PROMPTFOO_CACHE_MAX_SIZE=52428800" >> $GITHUB_ENV  # 50MB
```

### Cache Metrics and Monitoring

The action provides cache statistics as outputs:

```yaml
- name: Run evaluation
  id: eval
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
    cache-path: '.promptfoo-cache'

- name: Display cache metrics
  run: |
    echo "Cache size: ${{ steps.eval.outputs.cache-size-mb }}MB"
    echo "Cache files: ${{ steps.eval.outputs.cache-file-count }}"
```

### Best Practices

1. **Always use actions/cache@v4 or later** (required after February 1, 2025)
2. **Include content hashes in cache keys** for automatic invalidation
3. **Use restore-keys for fallback** to partial cache hits
4. **Set appropriate TTL** - shorter for development (1 day), longer for stable prompts
5. **Monitor cache size** to avoid hitting GitHub's 10GB limit
6. **Use separate caches** for different prompt sets or environments

### Troubleshooting Cache Issues

If caching isn't working as expected:

1. **Enable debug mode** to see cache hits/misses:
   ```yaml
   - uses: promptfoo/promptfoo-action@v1
     with:
       debug: true
   ```

2. **Check cache statistics** in the action output
3. **Verify cache paths** match between save and restore
4. **Clear cache manually** if needed via GitHub UI or API

For a complete example with all caching features, see [.github/workflows/example-cached.yml](.github/workflows/example-cached.yml).

## Sharing

By default, results are shared online. Without `PROMPTFOO_API_KEY`, sharing is skipped and results only appear in logs.

### Authentication Validation

The action validates your `PROMPTFOO_API_KEY` **before** running the evaluation. This ensures:

- **Fast failure**: Invalid credentials are detected immediately, saving CI time
- **Clear error messages**: You'll know exactly what's wrong with your authentication
- **Better security**: Authentication issues don't get buried in lengthy eval logs

If authentication fails, the action will stop and provide a clear error message with instructions on how to fix it.

To enable sharing with authentication:

```yaml
- name: Run promptfoo evaluation
  uses: promptfoo/promptfoo-action@v1
  env:
    PROMPTFOO_API_KEY: ${{ secrets.PROMPTFOO_API_KEY }}
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
```

Get your API key from [https://www.promptfoo.app/welcome](https://www.promptfoo.app/welcome).

To explicitly disable sharing:

```yaml
- name: Run promptfoo evaluation
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
    no-share: true
```

## Minimal Output

To reduce console output in CI, set `no-table: true` and `no-progress-bar: true` in your action configuration.

## Persisting Results as Artifacts

The action writes evaluation results to `output.json` in the working directory. You can upload this as a GitHub Action artifact to preserve results beyond the 2-week shareable URL expiration:

```yaml
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
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()  # Upload even if evaluation fails
        with:
          name: promptfoo-results
          path: output.json
          retention-days: 90
```

Artifacts are retained for up to 90 days and can be downloaded from the GitHub Actions UI or via the GitHub API.
