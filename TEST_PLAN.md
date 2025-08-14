# Testing the Caching Implementation

## Prerequisites
1. Ensure you have API keys set up as secrets in your repository:
   - `OPENAI_API_KEY` or another provider key
   - `GITHUB_TOKEN` (automatically available)

## Test 1: Local Testing

### Step 1: Set up test environment
```bash
# Create test prompts and config
mkdir -p test-prompts
cat > test-prompts/test.txt << 'EOF'
Tell me a joke about {{topic}}
EOF

cat > test-prompts/promptfooconfig.yaml << 'EOF'
prompts:
  - test-prompts/test.txt

providers:
  - openai:gpt-3.5-turbo

tests:
  - vars:
      topic: caching
EOF
```

### Step 2: Test the action locally (using act)
```bash
# Install act if you haven't already
brew install act  # macOS
# or: sudo apt install act  # Linux

# Create a test workflow
cat > .github/workflows/test-cache.yml << 'EOF'
name: Test Cache
on:
  push:
    branches: [test-cache]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      
      - name: Cache promptfoo
        uses: actions/cache@v4
        with:
          path: |
            ~/.promptfoo/cache
            .promptfoo-cache
          key: test-${{ runner.os }}-${{ hashFiles('test-prompts/**') }}
          
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          config: test-prompts/promptfooconfig.yaml
          cache-path: .promptfoo-cache
          debug: true
EOF

# Run with act
act -s OPENAI_API_KEY=$OPENAI_API_KEY -s GITHUB_TOKEN=$GITHUB_TOKEN
```

## Test 2: GitHub Actions Testing

### Step 1: Create a test branch
```bash
git checkout -b test/caching-implementation
git add .
git commit -m "test: Add caching implementation"
git push origin test/caching-implementation
```

### Step 2: Create test workflow in your repo
```yaml
# .github/workflows/test-promptfoo-cache.yml
name: Test Promptfoo Cache
on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  test-cache-cold:
    name: Test Cold Cache
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      
      - name: Clear cache (simulate cold start)
        run: |
          rm -rf ~/.promptfoo/cache
          rm -rf .promptfoo-cache
      
      - name: Run evaluation (cold cache)
        id: cold-run
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          config: test-prompts/promptfooconfig.yaml
          cache-path: .promptfoo-cache
          debug: true
      
      - name: Check cache was created
        run: |
          echo "Cache size: $(du -sh .promptfoo-cache || echo 'N/A')"
          echo "Cache files: $(find .promptfoo-cache -type f | wc -l || echo '0')"
          test -d .promptfoo-cache || exit 1

  test-cache-warm:
    name: Test Warm Cache
    needs: test-cache-cold
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      
      - name: Restore cache
        uses: actions/cache@v4
        with:
          path: .promptfoo-cache
          key: cache-test-${{ github.run_id }}
      
      - name: Run evaluation (warm cache)
        id: warm-run
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          config: test-prompts/promptfooconfig.yaml
          cache-path: .promptfoo-cache
          debug: true
      
      - name: Verify cache was used
        run: |
          # Check that cache exists and has content
          test -d .promptfoo-cache || exit 1
          test "$(find .promptfoo-cache -type f | wc -l)" -gt 0 || exit 1
```

## Test 3: Verify Cache Environment Variables

```bash
# Add this debug step to your workflow
- name: Debug cache environment
  run: |
    echo "PROMPTFOO_CACHE_ENABLED=$PROMPTFOO_CACHE_ENABLED"
    echo "PROMPTFOO_CACHE_TYPE=$PROMPTFOO_CACHE_TYPE"
    echo "PROMPTFOO_CACHE_PATH=$PROMPTFOO_CACHE_PATH"
    echo "PROMPTFOO_CACHE_TTL=$PROMPTFOO_CACHE_TTL"
    echo "PROMPTFOO_CACHE_MAX_SIZE=$PROMPTFOO_CACHE_MAX_SIZE"
```

## Test 4: Unit Tests
```bash
# Run the cache unit tests
npm test -- __tests__/utils/cache.test.ts

# Run all tests
npm test
```

## Test 5: Manual Verification

1. **First run (cold cache)**:
   - Should take longer (actual API calls)
   - Should create cache directories
   - Should log "Cache directory does not exist yet" or show 0 files

2. **Second run (warm cache)**:
   - Should be significantly faster
   - Should show cache statistics with files
   - Should not make API calls for cached prompts

## Expected Outputs

### Cold Cache Run
```
Setting up cache
  Cache environment configured:
    Path: /home/runner/work/repo/.promptfoo-cache
    TTL: 86400s (24 hours)
    Max Size: 50MB
    Max Files: 5000
  Cache directory does not exist yet
```

### Warm Cache Run
```
Setting up cache
  Cache environment configured:
    Path: /home/runner/work/repo/.promptfoo-cache
    TTL: 86400s (24 hours)
    Max Size: 50MB
    Max Files: 5000
  Cache Statistics:
    Size: 0.15MB
    Files: 3
    Oldest: 2025-01-14T10:00:00.000Z
    Newest: 2025-01-14T10:00:05.000Z
```

## Debugging Issues

If caching isn't working:

1. **Check environment variables are set**:
   ```bash
   env | grep PROMPTFOO_CACHE
   ```

2. **Verify cache directory exists**:
   ```bash
   ls -la ~/.promptfoo/cache/
   ls -la .promptfoo-cache/
   ```

3. **Check promptfoo version supports caching**:
   ```bash
   npx promptfoo@latest --version
   ```

4. **Enable debug mode**:
   Set `debug: true` in the action inputs

5. **Check for the duplicate PROMPTFOO_CACHE_PATH bug** (see fixes needed below)

## Fixes Needed

1. Remove duplicate `PROMPTFOO_CACHE_PATH` setting in main.ts:
   - Line 553 should be removed since we set it in setupCacheEnvironment()

2. Ensure cache environment is set up in the process.env (not just in exec env)

3. Add integration test with real promptfoo execution