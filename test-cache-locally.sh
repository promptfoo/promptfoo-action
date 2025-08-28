#!/bin/bash
set -e

echo "=== Testing promptfoo-action caching implementation ==="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create test directory
TEST_DIR="test-cache-demo"
rm -rf $TEST_DIR
mkdir -p $TEST_DIR
cd $TEST_DIR

echo -e "${YELLOW}Setting up test files...${NC}"

# Create a simple prompt
cat > test-prompt.txt << 'EOF'
Write a haiku about: {{topic}}
EOF

# Create a simple config
cat > promptfooconfig.yaml << 'EOF'
prompts:
  - test-prompt.txt

providers:
  - openai:gpt-3.5-turbo:
      config:
        temperature: 0

tests:
  - vars:
      topic: caching
  - vars:
      topic: testing
EOF

echo -e "${GREEN}✓ Test files created${NC}"

# Test 1: Run without cache (cold start)
echo -e "\n${YELLOW}Test 1: Cold cache run${NC}"
echo "Clearing any existing cache..."
rm -rf ~/.promptfoo/cache
rm -rf .promptfoo-cache

# Set up environment
export PROMPTFOO_CACHE_ENABLED=true
export PROMPTFOO_CACHE_PATH=.promptfoo-cache
export PROMPTFOO_CACHE_TTL=86400
export PROMPTFOO_CACHE_MAX_SIZE=52428800

echo "Running promptfoo evaluation (this will make API calls)..."
START_TIME=$(date +%s)

if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}ERROR: OPENAI_API_KEY not set${NC}"
    echo "Please set your OpenAI API key: export OPENAI_API_KEY=sk-..."
    exit 1
fi

npx promptfoo@latest eval -c promptfooconfig.yaml -o output1.json --no-progress-bar || {
    echo -e "${RED}✗ First run failed${NC}"
    exit 1
}

END_TIME=$(date +%s)
DURATION1=$((END_TIME - START_TIME))
echo -e "${GREEN}✓ First run completed in ${DURATION1} seconds${NC}"

# Check cache was created
if [ -d ".promptfoo-cache" ]; then
    CACHE_SIZE=$(du -sh .promptfoo-cache 2>/dev/null | cut -f1)
    CACHE_FILES=$(find .promptfoo-cache -type f 2>/dev/null | wc -l | tr -d ' ')
    echo -e "${GREEN}✓ Cache created: ${CACHE_SIZE} in ${CACHE_FILES} files${NC}"
else
    # Check default location
    if [ -d "$HOME/.promptfoo/cache" ]; then
        CACHE_SIZE=$(du -sh "$HOME/.promptfoo/cache" 2>/dev/null | cut -f1)
        CACHE_FILES=$(find "$HOME/.promptfoo/cache" -type f 2>/dev/null | wc -l | tr -d ' ')
        echo -e "${YELLOW}ℹ Cache created in default location: ${CACHE_SIZE} in ${CACHE_FILES} files${NC}"
    else
        echo -e "${YELLOW}⚠ Warning: Cache directory not found${NC}"
    fi
fi

# Test 2: Run with cache (warm start)
echo -e "\n${YELLOW}Test 2: Warm cache run${NC}"
echo "Running promptfoo evaluation again (should use cache)..."
START_TIME=$(date +%s)

npx promptfoo@latest eval -c promptfooconfig.yaml -o output2.json --no-progress-bar || {
    echo -e "${RED}✗ Second run failed${NC}"
    exit 1
}

END_TIME=$(date +%s)
DURATION2=$((END_TIME - START_TIME))
echo -e "${GREEN}✓ Second run completed in ${DURATION2} seconds${NC}"

# Compare durations
if [ "$DURATION2" -lt "$DURATION1" ]; then
    if [ "$DURATION2" -lt 1 ]; then DURATION2=1; fi
    SPEEDUP=$((DURATION1 * 100 / DURATION2 - 100))
    echo -e "${GREEN}✓ Cache is working! Second run was ${SPEEDUP}% faster${NC}"
else
    echo -e "${YELLOW}⚠ Second run was not faster. Cache might not be working.${NC}"
fi

# Show cache statistics
echo -e "\n${YELLOW}Cache Statistics:${NC}"
if [ -d ".promptfoo-cache" ]; then
    echo "Local cache (.promptfoo-cache):"
    du -sh .promptfoo-cache 2>/dev/null || echo "Unable to get size"
    echo "Files: $(find .promptfoo-cache -type f 2>/dev/null | wc -l | tr -d ' ')"
fi

if [ -d "$HOME/.promptfoo/cache" ]; then
    echo "Default cache (~/.promptfoo/cache):"
    du -sh "$HOME/.promptfoo/cache" 2>/dev/null || echo "Unable to get size"
    echo "Files: $(find "$HOME/.promptfoo/cache" -type f 2>/dev/null | wc -l | tr -d ' ')"
fi

# Compare outputs
echo -e "\n${YELLOW}Comparing outputs...${NC}"
if [ -f output1.json ] && [ -f output2.json ]; then
    # Extract just the results for comparison (ignore timestamps)
    RESULTS1=$(jq -r '.results.results[].response.output' output1.json 2>/dev/null | sort)
    RESULTS2=$(jq -r '.results.results[].response.output' output2.json 2>/dev/null | sort)
    
    if [ "$RESULTS1" = "$RESULTS2" ]; then
        echo -e "${GREEN}✓ Results are identical (cache working correctly)${NC}"
    else
        echo -e "${YELLOW}⚠ Results differ (might be due to temperature > 0)${NC}"
    fi
fi

echo -e "\n${GREEN}=== Test complete ===${NC}"
echo "Summary:"
echo "  First run:  ${DURATION1}s (cold cache)"
echo "  Second run: ${DURATION2}s (warm cache)"

# Cleanup
cd ..
echo -e "\n${YELLOW}Test files left in ${TEST_DIR} for inspection${NC}"
echo "Run 'rm -rf ${TEST_DIR}' to clean up"