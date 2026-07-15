# GitHub Action for LLM Prompt Evaluation

This GitHub Action uses [Promptfoo](https://www.promptfoo.dev) to evaluate
prompts when monitored files change.

On pull requests, the action evaluates the current checkout and posts a summary
comment with pass/fail counts and, when sharing is enabled, a link to the
Promptfoo web viewer:

<img width="650" alt="pull request llm eval" src="https://github.com/typpo/promptfoo-action/assets/310310/ec75fb39-c6b1-4395-9e41-6d66a7bf8657"/>

The web viewer lets you inspect the evaluation results:

<img width="650" alt="promptfoo web viewer" src="https://github.com/typpo/promptfoo-action/assets/310310/d0ef0497-0c1a-4886-b115-1ee92680891b"/>

## Supported Events

This action supports multiple GitHub event types:

- **Pull Request** (`pull_request`, `pull_request_target`) - Uses the pull
  request file list to select matching prompt files and posts a PR comment.
- **Push** (`push`) - Uses the before/after commit SHAs to select matching
  prompt files and writes a workflow summary.
- **Manual Trigger** (`workflow_dispatch`) - Uses a supplied file list or a git
  comparison against a base ref and writes a workflow summary.

If change detection is unavailable, the action evaluates all files matching the
configured `prompts` globs. The action evaluates only the current checkout; it
does not run separate base and head evaluations.

For `pull_request_target`, use extra care with checkout configuration and
credentials. Do not execute untrusted pull request code with a privileged token.

## Configuration

The action can be configured using the following inputs:

| Parameter | Description | Required |
| --- | --- | --- |
| `config` | Promptfoo configuration path, relative to `working-directory` unless absolute. | Yes |
| `github-token` | GitHub token used to list PR files and post PR comments. | Yes |
| `prompts` | Newline-separated prompt glob patterns, resolved from `working-directory`. Matching changed files are passed to Promptfoo with `--prompts`. If omitted, Promptfoo uses the prompts in `config`. | No |
| `working-directory` | Base directory for the Promptfoo process and relative config, prompt, environment, and cache paths. Defaults to `.`. | No |
| `cache-path` | Promptfoo disk-cache directory. Relative paths are resolved from `working-directory`. | No |
| `promptfoo-version` | Version or dist-tag used by `npx promptfoo@<version>`. Defaults to `latest`. | No |
| `no-share` | Pass `--no-share`, overriding config-level sharing. Defaults to `false`. | No |
| `use-config-prompts` | Do not override config prompts with changed files matched by `prompts`. Defaults to `false`. | No |
| `env-files` | Comma-separated application `.env` paths loaded in order from `working-directory`. Later files override earlier files; process-control and Promptfoo authentication variables are rejected. | No |
| `fail-on-threshold` | Required suite pass percentage from 0 to 100. | No |
| `max-concurrency` | Value passed to Promptfoo's `--max-concurrency`. Defaults to `4`. | No |
| `no-table` | Pass `--no-table`. Defaults to `false`. | No |
| `no-progress-bar` | Pass `--no-progress-bar`. Defaults to `false`. | No |
| `no-cache` | Pass `--no-cache` so Promptfoo does not read or write cached evaluation results. Defaults to `false`. | No |
| `disable-comment` | Disable posting comments to the PR. Defaults to `false`. Non-PR workflow summaries are unaffected. | No |
| `workflow-files` | Newline-separated changed-file list for `workflow_dispatch`. Takes precedence over workflow-level `files`. | No |
| `workflow-base` | Base branch, tag, full commit SHA, or supported `HEAD` revision for `workflow_dispatch`. Takes precedence over workflow-level `base`; defaults to `HEAD~1`. | No |
| `repeat` | Number of times Promptfoo runs each test. Must be at least `2`; omit it to run once. | No |
| `repeat-min-pass` | Minimum passes required for each repeated test. Requires `repeat` and cannot exceed it. | No |
| `force-run` | Evaluate even when change detection finds no relevant files. Defaults to `false`. | No |
| `debug` | Accepted for compatibility but does not change runner log visibility. Use GitHub Actions step debug logging to display `core.debug` messages. | No |

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

All workflow environment variables are passed through to promptfoo. You can set
API keys at the job or workflow level instead of using action inputs:

```yaml
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

steps:
  - uses: promptfoo/promptfoo-action@v1
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      config: 'promptfooconfig.yaml'
```

Action inputs take precedence over their corresponding environment variables.
See [`action.yml`](action.yml) for the complete input metadata.

## Usage Examples

### Pull Request Evaluation

Here is a pull request workflow with changed-prompt filtering and an optional
GitHub Actions cache:

```yaml
name: 'Prompt Evaluation'
on:
  pull_request:
    paths:
      - 'prompts/**'
      - 'promptfooconfig.yaml'

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
        uses: actions/cache@v4
        with:
          path: .promptfoo-cache
          key: ${{ runner.os }}-promptfoo-${{ hashFiles('promptfooconfig.yaml', 'prompts/**') }}
          restore-keys: |
            ${{ runner.os }}-promptfoo-

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
          prompts: 'prompts/**'
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
        description: 'Changed files to consider (leave empty to auto-detect)'
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
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Fetch all history for comparisons

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
          prompts: 'prompts/**'
```

When triggered manually:

- If `files` is provided, those paths are treated as the changed-file set.
- Only changed files that also match `prompts` are passed through
  `--prompts`.
- If `base` is provided, the action compares that ref with `HEAD`.
- If neither input is provided, the action compares `HEAD~1` with `HEAD`.
- Results will be displayed in the workflow summary instead of a PR comment

Writing a step summary does not require `actions: write`.

#### Alternative: Using Action Inputs

You can also specify files and base directly as action inputs:

```yaml
- name: Run promptfoo evaluation
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
    prompts: 'prompts/**'
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
      - 'promptfooconfig.yaml'

jobs:
  evaluate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Ensure the push before/after commits are available

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: 'promptfooconfig.yaml'
          prompts: 'prompts/**'
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
      - 'promptfooconfig.yaml'

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

> **Security note:** `env-files` is for _application_ configuration only. Because these files are part of the checked-out repository, a pull request could otherwise execute code before evaluation, redirect inherited provider credentials or evaluation data, bypass the failure gate, or redirect cache cleanup. The action therefore rejects process controls — Node/npm (`NODE_OPTIONS`, `NODE_PATH`, `NPM_CONFIG_*`), git (`GIT_*`), interpreter startup/search paths and executable selection (`PYTHONPATH`, `PYTHONUSERBASE`, `RUBYLIB`, `PERL5LIB`, `PROMPTFOO_PYTHON`, `PROMPTFOO_RUBY`, ...), Go compiler/toolchain/module controls (`GOFLAGS`, `GOENV`, `GOTOOLCHAIN`, `GOPROXY`, `GOSUMDB`, `GOINSECURE`, `CC`, `CGO_*`, ...), browser executable/cache/download controls (`PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_*_DOWNLOAD_HOST`, `PUPPETEER_EXECUTABLE_PATH`, ...), executable resolution (`PATH`), dynamic loaders (`LD_*`, including `LD_AUDIT`, and `DYLD_*`), config-home redirection (`HOME`, `XDG_CONFIG_HOME`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, ...), proxy/TLS controls (`HTTP_PROXY`, `NODE_TLS_REJECT_UNAUTHORIZED`, `PROMPTFOO_INSECURE_SSL`, `AWS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, ...), provider/cloud/telemetry endpoints and routing controls (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `AZURE_AI_PROJECT_URL`, `API_HOST`, `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_*`, `CLOUDFLARE_GATEWAY_ID`, `PROMPTFOO_CLOUD_API_URL`, `PROMPTFOO_REMOTE_API_BASE_URL`, `PROMPTFOO_REMOTE_GENERATION_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, ...), Promptfoo authentication (`PROMPTFOO_API_KEY`), and action controls (`PROMPTFOO_CACHE_PATH`, `PROMPTFOO_CONFIG_DIR`, `PROMPTFOO_PASS_RATE_THRESHOLD`, `PROMPTFOO_FAILED_TEST_EXIT_CODE`, ...) — and fails the run if any selected file sets one. Ordinary application variables (`NODE_ENV`, custom provider settings, provider API keys such as `OPENAI_API_KEY`, ...) still pass through. If your evaluation genuinely needs a protected override (for example, a provider endpoint, outbound proxy, custom CA, or Python module path), set it in the trusted workflow `env:` block instead of an `env-files` file:
>
> ```yaml
>       - name: Run promptfoo evaluation
>         uses: promptfoo/promptfoo-action@v1
>         env:
>           HTTPS_PROXY: ${{ vars.HTTPS_PROXY }}
>         with:
>           config: 'promptfooconfig.yaml'
> ```

## Custom Provider Detection

When `prompts` is configured, the action also checks file dependencies referenced
by the Promptfoo config before deciding to skip an evaluation. This includes
custom providers, prompt files, test variables, and assertion files.

If the workflow uses an `on.<event>.paths` filter, include these dependency
paths there too; GitHub must start the workflow before the action can inspect
changed files.

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

### How It Works

- Direct file dependencies are compared with GitHub's changed-file list.
- For wildcard dependencies, the action expands existing matches and also
  watches the non-wildcard directory prefix conservatively.
- A directory dependency watches all changed files below that directory.
- Dependency detection matters when `prompts` is set and the action is deciding
  whether it can safely skip an evaluation. Without `prompts`, the config is
  evaluated on every supported event.

### Example Configuration

```yaml
# promptfooconfig.yaml
providers:
  - file://providers/**/*.py      # Watch all Python files recursively
  
prompts:
  - file://prompts/system.txt

tests:
  - vars:
      context: file://data/context.json
    assert:
      - type: javascript
        value: file://validators/check.js
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

### Handling flaky LLM evals with repeat

LLM eval outputs are non-deterministic. Use `repeat` to run each test multiple times and `repeat-min-pass` to require a minimum number of passes per test:

```yaml
- name: Run skill evals
  uses: promptfoo/promptfoo-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: evals/skills.yaml
    use-config-prompts: 'true'
    repeat: 3
    repeat-min-pass: 2
```

This runs each test 3 times and requires each test to pass at least 2 of its 3 runs. Tests that consistently fail will be flagged, while random grader variance is tolerated.

You can combine this with `fail-on-threshold` for a suite-level check. Both
configured checks must pass.

**Note:** The repeat check groups results by the resolved test case, prompt, and provider. If you intentionally define exact duplicate tests, give them unique `id` or `description` values so the report can distinguish them cleanly.

## Caching for Better Performance

The action configures Promptfoo's disk cache. Disk contents do not persist
between fresh GitHub-hosted runners unless the workflow also uses
`actions/cache`.

### Why Caching Matters

- **Cost Savings**: Avoid redundant API calls to OpenAI, Anthropic, and other providers
- **Speed**: Cached evaluations can complete much faster
- **Reliability**: Reduce repeated calls to external model providers

### How It Works

The action:

1. Enables Promptfoo's disk cache and configures its path and TTL.
2. Logs cache size and file-count metrics before and after evaluation.
3. Removes cache entries older than seven days when `CI=true`.
4. Writes a `.cache-manifest.json` file into the cache directory.

Your workflow is responsible for choosing an `actions/cache` key and persisting
the directory across jobs.

### Basic Setup

```yaml
name: 'Prompt Evaluation with Caching'
on:
  pull_request:
    paths:
      - 'prompts/**'
      - 'promptfooconfig.yaml'

jobs:
  evaluate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for git diff comparisons

      - name: Cache promptfoo evaluations
        uses: actions/cache@v4
        with:
          path: .promptfoo-cache
          key: ${{ runner.os }}-promptfoo-${{ hashFiles('promptfooconfig.yaml', 'prompts/**') }}
          restore-keys: |
            ${{ runner.os }}-promptfoo-

      - name: Run promptfoo evaluation
        uses: promptfoo/promptfoo-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          config: 'promptfooconfig.yaml'
          prompts: 'prompts/**'
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

The action sets these Promptfoo cache variables. Existing values are respected.
Promptfoo currently consumes the path and TTL settings; the size and file-count
variables are exported for compatibility but are not enforced by the current
Promptfoo CLI:

```yaml
- name: Run evaluation with custom cache limits
  uses: promptfoo/promptfoo-action@v1
  env:
    PROMPTFOO_CACHE_TTL: 86400
    PROMPTFOO_CACHE_MAX_SIZE: 52428800
    PROMPTFOO_CACHE_MAX_FILE_COUNT: 5000
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    config: 'promptfooconfig.yaml'
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

1. **Use a supported `actions/cache` release**
2. **Include content hashes in cache keys** for automatic invalidation
3. **Use restore-keys for fallback** to partial cache hits
4. **Set appropriate TTL** - shorter for development (1 day), longer for stable prompts
5. **Monitor cache size** to stay within repository cache quotas
6. **Use separate caches** for different prompt sets or environments

### Troubleshooting Cache Issues

If caching isn't working as expected:

1. **Check cache statistics** in the action output
2. **Verify cache paths** match between the action and `actions/cache`
3. **Check that the cache key or a restore key matches a previous run**
4. **Clear stale caches** through the GitHub Actions cache UI when needed

## Sharing

By default, the action requests a shareable result only when either
`PROMPTFOO_API_KEY` or `PROMPTFOO_REMOTE_API_BASE_URL` is set. Without either
variable, it passes `--no-share`. Results remain available in the PR comment or
workflow summary, as applicable, and in logs. Set `no-share: true` to override
config-level sharing explicitly.

### Authentication Validation

When `PROMPTFOO_API_KEY` is set, the action validates it before running the
evaluation. Validation uses `PROMPTFOO_REMOTE_API_BASE_URL` when configured and
Promptfoo Cloud otherwise. When a remote base URL is set without an API key, the
action requests sharing but skips validation because self-hosted instances may
use a different authentication mechanism.

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

## Evaluation Result Files

The action creates a uniquely named JSON result file for internal processing and
deletes it after parsing. It does not leave `output.json` in the workspace.

The PR comment or workflow summary contains aggregate results and a viewer link
when sharing succeeds. Workflows that require a persistent raw result file
should run the Promptfoo CLI directly with `--output <path>` and upload that
file separately.
