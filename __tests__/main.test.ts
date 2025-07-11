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

// Create mock functions before importing the module that uses them
const mockGitInterface = {
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
  let mockOctokit: any;

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
    mockGithub.getOctokit.mockReturnValue(mockOctokit as any);

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
    } as any;

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

      // Verify git operations
      expect(mockExec.exec).toHaveBeenCalledWith('git', [
        'fetch',
        'origin',
        'main',
      ]);
      expect(mockExec.exec).toHaveBeenCalledWith('git', [
        'fetch',
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
        'No LLM prompt or config files were modified.',
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
      const diffCalls = (mockGitInterface.diff as any).mock.calls;
      expect(diffCalls[0][0]).toEqual(['--name-only', 'abc123', 'def456']);
    });

    test('should handle workflow_dispatch events', async () => {
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
        'No pull request found in context.',
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

      // Should still create comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();

      // But should fail the action
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Promptfoo evaluation failed',
      );
    });
  });

  describe('handleError function', () => {
    test('should set failed status with error message', () => {
      const error = new Error('Test error');
      handleError(error);
      expect(mockCore.setFailed).toHaveBeenCalledWith('Test error');
    });
  });
});
