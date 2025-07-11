// Mock all external modules
jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('@actions/exec');
jest.mock('fs');
jest.mock('glob');
jest.mock('simple-git');
jest.mock('dotenv');

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
import { handleError, run } from '../src/main';

const mockCore = core as jest.Mocked<typeof core>;
const mockGithub = github as jest.Mocked<typeof github>;
const mockExec = exec as jest.Mocked<typeof exec>;
const mockFs = fs as jest.Mocked<typeof fs>;

// Create a mutable context object
let mockContext: any;

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default context
    mockContext = {
      eventName: 'pull_request',
      payload: {
        pull_request: {
          number: 123,
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      },
      repo: {
        owner: 'test-owner',
        repo: 'test-repo',
      },
    };

    // Mock github.context getter
    Object.defineProperty(mockGithub, 'context', {
      get: jest.fn(() => mockContext),
      configurable: true,
    });

    // Setup default mocks
    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'test-token',
        config: 'promptfooconfig.yaml',
        prompts: 'prompts/*.txt',
        'promptfoo-version': 'latest',
        'working-directory': '',
        'cache-path': '',
        'env-files': '',
      };
      return inputs[name] || '';
    });

    mockCore.getBooleanInput.mockReturnValue(false);
    mockCore.summary = {
      addHeading: jest.fn().mockReturnThis(),
      addTable: jest.fn().mockReturnThis(),
      addList: jest.fn().mockReturnThis(),
      addLink: jest.fn().mockReturnThis(),
      addRaw: jest.fn().mockReturnThis(),
      write: jest.fn(() => Promise.resolve()),
    } as any;

    mockFs.existsSync.mockReturnValue(false);
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

    // Mock glob
    const mockGlob = require('glob');
    mockGlob.sync = jest.fn().mockReturnValue(['prompts/test.txt']);

    // Mock simple-git
    const mockSimpleGit = require('simple-git');
    const gitMock = {
      diff: jest
        .fn()
        .mockImplementation(() => Promise.resolve('prompts/test.txt\nprompts/another.txt')),
      revparse: jest.fn().mockImplementation(() => Promise.resolve('abc123')),
    };
    mockSimpleGit.simpleGit.mockReturnValue(gitMock);

    mockExec.exec.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('workflow_dispatch event', () => {
    beforeEach(() => {
      mockContext = {
        eventName: 'workflow_dispatch',
        payload: {
          inputs: {},
        },
        repo: {
          owner: 'test-owner',
          repo: 'test-repo',
        },
      };
    });

    test('should handle workflow_dispatch with file input', async () => {
      mockContext.payload.inputs = {
        files: 'prompts/file1.txt\nprompts/file2.txt',
      };

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Running in workflow_dispatch mode',
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        'Using manually specified files: prompts/file1.txt\nprompts/file2.txt',
      );
      expect(mockExec.exec).toHaveBeenCalledWith(
        expect.stringContaining('npx promptfoo@latest'),
        expect.arrayContaining(['eval']),
        expect.any(Object),
      );
      expect(mockCore.summary.write).toHaveBeenCalled();
    });

    test('should handle workflow_dispatch with base comparison', async () => {
      const mockGit = require('simple-git').simpleGit();
      mockContext.payload.inputs = {
        base: 'main',
      };

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Running in workflow_dispatch mode',
      );
      expect(mockGit.diff).toHaveBeenCalledWith([
        '--name-only',
        'main',
        'HEAD',
      ]);
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Comparing against main'),
      );
    });

    test('should handle workflow_dispatch without inputs (default to HEAD~1)', async () => {
      const mockGit = require('simple-git').simpleGit();

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Running in workflow_dispatch mode',
      );
      expect(mockGit.diff).toHaveBeenCalledWith([
        '--name-only',
        'HEAD~1',
        'HEAD',
      ]);
    });

    test('should handle git diff failure gracefully', async () => {
      const mockGit = require('simple-git').simpleGit();
      mockGit.diff.mockRejectedValue(new Error('Git error'));

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not compare against HEAD~1'),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Processing all matching prompt files'),
      );
    });

    test('should write results to workflow summary', async () => {
      await run();

      expect(mockCore.summary.addHeading).toHaveBeenCalledWith(
        'Promptfoo Evaluation Results',
      );
      expect(mockCore.summary.addTable).toHaveBeenCalledWith([
        [
          { data: 'Metric', header: true },
          { data: 'Count', header: true },
        ],
        ['Success', '10'],
        ['Failure', '2'],
      ]);
      expect(mockCore.summary.write).toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        '=== Promptfoo Evaluation Results ===',
      );
      expect(mockCore.info).toHaveBeenCalledWith('Success: 10');
      expect(mockCore.info).toHaveBeenCalledWith('Failure: 2');
    });
  });

  describe('pull_request event', () => {
    beforeEach(() => {
      mockContext = {
        eventName: 'pull_request',
        payload: {
          pull_request: {
            number: 123,
            base: { ref: 'main' },
            head: { ref: 'feature-branch' },
          },
        },
        repo: {
          owner: 'test-owner',
          repo: 'test-repo',
        },
      };
    });

    test('should handle pull_request event', async () => {
      const mockCreateComment = jest.fn() as any;
      mockCreateComment.mockResolvedValue({ data: {} });
      
      const mockOctokit = {
        rest: {
          issues: {
            createComment: mockCreateComment,
          },
        },
      };
      (mockGithub.getOctokit as jest.Mock).mockReturnValue(mockOctokit);

      await run();

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
      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('LLM prompt was modified'),
      });
    });

    test('should throw error if pull request context is missing', async () => {
      mockContext.payload.pull_request = undefined;

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'No pull request found in context.',
      );
    });
  });

  describe('push event', () => {
    beforeEach(() => {
      mockContext = {
        eventName: 'push',
        payload: {
          before: 'abc123',
          after: 'def456',
        },
        repo: {
          owner: 'test-owner',
          repo: 'test-repo',
        },
        sha: 'def456',
      };
    });

    test('should handle push event', async () => {
      const mockGit = require('simple-git').simpleGit();

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('Running in push mode');
      expect(mockGit.diff).toHaveBeenCalledWith([
        '--name-only',
        'abc123',
        'def456',
      ]);
      expect(mockCore.summary.write).toHaveBeenCalled();
    });

    test('should handle first commit (before is all zeros)', async () => {
      mockGithub.context.payload.before =
        '0000000000000000000000000000000000000000';

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Unable to determine changed files from push event. Will process all matching prompt files.',
      );
    });
  });

  describe('unsupported events', () => {
    test('should warn for unsupported event types', async () => {
      mockContext = {
        eventName: 'issue_comment',
        payload: {},
        repo: {
          owner: 'test-owner',
          repo: 'test-repo',
        },
      };

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'This action is designed to run on pull request, push, or workflow_dispatch events',
        ),
      );
    });
  });

  describe('error handling', () => {
    test('should handle errors properly', async () => {
      const testError = new Error('Test error');
      mockExec.exec.mockRejectedValue(testError);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith('Test error');
    });

    test('handleError should call setFailed', () => {
      const error = new Error('Test error message');
      handleError(error);
      expect(mockCore.setFailed).toHaveBeenCalledWith('Test error message');
    });
  });

  describe('environment files', () => {
    test('should load environment files when specified', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        if (name === 'env-files') return '.env,.env.local';
        if (name === 'github-token') return 'test-token';
        if (name === 'config') return 'promptfooconfig.yaml';
        if (name === 'prompts') return 'prompts/*.txt';
        if (name === 'promptfoo-version') return 'latest';
        return '';
      });

      mockFs.existsSync.mockImplementation((path: fs.PathLike) => {
        return String(path).includes('.env');
      });

      const mockDotenv = require('dotenv');
      mockDotenv.config.mockReturnValue({ error: null });

      mockContext = {
        eventName: 'workflow_dispatch',
        payload: { inputs: {} },
        repo: { owner: 'test-owner', repo: 'test-repo' },
      };

      await run();

      expect(mockFs.existsSync).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
      );
      expect(mockDotenv.config).toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Successfully loaded'),
      );
    });

    test('should warn when environment file not found', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        if (name === 'env-files') return '.env.missing';
        if (name === 'github-token') return 'test-token';
        if (name === 'config') return 'promptfooconfig.yaml';
        if (name === 'prompts') return 'prompts/*.txt';
        if (name === 'promptfoo-version') return 'latest';
        return '';
      });

      mockFs.existsSync.mockReturnValue(false);

      mockContext = {
        eventName: 'workflow_dispatch',
        payload: { inputs: {} },
        repo: { owner: 'test-owner', repo: 'test-repo' },
      };

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('Environment file'),
      );
    });
  });
});
