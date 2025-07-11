# TODO: promptfoo-action Improvements

## 🔴 Critical Issues (Priority 1)

### Security & Compatibility
- [x] **Update Node.js runtime from node16 to node20** - GitHub Actions deprecation
  - Update `action.yml` to use `node20`
  - Test compatibility with new runtime
  
- [ ] **Security audit for API key handling**
  - Validate all API keys are properly masked in logs
  - Add input sanitization for all user inputs
  - Prevent path traversal attacks in file paths
  - Escape shell commands to prevent injection
  
- [ ] **Add comprehensive input validation**
  - Validate file paths don't escape workspace
  - Check for malicious patterns in inputs
  - Validate URL formats for API endpoints
  - Add rate limiting considerations

## 🟡 Major Improvements (Priority 2)

### Code Quality & Testing
- [ ] **Improve test coverage**
  - Add real integration tests (not just mocked)
  - Test error scenarios and edge cases
  - Add E2E tests with actual promptfoo runs
  - Test with different promptfoo versions
  - Add tests for .env file loading
  
- [ ] **TypeScript improvements**
  - Remove all `any` types
  - Add proper type definitions for promptfoo outputs
  - Enable stricter compiler options in tsconfig.json
  - Add type guards for runtime validation
  
- [ ] **Enhanced error handling**
  - Create specific error classes
  - Add context to all errors
  - Implement retry logic with exponential backoff
  - Handle network failures gracefully
  - Provide actionable error messages

### Performance Optimization
- [ ] **Parallel processing**
  - Process multiple prompt files in parallel
  - Optimize git diff operations
  - Implement concurrent API calls where possible
  
- [ ] **Improve caching strategy**
  - Cache promptfoo installations
  - Cache model responses (with TTL)
  - Add cache invalidation options
  - Document cache usage best practices

## 🟢 Feature Enhancements (Priority 3)

### promptfoo Feature Parity
- [ ] **Expose core eval command options**
  - Add `max-concurrency` input (default: 25)
  - Add `repeat` input for running tests multiple times
  - Add `delay` input for API call delays
  - Add `grader` input for output grading
  - Add `assertions-path` input for external assertions
  - Add `var` input for setting variables (key=value format)
  - Add `description` input for eval run descriptions
  
- [ ] **Add comprehensive filtering options**
  - `filter-pattern` - Regex pattern to filter tests
  - `filter-first-n` - Only run first N tests
  - `filter-failing` - Filter failures from previous run
  - `filter-metadata` - Filter by metadata key-value pairs
  - `filter-providers` - Only run tests with specific providers
  - `filter-sample` - Random sample of N tests
  
- [ ] **Support multiple output formats**
  - Add `output-format` input (json, csv, html, yaml, txt)
  - Support multiple formats simultaneously
  - Add `table-cell-max-length` for console output
  - Add `no-table` and `no-progress-bar` options
  
- [ ] **Red team testing support**
  - Add `redteam` boolean input to enable red team mode
  - Add `redteam-plugins` input (harmful, jailbreak, pii, etc.)
  - Add `redteam-strategies` input (prompt injection, encoding)
  - Support red team report generation
  - Add security vulnerability scanning
  
- [ ] **Expand provider support**
  - Add Groq (`groq-api-key`)
  - Add Together AI (`together-api-key`) 
  - Add Mistral (`mistral-api-key`)
  - Add Cohere (`cohere-api-key`)
  - Add Cerebras (`cerebras-api-key`)
  - Add Cloudflare Workers AI (`cloudflare-account-id`, `cloudflare-api-key`)
  - Add Hyperbolic (`hyperbolic-api-key`)
  - Add xAI (`xai-api-key`)
  - Add OpenRouter (`openrouter-api-key`)
  - Add Ollama support (`ollama-base-url`, `ollama-api-key`)
  
- [ ] **Add advanced configuration options**
  - `timeout-ms` - Timeout per evaluation
  - `max-eval-time-ms` - Maximum total evaluation time
  - `pass-rate-threshold` - Minimum pass rate (0-100)
  - `disable-telemetry` - Disable telemetry
  - `disable-sharing` - Disable sharing features
  - `request-backoff-ms` - API request backoff
  - `retry-5xx` - Retry on 5xx errors
  
- [ ] **Tracing and observability**
  - OpenTelemetry support configuration
  - Trace forwarding options
  - Storage retention settings
  - Custom collector endpoints

### User Experience
- [ ] **Enhance PR comment formatting**
  - Add detailed markdown tables
  - Include visual diff representation
  - Support collapsible sections for large results
  - Add charts/graphs for metrics
  - Show performance comparisons
  
- [ ] **Add configuration schema validation**
  - Create JSON schema for promptfoo configs
  - Validate configs before running
  - Provide helpful error messages
  - Add config migration helpers
  
- [ ] **Implement dry-run mode**
  - Preview what would be evaluated
  - Show estimated costs
  - Validate configuration without running
  
- [ ] **Support matrix testing**
  - Test across multiple promptfoo versions
  - Support multiple configurations
  - Parallel evaluation strategies

### Documentation
- [ ] **Comprehensive documentation overhaul**
  - Add troubleshooting guide
  - Document best practices
  - Provider-specific setup guides
  - Migration guide from other tools
  - Performance optimization tips
  - Security best practices
  
- [ ] **Add more examples**
  - Different provider configurations
  - Complex evaluation scenarios
  - Custom assertion examples
  - Multi-model comparisons
  - Cost optimization strategies

## 📊 Monitoring & Analytics (Priority 4)

- [ ] **Add optional telemetry**
  - Usage analytics (with consent)
  - Error tracking
  - Performance metrics
  - Popular configuration patterns
  
- [ ] **Implement health checks**
  - Validate provider connectivity
  - Check API key validity
  - Monitor rate limits

## 🔧 Technical Debt (Priority 5)

- [ ] **Optimize bundle size**
  - Analyze and reduce dist size (currently 1.5MB)
  - Tree-shake unused dependencies
  - Use dynamic imports where possible
  
- [ ] **Modernize build pipeline**
  - Update to latest versions of build tools
  - Add source map support
  - Implement proper versioning strategy
  
- [ ] **Code refactoring**
  - Split main.ts into smaller modules
  - Extract git operations to separate module
  - Create provider-specific handlers
  - Implement proper dependency injection

## 🚀 Quick Wins (Can be done immediately)

1. [ ] Update Node runtime in action.yml (5 min)
2. [ ] Add basic input validation (1 hour)
3. [ ] Improve error messages (2 hours)
4. [ ] Fix ESLint warnings (1 hour)
5. [ ] Update outdated dependencies (30 min)
6. [ ] Add .nvmrc file for Node version (5 min)
7. [ ] Add `max-concurrency` input (30 min)
8. [ ] Add `output-format` input with CSV/YAML support (1 hour)
9. [ ] Add `filter-pattern` for test filtering (1 hour)
10. [ ] Add Groq and Together AI provider support (30 min)

## 📅 Suggested Implementation Order

1. **Week 1**: Critical security fixes and Node.js update
2. **Week 2**: Test coverage and error handling improvements
3. **Week 3**: Performance optimizations and PR comment enhancements
4. **Week 4**: Core promptfoo feature parity (filtering, output formats)
5. **Week 5**: Additional provider support and configuration options
6. **Week 6**: Red team testing capabilities
7. **Ongoing**: Technical debt and monitoring

## 📝 Notes

- Consider creating a beta branch for testing major changes
- Set up automated dependency updates with Dependabot
- Add CODEOWNERS for critical files
- Consider adding a SECURITY.md file
- Set up issue templates for better bug reporting
- promptfoo supports 30+ providers - prioritize based on user demand
- Red team features should be opt-in with clear security warnings
- Consider creating preset configurations for common use cases

## 🔬 Environment Variables to Consider

Based on promptfoo's capabilities, consider exposing these environment variables:

### Core Configuration
- `PROMPTFOO_CACHE_ENABLED` - Enable/disable caching
- `PROMPTFOO_CACHE_TTL` - Cache time-to-live
- `PROMPTFOO_CACHE_TYPE` - 'memory' or 'disk'
- `PROMPTFOO_LOG_LEVEL` - 'error', 'warn', 'info', 'debug'
- `PROMPTFOO_FAILED_TEST_EXIT_CODE` - Custom exit code for failures

### Advanced Features
- `PROMPTFOO_EVAL_TIMEOUT_MS` - Evaluation timeout
- `PROMPTFOO_MAX_EVAL_TIME_MS` - Maximum total evaluation time
- `PROMPTFOO_REQUEST_BACKOFF_MS` - API request backoff
- `PROMPTFOO_CSV_DELIMITER` - Custom CSV delimiter

### Provider-Specific
- `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` - Observability
- `HELICONE_API_KEY` - API observability
- `PORTKEY_API_KEY` - LLM gateway
- `LOCALAI_BASE_URL`, `LLAMA_BASE_URL` - Local model endpoints 

remove references to typpo - rename to promptfoo 