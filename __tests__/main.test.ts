import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import { load as loadYaml } from 'js-yaml';
import { Minimatch } from 'minimatch';
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
      Promise.resolve('M\0prompts/prompt1.txt\0M\0promptfooconfig.yaml\0'),
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
    realpathSync: vi.fn(),
    existsSync: vi.fn(),
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
  realpathSync: MockedFunction<typeof fs.realpathSync>;
  existsSync: MockedFunction<typeof fs.existsSync>;
  unlinkSync: MockedFunction<typeof fs.unlinkSync>;
};

// Import glob after mocking to get the mocked version
import * as glob from 'glob';

const mockGlob = glob as unknown as {
  sync: MockedFunction<typeof glob.sync>;
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
    'M\0prompts/prompt1.txt\0M\0promptfooconfig.yaml\0',
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
    String(filePath),
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

    test('should reject an in-checkout config symlink that resolves outside the workspace', async () => {
      withInputs({ config: 'shared-link/promptfooconfig.yaml' });
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return value.endsWith('/shared-link/promptfooconfig.yaml')
          ? '/outside/promptfooconfig.yaml'
          : value;
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Config file resolves outside the repository workspace.',
      );
      expect(mockConfig.extractFileDependencies).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should fail closed when an in-checkout config path cannot be resolved', async () => {
      mockFs.realpathSync.mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Config file resolves outside the repository workspace.',
      );
      expect(mockConfig.extractFileDependencies).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a changed PR prompt whose filename contains a newline', async () => {
      const filename = 'prompts/line\nbreak.txt';
      mockOctokit.paginate.mockResolvedValue([
        { filename, status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue([filename]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should reject a PR prompt filename that could forge a workflow annotation', async () => {
      const filename = 'prompts/policy\n::error::forged.txt';
      mockOctokit.paginate.mockResolvedValue([{ filename, status: 'added' }]);
      mockGlob.sync.mockReturnValue([filename]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        mockCore.info.mock.calls.every(
          ([message]) => !message.includes(filename),
        ),
      ).toBe(true);
    });

    test.each([
      [
        'removed',
        { filename: 'prompts/policy\n::error::forged.txt', status: 'removed' },
      ],
      [
        'renamed-out',
        {
          filename: 'archive/policy.txt',
          previous_filename: 'prompts/policy\r::error::forged.txt',
          status: 'renamed',
        },
      ],
    ])('should reject a CRLF %s prompt before full-scan fallback', async (_case, file) => {
      mockOctokit.paginate.mockResolvedValue([file]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should ignore a removed CRLF filename outside the configured prompt globs', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'docs/old\nnotes.md', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a CRLF rename-out when prompt-glob matching is capped', async () => {
      withInputs({ prompts: `prompts/${'a'.repeat(65536)}\nprompts/*.txt` });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'archive/policy.txt',
          previous_filename: 'prompts/policy\n::error::forged.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
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

    test('should process a removed prompt when the prompt-glob input uses CRLF lines', async () => {
      withInputs({ prompts: 'prompts/*.txt\r\nprompts/**/*.md\r\n' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockImplementation((pattern: string) =>
        pattern === 'prompts/*.txt' ? ['prompts/remaining.txt'] : [],
      );

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
      expect(mockGlob.sync).toHaveBeenCalledWith(
        'prompts/*.txt',
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

    test('should process all remaining prompts when a monitored prompt is deleted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should detect a removed prompt with a leading-dot glob', async () => {
      withInputs({ prompts: './prompts/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should detect a removed prompt in a repository sibling directory', async () => {
      withInputs({
        prompts: '../shared/*.txt',
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'packages/shared/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['../shared/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', '../shared/remaining.txt']),
      );
    });

    test('should detect a removed prompt with an absolute in-workspace glob', async () => {
      const promptPattern = path.join(process.cwd(), 'prompts/*.txt');
      const remainingPrompt = path.join(process.cwd(), 'prompts/remaining.txt');
      withInputs({ prompts: promptPattern });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([remainingPrompt]);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', remainingPrompt]),
      );
    });

    test('should detect a removed prompt with an absolute Windows-separator glob', async () => {
      const currentPlatform = process.platform;
      const promptPattern = path
        .join(process.cwd(), 'prompts/*.txt')
        .split(path.sep)
        .join('\\');
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'prompts/removed.txt', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockExec.exec.mock.calls[0][1]).toEqual(
          expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          promptPattern.split('\\').join('/'),
          { cwd: process.cwd(), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test('should detect a removed prompt with a mixed Windows-separator glob', async () => {
      const currentPlatform = process.platform;
      const promptPattern = `${path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('\\')}/[tr]/*.txt`;

      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'prompts/t/removed.txt', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/t/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          promptPattern.split('\\').join('/'),
          { cwd: process.cwd(), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test('should detect a removed prompt with a native wildcard separator after a Windows forward slash', async () => {
      const currentPlatform = process.platform;
      const promptRoot = path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('/');
      const promptPattern = `${promptRoot}\\*.txt`;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'prompts/removed.txt', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(`${promptRoot}/*.txt`, {
          cwd: process.cwd(),
          nodir: true,
        });
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test.each([
      '.prompts',
      '-prompts',
      ',prompts',
      '^prompts',
    ])('should detect a removed prompt under a native Windows punctuation directory %s', async (promptDirectory) => {
      const currentPlatform = process.platform;
      const nativeRoot = process.cwd().split(path.sep).join('\\');
      const promptPattern = `${nativeRoot}\\${promptDirectory}\\*.txt`;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          { filename: `${promptDirectory}/removed.txt`, status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue([`${promptDirectory}/remaining.txt`]);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          `${process.cwd()}/${promptDirectory}/*.txt`,
          { cwd: process.cwd(), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test.each([
      ['[tr]', 't'],
      ['*', 't'],
      ['{t,r}', 't'],
    ])('should detect a removed prompt with a native separator before Windows glob %s', async (globSegment, promptDirectory) => {
      const currentPlatform = process.platform;
      const promptRoot = path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('\\');
      const promptPattern = `${promptRoot}\\${globSegment}/*.txt`;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          {
            filename: `prompts/${promptDirectory}/removed.txt`,
            status: 'removed',
          },
        ]);
        mockGlob.sync.mockReturnValue([
          `prompts/${promptDirectory}/remaining.txt`,
        ]);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          `${promptRoot.split('\\').join('/')}/${globSegment}/*.txt`,
          { cwd: process.cwd(), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test('should preserve escaped magic in an absolute Windows glob', async () => {
      const currentPlatform = process.platform;
      const promptPattern = `${path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('/')}/\\[team\\]/*.txt`;

      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'prompts/[team]/removed.txt', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/[team]/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(promptPattern, {
          cwd: process.cwd(),
          nodir: true,
        });
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test.each([
      ['{red\\,blue,green}', 'red,blue'],
      ['[a\\-c]', '-'],
      ['[\\^a]', '^'],
      ['{v1\\..v3,stable}', 'v1..v3'],
    ])('should preserve escaped Windows glob punctuation %s', async (globSegment, promptDirectory) => {
      const currentPlatform = process.platform;
      const promptPattern = `${path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('/')}/${globSegment}/*.txt`;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          {
            filename: `prompts/${promptDirectory}/removed.txt`,
            status: 'removed',
          },
        ]);
        mockGlob.sync.mockReturnValue([
          `prompts/${promptDirectory}/remaining.txt`,
        ]);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(promptPattern, {
          cwd: process.cwd(),
          nodir: true,
        });
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test.each([
      ['[team\\]', '[team]', '\\[team\\]'],
      ['{red\\,blue,green}', 'red,blue', '{red\\,blue,green}'],
    ])('should preserve escaped punctuation in a native Windows glob %s', async (nativeSegment, promptDirectory, normalizedSegment) => {
      const currentPlatform = process.platform;
      const promptRoot = path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('\\');
      const promptPattern = `${promptRoot}\\${nativeSegment}\\*.txt`;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({ prompts: promptPattern });
        mockOctokit.paginate.mockResolvedValue([
          {
            filename: `prompts/${promptDirectory}/removed.txt`,
            status: 'removed',
          },
        ]);
        mockGlob.sync.mockReturnValue([
          `prompts/${promptDirectory}/remaining.txt`,
        ]);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          `${promptRoot.split('\\').join('/')}/${normalizedSegment}/*.txt`,
          { cwd: process.cwd(), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test('should detect a removed prompt under an escaped directory glob', async () => {
      withInputs({ prompts: 'prompts/\\[team\\]/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/[team]/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/[team]/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/[team]/remaining.txt']),
      );
    });

    test.each([
      'packages/[team]',
      'packages/{alpha,beta}',
      'packages/{1..3}',
      'packages/\\{alpha,beta}',
      'packages/\\\\{1..3}',
      'packages/app*(team)',
    ])('should treat glob characters in the working directory %s as literal', async (workingDirectory) => {
      withInputs({
        prompts: 'prompts/*.txt',
        'working-directory': workingDirectory,
      });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: `${workingDirectory}/prompts/removed.txt`,
          status: 'removed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test.each([
      [
        '../../packages/shared/prompts/*.txt',
        'packages/shared/prompts/removed.txt',
        '../../packages/shared/prompts/remaining.txt',
      ],
      [
        '../app/prompts/*.txt',
        'packages/app/prompts/removed.txt',
        '../app/prompts/remaining.txt',
      ],
      [
        '../../**/*.txt',
        'packages/shared/prompts/removed.txt',
        '../../packages/shared/prompts/remaining.txt',
      ],
      [
        'prompts/**/../*.txt',
        'packages/app/prompts/sub/removed.txt',
        'prompts/sub/remaining.txt',
      ],
      ['prompts/**/../*.txt', 'packages/app/removed.txt', 'remaining.txt'],
      ['prompts/**/./../*.txt', 'packages/app/removed.txt', 'remaining.txt'],
      ['prompts/**//../*.txt', 'packages/app/removed.txt', 'remaining.txt'],
      [
        'prompts/**/../../**/*.txt',
        'packages/shared/prompts/removed.txt',
        '../shared/prompts/remaining.txt',
      ],
      [
        'prompts/{**,sub}/../*.txt',
        'packages/app/removed.txt',
        'remaining.txt',
      ],
    ])('should preserve deletion matching for the working-directory-relative glob %s', async (promptPattern, removedPrompt, remainingPrompt) => {
      withInputs({
        prompts: promptPattern,
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: removedPrompt, status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([remainingPrompt]);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', remainingPrompt]),
      );
    });

    test('should detect a removed prompt below separated globstars', async () => {
      withInputs({ prompts: '**/sub/**/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/sub/deep/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/sub/deep/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/sub/deep/remaining.txt']),
      );
    });

    test('should ignore a removed hidden prompt outside a globstar match', async () => {
      withInputs({ prompts: 'prompts/**/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/.hidden/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should match a removed prompt when the regexp optimization is unavailable', async () => {
      const makeRe = vi
        .spyOn(Minimatch.prototype, 'makeRe')
        .mockReturnValue(false);
      withInputs({ prompts: 'prompts/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      try {
        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
      } finally {
        makeRe.mockRestore();
      }
    });

    test('should detect a removed prompt in an absolute brace alternative', async () => {
      const absolutePromptDirectory = path.join(process.cwd(), 'prompts');
      withInputs({
        prompts: `{${absolutePromptDirectory},archive}/*.txt`,
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should detect a removed prompt in a native Windows brace alternative', async () => {
      const currentPlatform = process.platform;
      const absolutePromptDirectory = path
        .join(process.cwd(), 'prompts')
        .split(path.sep)
        .join('\\');
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      try {
        withInputs({
          prompts: `{${absolutePromptDirectory},archive}/*.txt`,
          'working-directory': 'packages/app',
        });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'prompts/removed.txt', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockGlob.sync).toHaveBeenCalledWith(
          `{${absolutePromptDirectory.split('\\').join('/')},archive}/*.txt`,
          { cwd: path.join(process.cwd(), 'packages/app'), nodir: true },
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test.each([
      'prompts/**/./../*.txt',
      'prompts/**//../*.txt',
    ])('should preserve rename-out matching for the redundant-parent glob %s', async (prompts) => {
      withInputs({ prompts, 'working-directory': 'packages/app' });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'archive/renamed.md',
          previous_filename: 'packages/app/removed.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'remaining.txt']),
      );
    });

    test('should fail open when prompt traversal expansion is excessive', async () => {
      withInputs({
        prompts: `prompts${'/**/..'.repeat(10)}/**/*.txt`,
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'docs/unrelated.md', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should fail open before a single traversal group exceeds the variant cap', async () => {
      withInputs({
        prompts: `prompts/**${'/..'.repeat(1001)}/**/*.txt`,
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'docs/unrelated.md', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should fail open when brace expansion exceeds the variant cap', async () => {
      withInputs({ prompts: 'prompts/{1..1001}/**/*.txt' });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'docs/unrelated.md', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should fail open when a prompt glob exceeds the minimatch pattern limit', async () => {
      withInputs({
        prompts: `prompts/${'a'.repeat(65536)}\nprompts/*.txt`,
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockImplementation((pattern) => {
        if (typeof pattern === 'string' && pattern.length > 65536) {
          throw new TypeError('pattern is too long');
        }
        return ['prompts/remaining.txt'];
      });

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
      expect(mockGlob.sync).toHaveBeenCalledTimes(1);
      expect(mockGlob.sync).toHaveBeenCalledWith('prompts/*.txt', {
        cwd: process.cwd(),
        nodir: true,
      });
    });

    test('should explain capped prompt-glob matching when no prompt was removed', async () => {
      withInputs({
        prompts: `prompts/${'a'.repeat(65536)}\nprompts/*.txt`,
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/changed.txt', status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/changed.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/changed.txt']),
      );
    });

    test('should fail open when the working-directory prefix exceeds the minimatch pattern limit', async () => {
      withInputs({
        prompts: `${'a'.repeat(65520)}\nprompts/*.txt`,
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'packages/app/prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should compile capped brace patterns once when scanning many removed files', async () => {
      withInputs({ prompts: 'prompts/{1..1000}/**/*.txt' });
      mockOctokit.paginate.mockResolvedValue(
        Array.from({ length: 2999 }, (_, index) => ({
          filename: `docs/removed-${index}.md`,
          status: 'removed',
        })),
      );
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      'prompts/{1..1001}/**/*.txt',
      `prompts${'/**/..'.repeat(10)}/**/*.txt`,
    ])('should not let a capped prompt glob mask a rename-out for %s', async (prompts) => {
      withInputs({ prompts });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'archive/new.txt',
          previous_filename: 'prompts/old.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt glob matching exceeded its safety limits',
        ),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test.each([
      'darwin',
      'win32',
    ])('should detect a removed prompt with case differences on %s', async (platform) => {
      const currentPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true,
      });

      try {
        withInputs({ prompts: 'prompts/*.txt' });
        mockOctokit.paginate.mockResolvedValue([
          { filename: 'Prompts/OLD.TXT', status: 'removed' },
        ]);
        mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

        await run();

        expect(mockCore.warning).toHaveBeenCalledWith(
          expect.stringContaining('monitored prompt was removed or moved'),
        );
        expect(mockExec.exec.mock.calls[0][1]).toEqual(
          expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: currentPlatform,
          configurable: true,
        });
      }
    });

    test('should ignore a removed prompt path outside the workspace', async () => {
      withInputs({
        prompts: '../../../outside/*.txt',
        'working-directory': 'packages/app',
      });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: path.join(
            path.dirname(process.cwd()),
            'outside/secret.txt',
          ),
          status: 'removed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should process all remaining prompts when a prompt is renamed out of scope', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'archive/original.txt',
          previous_filename: 'prompts/original.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should select the new path when a prompt is renamed within scope', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'prompts/new.txt',
          previous_filename: 'prompts/old.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/new.txt']);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/new.txt']),
      );
    });

    test('should select the new path when a prompt is renamed into scope', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'prompts/new.txt',
          previous_filename: 'archive/old.txt',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/new.txt']);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should ignore a rename row without a previous filename', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'archive/new.txt', status: 'renamed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should ignore a deletion outside the configured working directory', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs = {
          ...DEFAULT_INPUTS,
          'working-directory': 'packages/app',
        };
        return inputs[name] || '';
      });
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: 'packages/other/prompts/removed.txt',
          status: 'removed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should still evaluate config prompts when no current prompt remains', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/removed.txt', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      const promptfooCall = mockExec.exec.mock.calls[0];
      const args = promptfooCall[1] as string[];
      expect(args).not.toContain('--prompts');
    });

    test('should skip an unrelated deleted file', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'docs/removed.md', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should preserve deleted config dependency detection', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
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
          '--name-status',
          '--find-renames',
          '-z',
          'a'.repeat(40),
          'b'.repeat(40),
          '--',
        ]);
      }
    });

    test('should process remaining prompts when a push deletes a monitored prompt', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce('D\0prompts/removed.txt\0');
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should process remaining prompts when a push renames a prompt out of scope', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(
        'R100\0prompts/old.txt\0archive/new.txt\0',
      );
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test.each([
      ['removed', 'D\0prompts/policy\n::error::forged.txt\0'],
      [
        'renamed-out',
        'R100\0prompts/policy\r::error::forged.txt\0archive/policy.txt\0',
      ],
    ])('should reject a CRLF %s push prompt before full-scan fallback', async (_case, diff) => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(diff);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Could not compare commits'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should select a copied prompt from a push comparison', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(
        'C100\0archive/template.txt\0prompts/copied.txt\0',
      );
      mockGlob.sync.mockReturnValue(['prompts/copied.txt']);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/copied.txt']),
      );
    });

    test('should reject a changed push prompt whose filename contains a tab and newline', async () => {
      const filename = 'prompts/tab\tline\nbreak.txt';
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(`M\0${filename}\0`);
      mockGlob.sync.mockReturnValue([filename]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining('found 1 changed file(s).'),
      );
      expect(
        mockCore.info.mock.calls.every(
          ([message]) => !message.includes(filename),
        ),
      ).toBe(true);
    });

    test.each([
      ['an empty status', '\0prompts/changed.txt\0'],
      ['an empty path', 'M\0\0'],
      ['an incomplete rename', 'R100\0prompts/old.txt\0'],
      ['an incomplete copy', 'C100\0archive/template.txt\0'],
      [
        'a truncated rename after a valid prefix',
        'M\0docs/readme.md\0R100\0prompts/old.txt\0',
      ],
      ['a dangling final status after a valid prefix', 'M\0docs/readme.md\0D'],
    ])('should process all prompts when a push diff contains %s', async (_case, diff) => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(diff);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
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
        '--name-status',
        '--find-renames',
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
        'Using manually specified files: prompts/file1.txt, prompts/file2.txt',
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should process remaining prompts when a manually specified prompt is missing', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: 'prompts/removed.txt' } },
        configurable: true,
      });
      mockFs.existsSync.mockReturnValue(false);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should trim a manually specified missing prompt', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: '  prompts/removed.txt  \r\n  ' } },
        configurable: true,
      });
      mockFs.existsSync.mockReturnValue(false);
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should select an existing manually specified prompt', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: 'prompts/changed.txt' } },
        configurable: true,
      });
      mockFs.existsSync.mockReturnValue(true);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/remaining.txt',
      ]);

      await run();

      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/changed.txt']),
      );
      expect(args).not.toContain('prompts/remaining.txt');
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should trim an existing manually specified prompt before filtering', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: '  prompts/changed.txt  \r\n  ' } },
        configurable: true,
      });
      mockFs.existsSync.mockReturnValue(true);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/remaining.txt',
      ]);

      await run();

      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/changed.txt']),
      );
      expect(args).not.toContain('prompts/remaining.txt');
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should preserve leading and trailing spaces in a manually specified dependency path', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: ' providers/spaced.py \r\n' } },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' providers/spaced.py ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should preserve leading and trailing spaces in the workflow-files action input', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: {} },
        configurable: true,
      });
      const rawFile = ' providers/spaced.py ';
      mockCore.getInput.mockImplementation((name, options) => {
        if (name === 'workflow-files') {
          return options?.trimWhitespace === false ? rawFile : rawFile.trim();
        }
        return DEFAULT_INPUTS[name] || '';
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([rawFile]);

      await run();

      expect(mockCore.getInput).toHaveBeenCalledWith('workflow-files', {
        required: false,
        trimWhitespace: false,
      });
      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
      expect(mockGitInterface.diff).not.toHaveBeenCalled();
    });

    test('should reject a NUL in a manually specified filename before logging or resolving it', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: 'prompts/changed.txt\0::error::forged' } },
        configurable: true,
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Manually specified filenames cannot contain NUL characters.',
      );
      expect(mockFs.existsSync).not.toHaveBeenCalledWith(
        expect.stringContaining('::error::forged'),
      );
      expect(
        mockCore.info.mock.calls.every(
          ([message]) => !message.includes('::error::forged'),
        ),
      ).toBe(true);
      expect(mockExec.exec).not.toHaveBeenCalled();
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

    test('should process remaining prompts when a manual comparison deletes a prompt', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { base: 'main' } },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce('D\0prompts/removed.txt\0');
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should process remaining prompts when a manual comparison renames a prompt out of scope', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { base: 'main' } },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(
        'R096\0prompts/old.txt\0archive/new.txt\0',
      );
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('monitored prompt was removed or moved'),
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/remaining.txt']),
      );
    });

    test('should reject a CRLF removed prompt from a manual comparison before full-scan fallback', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { base: 'main' } },
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(
        'D\0prompts/policy\n::error::forged.txt\0',
      );
      mockGlob.sync.mockReturnValue(['prompts/remaining.txt']);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockCore.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Could not compare against'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
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
          '--name-status',
          '--find-renames',
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

    test('should not narrow evaluation when a prompt and shared config dependency change together', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/changed.txt', status: 'modified' },
        { filename: 'data/context.json', status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/unchanged.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/changed.txt',
          'prompts/unchanged.txt',
        ]),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Evaluated prompt files: prompts/changed.txt, prompts/unchanged.txt',
          ),
        }),
      );
    });

    test('should preserve all input prompt matches when a prompt and config change together', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/changed.txt', status: 'modified' },
        { filename: 'promptfooconfig.yaml', status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/unchanged.txt',
      ]);

      await run();

      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          '--prompts',
          'prompts/changed.txt',
          'prompts/unchanged.txt',
        ]),
      );
    });

    test('should reject an unchanged CRLF prompt selected for a dependency-triggered full evaluation', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/changed.txt', status: 'modified' },
        { filename: 'data/context.json', status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/policy\n::error::forged.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Prompt filenames cannot contain carriage return or newline characters.',
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should accurately describe a dependency-triggered PR evaluation using config prompts', async () => {
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json', status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/unchanged.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockExec.exec.mock.calls[0][1]).not.toContain('--prompts');
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Evaluation used prompts defined in the Promptfoo config.',
          ),
        }),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining('prompts/unchanged.txt'),
        }),
      );
    });

    test('should not log an unsafe config-dependency filename while detecting its change', async () => {
      const dependency = 'data/policy\n::error::forged.json';
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'prompts/changed.txt', status: 'modified' },
        { filename: dependency, status: 'modified' },
      ]);
      mockGlob.sync.mockReturnValue(['prompts/changed.txt']);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);

      await run();

      expect(mockCore.debug).toHaveBeenCalledWith(
        'Found 1 file dependencies in config',
      );
      expect(
        mockCore.debug.mock.calls.every(
          ([message]) => !message.includes(dependency),
        ),
      ).toBe(true);
      expect(mockExec.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--prompts', 'prompts/changed.txt']),
      );
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

    test('should detect dependency directories without a trailing slash', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/context.json' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data']);
      mockFsUtils.isDirectory.mockReturnValue(true);

      await run();

      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should run when the last matching config-glob dependency is deleted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/removed.json', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['data']);
      mockFsUtils.isDirectory.mockReturnValue(false);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test.each([
      './',
      '/',
    ])('should run when a root dependency watcher %s observes a changed file', async (dependency) => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: 'data/removed.json', status: 'removed' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([dependency]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
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

    test('should omit action prompt globs from a dependency-triggered config-prompt summary', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'push',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        configurable: true,
      });
      mockCore.getBooleanInput.mockImplementation(
        (name: string) => name === 'use-config-prompts',
      );
      mockGitInterface.diff.mockResolvedValue('M\0data/context.json\0');
      mockGlob.sync.mockReturnValue([
        'prompts/changed.txt',
        'prompts/unchanged.txt',
      ]);
      mockConfig.extractFileDependencies.mockReturnValue(['data/context.json']);

      await run();

      expect(mockExec.exec.mock.calls[0][1]).not.toContain('--prompts');
      expect(mockCore.summary.addHeading).not.toHaveBeenCalledWith(
        'Evaluated Files',
        3,
      );
      expect(mockCore.summary.addList).not.toHaveBeenCalled();
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
        '--name-status',
        '--find-renames',
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
