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
  mockGlob.hasMagic.mockImplementation((value: string) => value.includes('*'));

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

    test('should run when a referenced dependency is renamed away in a push', async () => {
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
      mockGitInterface.diff.mockImplementation(async (args: string[]) =>
        args.includes('--no-renames') && args.includes('-z')
          ? 'fixtures/referenced-upload.pdf\0fixtures/renamed-upload.pdf\0'
          : 'fixtures/renamed-upload.pdf',
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve tabs and spaces in renamed push dependency filenames', async () => {
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
      mockGitInterface.diff.mockResolvedValue(
        'fixtures/\treferenced-upload.pdf \0fixtures/\trenamed-upload.pdf \0',
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/\treferenced-upload.pdf ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        `Comparing ${'a'.repeat(40)}..${'b'.repeat(40)}, found changed files: "fixtures/\\treferenced-upload.pdf ", "fixtures/\\trenamed-upload.pdf "`,
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
        'Using manually specified files: "prompts/file1.txt", "prompts/file2.txt"',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should preserve whitespace in workflow dependency paths with CRLF separators', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'fixtures/ referenced-upload.pdf \r\n \r\n',
          },
        },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/ referenced-upload.pdf ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve whitespace in workflow prompt paths', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: {
            files: 'prompts/ example.txt \r\n',
          },
        },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue(['prompts/ example.txt ']);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toContain('prompts/ example.txt ');
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should preserve whitespace in CRLF-separated prompt input globs', async () => {
      withInputs({
        prompts: 'prompts/ first.txt \r\nprompts/second.txt\r\n',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/ first.txt ' },
      ]);
      mockGlob.sync.mockImplementation((globPattern: string) => {
        if (globPattern === 'prompts/ first.txt ') {
          return ['prompts/ first.txt '];
        }
        if (globPattern === 'prompts/second.txt') {
          return ['prompts/second.txt'];
        }
        return [];
      });

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/ first.txt ',
        expect.objectContaining({ nodir: true }),
      );
      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toContain('prompts/ first.txt ');
    });

    test('should disable action-input trimming for whitespace-bearing workflow and prompt paths', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: {} },
        configurable: true,
      });
      const inputs = {
        ...DEFAULT_INPUTS,
        prompts: 'prompts/ example.txt ',
        'workflow-files': 'prompts/ example.txt ',
      };
      mockCore.getInput.mockImplementation((name: string, options) => {
        const value = inputs[name] || '';
        return options?.trimWhitespace === false ? value : value.trim();
      });
      mockGlob.sync.mockImplementation((globPattern: string) =>
        globPattern === 'prompts/ example.txt '
          ? ['prompts/ example.txt ']
          : [],
      );

      await run();

      expect(mockCore.getInput).toHaveBeenCalledWith('prompts', {
        required: false,
        trimWhitespace: false,
      });
      expect(mockCore.getInput).toHaveBeenCalledWith('workflow-files', {
        required: false,
        trimWhitespace: false,
      });
      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toContain('prompts/ example.txt ');
    });

    test('should treat a whitespace-only workflow files input as empty', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: { files: ' \r\n  \r\n' },
        },
        configurable: true,
      });

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Using manually specified files: ',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
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
        'Using manually specified files: "action-input-file.txt"',
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

    test('should run when a referenced dependency is renamed away from a workflow base', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: {
          inputs: { base: 'feature-branch' },
        },
        configurable: true,
      });
      mockGitInterface.diff.mockImplementation(async (args: string[]) =>
        args.includes('--no-renames') && args.includes('-z')
          ? 'fixtures/referenced-upload.pdf\0fixtures/renamed-upload.pdf\0'
          : 'fixtures/renamed-upload.pdf',
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
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

    test('should evaluate all prompts when a prompt and shared dependency change together', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
        { filename: 'fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Evaluated prompt files: prompts/prompt1.txt, prompts/prompt2.txt',
          ),
        }),
      );
    });

    test('should preserve all action-input prompts when the config changes', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/prompt1.txt',
        'prompts/prompt2.txt',
      ]);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/prompt1.txt',
          'prompts/prompt2.txt',
        ]),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Evaluated prompt files: prompts/prompt1.txt, prompts/prompt2.txt',
          ),
        }),
      );
    });

    test('should deduplicate changed prompts matched by overlapping action globs', async () => {
      withInputs({
        prompts: 'prompts/*.txt\nprompts/prompt1.*',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(
        promptfooArgs.filter((arg) => arg === 'prompts/prompt1.txt'),
      ).toHaveLength(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Evaluated prompt files: prompts/prompt1.txt',
          ),
        }),
      );
      const commentBody =
        mockOctokit.rest.issues.createComment.mock.calls[0]?.[0].body;
      expect(commentBody).not.toContain(
        'prompts/prompt1.txt, prompts/prompt1.txt',
      );
    });

    test('should deduplicate all prompts matched by overlapping action globs on a config change', async () => {
      withInputs({
        prompts: 'prompts/*.txt\nprompts/prompt1.*',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'promptfooconfig.yaml' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(
        promptfooArgs.filter((arg) => arg === 'prompts/prompt1.txt'),
      ).toHaveLength(1);
      const commentBody =
        mockOctokit.rest.issues.createComment.mock.calls[0]?.[0].body;
      expect(commentBody).not.toContain(
        'prompts/prompt1.txt, prompts/prompt1.txt',
      );
    });

    test('should deduplicate the same prompt matched by relative and absolute action globs', async () => {
      const absolutePrompt = path.join(process.cwd(), 'prompts', 'prompt1.txt');
      withInputs({
        prompts: `prompts/*.txt\n${path.join(process.cwd(), 'prompts', 'prompt1.*')}`,
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
      ]);
      mockGlob.sync
        .mockReturnValueOnce(['prompts/prompt1.txt'])
        .mockReturnValueOnce([absolutePrompt]);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).toContain('prompts/prompt1.txt');
      expect(promptfooArgs).not.toContain(absolutePrompt);
      const commentBody =
        mockOctokit.rest.issues.createComment.mock.calls[0]?.[0].body;
      expect(commentBody).toContain(
        'Evaluated prompt files: prompts/prompt1.txt',
      );
      expect(commentBody).not.toContain(absolutePrompt);
    });

    test('should run when the last file from an extension-style dependency directory is deleted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'providers.v1/deleted.py', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockFsUtils.isDirectory.mockReturnValue(false);
      mockConfig.extractFileDependencies.mockReturnValue(['providers.v1/']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should treat an empty workspace-root dependency as a root sentinel', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockFsUtils.isDirectory.mockReturnValue(false);
      mockConfig.extractFileDependencies.mockReturnValue(['']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when a referenced dependency is renamed away in a pull request', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'fixtures/renamed-upload.pdf',
          previous_filename: 'fixtures/referenced-upload.pdf',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve spaces in renamed pull-request dependency filenames', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'fixtures/ renamed-upload.pdf ',
          previous_filename: 'fixtures/ referenced-upload.pdf ',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/ referenced-upload.pdf ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve newlines in renamed pull-request dependency filenames', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'fixtures/renamed\nupload.pdf',
          previous_filename: 'fixtures/referenced\nupload.pdf',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced\nupload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve a newline in a single pull-request dependency filename', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'fixtures/referenced\nupload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced\nupload.pdf',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should not log resolved config dependency paths', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/SECRET_DEPENDENCY_MARKER.py',
      ]);

      await run();

      expect(mockCore.debug).toHaveBeenCalledWith(
        'Found 1 file dependencies in config',
      );
      expect(
        mockCore.debug.mock.calls.some((call) =>
          String(call[0]).includes('SECRET_DEPENDENCY_MARKER'),
        ),
      ).toBe(false);
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

    test('should run when a workspace-root dependency sentinel is present', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'deleted_provider_one.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['./']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when a workspace-root dependency glob matches a change', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'deleted_provider_one.yaml' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'deleted_provider_*.yaml',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when a brace-only dependency glob matches a deleted file', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'evals/deleted_one.yaml' },
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'evals/deleted_{one,two}.yaml',
      ]);
      mockGlob.hasMagic.mockImplementation(
        (value: string, options?: { magicalBraces?: boolean }) =>
          value.includes('*') ||
          (options?.magicalBraces === true && value.includes('{')),
      );

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should match repository-style dependency globs with POSIX semantics', async () => {
      const posixMatchesGlob = vi.spyOn(path.posix, 'matchesGlob');
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'evals/providers/deleted.py' },
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'evals/providers/*.py',
      ]);
      mockGlob.hasMagic.mockImplementation((value: string) =>
        value.includes('*'),
      );

      await run();

      expect(posixMatchesGlob).toHaveBeenCalledWith(
        'evals/providers/deleted.py',
        'evals/providers/*.py',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should skip an unrelated change for a workspace-root dependency glob', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'docs/readme.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'deleted_provider_*.yaml',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should detect dependency directories without a trailing slash', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data']);
      mockFsUtils.isDirectory.mockReturnValue(true);

      await run();

      expect(mockFsUtils.isDirectory).toHaveBeenCalledWith('data');
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

    test('should conservatively run when dependency glob validation throws', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'providers/INVALID_GLOB_SECRET_MARKER*.py',
      ]);
      mockGlob.hasMagic.mockImplementation((value: string) => {
        if (value.includes('INVALID_GLOB_SECRET_MARKER')) {
          throw new TypeError('INVALID_GLOB_SECRET_MARKER: invalid pattern');
        }
        return false;
      });

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        'Failed to validate config dependency glob; conservatively running evaluation',
      );
      expect(mockExec.exec).toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('INVALID_GLOB_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should conservatively run before parsing an oversized numeric config dependency glob', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'prompts/{1..1000000000}.txt',
      ]);
      mockGlob.hasMagic.mockImplementation(() => {
        throw new Error('dependency glob parser should not run');
      });

      await run();

      expect(mockGlob.hasMagic).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should conservatively run before matching a multiplicative config dependency brace glob', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        `prompts/${'{one,two}'.repeat(11)}.txt`,
      ]);
      mockGlob.hasMagic.mockImplementation(() => {
        throw new Error('dependency glob parser should not run');
      });

      await run();

      expect(mockGlob.hasMagic).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
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

    test('should report config prompts accurately in a pull request comment', async () => {
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/watch.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/watch.txt']);

      await run();

      const promptfooArgs = mockExec.exec.mock.calls[0]?.[1] as string[];
      expect(promptfooArgs).not.toContain('--prompts');
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Prompts evaluated from config'),
        }),
      );
      const commentBody =
        mockOctokit.rest.issues.createComment.mock.calls[0]?.[0].body;
      expect(commentBody).not.toContain('prompts/watch.txt');
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
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockGlob.sync.mockReturnValue(['prompts/watch.txt']);

      await run();

      expect(mockCore.summary.addHeading).not.toHaveBeenCalledWith(
        'Evaluated Files',
        3,
      );
      expect(mockCore.summary.addList).not.toHaveBeenCalledWith([
        'prompts/watch.txt',
      ]);
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
    test('should reject action prompt globs with too many brace alternatives before enumeration', async () => {
      withInputs({ prompts: 'prompts/{1..1025}.txt' });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob expands to more than 1024 alternatives; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a huge numeric action prompt brace range before enumeration', async () => {
      withInputs({ prompts: 'prompts/{1..1000000000}.txt' });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob expands to more than 1024 alternatives; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a huge numeric action prompt brace range inside a character class before enumeration', async () => {
      withInputs({ prompts: 'prompts/[{1..1000000000}].txt' });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob expands to more than 1024 alternatives; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject an amplified zero-padded numeric action prompt brace range before enumeration', async () => {
      const paddedStart = `${'0'.repeat(1024)}1`;
      withInputs({ prompts: `prompts/{${paddedStart}..1024}.txt` });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob expands to more than 1024 alternatives; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a zero-step numeric action prompt brace range before enumeration', async () => {
      withInputs({ prompts: 'prompts/{1..8..0}.txt' });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob expands to more than 1024 alternatives; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      ['an overlong glob', `prompts/${'a'.repeat(4097)}.txt`],
      ['a null-byte glob', 'prompts/null\0byte.txt'],
    ])('should reject %s before action prompt enumeration', async (_name, globPattern) => {
      withInputs({ prompts: globPattern });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob is too long or contains a null byte; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject malformed action prompt glob delimiters without leaking the pattern', async () => {
      withInputs({
        prompts: 'prompts/{ACTION_GLOB_SECRET_MARKER.txt',
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Action prompt glob contains malformed delimiters; refusing to enumerate unsafe pattern',
      );
      expect(mockGlob.sync).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('ACTION_GLOB_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should cap action prompt glob enumeration while preserving valid braces and character classes', async () => {
      withInputs({ prompts: 'prompts/{one,two}/[!}]*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/one/prompt1.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/one/prompt1.txt']);

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/{one,two}/[!}]*.txt',
        expect.objectContaining({ nodir: true, braceExpandMax: 1024 }),
      );
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should preserve a safely stepped descending numeric action prompt brace range', async () => {
      withInputs({ prompts: 'prompts/{1000000000..1..-1000000}.txt' });
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/{1000000000..1..-1000000}.txt',
        expect.objectContaining({ braceExpandMax: 1024 }),
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should preserve escaped literal action prompt glob delimiters on POSIX', async () => {
      if (process.platform === 'win32') return;
      const patterns = [
        'prompts/\\{literal.txt',
        'prompts/literal\\}.txt',
        'prompts/\\[literal.txt',
        'prompts/\\(literal.txt',
        'prompts/\\{1..1000000000}.txt',
      ];
      withInputs({ prompts: patterns.join('\n') });
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockGlob.sync).toHaveBeenCalledTimes(patterns.length);
      for (const pattern of patterns) {
        expect(mockGlob.sync).toHaveBeenCalledWith(
          pattern,
          expect.objectContaining({ braceExpandMax: 1024 }),
        );
      }
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should reject an in-workspace config symlink that resolves outside the checkout before evaluation', async () => {
      withInputs({ config: 'evals/promptfooconfig.yaml' });
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const resolvedPath = filePath.toString();
        return resolvedPath.endsWith('evals/promptfooconfig.yaml')
          ? '/private/outside/CONFIG_ESCAPE_SECRET_MARKER.yaml'
          : resolvedPath;
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Config path resolves outside the repository workspace; refusing to evaluate unsafe config',
      );
      expect(mockConfig.extractFileDependencies).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('CONFIG_ESCAPE_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should allow an explicitly external config path', async () => {
      withInputs({ config: '/private/config/promptfooconfig.yaml' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/prompt1.txt' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should reject an in-workspace config when realpath validation is unavailable', async () => {
      withInputs({ config: 'evals/promptfooconfig.yaml' });
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const resolvedPath = filePath.toString();
        if (resolvedPath.endsWith('evals/promptfooconfig.yaml')) {
          throw Object.assign(new Error('CONFIG_REALPATH_SECRET_MARKER'), {
            code: 'EACCES',
          });
        }
        return resolvedPath;
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Config path resolves outside the repository workspace; refusing to evaluate unsafe config',
      );
      expect(mockConfig.extractFileDependencies).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('CONFIG_REALPATH_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should reject a matched prompt path that can forge a workflow annotation', async () => {
      const forgedPrompt =
        'prompts/unsafe\n::error::FORGED_ANNOTATION_SECRET_MARKER.txt';
      mockOctokit.paginate.mockResolvedValue([{ filename: forgedPrompt }]);
      mockGlob.sync.mockReturnValue([forgedPrompt]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Matched prompt file path contains a newline; refusing to evaluate unsafe path',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('FORGED_ANNOTATION_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should reject an unchanged matched prompt path with a newline during a full dependency evaluation', async () => {
      const forgedPrompt =
        'prompts/unsafe\r\n::error::UNCHANGED_PROMPT_SECRET_MARKER.txt';
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt', forgedPrompt]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Matched prompt file path contains a newline; refusing to evaluate unsafe path',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('UNCHANGED_PROMPT_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should ignore an unchanged newline prompt match when an unrelated change skips evaluation', async () => {
      const forgedPrompt =
        'prompts/unsafe\r\n::error::SKIPPED_PROMPT_SECRET_MARKER.txt';
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'unrelated/readme.md' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt', forgedPrompt]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('SKIPPED_PROMPT_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should reject an unchanged prompt glob match that escapes the workspace during a full dependency evaluation', async () => {
      withInputs({ prompts: '../secrets/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue([
        '../secrets/LEXICAL_PROMPT_ESCAPE_SECRET_MARKER.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Matched prompt file path resolves outside the repository workspace or working directory; refusing to evaluate unsafe path',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('LEXICAL_PROMPT_ESCAPE_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should reject an unchanged prompt symlink match that escapes the workspace during a full dependency evaluation', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/linked-prompt.txt']);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const resolvedPath = filePath.toString();
        return resolvedPath.endsWith('prompts/linked-prompt.txt')
          ? '/private/outside/SYMLINK_PROMPT_ESCAPE_SECRET_MARKER.txt'
          : resolvedPath;
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Matched prompt file path resolves outside the repository workspace or working directory; refusing to evaluate unsafe path',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('SYMLINK_PROMPT_ESCAPE_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should reject an unchanged prompt match outside the working directory during a full dependency evaluation', async () => {
      withInputs({
        'working-directory': 'evals',
        prompts: '../secrets/*.txt',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'evals/fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue([
        '../secrets/WORKDIR_PROMPT_ESCAPE_SECRET_MARKER.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'evals/fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Matched prompt file path resolves outside the repository workspace or working directory; refusing to evaluate unsafe path',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) =>
            String(call[0]).includes('WORKDIR_PROMPT_ESCAPE_SECRET_MARKER'),
          ),
      ).toBe(false);
    });

    test('should ignore unsafe unchanged action prompt matches when config prompts are evaluated', async () => {
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'fixtures/referenced-upload.pdf' },
      ]);
      mockGlob.sync.mockReturnValue([
        '../secrets/UNUSED_PROMPT_SECRET_MARKER.txt',
        'prompts/unused\r\n::error::UNUSED_ANNOTATION_SECRET_MARKER.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue([
        'fixtures/referenced-upload.pdf',
      ]);

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx',
        expect.not.arrayContaining(['--prompts']),
        expect.any(Object),
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(
        [mockCore.info, mockCore.warning, mockCore.debug, mockCore.setFailed]
          .flatMap((mock) => mock.mock.calls)
          .some((call) => String(call[0]).includes('SECRET_MARKER')),
      ).toBe(false);
    });

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
