import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  type MockedFunction,
  test,
  vi,
} from 'vitest';

// Get actual fs module for tests that need to read real files
const actualFs = await vi.importActual<typeof import('fs')>('fs');

// Type definitions for mocks
type MockOctokit = {
  rest: {
    issues: {
      createComment: Mock;
    };
  };
};

// Use vi.hoisted() to define mocks before vi.mock() hoisting
const { mockGitInterface } = vi.hoisted(() => ({
  mockGitInterface: {
    fetch: vi.fn(async (options: string[]) => {
      // Simulate git error for invalid ref names (with spaces)
      // This tests the error flow without calling real git
      if (options[2]?.match(/\s/)) {
        const error = new Error('Git fetch failed for invalid ref');
        (error as Error & { code?: string }).code = 'INVALID_REF';
        throw error;
      }
      return Promise.resolve();
    }),
    revparse: vi.fn(() => Promise.resolve('mock-commit-hash\n')),
    diff: vi.fn(() =>
      Promise.resolve('prompts/prompt1.txt\npromptfooconfig.yaml'),
    ),
  },
}));

// Mock simple-git before importing main.ts
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGitInterface),
}));

// Mock auth utilities
vi.mock('../src/utils/auth');

import { handleError, run } from '../src/main';
import * as auth from '../src/utils/auth';

const mockAuth = auth as {
  validatePromptfooApiKey: MockedFunction<typeof auth.validatePromptfooApiKey>;
  getApiHost: MockedFunction<typeof auth.getApiHost>;
};

// Note: @actions/core, @actions/github, and @actions/exec are already mocked via vitest.config.ts aliases
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    promises: {
      access: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});
vi.mock('glob', () => ({
  sync: vi.fn(),
}));
vi.mock('dotenv');

const mockCore = core as unknown as {
  getInput: MockedFunction<typeof core.getInput>;
  getBooleanInput: MockedFunction<typeof core.getBooleanInput>;
  setSecret: MockedFunction<typeof core.setSecret>;
  setFailed: MockedFunction<typeof core.setFailed>;
  info: MockedFunction<typeof core.info>;
  debug: MockedFunction<typeof core.debug>;
  warning: MockedFunction<typeof core.warning>;
  startGroup: MockedFunction<typeof core.startGroup>;
  endGroup: MockedFunction<typeof core.endGroup>;
  summary: typeof core.summary;
};
const mockGithub = github as unknown as {
  getOctokit: MockedFunction<typeof github.getOctokit>;
  context: typeof github.context;
};
const mockExec = exec as unknown as {
  exec: MockedFunction<typeof exec.exec>;
};
const mockFs = fs as unknown as {
  readFileSync: MockedFunction<typeof fs.readFileSync>;
  existsSync: MockedFunction<typeof fs.existsSync>;
};

// Import glob after mocking to get the mocked version
import * as glob from 'glob';

const mockGlob = glob as unknown as {
  sync: MockedFunction<typeof glob.sync>;
};

/**
 * Helper function to setup common mocks used across test suites.
 * Reduces duplication between 'GitHub Action Main' and 'API key environment variable fallback' describe blocks.
 */
function setupCommonMocks(): MockOctokit {
  // Reset all mocks
  vi.clearAllMocks();

  // Reset git interface mocks
  mockGitInterface.revparse.mockClear();
  mockGitInterface.diff.mockClear();
  mockGitInterface.revparse.mockResolvedValue('mock-commit-hash\n');
  mockGitInterface.diff.mockResolvedValue(
    'prompts/prompt1.txt\npromptfooconfig.yaml',
  );

  // Setup octokit mock
  const mockOctokit: MockOctokit = {
    rest: {
      issues: {
        createComment: vi.fn(() => Promise.resolve({})),
      },
    },
  };
  mockGithub.getOctokit.mockReturnValue(
    mockOctokit as unknown as ReturnType<typeof github.getOctokit>,
  );

  // Setup default input mocks
  mockCore.getInput.mockImplementation((name: string) => {
    const inputs: Record<string, string> = {
      'github-token': 'mock-github-token',
      config: 'promptfooconfig.yaml',
      prompts: 'prompts/*.txt',
      'working-directory': '',
      'cache-path': '',
      'promptfoo-version': 'latest',
      'env-files': '',
    };
    return inputs[name] || '';
  });

  mockCore.getBooleanInput.mockReturnValue(false);

  // Summary mock is already configured in the mock file, just clear it
  if (mockCore.summary) {
    (mockCore.summary.addHeading as Mock).mockClear().mockReturnThis();
    (mockCore.summary.addTable as Mock).mockClear().mockReturnThis();
    (mockCore.summary.addList as Mock).mockClear().mockReturnThis();
    (mockCore.summary.addLink as Mock).mockClear().mockReturnThis();
    (mockCore.summary.addRaw as Mock).mockClear().mockReturnThis();
    (mockCore.summary.write as Mock).mockClear().mockResolvedValue(undefined);
  }

  // Setup GitHub context
  Object.defineProperty(mockGithub.context, 'eventName', {
    value: 'pull_request',
    configurable: true,
  });
  Object.defineProperty(mockGithub.context, 'payload', {
    value: {
      pull_request: {
        number: 123,
        base: { ref: 'main' },
        head: { ref: 'feature-branch' },
      },
    },
    configurable: true,
  });
  Object.defineProperty(mockGithub.context, 'repo', {
    value: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
    configurable: true,
  });

  // Setup file system mocks
  mockFs.readFileSync.mockReturnValue(
    JSON.stringify({
      results: {
        stats: {
          successes: 10,
          failures: 2,
        },
      },
      shareableUrl: 'https://example.com/results',
    }),
  );
  mockFs.existsSync.mockReturnValue(false);

  // Setup exec mock
  mockExec.exec.mockResolvedValue(0);

  // Setup glob mock - return files that will match changed files
  mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

  return mockOctokit;
}

describe('GitHub Action Main', () => {
  let mockOctokit: MockOctokit;

  beforeEach(() => {
    mockOctokit = setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up any PROMPTFOO env vars that tests might have set
    delete process.env.PROMPTFOO_API_KEY;
    delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;
  });

  describe('run function', () => {
    test('should successfully run evaluation when prompt files change', async () => {
      await run();

      // Verify git operations - now with -- separator for security
      expect(mockGitInterface.fetch).toHaveBeenCalledWith([
        '--',
        'origin',
        'main',
      ]);
      expect(mockGitInterface.fetch).toHaveBeenCalledWith([
        '--',
        'origin',
        'feature-branch',
      ]);
      expect(mockGitInterface.diff).toHaveBeenCalled();

      // Verify promptfoo execution
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval', '-c', 'promptfooconfig.yaml']),
        expect.any(Object),
      );

      // Verify PR comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('LLM prompt was modified'),
      });
    });

    test('should skip evaluation when no relevant files change', async () => {
      // Mock git diff to return files that don't match our glob pattern
      mockGitInterface.diff.mockResolvedValue('README.md\npackage.json');
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo'),
        expect.any(Array),
        expect.any(Object),
      );
    });

    test('should handle empty prompts input', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: '', // Empty prompts
          'working-directory': '',
          'cache-path': '',
          'promptfoo-version': 'latest',
          'env-files': '',
        };
        return inputs[name] || '';
      });

      // Empty prompts should still work - it uses config file prompts
      mockGlob.sync.mockReturnValue([]);

      await run();

      // Should still proceed with evaluation using config file
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval']),
        expect.any(Object),
      );
    });

    test('should handle whitespace-only prompts input', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: '   \t\n  ', // Whitespace only
          'working-directory': '',
          'cache-path': '',
          'promptfoo-version': 'latest',
          'env-files': '',
        };
        return inputs[name] || '';
      });

      // Whitespace prompts should be treated as empty
      mockGlob.sync.mockReturnValue([]);

      await run();

      // Should still proceed with evaluation using config file
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval']),
        expect.any(Object),
      );
    });

    test('should handle API keys correctly', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: 'prompts/*.txt',
          'openai-api-key': 'sk-test-key',
          'anthropic-api-key': 'claude-key',
        };
        return inputs[name] || '';
      });

      await run();

      // Verify secrets are masked
      expect(mockCore.setSecret).toHaveBeenCalledWith('sk-test-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('claude-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('mock-github-token');

      // Verify environment variables are passed
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENAI_API_KEY: 'sk-test-key',
            ANTHROPIC_API_KEY: 'claude-key',
          }),
        }),
      );
    });

    test('should load environment files when specified', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: 'prompts/*.txt',
          'env-files': '.env,.env.local',
        };
        return inputs[name] || '';
      });

      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const pathStr = filePath.toString();
        return pathStr.includes('.env');
      });

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockReturnValue({ error: null });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Loading environment variables from'),
      );
    });

    test('should handle push events', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          before: 'abc123',
          after: 'def456',
        },
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'sha', {
        value: 'def456',
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('Running in push mode');
      expect(mockGitInterface.diff).toHaveBeenCalled();
      const diffCalls = mockGitInterface.diff.mock.calls as unknown as Array<
        [string[]]
      >;
      if (diffCalls.length > 0) {
        expect(diffCalls[0][0]).toEqual(['--name-only', 'abc123', 'def456']);
      }
    });

    test('should handle workflow_dispatch events with default behavior', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {},
        },
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Running in workflow_dispatch mode',
      );
      // Verify it processes files (either through diff or all files)
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval']),
        expect.any(Object),
      );
    });

    test('should handle workflow_dispatch with manual files input', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'prompts/file1.txt\nprompts/file2.txt',
          },
        },
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Using manually specified files: prompts/file1.txt\nprompts/file2.txt',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should handle workflow_dispatch with custom base comparison', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            base: 'main',
          },
        },
        configurable: true,
      });

      await run();

      // Should still run the evaluation
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval']),
        expect.any(Object),
      );
    });

    test('should handle workflow_dispatch when diff comparison fails', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            base: 'invalid-ref',
          },
        },
        configurable: true,
      });

      // Make diff throw an error for this test
      mockGitInterface.diff.mockRejectedValueOnce(new Error('Invalid ref'));

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not compare against invalid-ref'),
      );
      // Should process all matching files when diff fails
      expect(mockGlob.sync).toHaveBeenCalled();
    });

    test('should prioritize action inputs over workflow inputs', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'workflow-input-file.txt',
            base: 'workflow-base',
          },
        },
        configurable: true,
      });

      // Mock action inputs
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          prompts: 'prompts/**/*.txt',
          config: 'promptfooconfig.yaml',
          'promptfoo-version': 'latest',
          'working-directory': '',
          'no-share': 'false',
          'use-config-prompts': 'false',
          'env-files': '',
          'cache-path': '',
          'no-table': 'false',
          'no-progress-bar': 'false',
          'no-cache': 'false',
          'disable-comment': 'false',
          'workflow-files': 'action-input-file.txt',
          'workflow-base': 'action-base',
        };
        return inputs[name] || '';
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Using manually specified files: action-input-file.txt',
      );
      // Since we're providing files directly, diff shouldn't be called
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should use action input base when only base is provided', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {},
        },
        configurable: true,
      });

      // Mock only workflow-base action input
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          prompts: 'prompts/**/*.txt',
          config: 'promptfooconfig.yaml',
          'promptfoo-version': 'latest',
          'working-directory': '',
          'no-share': 'false',
          'use-config-prompts': 'false',
          'env-files': '',
          'cache-path': '',
          'no-table': 'false',
          'no-progress-bar': 'false',
          'no-cache': 'false',
          'disable-comment': 'false',
          'workflow-files': '', // Empty
          'workflow-base': 'feature-branch',
        };
        return inputs[name] || '';
      });

      await run();

      // Verify that diff was called with the action input base
      const diffCalls = mockGitInterface.diff.mock.calls as unknown as Array<
        [string[]]
      >;
      if (diffCalls.length > 0) {
        expect(diffCalls[0][0]).toEqual([
          '--name-only',
          'feature-branch',
          'HEAD',
        ]);
      }
    });

    test('should handle unsupported events with warning', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'issues',
        configurable: true,
      });

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'This action is designed to run on pull request, push, or workflow_dispatch events',
        ),
      );
    });

    test('should handle missing pull request data', async () => {
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {},
        configurable: true,
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: No pull request found in context.',
      );
    });

    test('should handle promptfoo execution failure', async () => {
      mockExec.exec.mockImplementation(
        (command: string, args?: readonly string[]) => {
          if (command.includes('promptfoo') && args?.includes('eval')) {
            throw new Error('Promptfoo evaluation failed');
          }
          return Promise.resolve(0);
        },
      );

      await run();

      // PR comment SHOULD be created even when tests fail
      // This is the intended behavior per issue #786 - we want to show test results
      // in PR comments regardless of pass/fail status
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('LLM prompt was modified'),
      });

      // Should still fail the action after posting the comment
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Promptfoo evaluation failed'),
      );
    });

    test('should respect disable-comment option', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        return name === 'disable-comment';
      });

      await run();

      // Should NOT create comment when disable-comment is true
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should not include any flags when all are false', async () => {
      await run();

      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const promptfooCall = mockExec.exec.mock.calls[0];
      expect(promptfooCall[0]).toBe('npx promptfoo@latest');

      const args = promptfooCall[1] as string[];
      expect(args).toContain('eval');
      expect(args).toContain('-c');
      expect(args).toContain('promptfooconfig.yaml');
      expect(args).not.toContain('--no-table');
      expect(args).not.toContain('--no-progress-bar');
      expect(args).not.toContain('--no-cache');
    });

    test('should include --no-table flag when no-table is true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-table') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--no-table');
      expect(args).not.toContain('--no-progress-bar');
      expect(args).not.toContain('--no-cache');
    });

    test('should include --no-progress-bar flag when no-progress-bar is true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-progress-bar') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--no-table');
      expect(args).toContain('--no-progress-bar');
      expect(args).not.toContain('--no-cache');
    });

    test('should include --share flag when no-share is false and auth is present', async () => {
      process.env.PROMPTFOO_API_KEY = 'test-api-key';

      // Mock successful validation
      mockAuth.validatePromptfooApiKey.mockResolvedValue({
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        organization: { id: '1', name: 'Test Org' },
      });
      mockAuth.getApiHost.mockReturnValue('https://api.promptfoo.app');

      await run();

      expect(mockAuth.validatePromptfooApiKey).toHaveBeenCalledWith(
        'test-api-key',
        'https://api.promptfoo.app',
      );

      // Only 1 exec call (eval) - promptfoo now reads PROMPTFOO_API_KEY env var directly
      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const evalCall = mockExec.exec.mock.calls[0];
      const evalArgs = evalCall[1] as string[];
      expect(evalArgs).toContain('--share');
    });

    test('should not include --share flag when no-share is true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-share') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--share');
    });

    test('should skip sharing when no auth is present', async () => {
      delete process.env.PROMPTFOO_API_KEY;
      delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--share');
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Sharing is enabled but no authentication found',
        ),
      );
    });

    test('should include --share when PROMPTFOO_API_KEY is set', async () => {
      process.env.PROMPTFOO_API_KEY = 'test-api-key';

      mockAuth.validatePromptfooApiKey.mockResolvedValue({
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        organization: { id: '1', name: 'Test Org' },
      });
      mockAuth.getApiHost.mockReturnValue('https://api.promptfoo.app');

      await run();

      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const evalCall = mockExec.exec.mock.calls[0];
      const evalArgs = evalCall[1] as string[];
      expect(evalArgs).toContain('--share');
    });

    test('should include --share when PROMPTFOO_REMOTE_API_BASE_URL is set', async () => {
      // Ensure no API key is set (only REMOTE_API_BASE_URL)
      delete process.env.PROMPTFOO_API_KEY;
      process.env.PROMPTFOO_REMOTE_API_BASE_URL = 'https://example.com';

      await run();

      // Only 1 exec call (eval) - self-hosted uses env var for API URL
      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--share');
    });

    test('should fail early when API key validation fails', async () => {
      process.env.PROMPTFOO_API_KEY = 'invalid-api-key';

      const { PromptfooActionError, ErrorCodes } = await import(
        '../src/utils/errors'
      );

      // Mock failed validation
      mockAuth.validatePromptfooApiKey.mockRejectedValue(
        new PromptfooActionError(
          'Invalid PROMPTFOO_API_KEY: Authentication failed with status 401',
          ErrorCodes.AUTH_FAILED,
          'Ensure PROMPTFOO_API_KEY is set correctly',
        ),
      );
      mockAuth.getApiHost.mockReturnValue('https://api.promptfoo.app');

      await run();

      // Should have attempted to validate
      expect(mockAuth.validatePromptfooApiKey).toHaveBeenCalledWith(
        'invalid-api-key',
        'https://api.promptfoo.app',
      );

      // Should not have run promptfoo eval
      expect(mockExec.exec).not.toHaveBeenCalled();

      // Should have failed the action
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Invalid PROMPTFOO_API_KEY'),
      );

      delete process.env.PROMPTFOO_API_KEY;
    });

    test('should handle all flags together correctly', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-table') return true;
        if (name === 'no-progress-bar') return true;
        if (name === 'no-cache') return true;
        if (name === 'no-share') return true;
        if (name === 'use-config-prompts') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];

      // Should have these flags
      expect(args).toContain('--no-table');
      expect(args).toContain('--no-progress-bar');
      expect(args).toContain('--no-cache');

      // Should NOT have these
      expect(args).not.toContain('--share');
      expect(args).not.toContain('--prompts'); // because use-config-prompts is true
    });
  });

  describe('handleError function', () => {
    test('should set failed status with error message', () => {
      const error = new Error('Test error');
      handleError(error);
      expect(mockCore.setFailed).toHaveBeenCalledWith('Error: Test error');
    });
  });

  describe('security validation', () => {
    test('should reject git refs starting with --', async () => {
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          pull_request: {
            number: 123,
            base: { ref: '--upload-pack=/evil/script' },
            head: { ref: 'feature-branch' },
          },
        },
        configurable: true,
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('refs cannot start with "-" or "--"'),
      );
    });

    test('should reject git refs with spaces', async () => {
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          pull_request: {
            number: 123,
            base: { ref: 'main' },
            head: { ref: 'feature branch' },
          },
        },
        configurable: true,
      });

      await run();

      // Assert that the action failed with the deterministic error from our mock
      expect(mockCore.setFailed).toHaveBeenCalled();
      const failedCall = mockCore.setFailed.mock.calls[0][0];
      expect(typeof failedCall).toBe('string');
      expect(failedCall).toContain('Git fetch failed for invalid ref');
    });

    test('should accept valid git refs', async () => {
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          pull_request: {
            number: 123,
            base: { ref: 'main' },
            head: { ref: 'feature/JIRA-123_update-deps' },
          },
        },
        configurable: true,
      });

      await run();

      // Should proceed with git fetch using -- separator
      expect(mockGitInterface.fetch).toHaveBeenCalledWith([
        '--',
        'origin',
        'main',
      ]);
      expect(mockGitInterface.fetch).toHaveBeenCalledWith([
        '--',
        'origin',
        'feature/JIRA-123_update-deps',
      ]);
    });
  });
});

describe('API key environment variable fallback', () => {
  beforeEach(() => {
    setupCommonMocks();

    // Clear all provider-specific environment variables before each test
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.HF_API_TOKEN;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.PALM_API_KEY;
    delete process.env.VERTEX_API_KEY;
    delete process.env.COHERE_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PROMPTFOO_API_KEY;
    delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;
  });

  test('should use env var when action input not provided', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';

    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'mock-github-token',
        config: 'promptfooconfig.yaml',
        prompts: 'prompts/*.txt',
        'openai-api-key': '', // Not provided
        'anthropic-api-key': '', // Not provided
      };
      return inputs[name] || '';
    });

    await run();

    const envPassedToExec = mockExec.exec.mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(envPassedToExec.env.OPENAI_API_KEY).toBe('env-openai-key');
    expect(envPassedToExec.env.ANTHROPIC_API_KEY).toBe('env-anthropic-key');
  });

  test('should prefer action input over env var', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';

    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'mock-github-token',
        config: 'promptfooconfig.yaml',
        prompts: 'prompts/*.txt',
        'openai-api-key': 'input-openai-key', // Provided via input
        'anthropic-api-key': 'input-anthropic-key', // Provided via input
      };
      return inputs[name] || '';
    });

    await run();

    const envPassedToExec = mockExec.exec.mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(envPassedToExec.env.OPENAI_API_KEY).toBe('input-openai-key');
    expect(envPassedToExec.env.ANTHROPIC_API_KEY).toBe('input-anthropic-key');
  });

  test('should work for all API key providers', async () => {
    process.env.OPENAI_API_KEY = 'openai-env';
    process.env.AZURE_OPENAI_API_KEY = 'azure-env';
    process.env.ANTHROPIC_API_KEY = 'anthropic-env';
    process.env.HF_API_TOKEN = 'hf-env';
    process.env.AWS_ACCESS_KEY_ID = 'aws-key-id-env';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-env';
    process.env.REPLICATE_API_KEY = 'replicate-env';
    process.env.PALM_API_KEY = 'palm-env';
    process.env.VERTEX_API_KEY = 'vertex-env';
    process.env.COHERE_API_KEY = 'cohere-env';
    process.env.MISTRAL_API_KEY = 'mistral-env';
    process.env.GROQ_API_KEY = 'groq-env';

    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'mock-github-token',
        config: 'promptfooconfig.yaml',
        prompts: 'prompts/*.txt',
      };
      return inputs[name] || '';
    });

    await run();

    const envPassedToExec = mockExec.exec.mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(envPassedToExec.env.OPENAI_API_KEY).toBe('openai-env');
    expect(envPassedToExec.env.AZURE_OPENAI_API_KEY).toBe('azure-env');
    expect(envPassedToExec.env.ANTHROPIC_API_KEY).toBe('anthropic-env');
    expect(envPassedToExec.env.HF_API_TOKEN).toBe('hf-env');
    expect(envPassedToExec.env.AWS_ACCESS_KEY_ID).toBe('aws-key-id-env');
    expect(envPassedToExec.env.AWS_SECRET_ACCESS_KEY).toBe('aws-secret-env');
    expect(envPassedToExec.env.REPLICATE_API_KEY).toBe('replicate-env');
    expect(envPassedToExec.env.PALM_API_KEY).toBe('palm-env');
    expect(envPassedToExec.env.VERTEX_API_KEY).toBe('vertex-env');
    expect(envPassedToExec.env.COHERE_API_KEY).toBe('cohere-env');
    expect(envPassedToExec.env.MISTRAL_API_KEY).toBe('mistral-env');
    expect(envPassedToExec.env.GROQ_API_KEY).toBe('groq-env');
  });

  test('should mix inputs and env vars correctly', async () => {
    process.env.OPENAI_API_KEY = 'openai-env';
    process.env.ANTHROPIC_API_KEY = 'anthropic-env';

    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'mock-github-token',
        config: 'promptfooconfig.yaml',
        prompts: 'prompts/*.txt',
        'openai-api-key': 'openai-input', // Override with input
        // anthropic-api-key not provided, should use env
      };
      return inputs[name] || '';
    });

    await run();

    const envPassedToExec = mockExec.exec.mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(envPassedToExec.env.OPENAI_API_KEY).toBe('openai-input'); // Input wins
    expect(envPassedToExec.env.ANTHROPIC_API_KEY).toBe('anthropic-env'); // Env fallback
  });
});

describe('disable-comment feature', () => {
  test('should have disable-comment parameter in action.yml', () => {
    const actionYmlPath = path.join(__dirname, '..', 'action.yml');
    const actionYml = actualFs.readFileSync(actionYmlPath, 'utf8');
    const action = yaml.load(actionYml) as {
      inputs: Record<
        string,
        { description: string; default: string; required: boolean }
      >;
    };

    expect(action.inputs).toHaveProperty('disable-comment');
    expect(action.inputs['disable-comment'].description).toBe(
      'Disable posting comments to the PR',
    );
    expect(action.inputs['disable-comment'].default).toBe('false');
    expect(action.inputs['disable-comment'].required).toBe(false);
  });

  test('main.ts should have conditional comment logic', () => {
    const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
    const mainContent = actualFs.readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain(
      "const disableComment: boolean = core.getBooleanInput('disable-comment'",
    );
    expect(mainContent).toContain(
      'if (isPullRequest && pullRequestNumber && !disableComment)',
    );
    expect(mainContent).toContain('octokit.rest.issues.createComment');
  });

  test('README.md should document the new parameter', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readmeContent = actualFs.readFileSync(readmePath, 'utf8');

    expect(readmeContent).toContain('`disable-comment`');
    expect(readmeContent).toContain('Disable posting comments to the PR');
  });
});

describe('environment variable documentation', () => {
  test('README.md should document environment variable fallback', () => {
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readmeContent = actualFs.readFileSync(readmePath, 'utf8');

    expect(readmeContent).toContain('### Environment Variables');
    expect(readmeContent).toContain(
      'All workflow environment variables are passed through to promptfoo',
    );
    expect(readmeContent).toContain('Action inputs take precedence');
  });

  test('action.yml should mention environment variable fallback in descriptions', () => {
    const actionYmlPath = path.join(__dirname, '..', 'action.yml');
    const actionYml = actualFs.readFileSync(actionYmlPath, 'utf8');
    const action = yaml.load(actionYml) as {
      inputs: Record<string, { description: string }>;
    };

    expect(action.inputs['openai-api-key'].description).toContain(
      'OPENAI_API_KEY environment variable',
    );
    expect(action.inputs['azure-api-key'].description).toContain(
      'AZURE_OPENAI_API_KEY environment variable',
    );
    expect(action.inputs['anthropic-api-key'].description).toContain(
      'ANTHROPIC_API_KEY environment variable',
    );
    expect(action.inputs['huggingface-api-key'].description).toContain(
      'HF_API_TOKEN environment variable',
    );
    expect(action.inputs['aws-access-key-id'].description).toContain(
      'AWS_ACCESS_KEY_ID environment variable',
    );
    expect(action.inputs['aws-secret-access-key'].description).toContain(
      'AWS_SECRET_ACCESS_KEY environment variable',
    );
  });

  test('main.ts should have comments explaining fallback behavior', () => {
    const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
    const mainContent = actualFs.readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain(
      'Environment variables from workflow context (process.env) are used as fallback',
    );
    expect(mainContent).toContain(
      'Action inputs (if provided) take precedence and override environment variables',
    );
  });
});
