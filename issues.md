# GitHub Issues Analysis and Implementation Plan

## Executive Summary

This document analyzes all 7 open issues in the promptfoo-action repository, providing stack-ranked priorities, implementation plans, and test instructions for each issue.

## Priority Matrix

| Priority | Issue # | Title | Impact | Effort | Risk |
|----------|---------|-------|--------|--------|------|
| **P0** | #294 | Custom providers: trigger evals on changed provider files | High | Medium | Low |
| **P0** | #117 | Change `no-share` default to `true` | High | Low | Low |
| **P1** | #118 | Apply for publisher verification | High | Low | Low |
| **P1** | #121 | GitHub Action artifact support | Medium | Low | Low |
| **P2** | #120 | Document env var fallback for API keys | Low | Low | None |
| **P3** | #138 | Run eval on remote promptfoo server | High | High | High |
| **P4** | #122 | Git diffing for unstaged files | Low | Low | Low |

## Detailed Issue Analysis and Implementation Plans

---

## P0: Issue #294 - Custom providers: trigger evals on changed provider files

### Problem
The action doesn't re-run evaluations when custom provider files (e.g., `file://my_custom_provider.py`) change, only when the YAML config changes.

### Pros
- Enables proper CI/CD for custom provider development
- Fixes a significant workflow issue for advanced users
- Aligns with user expectations of change detection

### Cons
- Requires parsing YAML files to extract dependencies
- Adds complexity to file change detection logic
- May increase false positives if not implemented carefully

### Implementation Plan

1. **Add YAML parsing to extract file dependencies**
   ```typescript
   // In src/utils/config.ts (new file)
   import * as yaml from 'js-yaml';
   import * as fs from 'fs';
   
   export function extractFileDependencies(configPath: string): string[] {
     const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
     const dependencies: string[] = [];
     
     // Extract provider files
     if (config.providers) {
       for (const provider of config.providers) {
         if (typeof provider === 'string' && provider.startsWith('file://')) {
           dependencies.push(provider.replace('file://', ''));
         } else if (provider.id?.startsWith('file://')) {
           dependencies.push(provider.id.replace('file://', ''));
         }
       }
     }
     
     // Extract test files, datasets, etc.
     // ... additional parsing logic
     
     return dependencies;
   }
   ```

2. **Modify main.ts to check dependency files**
   ```typescript
   // Around line 420 in main.ts
   const configDependencies = extractFileDependencies(configPath);
   const dependencyChanges = await gitInterface.diff(baseRef, headRef, configDependencies);
   
   if (changedLLMFiles.length === 0 && dependencyChanges.length === 0) {
     logger.info('No LLM prompt, config files, or dependencies were modified');
     return;
   }
   ```

3. **Add force-run option as escape hatch**
   ```yaml
   # In action.yml
   force-run:
     description: 'Force evaluation to run even if no files changed'
     required: false
     default: 'false'
   ```

### Test Instructions

1. **Unit Tests**
   ```typescript
   // In __tests__/utils/config.test.ts
   describe('extractFileDependencies', () => {
     it('should extract file:// providers', () => {
       const yaml = `
         providers:
           - file://custom_provider.py
           - id: file://another_provider.js
             config: {}
       `;
       const deps = extractFileDependencies('test.yaml');
       expect(deps).toEqual(['custom_provider.py', 'another_provider.js']);
     });
   });
   ```

2. **Integration Test**
   - Create test repo with custom provider
   - Modify only the provider file
   - Verify action runs evaluation
   - Test with force-run option

---

## P0: Issue #117 - Change `no-share` default to `true`

### Problem
Current default shares evaluation results publicly, which may expose sensitive data.

### Pros
- Improves security by default
- Prevents accidental data exposure
- Aligns with security best practices
- Simple change with high impact

### Cons
- Breaking change for existing users
- Users who want sharing must explicitly enable it

### Implementation Plan

1. **Update action.yml**
   ```yaml
   # Line 83 in action.yml
   no-share:
     description: 'Disable sharing of evaluation results'
     required: false
     default: 'true'  # Changed from 'false'
   ```

2. **Add deprecation notice for clarity**
   ```yaml
   share:
     description: 'Enable sharing of evaluation results (replaces no-share)'
     required: false
     default: 'false'
   ```

3. **Update main.ts to handle both inputs**
   ```typescript
   // Around line 40 in main.ts
   const share = core.getBooleanInput('share');
   const noShare = core.getBooleanInput('no-share');
   
   // Handle backwards compatibility
   const shouldShare = share || !noShare;
   ```

4. **Update README.md with migration guide**

### Test Instructions

1. **Unit Tests**
   ```typescript
   it('should default to no-share=true', () => {
     // Test with no input
     const result = getShareSetting();
     expect(result).toBe(false);
   });
   
   it('should respect explicit share=true', () => {
     core.getInput.mockReturnValue('true');
     const result = getShareSetting();
     expect(result).toBe(true);
   });
   ```

2. **Manual Testing**
   - Run action without share/no-share inputs
   - Verify no share URL is generated
   - Test with explicit share: true
   - Verify backwards compatibility

---

## P1: Issue #118 - Apply for publisher verification

### Problem
Organizations requiring verified publishers cannot use this action.

### Pros
- Enables enterprise adoption
- Improves trust and credibility
- No code changes required

### Cons
- Administrative process outside codebase
- May have ongoing requirements

### Implementation Plan

1. **Prepare application materials**
   - Document action's purpose and usage
   - Gather usage statistics
   - Prepare security documentation

2. **Apply through GitHub Partner Program**
   - https://partner.github.com/
   - Follow verification process

3. **Update documentation once verified**
   - Add verified badge to README
   - Document in action.yml metadata

### Test Instructions
- No code changes to test
- Verify badge appears correctly once approved

---

## P1: Issue #121 - GitHub Action artifact support

### Problem
Users want to persist evaluation results beyond 2-week shareable URL lifespan.

### Pros
- Enables long-term result storage
- Integrates with existing CI/CD workflows
- Relatively simple to implement

### Cons
- Increases action complexity slightly
- May increase storage usage

### Implementation Plan

1. **Add artifact upload option**
   ```yaml
   # In action.yml
   upload-artifact:
     description: 'Upload evaluation results as artifact'
     required: false
     default: 'false'
   artifact-name:
     description: 'Name for uploaded artifact'
     required: false
     default: 'promptfoo-eval-results'
   ```

2. **Implement artifact upload**
   ```typescript
   // In main.ts after evaluation completes
   if (core.getBooleanInput('upload-artifact')) {
     const artifactClient = artifact.create();
     const artifactName = core.getInput('artifact-name');
     
     const uploadResult = await artifactClient.uploadArtifact(
       artifactName,
       ['output.json'],
       process.cwd(),
       { continueOnError: false }
     );
     
     logger.info(`Artifact uploaded: ${uploadResult.artifactName}`);
   }
   ```

3. **Add output for artifact location**
   ```typescript
   core.setOutput('artifact-name', artifactName);
   core.setOutput('output-path', 'output.json');
   ```

### Test Instructions

1. **Unit Tests**
   ```typescript
   it('should upload artifact when enabled', async () => {
     const mockUpload = jest.fn().mockResolvedValue({ artifactName: 'test' });
     // Test artifact upload logic
   });
   ```

2. **Integration Test**
   - Enable upload-artifact in workflow
   - Run evaluation
   - Verify artifact appears in Actions UI
   - Download and verify content

---

## P2: Issue #120 - Document env var fallback for API keys

### Problem
Documentation doesn't clarify that API keys can use environment variables.

### Pros
- Improves user experience
- No code changes needed
- Quick win

### Cons
- None

### Implementation Plan

1. **Update README.md**
   ```markdown
   ### API Key Configuration
   
   API keys can be provided in two ways:
   
   1. **As action inputs** (recommended for secrets):
   ```yaml
   with:
     openaiApiKey: ${{ secrets.OPENAI_API_KEY }}
   ```
   
   2. **As environment variables**:
   ```yaml
   env:
     OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
   ```
   
   The action will automatically use environment variables if inputs are not provided.
   ```

2. **Add to action.yml descriptions**

### Test Instructions
- Review documentation clarity
- Test both input methods work

---

## P3: Issue #138 - Run eval on remote promptfoo server

### Problem
Organizations want to run evaluations on their own infrastructure for security.

### Pros
- Enables enterprise use cases
- Keeps sensitive data out of GitHub
- Centralized evaluation management

### Cons
- Major architectural change
- Requires promptfoo server implementation
- Complex authentication/authorization
- High implementation effort

### Implementation Plan

1. **Design API contract**
   ```typescript
   interface RemoteEvalConfig {
     serverUrl: string;
     apiKey: string;
     timeout?: number;
   }
   
   interface RemoteEvalRequest {
     configPath: string;
     baseRef: string;
     headRef: string;
     changedFiles: string[];
   }
   ```

2. **Add remote mode to action**
   ```yaml
   remote-server-url:
     description: 'URL of remote promptfoo server'
     required: false
   remote-server-api-key:
     description: 'API key for remote server'
     required: false
   ```

3. **Implement remote client**
   ```typescript
   // src/utils/remote-client.ts
   export class RemotePromptfooClient {
     async runEvaluation(config: RemoteEvalConfig, request: RemoteEvalRequest) {
       // Implementation
     }
   }
   ```

### Test Instructions

1. **Mock Server Tests**
   - Create mock promptfoo server
   - Test authentication
   - Test error handling
   - Test timeout scenarios

2. **Integration Tests**
   - Deploy test server
   - Run action in remote mode
   - Verify results match local mode

---

## P4: Issue #122 - Git diffing for unstaged files

### Problem
Unstaged files in CI aren't detected as changes.

### Pros
- Handles edge case for generated configs
- More complete change detection

### Cons
- Very rare use case
- May cause unexpected behavior
- Low impact

### Implementation Plan

1. **Add option for unstaged detection**
   ```yaml
   include-unstaged:
     description: 'Include unstaged files in change detection'
     required: false
     default: 'false'
   ```

2. **Modify git diff logic**
   ```typescript
   // In src/utils/git.ts
   async diffUnstaged(patterns: string[]): Promise<string[]> {
     const result = await this.exec(['diff', '--name-only', ...patterns]);
     return result.stdout.trim().split('\n').filter(Boolean);
   }
   ```

### Test Instructions

1. **Unit Tests**
   - Test unstaged file detection
   - Test with various file patterns

2. **CI Test**
   - Generate config file in CI
   - Verify detection works

---

## Migration Timeline

### Phase 1 (Immediate - 1 week)
- [ ] P0: Issue #294 - Custom provider detection
- [ ] P0: Issue #117 - Security default change
- [ ] P2: Issue #120 - Documentation update

### Phase 2 (2-4 weeks)
- [ ] P1: Issue #121 - Artifact support
- [ ] P1: Issue #118 - Begin verification process

### Phase 3 (1-3 months)
- [ ] P3: Issue #138 - Remote server support (if approved)
- [ ] P4: Issue #122 - Unstaged file support (if needed)

## Risk Mitigation

1. **Breaking Changes**
   - Issue #117: Provide migration guide and deprecation period
   - Use feature flags for major changes

2. **Performance Impact**
   - Issue #294: Cache parsed configurations
   - Limit dependency scanning depth

3. **Security Considerations**
   - All file paths must be validated
   - Remote server connections must use TLS
   - API keys must be masked in logs

## Success Metrics

- Reduced issue reports about custom providers
- Increased adoption from verified publisher requirement
- No accidental data exposures from sharing
- Positive user feedback on new features