import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import * as fs from 'fs';

// Type definitions for mocks
type MockOctokit = {
  rest: {
    issues: {
      createComment: jest.Mock;
    };
  };
};

// Create mock functions before importing the module that uses them
const mockGitInterface = {
  fetch: jest.fn((options: string[]) => {
    // Call the underlying `fetch` when we have an invalid ref-name, for accurate errors
    if (options[2].match(/\s/)) {
      const { simpleGit } =
        jest.requireActual<typeof import('simple-git')>('simple-git');
      const actualGitInterface = simpleGit();
      return actualGitInterface.fetch(options);
    }
    return Promise.resolve();
  }),
  revparse: jest.fn(() => Promise.resolve('mock-commit-hash\n')),
  diff: jest.fn(() =>
    Promise.resolve('prompts/prompt1.txt\npromptfooconfig.yaml'),
  ),
};

// Mock simple-git before importing main.ts
jest.mock('simple-git', () => ({
  simpleGit: jest.fn(() => mockGitInterface),
}));

import { handleError, run } from '../src/main';

// Mock all dependencies
jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('@actions/exec');
jest.mock('fs', () => ({
  ...(jest.requireActual('fs') as object),
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
  promises: {
    access: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
  },
}));
jest.mock('glob', () => ({
  sync: jest.fn(),
}));
jest.mock('dotenv');

const mockCore = core as jest.Mocked<typeof core>;
const mockGithub = github as jest.Mocked<typeof github>;
const mockExec = exec as jest.Mocked<typeof exec>;
const mockFs = fs as jest.Mocked<typeof fs>;

// Import glob after mocking to get the mocked version
import * as glob from 'glob';

const mockGlob = glob as jest.Mocked<typeof glob>;

describe('GitHub Action Main', () => {
  let mockOctokit: MockOctokit;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset git interface mocks
    mockGitInterface.revparse.mockClear();
    mockGitInterface.diff.mockClear();
    mockGitInterface.revparse.mockResolvedValue('mock-commit-hash\n');
    mockGitInterface.diff.mockResolvedValue(
      'prompts/prompt1.txt\npromptfooconfig.yaml',
    );

    // Setup octokit mock
    mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn(() => Promise.resolve({})),
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

    // Setup summary mock
    mockCore.summary = {
      addHeading: jest.fn().mockReturnThis(),
      addTable: jest.fn().mockReturnThis(),
      addList: jest.fn().mockReturnThis(),
      addLink: jest.fn().mockReturnThis(),
      addRaw: jest.fn().mockReturnThis(),
      write: jest.fn(() => Promise.resolve()),
    } as unknown as typeof mockCore.summary;

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

      mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
        const pathStr = path.toString();
        return pathStr.includes('.env');
      });

      const mockDotenv = require('dotenv');
      mockDotenv.config = jest.fn().mockReturnValue({ error: null });

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
      const diffCalls = (
        mockGitInterface.diff as jest.MockedFunction<
          typeof mockGitInterface.diff
        >
      ).mock.calls as unknown as Array<[string[]]>;
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
          'disable-comment': 'false',
          'workflow-files': '', // Empty
          'workflow-base': 'feature-branch',
        };
        return inputs[name] || '';
      });

      await run();

      // Verify that diff was called with the action input base
      const diffCalls = (
        mockGitInterface.diff as jest.MockedFunction<
          typeof mockGitInterface.diff
        >
      ).mock.calls as unknown as Array<[string[]]>;
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
      mockExec.exec.mockImplementation((command: string) => {
        if (command.includes('promptfoo')) {
          throw new Error('Promptfoo evaluation failed');
        }
        return Promise.resolve(0);
      });

      await run();

      // Should fail fast and not create comment
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();

      // Should fail the action
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

    test('should not include flags when both are false', async () => {
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
    });

    test('should include both flags when both are true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-table') return true;
        if (name === 'no-progress-bar') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--no-table');
      expect(args).toContain('--no-progress-bar');
    });

    test('should run evaluation when prompts is not provided', async () => {
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

      // Mock config file as changed
      mockGitInterface.diff.mockResolvedValue('promptfooconfig.yaml');
      mockGlob.sync.mockReturnValue([]);

      await run();

      // Should run promptfoo without --prompts argument
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval', '-c', 'promptfooconfig.yaml']),
        expect.any(Object),
      );

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--prompts');
    });

    test('should handle empty prompts with spaces', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: '  \n  \n  ', // Only whitespace
          'working-directory': '',
          'cache-path': '',
          'promptfoo-version': 'latest',
          'env-files': '',
        };
        return inputs[name] || '';
      });

      // Mock config file as changed
      mockGitInterface.diff.mockResolvedValue('promptfooconfig.yaml');
      mockGlob.sync.mockReturnValue([]);

      await run();

      // Should run promptfoo without --prompts argument
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--prompts');
    });

    test('should skip evaluation when prompts are specified but no files match', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'mock-github-token',
          config: 'promptfooconfig.yaml',
          prompts: 'prompts/*.txt', // Prompts specified
          'working-directory': '',
          'cache-path': '',
          'promptfoo-version': 'latest',
          'env-files': '',
        };
        return inputs[name] || '';
      });

      // Mock changed files that don't match the glob
      mockGitInterface.diff.mockResolvedValue('README.md\npackage.json');
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']); // Files exist but weren't changed

      await run();

      // Should skip evaluation
      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo'),
        expect.any(Array),
        expect.any(Object),
      );
    });

    test('should include --share flag when no-share is false and auth is present', async () => {
      process.env.PROMPTFOO_API_KEY = 'test-api-key';

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--share');

      delete process.env.PROMPTFOO_API_KEY;
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
      // Ensure no auth environment variables are set
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

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--share');

      delete process.env.PROMPTFOO_API_KEY;
    });

    test('should include --share when PROMPTFOO_REMOTE_API_BASE_URL is set', async () => {
      process.env.PROMPTFOO_REMOTE_API_BASE_URL = 'https://example.com';

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toContain('--share');

      delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;
    });

    test('should handle all flags together correctly', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-table') return true;
        if (name === 'no-progress-bar') return true;
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

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("fatal: invalid refspec 'feature branch"),
      );
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

// Simple tests to verify the logic would work
describe('disable-comment feature', () => {
  test('should have disable-comment parameter in action.yml', async () => {
    const yaml = require('js-yaml');
    const path = require('path');
    const realFs = jest.requireActual('fs') as typeof fs;

    const actionYmlPath = path.join(__dirname, '..', 'action.yml');
    const actionYml = realFs.readFileSync(actionYmlPath, 'utf8');
    const action = yaml.load(actionYml);

    expect(action.inputs).toHaveProperty('disable-comment');
    expect(action.inputs['disable-comment'].description).toBe(
      'Disable posting comments to the PR',
    );
    expect(action.inputs['disable-comment'].default).toBe('false');
    expect(action.inputs['disable-comment'].required).toBe(false);
  });

  test('main.ts should have conditional comment logic', async () => {
    const path = require('path');
    const realFs = jest.requireActual('fs') as typeof fs;

    const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
    const mainContent = realFs.readFileSync(mainPath, 'utf8');

    // Check that disableComment is read from input
    expect(mainContent).toContain(
      "const disableComment: boolean = core.getBooleanInput('disable-comment'",
    );

    // Check that comment posting is wrapped in a condition
    expect(mainContent).toContain(
      'if (isPullRequest && pullRequestNumber && !disableComment)',
    );
    expect(mainContent).toContain('octokit.rest.issues.createComment');
  });

  test('README.md should document the new parameter', async () => {
    const path = require('path');
    const realFs = jest.requireActual('fs') as typeof fs;

    const readmePath = path.join(__dirname, '..', 'README.md');
    const readmeContent = realFs.readFileSync(readmePath, 'utf8');

    // Check that disable-comment is documented
    expect(readmeContent).toContain('`disable-comment`');
    expect(readmeContent).toContain('Disable posting comments to the PR');
  });
});
