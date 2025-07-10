import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';

// Mock the gitInterface at module level
const mockGitInterface = {
  diff: jest.fn<() => Promise<string>>().mockResolvedValue('prompts/prompt1.txt\nprompts/promptfooconfig.yaml'),
  revparse: jest.fn<() => Promise<string>>().mockResolvedValue('mock-commit-hash\n'),
};

// Mock modules
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/github');
jest.mock('glob');
jest.mock('simple-git', () => ({
  simpleGit: jest.fn(() => mockGitInterface),
}));
jest.mock('dotenv');
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs') as typeof import('fs');
  return {
    ...actualFs,
    readFileSync: jest.fn(),
    existsSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    statSync: jest.fn().mockReturnValue({ isDirectory: () => false }),
    promises: {
      ...actualFs.promises,
      access: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      readFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
      mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      stat: jest.fn<() => Promise<any>>().mockResolvedValue({ isDirectory: () => true }),
    },
  };
});

// Import after mocks are set up
import {run} from '../src/main';

describe('GitHub Action - no-table and no-progress-bar flags', () => {
  let mockGetInput: jest.MockedFunction<typeof core.getInput>;
  let mockGetBooleanInput: jest.MockedFunction<typeof core.getBooleanInput>;
  let mockSetSecret: jest.MockedFunction<typeof core.setSecret>;
  let mockSetFailed: jest.MockedFunction<typeof core.setFailed>;
  let mockInfo: jest.MockedFunction<typeof core.info>;
  let mockWarning: jest.MockedFunction<typeof core.warning>;
  let mockExec: jest.MockedFunction<typeof exec.exec>;
  let mockGetOctokit: jest.MockedFunction<typeof github.getOctokit>;
  
  const mockContext = {
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

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset git interface mocks
    mockGitInterface.diff.mockClear();
    mockGitInterface.revparse.mockClear();
    mockGitInterface.diff.mockResolvedValue('prompts/prompt1.txt\nprompts/promptfooconfig.yaml');
    mockGitInterface.revparse.mockResolvedValue('mock-commit-hash\n');
    
    // Setup core mocks
    mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;
    mockGetBooleanInput = core.getBooleanInput as jest.MockedFunction<typeof core.getBooleanInput>;
    mockSetSecret = core.setSecret as jest.MockedFunction<typeof core.setSecret>;
    mockSetFailed = core.setFailed as jest.MockedFunction<typeof core.setFailed>;
    mockInfo = core.info as jest.MockedFunction<typeof core.info>;
    mockWarning = core.warning as jest.MockedFunction<typeof core.warning>;
    
    // Setup exec mock
    mockExec = exec.exec as jest.MockedFunction<typeof exec.exec>;
    mockExec.mockResolvedValue(0);
    
    // Setup github mocks
    Object.defineProperty(github, 'context', {
      value: mockContext,
      configurable: true,
    });
    
    mockGetOctokit = github.getOctokit as jest.MockedFunction<typeof github.getOctokit>;
    const mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn<() => Promise<any>>().mockResolvedValue({}),
        },
      },
    };
    mockGetOctokit.mockReturnValue(mockOctokit as any);
    
    // Setup glob mock
    const glob = require('glob');
    glob.sync = jest.fn().mockReturnValue(['prompts/prompt1.txt']);
    
    // Setup fs mocks
    const fs = require('fs');
    fs.readFileSync.mockReturnValue(JSON.stringify({
      results: {
        stats: {
          successes: 10,
          failures: 2,
        },
      },
      shareableUrl: 'https://example.com/results',
    }));
    fs.existsSync.mockReturnValue(false);
    
    // Default input mocks
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'mock-github-token',
        'config': 'prompts/promptfooconfig.yaml',
        'prompts': 'prompts/*.txt',
        'working-directory': '.',
        'cache-path': '',
        'promptfoo-version': 'latest',
        'env-files': '',
        'openai-api-key': '',
        'azure-api-key': '',
        'anthropic-api-key': '',
        'huggingface-api-key': '',
        'aws-access-key-id': '',
        'aws-secret-access-key': '',
        'replicate-api-key': '',
        'palm-api-key': '',
        'vertex-api-key': '',
      };
      return inputs[name] || '';
    });
    
    mockGetBooleanInput.mockImplementation((name: string) => {
      const booleanInputs: Record<string, boolean> = {
        'no-share': false,
        'use-config-prompts': false,
        'no-table': false,
        'no-progress-bar': false,
      };
      return booleanInputs[name] || false;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should not include flags when both are false', async () => {
    await run();
    
    expect(mockExec).toHaveBeenCalledTimes(3); // 2 git fetches + 1 promptfoo
    const promptfooCall = mockExec.mock.calls[2];
    expect(promptfooCall[0]).toBe('npx promptfoo@latest');
    
    const args = promptfooCall[1] as string[];
    expect(args).toContain('eval');
    expect(args).toContain('-c');
    expect(args).toContain('prompts/promptfooconfig.yaml');
    expect(args).not.toContain('--no-table');
    expect(args).not.toContain('--no-progress-bar');
  });

  test('should include --no-table flag when no-table is true', async () => {
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'no-table') return true;
      return false;
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    expect(args).toContain('--no-table');
    expect(args).not.toContain('--no-progress-bar');
  });

  test('should include --no-progress-bar flag when no-progress-bar is true', async () => {
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'no-progress-bar') return true;
      return false;
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    expect(args).not.toContain('--no-table');
    expect(args).toContain('--no-progress-bar');
  });

  test('should include both flags when both are true', async () => {
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'no-table') return true;
      if (name === 'no-progress-bar') return true;
      return false;
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    expect(args).toContain('--no-table');
    expect(args).toContain('--no-progress-bar');
  });

  test('should include --share flag when no-share is false', async () => {
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    expect(args).toContain('--share');
  });

  test('should not include --share flag when no-share is true', async () => {
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'no-share') return true;
      return false;
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    expect(args).not.toContain('--share');
  });

  test('should handle all flags together correctly', async () => {
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'no-table') return true;
      if (name === 'no-progress-bar') return true;
      if (name === 'no-share') return true;
      if (name === 'use-config-prompts') return true;
      return false;
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const args = promptfooCall[1] as string[];
    
    // Should have these flags
    expect(args).toContain('--no-table');
    expect(args).toContain('--no-progress-bar');
    
    // Should NOT have these
    expect(args).not.toContain('--share');
    expect(args).not.toContain('--prompts'); // because use-config-prompts is true
  });

  test('should pass correct environment variables to exec', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'openai-api-key') return 'test-openai-key';
      if (name === 'cache-path') return '/test/cache';
      if (name === 'github-token') return 'mock-github-token';
      if (name === 'config') return 'prompts/promptfooconfig.yaml';
      if (name === 'prompts') return 'prompts/*.txt';
      return '';
    });
    
    await run();
    
    const promptfooCall = mockExec.mock.calls[2];
    const options = promptfooCall[2] as any;
    
    expect(options.env).toMatchObject({
      OPENAI_API_KEY: 'test-openai-key',
      PROMPTFOO_CACHE_PATH: '/test/cache',
    });
  });

  test('should create comment on PR with correct format', async () => {
    await run();
    
    const mockCreateComment = mockGetOctokit('').rest.issues.createComment as jest.MockedFunction<any>;
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 123,
      body: expect.stringContaining('⚠️ LLM prompt was modified'),
    });
  });

  test('should handle promptfoo execution errors gracefully', async () => {
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('npx promptfoo')) {
        throw new Error('Promptfoo execution failed');
      }
      return 0;
    });
    
    await run();
    
    expect(mockSetFailed).toHaveBeenCalledWith('Promptfoo execution failed');
  });

  test('should skip evaluation when no files are changed', async () => {
    // Mock no changed prompt files
    mockGitInterface.diff.mockResolvedValue('other-file.js\nREADME.md');
    
    await run();
    
    expect(mockInfo).toHaveBeenCalledWith('No LLM prompt or config files were modified.');
    // Should only have 2 exec calls (git fetches), not the promptfoo call
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  test('should load environment files when specified', async () => {
    const mockDotenvConfig = jest.fn().mockReturnValue({ parsed: {} });
    const dotenv = require('dotenv');
    dotenv.config = mockDotenvConfig;
    
    // Mock fs.existsSync to return true for env files
    const fs = require('fs');
    fs.existsSync.mockImplementation((path: any) => {
      const pathStr = path.toString();
      return pathStr.endsWith('.env') || pathStr.endsWith('.env.local');
    });
    
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'env-files') return '.env,.env.local';
      if (name === 'github-token') return 'mock-github-token';
      if (name === 'config') return 'prompts/promptfooconfig.yaml';
      if (name === 'prompts') return 'prompts/*.txt';
      return '';
    });
    
    await run();
    
    expect(mockDotenvConfig).toHaveBeenCalledTimes(2);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Loading environment variables from'));
  });
});
