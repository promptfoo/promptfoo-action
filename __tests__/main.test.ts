import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import { load as loadYaml } from 'js-yaml';
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
  paginate: Mock;
  rest: {
    issues: {
      createComment: Mock;
    };
    pulls: {
      listFiles: Mock;
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
      Promise.resolve('prompts/prompt1.txt\0promptfooconfig.yaml\0'),
    ),
  },
}));

// Mock simple-git before importing main.ts
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGitInterface),
}));

// Mock auth utilities
vi.mock('../src/utils/auth');
vi.mock('../src/utils/cache');
vi.mock('../src/utils/config');
vi.mock('../src/utils/fs');

import { handleError, run } from '../src/main';
import * as auth from '../src/utils/auth';
import * as cache from '../src/utils/cache';
import * as config from '../src/utils/config';
import * as fsUtils from '../src/utils/fs';

const mockAuth = auth as {
  validatePromptfooApiKey: MockedFunction<typeof auth.validatePromptfooApiKey>;
  getApiHost: MockedFunction<typeof auth.getApiHost>;
};
const mockCache = cache as {
  cleanupOldCache: MockedFunction<typeof cache.cleanupOldCache>;
  createCacheManifest: MockedFunction<typeof cache.createCacheManifest>;
  logCacheMetrics: MockedFunction<typeof cache.logCacheMetrics>;
  setupCacheEnvironment: MockedFunction<typeof cache.setupCacheEnvironment>;
};
const mockConfig = config as {
  extractFileDependencies: MockedFunction<
    typeof config.extractFileDependencies
  >;
};
const mockFsUtils = fsUtils as {
  isDirectory: MockedFunction<typeof fsUtils.isDirectory>;
};

// Note: @actions/core, @actions/github, and @actions/exec are already mocked via vitest.config.ts aliases
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    realpathSync: vi.fn(),
    unlinkSync: vi.fn(),
    promises: {
      access: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});
vi.mock('glob', () => ({
  sync: vi.fn(),
  hasMagic: vi.fn(),
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
  realpathSync: MockedFunction<typeof fs.realpathSync>;
  unlinkSync: MockedFunction<typeof fs.unlinkSync>;
};

// Import glob after mocking to get the mocked version
import * as glob from 'glob';

const mockGlob = glob as unknown as {
  sync: MockedFunction<typeof glob.sync>;
  hasMagic: MockedFunction<typeof glob.hasMagic>;
};

const DEFAULT_INPUTS: Record<string, string> = {
  'github-token': 'mock-github-token',
  config: 'promptfooconfig.yaml',
  prompts: 'prompts/*.txt',
  'working-directory': '',
  'cache-path': '',
  'promptfoo-version': 'latest',
  'env-files': '',
};

/**
 * Helper function to setup common mocks used across test suites.
 * Reduces duplication between 'GitHub Action Main' and 'API key environment variable fallback' describe blocks.
 */
function setupCommonMocks(): MockOctokit {
  // Reset all mocks
  vi.clearAllMocks();

  // Reset git interface mocks
  mockGitInterface.fetch.mockClear();
  mockGitInterface.revparse.mockClear();
  mockGitInterface.diff.mockClear();
  mockGitInterface.revparse.mockResolvedValue('mock-commit-hash\n');
  mockGitInterface.diff.mockResolvedValue(
    'prompts/prompt1.txt\0promptfooconfig.yaml\0',
  );
  mockCache.cleanupOldCache.mockResolvedValue(0);
  mockCache.createCacheManifest.mockResolvedValue();
  mockCache.logCacheMetrics.mockResolvedValue();
  mockConfig.extractFileDependencies.mockReturnValue([]);
  mockFsUtils.isDirectory.mockReturnValue(false);
  mockGlob.hasMagic.mockImplementation(
    (value: string, options?: { magicalBraces?: boolean }) =>
      value.includes('*') ||
      (options?.magicalBraces === true && value.includes('{')),
  );

  // Setup octokit mock
  const mockOctokit: MockOctokit = {
    paginate: vi.fn(() =>
      Promise.resolve([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'promptfooconfig.yaml' },
      ]),
    ),
    rest: {
      issues: {
        createComment: vi.fn(() => Promise.resolve({})),
      },
      pulls: {
        listFiles: vi.fn(),
      },
    },
  };
  mockGithub.getOctokit.mockReturnValue(
    mockOctokit as unknown as ReturnType<typeof github.getOctokit>,
  );

  // Setup default input mocks
  mockCore.getInput.mockImplementation(
    (name: string) => DEFAULT_INPUTS[name] || '',
  );

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
  mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
    filePath.toString(),
  );

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

      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.rest.pulls.listFiles,
        {
          owner: 'test-owner',
          repo: 'test-repo',
          pull_number: 123,
          per_page: 100,
        },
      );
      expect(mockGitInterface.fetch).not.toHaveBeenCalled();
      expect(mockGitInterface.diff).not.toHaveBeenCalled();

      // Verify promptfoo execution
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining([
          'promptfoo@latest',
          'eval',
          '-c',
          'promptfooconfig.yaml',
        ]),
        expect.any(Object),
      );

      // Verify PR comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('Evaluated prompt files'),
      });
    });

    test('should skip evaluation when no relevant files change', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'README.md' },
        { filename: 'package.json' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalledWith(
        'npx',
        expect.any(Array),
        expect.any(Object),
      );
    });

    test('should describe a directly modified prompt accurately in a PR comment', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
      ]);

      await run();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'LLM prompt was modified in these files: prompts/prompt1.txt',
          ),
        }),
      );
    });

    test('should process all matching prompts when PR file list hits GitHub cap', async () => {
      mockOctokit.paginate.mockResolvedValue(
        Array.from({ length: 3000 }, (_, index) => ({
          filename: `docs/file-${index}.md`,
        })),
      );
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('GitHub only returns the first 3000 files'),
      );
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
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
        'npx',
        expect.arrayContaining(['promptfoo@latest', 'eval']),
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
        'npx',
        expect.arrayContaining(['promptfoo@latest', 'eval']),
        expect.any(Object),
      );
    });

    test('should resolve prompt changes relative to working-directory', async () => {
      withInputs({
        'working-directory': 'evals',
        prompts: 'prompts/*.txt',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'evals/prompts/prompt1.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining([
          'promptfoo@latest',
          'eval',
          '--prompts',
          'prompts/prompt1.txt',
        ]),
        expect.objectContaining({
          cwd: path.join(process.cwd(), 'evals'),
        }),
      );
      expect(mockConfig.extractFileDependencies).toHaveBeenCalledWith(
        path.join(process.cwd(), 'evals', 'promptfooconfig.yaml'),
        path.join(process.cwd(), 'evals'),
      );
    });

    test('should preserve legacy resolution for absolute working-directory inputs', async () => {
      withInputs({
        'working-directory': '/evals',
        prompts: 'prompts/*.txt',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'evals/prompts/prompt1.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining([
          'promptfoo@latest',
          'eval',
          '--prompts',
          'prompts/prompt1.txt',
        ]),
        expect.objectContaining({
          cwd: path.join(process.cwd(), 'evals'),
        }),
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

    test('should pass every supported API key input to promptfoo', async () => {
      const keyInputs = {
        'openai-api-key': 'openai-input',
        'azure-api-key': 'azure-input',
        'anthropic-api-key': 'anthropic-input',
        'huggingface-api-key': 'huggingface-input',
        'aws-access-key-id': 'aws-id-input',
        'aws-secret-access-key': 'aws-secret-input',
        'replicate-api-key': 'replicate-input',
        'palm-api-key': 'palm-input',
        'vertex-api-key': 'vertex-input',
        'cohere-api-key': 'cohere-input',
        'mistral-api-key': 'mistral-input',
        'groq-api-key': 'groq-input',
      };
      withInputs(keyInputs);

      await run();

      const execOptions = mockExec.exec.mock.calls[0][2];
      expect(execOptions?.env).toEqual(
        expect.objectContaining({
          OPENAI_API_KEY: 'openai-input',
          AZURE_OPENAI_API_KEY: 'azure-input',
          ANTHROPIC_API_KEY: 'anthropic-input',
          HF_API_TOKEN: 'huggingface-input',
          AWS_ACCESS_KEY_ID: 'aws-id-input',
          AWS_SECRET_ACCESS_KEY: 'aws-secret-input',
          REPLICATE_API_KEY: 'replicate-input',
          PALM_API_KEY: 'palm-input',
          VERTEX_API_KEY: 'vertex-input',
          COHERE_API_KEY: 'cohere-input',
          MISTRAL_API_KEY: 'mistral-input',
          GROQ_API_KEY: 'groq-input',
        }),
      );
      for (const key of Object.values(keyInputs)) {
        expect(mockCore.setSecret).toHaveBeenCalledWith(key);
      }
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

    test('should fail when an environment file cannot be loaded', async () => {
      withInputs({ 'env-files': '.env' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockReturnValue({
        error: new Error('invalid env syntax'),
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should fail when an environment file does not exist', async () => {
      withInputs({ 'env-files': '.env.missing' });
      mockFs.existsSync.mockReturnValue(false);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Environment file'),
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should handle push events', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          before: 'a'.repeat(40),
          after: 'b'.repeat(40),
        },
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'sha', {
        value: 'b'.repeat(40),
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('Running in push mode');
      expect(mockGitInterface.diff).toHaveBeenCalled();
      const diffCalls = mockGitInterface.diff.mock.calls as unknown as Array<
        [string[]]
      >;
      if (diffCalls.length > 0) {
        expect(diffCalls[0][0]).toEqual([
          '--name-only',
          '--no-renames',
          '-z',
          'a'.repeat(40),
          'b'.repeat(40),
          '--',
        ]);
      }
    });

    test('should process all prompts when push diff fails', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          before: 'a'.repeat(40),
          after: 'b'.repeat(40),
        },
        configurable: true,
      });
      mockGitInterface.diff.mockRejectedValueOnce(new Error('shallow clone'));

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not compare commits'),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should process all prompts on an initial push', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          before: '0'.repeat(40),
          after: 'b'.repeat(40),
        },
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('Unable to determine changed files'),
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should use context SHA when a push payload omits after', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          before: 'a'.repeat(40),
        },
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'sha', {
        value: 'b'.repeat(40),
        configurable: true,
      });

      await run();

      expect(mockGitInterface.diff).toHaveBeenCalledWith([
        '--name-only',
        '--no-renames',
        '-z',
        'a'.repeat(40),
        'b'.repeat(40),
        '--',
      ]);
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
        'npx',
        expect.arrayContaining(['promptfoo@latest', 'eval']),
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
        'Using 2 manually specified file(s).',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test.each([
      'workflow payload',
      'action input',
    ])('should reject NUL-containing manual files from the %s', async (source) => {
      const hostileFile = 'data/context.json\0FORGED-NUL-MANUAL';
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: source === 'workflow payload' ? { files: hostileFile } : {},
        },
        configurable: true,
      });
      if (source === 'action input') {
        mockCore.getInput.mockImplementation((name: string) =>
          name === 'workflow-files' ? hostileFile : DEFAULT_INPUTS[name] || '',
        );
      }

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Changed file path contains an invalid NUL character.',
      );
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'FORGED-NUL-MANUAL',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should parse CRLF-separated prompt globs without stripping significant spaces', async () => {
      withInputs({
        prompts: 'prompts/ leading/*.txt\r\nprompts/trailing *.txt\r\n',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/ leading/one.txt' },
        { filename: 'prompts/trailing two.txt' },
      ]);
      mockGlob.sync.mockImplementation((pattern: string | string[]) => {
        if (pattern === 'prompts/ leading/*.txt') {
          return ['prompts/ leading/one.txt'];
        }
        if (pattern === 'prompts/trailing *.txt') {
          return ['prompts/trailing two.txt'];
        }
        return [];
      });

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/ leading/*.txt',
        expect.any(Object),
      );
      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/trailing *.txt',
        expect.any(Object),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve outer whitespace in the action prompts input', async () => {
      const rawPrompts = ' prompts/*.txt ';
      mockCore.getInput.mockImplementation(
        (name: string, options?: core.InputOptions) => {
          const value =
            name === 'prompts' ? rawPrompts : DEFAULT_INPUTS[name] || '';
          return options?.trimWhitespace === false ? value : value.trim();
        },
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: ' prompts/prompt.txt ' },
      ]);
      mockGlob.sync.mockImplementation((pattern: string | string[]) =>
        pattern === rawPrompts ? [' prompts/prompt.txt '] : [],
      );

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        rawPrompts,
        expect.any(Object),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should match whitespace-padded CRLF workflow_dispatch file inputs', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: '  data/context.json  \r\n\r\n',
          },
        },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should not expose forged workflow commands from manual file input logs', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'data/context.json\n::error::FORGED-MANUAL-ANNOTATION',
          },
        },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'FORGED-MANUAL-ANNOTATION',
      );
    });

    test('should preserve significant whitespace in manual workflow file paths', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: ' data/context.json ',
          },
        },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' data/context.json ',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve outer whitespace in the workflow-files action input', async () => {
      const rawFile = ' data/context.json ';
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: {} },
        configurable: true,
      });
      mockCore.getInput.mockImplementation(
        (name: string, options?: core.InputOptions) => {
          const value =
            name === 'workflow-files' ? rawFile : DEFAULT_INPUTS[name] || '';
          return options?.trimWhitespace === false ? value : value.trim();
        },
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([rawFile]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
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
        'npx',
        expect.arrayContaining(['promptfoo@latest', 'eval']),
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
        'Using 1 manually specified file(s).',
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
          '--no-renames',
          '-z',
          'feature-branch',
          'HEAD',
          '--',
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

    test('should run when a direct config dependency changes', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when a referenced config dependency is renamed away', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'archived/context.json',
          previous_filename: 'data/context.json',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test.each([
      'filename',
      'previous_filename',
    ])('should reject a NUL-containing GitHub API %s before change detection', async (field) => {
      const hostileFile = 'data/context.json\0FORGED-NUL-API';
      mockOctokit.paginate.mockResolvedValue([
        field === 'filename'
          ? { filename: hostileFile }
          : {
              filename: 'archived/context.json',
              previous_filename: hostileFile,
              status: 'renamed',
            },
      ]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Changed file path contains an invalid NUL character.',
      );
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'FORGED-NUL-API',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should preserve significant whitespace in GitHub API filenames', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: ' data/context.json ' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' data/context.json ',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve newline-containing GitHub API filenames', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/line\nbreak.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'data/line\nbreak.json',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should reject a newline-containing matched prompt path before command or comment sinks', async () => {
      const hostilePrompt = 'prompts/prompt.txt\n::error::forged-annotation';
      mockOctokit.paginate.mockResolvedValue([{ filename: hostilePrompt }]);
      mockGlob.sync.mockReturnValue([hostilePrompt]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt file paths containing CR or LF characters are not supported.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'forged-annotation',
      );
    });

    test('should reject a newline-containing full-evaluation prompt before command or comment sinks', async () => {
      const hostilePrompt = 'prompts/unchanged.txt\n::error::forged-annotation';
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt', hostilePrompt]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt file paths containing CR or LF characters are not supported.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'forged-annotation',
      );
    });

    test('should ignore an unused newline-containing glob match when prompts come from config', async () => {
      const hostilePrompt =
        'prompts/unchanged.txt\r\n::error::forged-config-annotation';
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt', hostilePrompt]);

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockExec.exec.mock.calls[0][1]).not.toContain(hostilePrompt);
      const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain(
        'Evaluation used prompts defined in the Promptfoo config.',
      );
      expect(body).not.toContain('forged-config-annotation');
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'forged-config-annotation',
      );
    });

    test('should not inspect an unused inaccessible glob match when prompts come from config', async () => {
      const unusedPrompt = 'prompts/inaccessible.txt';
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([unusedPrompt]);
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        if (filePath.toString().endsWith(`/${unusedPrompt}`)) {
          throw new Error('EACCES: SENSITIVE-UNUSED-PROMPT');
        }
        return filePath.toString();
      });

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockFs.realpathSync).not.toHaveBeenCalledWith(
        expect.stringContaining(unusedPrompt),
      );
      expect(mockCore.warning.mock.calls.join('\n')).not.toContain(
        'SENSITIVE-UNUSED-PROMPT',
      );
    });

    test('should skip an unchanged newline-containing prompt for an unrelated change', async () => {
      const hostilePrompt = 'prompts/unchanged.txt\n::error::forged-annotation';
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([hostilePrompt]);

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'forged-annotation',
      );
    });

    test('should match tab and space-containing push filenames from NUL-delimited git output', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValue(
        'docs/unrelated.md\0data/tab\tcontext.json\0data/ leading.json\0',
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'data/tab\tcontext.json',
        'data/ leading.json',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should not expose config dependency paths in debug logs', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/unrelated.py' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'prompts/SENSITIVE-REVIEW-TOKEN/system.txt',
      ]);

      await run();

      expect(mockCore.debug).toHaveBeenCalledWith(
        'Found 1 file dependencies in config',
      );
      expect(mockCore.debug.mock.calls.join('\n')).not.toContain(
        'SENSITIVE-REVIEW-TOKEN',
      );
    });

    test('should fail closed when dependency extraction fails', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/provider.py' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockImplementation(() => {
        throw new Error('Failed to extract dependencies from config: invalid');
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to extract dependencies from config'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should run when a file inside a dependency directory changes', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/nested/context.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test.each([
      'extensions/',
      'providers/',
      'tests/',
      'prompts/',
    ])('should run when the last file under a deleted %s glob base changes', async (dependencyDir) => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: `${dependencyDir}deleted-file.txt` },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependencyDir]);
      mockFsUtils.isDirectory.mockReturnValue(false);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve a changed directory dependency when an oversized glob cannot be inspected', async () => {
      const dependencyDir = `data/${'a'.repeat(70_000)}/`;
      mockOctokit.paginate.mockResolvedValue([
        { filename: `${dependencyDir}context.json` },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependencyDir]);
      mockGlob.hasMagic.mockImplementation((value: string) => {
        if (value.length > 65_536) throw new Error('pattern is too long');
        return value.includes('*');
      });

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve a changed directory dependency when glob inspection throws', async () => {
      const dependencyDir = 'data/';
      mockOctokit.paginate.mockResolvedValue([
        { filename: `${dependencyDir}context.json` },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependencyDir]);
      mockGlob.hasMagic.mockImplementation((value: string) => {
        if (value === dependencyDir) {
          throw new Error('EACCES: SENSITIVE-DEPENDENCY-PATTERN');
        }
        return value.includes('*');
      });

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockCore.warning.mock.calls.join('\n')).not.toContain(
        'SENSITIVE-DEPENDENCY-PATTERN',
      );
    });

    test('should fail closed before inspecting an unbounded dependency brace range', async () => {
      const dependency = 'providers/{1..1000000000}.py';
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/deleted.py' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);

      await run();

      expect(mockGlob.hasMagic).not.toHaveBeenCalledWith(
        dependency,
        expect.any(Object),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should fail closed before inspecting a backslash-separated dependency brace range', async () => {
      const dependency = String.raw`providers/\{1..1000000000}.py`;
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);

      await run();

      expect(mockGlob.hasMagic).not.toHaveBeenCalledWith(
        dependency,
        expect.any(Object),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when dependency extraction conservatively watches the repository root', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/dynamic-provider.py' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['.']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should not narrow prompts when a fail-closed dependency and a prompt both change', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'providers/dynamic-provider.py' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue(['./']);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
      );
    });

    test('should not narrow prompts when an ordinary dependency and a prompt both change', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'providers/custom.py' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/custom.py',
      ]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
      );
    });

    test('should not narrow prompts when the config and a prompt both change', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
      );
    });

    test('should cap prompt-glob brace expansion during enumeration', async () => {
      withInputs({ prompts: 'prompts/{first,second}.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/first.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/first.txt']);

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/{first,second}.txt',
        expect.objectContaining({
          cwd: process.cwd(),
          nodir: true,
          braceExpandMax: 1024,
        }),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should enumerate a backslash-separated action prompt glob on POSIX', async () => {
      if (process.platform === 'win32') return;
      withInputs({ prompts: String.raw`prompts\*.txt` });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/first.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/first.txt']);

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/*.txt',
        expect.objectContaining({ braceExpandMax: 1024 }),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test.each([
      [
        `prompts/${'x'.repeat(65_537)}.txt`,
        'Prompt glob pattern is invalid or too large',
      ],
      [
        'prompts/{first,second.txt',
        'Prompt glob pattern is invalid or too large',
      ],
      ['prompts/{1..0..0}.txt', 'Prompt glob pattern is invalid or too large'],
      ['prompts/{a..z..0}.txt', 'Prompt glob pattern is invalid or too large'],
      [
        'prompts/{000000000000000001..2}.txt',
        'Prompt glob pattern is invalid or too large',
      ],
      [
        `prompts/{${'0'.repeat(32_000)}1..1024}.txt`,
        'Prompt glob pattern is invalid or too large',
      ],
      [
        '{prompts),../outside}/*.txt',
        'Prompt glob pattern is invalid or too large',
      ],
      ['prompts/[first.txt', 'Prompt glob pattern is invalid or too large'],
      ['prompts/first\0.txt', 'Prompt glob pattern is invalid or too large'],
      [
        'prompts/{1..1025}.txt',
        'Prompt glob pattern has too many brace alternatives',
      ],
      [
        'prompts/{1..1000000000}.txt',
        'Prompt glob pattern has too many brace alternatives',
      ],
      [
        'prompts/[{1..5000000}].txt',
        'Prompt glob pattern has too many brace alternatives',
      ],
      [
        String.raw`prompts/\\{1..5000000}.txt`,
        'Prompt glob pattern has too many brace alternatives',
      ],
      [
        `prompts/{${Array.from({ length: 1025 }, (_, index) => index).join(',')}}.txt`,
        'Prompt glob pattern has too many brace alternatives',
      ],
      [
        '{prompts,../outside}/*.txt',
        'Prompt glob patterns must stay within the repository working directory',
      ],
      [
        'C:\\outside\\*.txt',
        'Prompt glob patterns must stay within the repository working directory',
      ],
    ])('should reject an unsafe prompt glob before enumeration', async (prompts, expectedError) => {
      withInputs({ prompts });

      await run();

      expect(
        mockCore.setFailed,
        `unexpected result for ${JSON.stringify(prompts.slice(0, 80))}`,
      ).toHaveBeenCalledWith(`Error: ${expectedError}`);
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      ['repository workspace', '', process.cwd()],
      ['working directory', 'evals', path.join(process.cwd(), 'evals')],
    ])('should fail safely when the %s cannot be resolved', async (_label, workingDirectory, inaccessiblePath) => {
      withInputs({ 'working-directory': workingDirectory });
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        if (filePath.toString() === inaccessiblePath) {
          throw new Error(`EACCES: sensitive filesystem detail ${filePath}`);
        }
        return filePath.toString();
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Could not resolve the repository workspace or working directory safely',
      );
      expect(mockCore.setFailed.mock.calls.join('\n')).not.toContain(
        'sensitive filesystem detail',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      ['lexical escape', '../outside-evals'],
      ['symlink escape', 'linked-evals'],
    ])('should reject a %s working directory before evaluation', async (_label, workingDirectory) => {
      withInputs({
        'working-directory': workingDirectory,
        prompts: 'prompts/*.txt',
      });
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const candidate = filePath.toString();
        return candidate === path.join(process.cwd(), 'linked-evals')
          ? '/tmp/outside/SENSITIVE-EVALS'
          : candidate;
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Working directory must stay within the repository workspace',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockCore.setFailed.mock.calls.join('\n')).not.toContain(
        'SENSITIVE-',
      );
    });

    test.each([
      'prompts/{1..100000..1000}.txt',
      'prompts/[{}]*.txt',
      'prompts/[{].txt',
      String.raw`prompts/\{1..1000000000\}.txt`,
    ])('should accept a bounded prompt glob before enumeration', async (prompts) => {
      withInputs({ prompts });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/first.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/first.txt']);

      await run();

      expect(mockGlob.sync).toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should ignore an escaping prompt glob match returned during enumeration', async () => {
      withInputs({ prompts: 'prompts/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([
        '../outside/leaked.txt',
        'prompts/safe.txt',
      ]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toContain('prompts/safe.txt');
      expect(args).not.toContain('../outside/leaked.txt');
      expect(mockCore.warning).toHaveBeenCalledWith(
        'Ignoring unsafe prompt file match: resolved path must stay within the working directory and repository workspace',
      );
    });

    test.each([
      ['', '../secrets/*.txt', '../secrets/token.txt'],
      ['evals', '../prompts/*.txt', '../prompts/outside-working.txt'],
    ])('should reject prompt globs outside the configured roots during a config-triggered evaluation', async (workingDirectory, promptGlob, _escapedPrompt) => {
      withInputs({
        prompts: promptGlob,
        'working-directory': workingDirectory,
      });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: workingDirectory
            ? `${workingDirectory}/promptfooconfig.yaml`
            : 'promptfooconfig.yaml',
        },
      ]);
      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt glob patterns must stay within the repository working directory',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should not pass an escaping prompt symlink during a dependency-triggered evaluation', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/custom.py' },
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/custom.py',
      ]);
      mockGlob.sync.mockReturnValue(['prompts/leaked.txt', 'prompts/safe.txt']);
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith('/prompts/leaked.txt')
          ? '/tmp/outside/token.txt'
          : filePath.toString(),
      );

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toContain('prompts/safe.txt');
      expect(args).not.toContain('prompts/leaked.txt');
    });

    test('should ignore an inaccessible prompt match during a dependency-triggered evaluation', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/custom.py' },
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/custom.py',
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/inaccessible.txt',
        'prompts/safe.txt',
      ]);
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        if (filePath.toString().endsWith('/prompts/inaccessible.txt')) {
          throw new Error('EACCES: sensitive filesystem detail');
        }
        return filePath.toString();
      });

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toContain('prompts/safe.txt');
      expect(args).not.toContain('prompts/inaccessible.txt');
      expect(mockCore.warning.mock.calls.join('\n')).not.toContain(
        'sensitive filesystem detail',
      );
    });

    test('should report all evaluated input prompts in a dependency-triggered PR comment', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'providers/custom.py' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/custom.py',
      ]);

      await run();

      const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain(
        'Evaluated prompt files: prompts/prompt1.txt, prompts/prompt2.txt',
      );
      expect(body).not.toContain('LLM prompt was modified');
    });

    test.each([
      [
        'a directly changed prompt',
        ['prompts/shared.txt'],
        [],
        ['prompts/shared.txt'],
        'LLM prompt was modified in these files',
      ],
      [
        'a config dependency',
        ['providers/custom.py'],
        ['providers/custom.py'],
        ['prompts/shared.txt', 'prompts/first.txt', 'prompts/second.txt'],
        'Evaluated prompt files',
      ],
    ])('should deduplicate overlapping prompt globs for %s', async (_trigger, changedFiles, dependencies, expectedPrompts, description) => {
      withInputs({
        prompts: `prompts/*.txt\n${path.join(process.cwd(), 'prompts/shared*.txt')}`,
      });
      mockOctokit.paginate.mockResolvedValue(
        changedFiles.map((filename) => ({ filename })),
      );
      mockConfig.extractFileDependencies.mockReturnValue(dependencies);
      mockGlob.sync.mockImplementation((pattern: string | string[]) =>
        pattern === 'prompts/*.txt'
          ? ['prompts/shared.txt', 'prompts/first.txt']
          : [
              path.join(process.cwd(), 'prompts/shared.txt'),
              path.join(process.cwd(), 'prompts/second.txt'),
            ],
      );

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args.filter((arg) => arg.endsWith('.txt'))).toEqual(
        expectedPrompts,
      );
      const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain(`${description}: ${expectedPrompts.join(', ')}`);
    });

    test('should not expose an absolute action prompt glob match in argv or PR comments', async () => {
      const absolutePrompt = path.join(
        process.cwd(),
        'prompts/absolute-prompt.txt',
      );
      withInputs({
        prompts: path.join(process.cwd(), 'prompts/*.txt'),
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/absolute-prompt.txt' },
      ]);
      mockGlob.sync.mockReturnValue([absolutePrompt]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toContain('prompts/absolute-prompt.txt');
      expect(args).not.toContain(absolutePrompt);
      const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain(
        'LLM prompt was modified in these files: prompts/absolute-prompt.txt',
      );
      expect(body).not.toContain(absolutePrompt);
    });

    test('should safely log normalized evaluated prompts for a manual full run', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: {} },
        configurable: true,
      });
      const absolutePrompt = path.join(
        process.cwd(),
        'prompts/manual-prompt.txt',
      );
      withInputs({
        prompts: `prompts/*.txt\n${path.join(process.cwd(), 'prompts/*.txt')}`,
      });
      mockGlob.sync.mockReturnValue([absolutePrompt]);
      mockGitInterface.diff.mockResolvedValue('');

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Processing all matching prompt files: ["prompts/manual-prompt.txt"]',
      );
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(absolutePrompt);
      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args.filter((arg) => arg.endsWith('manual-prompt.txt'))).toEqual([
        'prompts/manual-prompt.txt',
      ]);
    });

    test('should omit unused CRLF glob matches from manual config-prompt logs', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: {} },
        configurable: true,
      });
      withInputs({ prompts: 'prompts/*.txt' });
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockGlob.sync.mockReturnValue([
        'prompts/unchanged.txt\r\n::error::FORGED-MANUAL-ANNOTATION',
      ]);
      mockGitInterface.diff.mockResolvedValue('');

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        'Processing all matching prompt files: []',
      );
      expect(mockCore.info.mock.calls.join('\n')).not.toContain(
        'FORGED-MANUAL-ANNOTATION',
      );
      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args.join('\n')).not.toContain('FORGED-MANUAL-ANNOTATION');
    });

    test('should exclude the config file before recording prompt-glob matches', async () => {
      withInputs({ prompts: '**/*' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([
        'promptfooconfig.yaml',
        'prompts/shared.txt',
      ]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args.filter((arg) => arg.endsWith('.txt'))).toEqual([
        'prompts/shared.txt',
      ]);
      expect(args.filter((arg) => arg === 'promptfooconfig.yaml')).toHaveLength(
        1,
      );
    });

    test('should describe config-sourced prompts accurately in a PR comment', async () => {
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );

      await run();

      const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain(
        'Evaluation used prompts defined in the Promptfoo config.',
      );
      expect(body).not.toContain('LLM prompt was modified');
    });

    test('should report all evaluated input prompts in a dependency-triggered workflow summary', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValue(
        'prompts/prompt1.txt\0providers/custom.py\0',
      );
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/custom.py',
      ]);

      await run();

      expect(mockCore.summary.addList).toHaveBeenCalledWith([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
    });

    test('should run when a repository-root directory sentinel is returned', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/dynamic.txt' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['/']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when dependency extraction returns a dot-slash repository sentinel', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers/dynamic-provider.py' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['./']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test.each([
      ['deleted.txt', true],
      ['README.md', false],
    ])('should match a workspace-root dependency glob for %s', async (changedFile, shouldRun) => {
      mockOctokit.paginate.mockResolvedValue([{ filename: changedFile }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['*.txt']);

      await run();

      expect(mockExec.exec).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
    });

    test('should match a bracket-class dependency glob that glob.hasMagic misses', async () => {
      // glob.hasMagic reports no magic for a single-char bracket class, but
      // config.ts still emits file[1].txt as a glob (via hasGlobCharacterClass),
      // so main.ts must match it against the changed file file1.txt too.
      mockOctokit.paginate.mockResolvedValue([{ filename: 'file1.txt' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['file[1].txt']);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should compile a POSIX matcher once for repository dependency globs', async () => {
      const posixMatcher = vi.spyOn(path.posix, 'matchesGlob');
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'tests/fixtures/deleted.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['tests/**/*.yaml']);

      await run();

      expect(posixMatcher).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should match a bounded brace dependency against 2000 changed files without recompiling', async () => {
      const dependency = `providers/${Array.from({ length: 10 }, () => '{a,b}').join('/')}/*.txt`;
      mockOctokit.paginate.mockResolvedValue(
        Array.from({ length: 2000 }, (_, index) => ({
          filename: `docs/file-${index}.md`,
        })),
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);
      const posixMatcher = vi.spyOn(path.posix, 'matchesGlob');
      const started = performance.now();

      await run();

      expect(performance.now() - started).toBeLessThan(2000);
      expect(posixMatcher).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should fail closed for a dependency with more than 1024 brace alternatives', async () => {
      const dependency = `providers/${Array.from({ length: 11 }, () => '{a,b}').join('/')}/*.txt`;
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        'Config dependency glob has too many brace alternatives; conservatively running evaluation.',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should match a deleted dependency from a brace-only glob', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'deleted_first.txt' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'deleted_{first,second}.txt',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should detect a changed file inside a directory dependency even when the directory was deleted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data']);
      // The directory dependency was deleted in the PR, so isDirectory can no
      // longer confirm it; the changed child file must still trigger the eval.
      mockFsUtils.isDirectory.mockReturnValue(false);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should skip when config dependencies do not match changed files', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should force evaluation when no relevant files changed', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'force-run',
      );

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Force run enabled - running evaluation regardless of changes',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should clean old cache entries in CI', async () => {
      process.env.CI = 'true';
      process.env.PROMPTFOO_CACHE_PATH = '/tmp/promptfoo-cache';
      mockCache.cleanupOldCache.mockResolvedValue(2);

      await run();

      expect(mockCache.cleanupOldCache).toHaveBeenCalledWith(
        '/tmp/promptfoo-cache',
        7 * 24 * 60 * 60,
      );
      expect(mockCore.info).toHaveBeenCalledWith('Cleaned 2 old cache entries');

      delete process.env.CI;
      delete process.env.PROMPTFOO_CACHE_PATH;
    });

    test('should resolve a relative cache path from working-directory', async () => {
      process.env.CI = 'true';
      delete process.env.PROMPTFOO_CACHE_PATH;
      withInputs({
        'working-directory': 'evals',
        'cache-path': '.cache',
      });
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'force-run',
      );
      const expectedCachePath = path.join(process.cwd(), 'evals', '.cache');

      await run();

      expect(mockCache.setupCacheEnvironment).toHaveBeenCalledWith(
        expectedCachePath,
      );
      expect(mockCache.cleanupOldCache).toHaveBeenCalledWith(
        expectedCachePath,
        7 * 24 * 60 * 60,
      );
      expect(mockCache.logCacheMetrics).toHaveBeenCalledWith(expectedCachePath);

      delete process.env.CI;
    });

    test('should use the default cache path in CI', async () => {
      process.env.CI = 'true';
      delete process.env.PROMPTFOO_CACHE_PATH;
      const expectedCachePath = path.join(
        process.env.HOME || '/tmp',
        '.promptfoo',
        'cache',
      );

      await run();

      expect(mockCache.setupCacheEnvironment).toHaveBeenCalledWith(undefined);
      expect(mockCache.cleanupOldCache).toHaveBeenCalledWith(
        expectedCachePath,
        7 * 24 * 60 * 60,
      );
      expect(mockCache.logCacheMetrics).toHaveBeenCalledWith(expectedCachePath);

      delete process.env.CI;
    });

    test('should fall back to /tmp when HOME is unavailable', async () => {
      process.env.CI = 'true';
      delete process.env.PROMPTFOO_CACHE_PATH;
      const originalHome = process.env.HOME;
      delete process.env.HOME;

      await run();

      expect(mockCache.cleanupOldCache).toHaveBeenCalledWith(
        '/tmp/.promptfoo/cache',
        7 * 24 * 60 * 60,
      );
      expect(mockCache.logCacheMetrics).toHaveBeenCalledWith(
        '/tmp/.promptfoo/cache',
      );

      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      delete process.env.CI;
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

    test('should post PR comment even when promptfoo tests fail', async () => {
      // Simulate promptfoo returning exit code 100 (tests failed)
      // With ignoreReturnCode, exec returns the code instead of throwing
      mockExec.exec.mockResolvedValue(100);

      await run();

      // PR comment SHOULD be created even when tests fail
      // This is the intended behavior per issue #786 - we want to show test results
      // in PR comments regardless of pass/fail status
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('Evaluated prompt files'),
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
      expect(promptfooCall[0]).toBe('npx');

      const args = promptfooCall[1] as string[];
      expect(args).toContain('promptfoo@latest');
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

    test('should include max concurrency when configured', async () => {
      withInputs({ 'max-concurrency': '7' });

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(['--max-concurrency', '7']));
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
      expect(mockCore.setSecret).toHaveBeenCalledWith('test-api-key');

      // Only 1 exec call (eval) - promptfoo now reads PROMPTFOO_API_KEY env var directly
      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const evalCall = mockExec.exec.mock.calls[0];
      const evalArgs = evalCall[1] as string[];
      expect(evalArgs).toContain('--share');
    });

    test('should override config sharing when no-share is true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        if (name === 'no-share') return true;
        return false;
      });

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--share');
      expect(args).toContain('--no-share');
    });

    test('should skip sharing when no auth is present', async () => {
      delete process.env.PROMPTFOO_API_KEY;
      delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;

      await run();

      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--share');
      expect(args).toContain('--no-share');
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
      expect(args).toContain('--no-share');

      // Should NOT have these
      expect(args).not.toContain('--share');
      expect(args).not.toContain('--prompts'); // because use-config-prompts is true
    });

    test('should use console guidance in PR comments without a share URL', async () => {
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          results: {
            stats: { successes: 1, failures: 0 },
          },
        }),
      );

      await run();

      const commentBody =
        mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain('View eval results in CI console');
    });

    test('should write repeat results to a non-PR workflow summary', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'prompts/prompt1.txt',
          },
        },
        configurable: true,
      });
      withInputs({ repeat: '2', 'repeat-min-pass': '1' });
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          results: {
            results: [
              {
                testIdx: 0,
                promptIdx: 0,
                success: true,
                description: 'Test A',
              },
              {
                testIdx: 1,
                promptIdx: 0,
                success: false,
                description: 'Test A',
              },
            ],
            stats: { successes: 1, failures: 1 },
          },
        }),
      );

      await run();

      expect(mockCore.summary.addHeading).toHaveBeenCalledWith(
        'Repeat Check',
        3,
      );
      expect(mockCore.summary.addRaw).toHaveBeenCalledWith(
        expect.stringContaining('Repeat check'),
      );
      expect(mockCore.summary.addRaw).toHaveBeenCalledWith(
        'View eval results in CI console',
      );
      expect(mockCore.summary.write).toHaveBeenCalled();
    });

    test('should omit evaluated files when a non-PR run uses config prompts', async () => {
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
      withInputs({ prompts: '' });

      await run();

      expect(mockCore.summary.addHeading).not.toHaveBeenCalledWith(
        'Evaluated Files',
        3,
      );
      expect(mockCore.summary.write).toHaveBeenCalled();
    });

    test('should handle non-Error failures', async () => {
      mockExec.exec.mockRejectedValue('subprocess unavailable');

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: subprocess unavailable',
      );
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
    test('should use the GitHub API instead of PR refs for changed files', async () => {
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          pull_request: {
            number: 123,
            base: { ref: '--upload-pack=/evil/script' },
            head: { ref: 'feature branch' },
          },
        },
        configurable: true,
      });

      await run();

      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.rest.pulls.listFiles,
        expect.objectContaining({ pull_number: 123 }),
      );
      expect(mockGitInterface.fetch).not.toHaveBeenCalled();
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['promptfoo@latest', 'eval']),
        expect.any(Object),
      );
    });

    test('should reject unsafe workflow_dispatch base revisions', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            base: '--upload-pack=/evil/script',
          },
        },
        configurable: true,
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Invalid Git revision'),
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject malformed push commit SHAs', async () => {
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

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Invalid before commit'),
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject unsafe promptfoo versions', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          ...DEFAULT_INPUTS,
          'promptfoo-version': 'latest --package evil',
        };
        return inputs[name] || '';
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Invalid promptfoo-version'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should accept valid workflow_dispatch base revisions', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            base: 'feature/JIRA-123_update-deps',
          },
        },
        configurable: true,
      });

      await run();

      expect(mockGitInterface.diff).toHaveBeenCalledWith([
        '--name-only',
        '--no-renames',
        '-z',
        'feature/JIRA-123_update-deps',
        'HEAD',
        '--',
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
    const action = loadYaml(actionYml) as {
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

function withInputs(overrides: Record<string, string>) {
  const inputs = { ...DEFAULT_INPUTS, ...overrides };
  mockCore.getInput.mockImplementation((name: string) => inputs[name] || '');
}

describe('repeat feature', () => {
  beforeEach(() => {
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should not include --repeat flag when repeat is omitted', async () => {
    await run();

    const promptfooCall = mockExec.exec.mock.calls[0];
    const args = promptfooCall[1] as string[];
    expect(args).not.toContain('--repeat');
  });

  test('should include --repeat flag when repeat is set', async () => {
    withInputs({ repeat: '3' });

    await run();

    const promptfooCall = mockExec.exec.mock.calls[0];
    const args = promptfooCall[1] as string[];
    expect(args).toContain('--repeat');
    expect(args[args.indexOf('--repeat') + 1]).toBe('3');
  });

  test('should fail when repeat is 1', async () => {
    withInputs({ repeat: '1' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat must be at least 2'),
    );
  });

  test('should fail when repeat is 0', async () => {
    withInputs({ repeat: '0' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat must be a positive integer'),
    );
  });

  test('should fail when repeat is negative', async () => {
    withInputs({ repeat: '-1' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat must be a positive integer'),
    );
  });

  test('should fail when repeat is a float', async () => {
    withInputs({ repeat: '2.5' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat must be a positive integer'),
    );
  });

  test('should fail when repeat is non-numeric', async () => {
    withInputs({ repeat: '3abc' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat must be a positive integer'),
    );
  });
});

describe('repeat-min-pass feature', () => {
  beforeEach(() => {
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should pass when all tests meet the min pass count', async () => {
    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    // 2 tests, each run 3 times, each passing 2/3
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
            { testIdx: 3, promptIdx: 0, success: true, description: 'Test B' },
            { testIdx: 4, promptIdx: 0, success: false, description: 'Test B' },
            { testIdx: 5, promptIdx: 0, success: true, description: 'Test B' },
          ],
          stats: { successes: 4, failures: 2 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).not.toHaveBeenCalled();
  });

  test('should fail when a test does not meet the min pass count', async () => {
    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    // Test A passes 2/3 (ok), Test B passes 1/3 (fails)
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
            { testIdx: 3, promptIdx: 0, success: true, description: 'Test B' },
            { testIdx: 4, promptIdx: 0, success: false, description: 'Test B' },
            { testIdx: 5, promptIdx: 0, success: false, description: 'Test B' },
          ],
          stats: { successes: 3, failures: 3 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('1 test(s) failed the repeat check'),
    );
    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Test B: passed 1/3 runs'),
    );
  });

  test('should handle multiple prompts per test correctly', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });

    // Test with prompt 0: 1/2 pass (ok, >= 1)
    // Test with prompt 1: 0/2 pass (fails, < 1)
    // Uses vars to group since no description
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, vars: { q: 'hello' } },
            { testIdx: 1, promptIdx: 0, success: false, vars: { q: 'hello' } },
            { testIdx: 2, promptIdx: 1, success: false, vars: { q: 'hello' } },
            { testIdx: 3, promptIdx: 1, success: false, vars: { q: 'hello' } },
          ],
          stats: { successes: 1, failures: 3 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('1 test(s) failed the repeat check'),
    );
  });

  test('should not treat distinct tests with the same description as ambiguous', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });

    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            {
              testIdx: 0,
              promptIdx: 0,
              success: true,
              description: 'Shared label',
              vars: { q: 'hello' },
            },
            {
              testIdx: 1,
              promptIdx: 0,
              success: false,
              description: 'Shared label',
              vars: { q: 'hello' },
            },
            {
              testIdx: 2,
              promptIdx: 0,
              success: true,
              description: 'Shared label',
              vars: { q: 'goodbye' },
            },
            {
              testIdx: 3,
              promptIdx: 0,
              success: false,
              description: 'Shared label',
              vars: { q: 'goodbye' },
            },
          ],
          stats: { successes: 2, failures: 2 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).not.toHaveBeenCalled();
  });

  test('should fail when repeat-min-pass is set without repeat', async () => {
    withInputs({ 'repeat-min-pass': '2' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat-min-pass requires repeat to be set'),
    );
  });

  test('should fail when repeat-min-pass exceeds repeat', async () => {
    withInputs({ repeat: '3', 'repeat-min-pass': '4' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat-min-pass (4) cannot exceed repeat (3)'),
    );
  });

  test('should fail when repeat-min-pass is non-numeric', async () => {
    withInputs({ repeat: '3', 'repeat-min-pass': 'abc' });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('repeat-min-pass must be a positive integer'),
    );
  });

  test('should work independently from fail-on-threshold', async () => {
    withInputs({
      repeat: '3',
      'fail-on-threshold': '10',
      'repeat-min-pass': '2',
    });

    // Overall: 5/6 = 83% (passes fail-on-threshold of 10%)
    // Test A: 3/3 pass (ok)
    // Test B: 2/3 pass (ok, >= 2)
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 3, promptIdx: 0, success: true, description: 'Test B' },
            { testIdx: 4, promptIdx: 0, success: true, description: 'Test B' },
            { testIdx: 5, promptIdx: 0, success: false, description: 'Test B' },
          ],
          stats: { successes: 5, failures: 1 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).not.toHaveBeenCalled();
  });

  test('should count errors against fail-on-threshold', async () => {
    withInputs({
      repeat: '3',
      'fail-on-threshold': '90',
      'repeat-min-pass': '2',
    });
    mockExec.exec.mockResolvedValue(100);

    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
          ],
          stats: { successes: 2, failures: 0, errors: 1 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('below the required threshold (90%)'),
    );
  });

  test('should post PR comment with repeat summary before failing', async () => {
    const mockOctokit = setupCommonMocks();

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    // Test fails — all 3 repeats fail
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            {
              testIdx: 0,
              promptIdx: 0,
              success: false,
              description: 'Failing test',
            },
            {
              testIdx: 1,
              promptIdx: 0,
              success: false,
              description: 'Failing test',
            },
            {
              testIdx: 2,
              promptIdx: 0,
              success: false,
              description: 'Failing test',
            },
          ],
          stats: { successes: 0, failures: 3 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    // PR comment should still be posted with repeat summary
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    const commentBody =
      mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(commentBody).toContain('Repeat check');
    // And action should fail
    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('failed the repeat check'),
    );
  });

  test('should reject repeat output when results is not an array', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: 'invalid',
          stats: { successes: 1, failures: 0 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('expected output.results.results to be an array'),
    );
  });

  test('should reject non-object repeat results', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [null],
          stats: { successes: 0, failures: 1 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid result at index 0: expected object'),
    );
  });

  test('should reject repeat results without promptIdx', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [{ success: true }],
          stats: { successes: 1, failures: 0 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("missing or invalid 'promptIdx' field"),
    );
  });

  test('should reject repeat results without success', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [{ promptIdx: 0 }],
          stats: { successes: 0, failures: 1 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("missing or invalid 'success' field"),
    );
  });

  test('should reject empty repeat results', async () => {
    withInputs({ repeat: '2', 'repeat-min-pass': '1' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [],
          stats: { successes: 0, failures: 0 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('No test results found'),
    );
  });
});

describe('exec error handling with repeat-min-pass', () => {
  beforeEach(() => {
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should suppress test-failure exit when repeat-min-pass passes', async () => {
    // Promptfoo exits with code 100 when tests fail
    mockExec.exec.mockResolvedValue(100);

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    // All tests pass 2/3 — meets min pass
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
          ],
          stats: { successes: 2, failures: 1 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).not.toHaveBeenCalled();
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Promptfoo exited with test-failure code 100'),
    );
  });

  test('should NOT suppress hard failure (exit code 1) even when repeat-min-pass is configured', async () => {
    // Exit code 1 = config/runtime error, NOT a test failure
    mockExec.exec.mockResolvedValue(1);

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    await run();

    // Should fail immediately — exit code 1 is never suppressed
    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Promptfoo exited with unexpected code 1'),
    );
  });

  test('should suppress test-failure exit when fail-on-threshold passes', async () => {
    // Test-failure exit code 100 — fail-on-threshold permits partial failures
    mockExec.exec.mockResolvedValue(100);

    withInputs({ 'fail-on-threshold': '80' });

    // 9/10 passed = 90% > 80% threshold
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          stats: { successes: 9, failures: 1 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).not.toHaveBeenCalled();
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('suite threshold passed'),
    );
  });

  test('should preserve PROMPTFOO_PASS_RATE_THRESHOLD when repeat-min-pass passes', async () => {
    process.env.PROMPTFOO_PASS_RATE_THRESHOLD = '90';
    mockExec.exec.mockResolvedValue(100);

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
          ],
          stats: { successes: 2, failures: 1, errors: 0 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('PROMPTFOO_PASS_RATE_THRESHOLD'),
    );

    delete process.env.PROMPTFOO_PASS_RATE_THRESHOLD;
  });

  test('should preserve malformed PROMPTFOO_PASS_RATE_THRESHOLD as a 100% gate', async () => {
    process.env.PROMPTFOO_PASS_RATE_THRESHOLD = 'not-a-number';
    mockExec.exec.mockResolvedValue(100);

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
          ],
          stats: { successes: 2, failures: 1, errors: 0 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('PROMPTFOO_PASS_RATE_THRESHOLD (100%)'),
    );

    delete process.env.PROMPTFOO_PASS_RATE_THRESHOLD;
  });

  test('should fail on test-failure exit when no thresholds configured', async () => {
    mockExec.exec.mockResolvedValue(100);

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Promptfoo evaluation failed'),
    );
  });

  test('should fail immediately on hard failure (exit code 1)', async () => {
    mockExec.exec.mockResolvedValue(1);

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('unexpected code 1'),
    );
  });

  test('should report missing output after a test-failure exit', async () => {
    mockExec.exec.mockResolvedValue(100);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'Promptfoo tests failed (exit code 100) but no output was generated',
      ),
    );
  });

  test('should report invalid output after a successful exit', async () => {
    mockExec.exec.mockResolvedValue(0);
    mockFs.readFileSync.mockReturnValue('{not-json');

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read or parse output file'),
    );
  });

  test('should format non-Error output read failures', async () => {
    mockExec.exec.mockResolvedValue(0);
    mockFs.readFileSync.mockImplementation(() => {
      throw 'read failed';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read or parse output file: read failed',
      ),
    );
  });

  test('should fail thresholds when no tests were run', async () => {
    withInputs({ 'fail-on-threshold': '80' });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          stats: { successes: 0, failures: 0 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('No tests were run'),
    );
  });

  test('should log when PROMPTFOO_PASS_RATE_THRESHOLD passes', async () => {
    process.env.PROMPTFOO_PASS_RATE_THRESHOLD = '50';
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          stats: { successes: 3, failures: 1 },
        },
      }),
    );

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      'Promptfoo pass-rate threshold passed: 75.00% >= 50%',
    );

    delete process.env.PROMPTFOO_PASS_RATE_THRESHOLD;
  });

  test.each([
    '',
    'Infinity',
  ])('should normalize PROMPTFOO_PASS_RATE_THRESHOLD=%j to 100%%', async (threshold) => {
    process.env.PROMPTFOO_PASS_RATE_THRESHOLD = threshold;
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          stats: { successes: 3, failures: 1 },
        },
      }),
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('PROMPTFOO_PASS_RATE_THRESHOLD (100%)'),
    );

    delete process.env.PROMPTFOO_PASS_RATE_THRESHOLD;
  });

  test('should honor a valid custom failed-test exit code', async () => {
    process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE = '42';
    mockExec.exec.mockImplementation((_command, _args, options) => {
      expect(options?.env?.PROMPTFOO_FAILED_TEST_EXIT_CODE).toBe('42');
      return Promise.resolve(42);
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Promptfoo evaluation failed (exit code 42)'),
    );

    delete process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE;
  });

  test.each([
    '130',
    '300',
  ])('should normalize invalid failed-test exit code %s', async (exitCode) => {
    process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE = exitCode;
    mockExec.exec.mockImplementation((_command, _args, options) => {
      expect(options?.env?.PROMPTFOO_FAILED_TEST_EXIT_CODE).toBe('100');
      return Promise.resolve(100);
    });

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('reserved or invalid'),
    );

    delete process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE;
  });

  test('should normalize reserved PROMPTFOO_FAILED_TEST_EXIT_CODE before invoking promptfoo', async () => {
    process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE = '1';
    mockExec.exec.mockImplementation((_command, _args, options) => {
      expect(options?.env?.PROMPTFOO_FAILED_TEST_EXIT_CODE).toBe('100');
      return Promise.resolve(100);
    });

    withInputs({ repeat: '3', 'repeat-min-pass': '2' });

    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        results: {
          results: [
            { testIdx: 0, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 1, promptIdx: 0, success: true, description: 'Test A' },
            { testIdx: 2, promptIdx: 0, success: false, description: 'Test A' },
          ],
          stats: { successes: 2, failures: 1 },
        },
        shareableUrl: 'https://example.com/results',
      }),
    );

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('reserved or invalid'),
    );
    expect(mockCore.setFailed).not.toHaveBeenCalled();

    delete process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE;
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
    const action = loadYaml(actionYml) as {
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
