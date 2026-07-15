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
    statSync: vi.fn(),
    existsSync: vi.fn(),
    realpathSync: vi.fn((filePath: fs.PathLike) => filePath.toString()),
    unlinkSync: vi.fn(),
    promises: {
      access: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});
vi.mock('glob', () => ({
  hasMagic: vi.fn(() => false),
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
  statSync: MockedFunction<typeof fs.statSync>;
  existsSync: MockedFunction<typeof fs.existsSync>;
  realpathSync: MockedFunction<typeof fs.realpathSync>;
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
    'prompts/prompt1.txt\npromptfooconfig.yaml',
  );
  mockCache.cleanupOldCache.mockResolvedValue(0);
  mockCache.createCacheManifest.mockResolvedValue();
  mockCache.logCacheMetrics.mockResolvedValue();
  mockConfig.extractFileDependencies.mockReturnValue([]);
  mockFsUtils.isDirectory.mockReturnValue(false);
  mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
    filePath.toString(),
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
  mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
    String(filePath).endsWith('promptfooconfig.yaml'),
  );
  mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
    String(filePath),
  );
  mockFs.statSync.mockReturnValue({
    isFile: () => true,
    size: 0,
  } as fs.Stats);

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
        body: expect.stringContaining('LLM prompt was modified'),
      });
    });

    test.each([
      '\n',
      '\r',
    ])('should reject a matched prompt path containing %j before any output sink', async (lineBreak) => {
      const unsafePrompt = `prompts/policy${lineBreak}::error::forged.txt`;
      mockOctokit.paginate.mockResolvedValue(
        lineBreak === '\r' ? [{ filename: unsafePrompt }] : [],
      );
      mockGlob.sync.mockReturnValue([unsafePrompt]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Error: Invalid prompt file path: line breaks are not allowed.\n\nHelp: Rename the prompt file so its path does not contain CR or LF characters.',
      );
      expect(mockCore.info).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
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

    test('should not load environment files when no relevant files change', async () => {
      withInputs({ 'env-files': '.env' });
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          Object.assign(options?.processEnv ?? process.env, {
            PROMPTFOO_REMOTE_API_BASE_URL: 'https://capture.example',
          });
          return { parsed: {} };
        },
      );

      await run();

      expect(dotenv.config).not.toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockAuth.validatePromptfooApiKey).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should mask trusted provider keys before skipping unrelated changes', async () => {
      withInputs({ 'openai-api-key': 'trusted-openai-input' });
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);
      const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'trusted-anthropic-env';

      try {
        await run();

        expect(mockCore.setSecret).toHaveBeenCalledWith('trusted-openai-input');
        expect(mockCore.setSecret).toHaveBeenCalledWith(
          'trusted-anthropic-env',
        );
        expect(mockCore.info).toHaveBeenCalledWith(
          'No LLM prompt, config files, or dependencies were modified.',
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
      } finally {
        if (originalAnthropicKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
        }
      }
    });

    test('should skip unrelated changes before validating an implicit .env', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${path.sep}.env`),
      );

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { OPENAI_BASE_URL: 'http://attacker.invalid/v1' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'No LLM prompt, config files, or dependencies were modified.',
      );
      expect(dotenv.config).not.toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should isolate npx from a repository-controlled project .npmrc', async () => {
      await run();

      expect(mockExec.exec).toHaveBeenCalledTimes(1);
      const args = mockExec.exec.mock.calls[0][1] as string[];
      expect(args.slice(0, 2)).toEqual([
        '--prefix',
        path.resolve(__dirname, '..'),
      ]);
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
        process.cwd(),
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

    test.each([
      'NODE_OPTIONS',
      'nOdE_oPtIoNs',
      'PATH',
      'Node_Path',
      'NPM_CONFIG_USERCONFIG',
      'npm_config_script_shell',
      'DOTENV_KEY',
      'dotenv_config_path',
      'DOTENV_CONFIG_OVERRIDE',
      'GITHUB_STEP_SUMMARY',
      'GITHUB_OUTPUT',
      'GITHUB_ENV',
      'GITHUB_PATH',
      'GITHUB_STATE',
      'LD_PRELOAD',
      'LD_AUDIT',
      'ld_debug_output',
      'DYLD_INSERT_LIBRARIES',
      'dyld_image_suffix',
      'HTTPS_PROXY',
      'HOME',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
      'APPDATA',
      'LOCALAPPDATA',
      'GIT_SSH_COMMAND',
      'git_external_diff',
      'GIT_CONFIG_COUNT',
      'RUBYOPT',
      'PYTHONHOME',
      'PYTHON',
      'PYTHONPATH',
      'PYTHONWARNINGS',
      '_PYTHON_SYSCONFIGDATA_NAME',
      'pythonuserbase',
      'PERL5LIB',
      'RUBYLIB',
      'RUBYGEMS_GEMDEPS',
      'bundle_gemfile',
      'BUNDLE_APP_CONFIG',
      'BUNDLE_PATH',
      'GEM_HOME',
      'GEM_PATH',
      'GEM_SPEC_CACHE',
      'PROMPTFOO_PYTHON',
      'NODE_GYP_FORCE_PYTHON',
      'MAKE',
      'MAKEFLAGS',
      'MAKEFILES',
      'CFLAGS',
      'CXXFLAGS',
      'CPPFLAGS',
      'LDFLAGS',
      'CFLAGS_host',
      'CXXFLAGS_host',
      'CPPFLAGS_host',
      'LDFLAGS_host',
      'GYP_DEFINES',
      'CC_TARGET',
      'CXX_TARGET',
      'AR_TARGET',
      'LINK_TARGET',
      'CC_HOST',
      'CXX_HOST',
      'AR_HOST',
      'LINK_HOST',
      'GYP_CONFIG_DIR',
      'GYP_GENERATORS',
      'GYP_GENERATOR_OUTPUT',
      'GYP_MSVS_OVERRIDE_PATH',
      'NODEJS_ORG_MIRROR',
      'PROMPTFOO_RUBY',
      'playwright_browsers_path',
      'PLAYWRIGHT_DOWNLOAD_HOST',
      'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST',
      'PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST',
      'PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST',
      'PUPPETEER_EXECUTABLE_PATH',
      'PUPPETEER_CACHE_DIR',
      'PUPPETEER_DOWNLOAD_HOST',
      'PUPPETEER_DOWNLOAD_BASE_URL',
      'PUPPETEER_CHROME_DOWNLOAD_BASE_URL',
      'OPENSSL_CONF',
      'OPENSSL_CONF_INCLUDE',
      'oPeNsSl_MoDuLeS',
      'OPENSSL_ENGINES',
      'OPENSSL_TRACE',
      'OPENSSL_MALLOC_FAILURES',
      'OPENSSL_FUTURE_CONTROL',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_DEBUG',
      'node_debug_native',
      'GOFLAGS',
      'goenv',
      'GOAUTH',
      'GOBIN',
      'GOTOOLCHAIN',
      'GOPROXY',
      'GOSUMDB',
      'GOINSECURE',
      'GONOSUMDB',
      'GONOPROXY',
      'GOPRIVATE',
      'GOMODCACHE',
      'GOCACHE',
      'GOCACHEPROG',
      'GOCOVERDIR',
      'GODEBUG',
      'GOPATH',
      'GOROOT',
      'GOTELEMETRYDIR',
      'GOTMPDIR',
      'GOTOOLDIR',
      'GOVCS',
      'GOWORK',
      'CC',
      'AR',
      'CXX',
      'FC',
      'GCCGO',
      'GCCGOTOOLDIR',
      'GCC_EXEC_PREFIX',
      'COMPILER_PATH',
      'LIBRARY_PATH',
      'CPATH',
      'C_INCLUDE_PATH',
      'CPLUS_INCLUDE_PATH',
      'OBJC_INCLUDE_PATH',
      'CGO_CFLAGS',
      'CGO_CPPFLAGS',
      'CGO_CXXFLAGS',
      'CGO_LDFLAGS',
      'cgo_fflags',
      'CGO_CFLAGS_ALLOW',
      'CGO_LDFLAGS_DISALLOW',
      'CGO_ENABLED',
      'PKG_CONFIG',
      'PKG_CONFIG_PATH',
      'PKG_CONFIG_LIBDIR',
      'PKG_CONFIG_SYSROOT_DIR',
      'AWS_CA_BUNDLE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'CURL_CA_BUNDLE',
      'requests_ca_bundle',
      'OPENAI_BASE_URL',
      'openai_api_base_url',
      'OPENAI_API_HOST',
      'OPENAI_ORGANIZATION',
      'OPENAI_ORG_ID',
      'OPENAI_PROJECT_ID',
      'OPENAI_CUSTOM_HEADERS',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CONFIG_DIR',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_IDENTITY_TOKEN',
      'ANTHROPIC_IDENTITY_TOKEN_FILE',
      'ANTHROPIC_ORGANIZATION_ID',
      'ANTHROPIC_PROFILE',
      'ANTHROPIC_SERVICE_ACCOUNT_ID',
      'ANTHROPIC_WORKSPACE_ID',
      'ANTHROPIC_SCOPE',
      'ANTHROPIC_ENVIRONMENT_ID',
      'ANTHROPIC_ENVIRONMENT_KEY',
      'aPi_HoSt',
      'AWS_ENDPOINT_URL',
      'AWS_BEDROCK_BASE_URL',
      'AWS_PROFILE',
      'AWS_BEDROCK_REGION',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'aws_default_profile',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AWS_ROLE_SESSION_NAME',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
      'AWS_LOGIN_CACHE_DIRECTORY',
      'aws_config_file',
      'AWS_SHARED_CREDENTIALS_FILE',
      'aws_endpoint_url_bedrock_runtime',
      'AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME',
      'AZURE_OPENAI_API_HOST',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_POD_IDENTITY_AUTHORITY_HOST',
      'AZURE_STORAGE_CONNECTION_STRING',
      'AZURE_TOKEN_CREDENTIALS',
      'AZURE_ADDITIONALLY_ALLOWED_TENANTS',
      'AZURE_TENANT_ID',
      'AZURE_TOKEN_SCOPE',
      'AZURE_REGIONAL_AUTHORITY_NAME',
      'IDENTITY_ENDPOINT',
      'IDENTITY_HEADER',
      'IDENTITY_SERVER_THUMBPRINT',
      'IMDS_ENDPOINT',
      'MSI_ENDPOINT',
      'MSI_SECRET',
      'AZURE_FEDERATED_TOKEN_FILE',
      'AZURE_CLIENT_CERTIFICATE_PATH',
      'AZURE_CLIENT_ID',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GENAI_ENDPOINT',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_QUOTA_PROJECT',
      'GOOGLE_PROJECT_ID',
      'GOOGLE_API_CERTIFICATE_CONFIG',
      'google_external_account_allow_executables',
      'GOOGLE_GHA_CREDS_PATH',
      'GOOGLE_LOCATION',
      'GOOGLE_CLOUD_LOCATION',
      'GCE_METADATA_HOST',
      'gce_metadata_ip',
      'GCLOUD_PROJECT',
      'METADATA_SERVER_DETECTION',
      'VERTEX_REGION',
      'VERTEX_PROJECT_ID',
      'WATSONX_AI_PROJECT_ID',
      'WATSONX_AI_AUTH_TYPE',
      'WATSONX_AI_BEARER_TOKEN',
      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
      'cloudsdk_config',
      'CLOUDSDK_PYTHON',
      'AZURE_AI_PROJECT_URL',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CLOUDFLARE_GATEWAY_ID',
      'SNOWFLAKE_ACCOUNT_IDENTIFIER',
      'DATABRICKS_WORKSPACE_URL',
      'CLAWDBOT_GATEWAY_URL',
      'OPENCLAW_CONFIG_PATH',
      'OPENCLAW_GATEWAY_PORT',
      'opencode_config',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_CONFIG_DIR',
      'OPENCODE_GIT_BASH_PATH',
      'PROMPTFOO_CLOUD_API_URL',
      'promptfoo_remote_api_base_url',
      'PROMPTFOO_REMOTE_GENERATION_URL',
      'PROMPTFOO_UNALIGNED_INFERENCE_ENDPOINT',
      'PROMPTFOO_OTEL_ENDPOINT',
      'otel_exporter_otlp_endpoint',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      'PROMPTFOO_REMOTE_APP_BASE_URL',
      'PROMPTFOO_SHARING_APP_BASE_URL',
      'PROMPTFOO_CACHE_PATH',
      'PROMPTFOO_CACHE_MAX_FILE_COUNT',
      'PROMPTFOO_CACHE_MAX_SIZE',
      'PROMPTFOO_CONFIG_DIR',
      'PROMPTFOO_PASS_RATE_THRESHOLD',
      'PROMPTFOO_API_KEY',
      'PROMPTFOO_CACHE_TTL',
      'PROMPTFOO_AUTHOR',
      'CI',
      'PROMPTFOO_DISABLE_SHARING',
      'PROMPTFOO_DISABLE_TELEMETRY',
      'PROMPTFOO_DISABLE_REMOTE_GENERATION',
      'PROMPTFOO_DISABLE_REDTEAM_MODERATION',
      'PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION',
      'PROMPTFOO_DISABLE_ERROR_LOG',
      'PROMPTFOO_DISABLE_DEBUG_LOG',
      'PROMPTFOO_STRIP_GRADING_RESULT',
      'PROMPTFOO_STRIP_RESPONSE_OUTPUT',
      'PROMPTFOO_STRIP_PROMPT_TEXT',
      'PROMPTFOO_STRIP_TEST_VARS',
      'PROMPTFOO_STRIP_METADATA',
      'PROMPTFOO_DISABLE_VAR_EXPANSION',
      'PROMPTFOO_DISABLE_REF_PARSER',
      'PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS',
      'PROMPTFOO_DISABLE_CONVERSATION_VAR',
      'PROMPTFOO_DISABLE_OBJECT_STRINGIFY',
      'PROMPTFOO_SELF_HOSTED',
      'PROMPTFOO_DISABLE_TEMPLATING',
      'PROMPTFOO_STRICT_FILES',
      'CDP_DOMAIN',
      'PROMPTFOO_FAILED_TEST_EXIT_CODE',
      'PROMPTFOO_LOG_DIR',
      'PROMPTFOO_MEDIA_PATH',
      'SHAREPOINT_BASE_URL',
      'SHAREPOINT_CERT_PATH',
      'SHAREPOINT_CLIENT_ID',
      'SHAREPOINT_TENANT_ID',
    ])('should reject process startup variable %s from environment files', async (variableName) => {
      withInputs({ 'env-files': '.env' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      const originalValue = process.env[variableName];
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { [variableName]: 'attacker-controlled' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining(variableName),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env[variableName]).toBe(originalValue);
      } finally {
        if (originalValue === undefined) {
          delete process.env[variableName];
        } else {
          process.env[variableName] = originalValue;
        }
      }
    });

    test('should preserve later-file-wins behavior for application variables', async () => {
      withInputs({ 'env-files': '.env,.env.local' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.local')
            ? { CUSTOM_PROVIDER_SETTING: 'second', NODE_ENV: 'test' }
            : { CUSTOM_PROVIDER_SETTING: 'first' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        const execOptions = mockExec.exec.mock.calls[0][2];
        expect(execOptions?.env).toEqual(
          expect.objectContaining({
            CUSTOM_PROVIDER_SETTING: 'second',
            NODE_ENV: 'test',
          }),
        );
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        delete process.env.NODE_ENV;
      }
    });

    test.each([
      'OPENAI_BASE_URL',
      'OPENSSL_CONF',
      'oPeNsSl_MoDuLeS',
    ])('should reject %s from the implicit working-directory .env file', async (variableName) => {
      withInputs({ 'env-files': '' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${path.sep}.env`),
      );

      const dotenv = await import('dotenv');
      const originalValue = process.env[variableName];
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = {
            [variableName]: 'attacker-controlled',
            CUSTOM_PROVIDER_SETTING: 'must-not-merge',
          };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining(variableName),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env[variableName]).toBe(originalValue);
        expect(process.env.CUSTOM_PROVIDER_SETTING).toBeUndefined();
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        if (originalValue === undefined) {
          delete process.env[variableName];
        } else {
          process.env[variableName] = originalValue;
        }
      }
    });

    test('should load the implicit .env before selected environment files', async () => {
      withInputs({ 'env-files': '.env.local' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value.endsWith(`${path.sep}.env`) ||
          value.endsWith('.env.local') ||
          value.endsWith('promptfooconfig.yaml')
        );
      });

      const dotenv = await import('dotenv');
      const loadedPaths: string[] = [];
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          loadedPaths.push(options?.path ?? '');
          const parsed = options?.path?.endsWith('.env.local')
            ? { CUSTOM_PROVIDER_SETTING: 'selected' }
            : { CUSTOM_PROVIDER_SETTING: 'implicit' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(loadedPaths).toHaveLength(2);
        expect(loadedPaths[0]).toMatch(/(?:^|[/\\])\.env$/);
        expect(loadedPaths[1]).toMatch(/(?:^|[/\\])\.env\.local$/);
        const execOptions = mockExec.exec.mock.calls[0][2];
        expect(execOptions?.env).toEqual(
          expect.objectContaining({ CUSTOM_PROVIDER_SETTING: 'selected' }),
        );
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
      }
    });

    test.each([
      { implicitFile: '.env', dotenvKey: undefined },
      { implicitFile: '.env.vault', dotenvKey: 'trusted-dotenv-key' },
    ])('should preserve explicit order when $implicitFile is selected', async ({
      implicitFile,
      dotenvKey,
    }) => {
      withInputs({ 'env-files': `.env.local,./${implicitFile}` });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value.endsWith(`${path.sep}${implicitFile}`) ||
          value.endsWith(`${path.sep}.env.local`) ||
          value.endsWith('promptfooconfig.yaml')
        );
      });

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      if (dotenvKey === undefined) {
        delete process.env.DOTENV_KEY;
      } else {
        process.env.DOTENV_KEY = dotenvKey;
      }
      const loadedPaths: string[] = [];
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          loadedPaths.push(options?.path ?? '');
          const parsed = options?.path?.endsWith('.env.local')
            ? { CUSTOM_PROVIDER_SETTING: 'selected' }
            : { CUSTOM_PROVIDER_SETTING: 'implicit' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(loadedPaths).toEqual([
          path.join(process.cwd(), '.env.local'),
          path.join(process.cwd(), implicitFile),
        ]);
        const execOptions = mockExec.exec.mock.calls[0][2];
        expect(execOptions?.env).toEqual(
          expect.objectContaining({ CUSTOM_PROVIDER_SETTING: 'implicit' }),
        );
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
      }
    });

    test('should preserve explicit order when .env aliases a vault-only implicit file', async () => {
      withInputs({ 'env-files': '.env.local,.env' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value.endsWith(`${path.sep}.env.vault`) ||
          value.endsWith(`${path.sep}.env.local`) ||
          value.endsWith('promptfooconfig.yaml')
        );
      });

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      process.env.DOTENV_KEY = 'trusted-dotenv-key';
      const loadedPaths: string[] = [];
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const requestedPath = options?.path ?? '';
          const effectivePath = requestedPath.endsWith('.env')
            ? `${requestedPath}.vault`
            : requestedPath;
          loadedPaths.push(effectivePath);
          const parsed = effectivePath.endsWith('.env.local')
            ? { CUSTOM_PROVIDER_SETTING: 'selected' }
            : { CUSTOM_PROVIDER_SETTING: 'implicit' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(loadedPaths).toEqual([
          path.join(process.cwd(), '.env.local'),
          path.join(process.cwd(), '.env.vault'),
        ]);
        const execOptions = mockExec.exec.mock.calls[0][2];
        expect(execOptions?.env).toEqual(
          expect.objectContaining({ CUSTOM_PROVIDER_SETTING: 'implicit' }),
        );
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
      }
    });

    test('should keep an absolute-looking env file path under the working directory', async () => {
      const absoluteInput = path.join(path.sep, 'tmp', 'outside.env');
      const expectedPath = path.resolve(
        path.join(process.cwd(), absoluteInput),
      );
      withInputs({ 'env-files': absoluteInput });
      mockFs.existsSync.mockImplementation(
        (filePath: fs.PathLike) =>
          filePath.toString() === expectedPath ||
          filePath.toString().endsWith('promptfooconfig.yaml'),
      );

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockReturnValue({ error: null });

      await run();

      expect(dotenv.config).toHaveBeenCalledWith(
        expect.objectContaining({ path: expectedPath }),
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should reject an env file that lexically escapes the working directory', async () => {
      withInputs({ 'env-files': '../outside.env' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockReturnValue({ error: null });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('must stay within the working directory'),
      );
      expect(dotenv.config).not.toHaveBeenCalled();
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      { envFiles: '', file: '.env', dotenvKey: undefined },
      {
        envFiles: '',
        file: '.env.vault',
        dotenvKey: 'trusted-dotenv-key',
      },
      { envFiles: '.env.local', file: '.env.local', dotenvKey: undefined },
    ])('should reject an escaping $file symlink before loading it', async ({
      envFiles,
      file,
      dotenvKey,
    }) => {
      withInputs({ 'env-files': envFiles });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${path.sep}${file}`),
      );
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return value.endsWith(`${path.sep}${file}`)
          ? path.join(path.dirname(process.cwd()), 'outside.env')
          : value;
      });

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockReturnValue({ error: null });
      const originalDotenvKey = process.env.DOTENV_KEY;
      if (dotenvKey === undefined) {
        delete process.env.DOTENV_KEY;
      } else {
        process.env.DOTENV_KEY = dotenvKey;
      }

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('must stay within the working directory'),
        );
        expect(dotenv.config).not.toHaveBeenCalled();
        expect(mockExec.exec).not.toHaveBeenCalled();
      } finally {
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
      }
    });

    test('should preserve vault semantics for a contained .env.vault symlink', async () => {
      withInputs({ 'env-files': '' });
      const logicalPath = path.join(process.cwd(), '.env.vault');
      const physicalPath = path.join(process.cwd(), 'configs', 'prod-secret');
      mockFs.existsSync.mockImplementation(
        (filePath: fs.PathLike) =>
          filePath.toString() === logicalPath ||
          filePath.toString().endsWith('promptfooconfig.yaml'),
      );
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString() === logicalPath
          ? physicalPath
          : filePath.toString(),
      );

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      process.env.DOTENV_KEY = 'trusted-dotenv-key';
      (dotenv.config as Mock).mockReturnValue({ error: null });

      try {
        await run();

        expect(dotenv.config).toHaveBeenCalledWith(
          expect.objectContaining({ path: logicalPath }),
        );
        expect(dotenv.config).not.toHaveBeenCalledWith(
          expect.objectContaining({ path: physicalPath }),
        );
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      } finally {
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
      }
    });

    test('should not select a physical vault for a contained .env.local symlink', async () => {
      withInputs({ 'env-files': '.env.local' });
      const logicalPath = path.join(process.cwd(), '.env.local');
      const physicalPath = path.join(process.cwd(), 'configs', 'dev.env');
      const physicalVaultPath = `${physicalPath}.vault`;
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value === logicalPath ||
          value === physicalVaultPath ||
          value.endsWith('promptfooconfig.yaml')
        );
      });
      mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString() === logicalPath
          ? physicalPath
          : filePath.toString(),
      );

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      process.env.DOTENV_KEY = 'trusted-dotenv-key';
      const loadedPaths: string[] = [];
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string }) => {
          const requestedPath = options?.path ?? '';
          loadedPaths.push(
            requestedPath === physicalPath ? physicalVaultPath : requestedPath,
          );
          return { error: null };
        },
      );

      try {
        await run();

        expect(loadedPaths).toEqual([logicalPath]);
        expect(mockCore.setFailed).not.toHaveBeenCalled();
      } finally {
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
      }
    });

    test('should preserve trusted workflow credentials when loading the implicit .env', async () => {
      withInputs({ 'env-files': '' });
      mockFs.existsSync.mockImplementation(
        (filePath: fs.PathLike) =>
          filePath.toString().endsWith(`${path.sep}.env`) ||
          filePath.toString().endsWith('promptfooconfig.yaml'),
      );

      const dotenv = await import('dotenv');
      const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const originalOpenaiKey = process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'trusted-anthropic-key';
      process.env.OPENAI_API_KEY = 'trusted-openai-key';
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = {
            ANTHROPIC_API_KEY: 'attacker-key',
            OPENAI_API_KEY: 'attacker-key',
          };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        const execOptions = mockExec.exec.mock.calls[0][2];
        expect(execOptions?.env).toEqual(
          expect.objectContaining({
            ANTHROPIC_API_KEY: 'trusted-anthropic-key',
            OPENAI_API_KEY: 'trusted-openai-key',
          }),
        );
      } finally {
        if (originalAnthropicKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
        }
        if (originalOpenaiKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalOpenaiKey;
        }
      }
    });

    test('should reject an implicit .env.vault when the plaintext .env is absent', async () => {
      withInputs({ 'env-files': '' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${path.sep}.env.vault`),
      );

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      const originalBaseUrl = process.env.OPENAI_BASE_URL;
      process.env.DOTENV_KEY = 'trusted-dotenv-key';
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { OPENAI_BASE_URL: 'http://attacker.invalid/v1' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('OPENAI_BASE_URL'),
        );
        expect(dotenv.config).toHaveBeenCalledWith(
          expect.objectContaining({
            path: expect.stringMatching(/(?:^|[/\\])\.env\.vault$/),
          }),
        );
        expect(mockCore.info).toHaveBeenCalledWith(
          expect.stringMatching(
            /Loading environment variables from .*\.env\.vault$/,
          ),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env.OPENAI_BASE_URL).toBe(originalBaseUrl);
      } finally {
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
        if (originalBaseUrl === undefined) {
          delete process.env.OPENAI_BASE_URL;
        } else {
          process.env.OPENAI_BASE_URL = originalBaseUrl;
        }
      }
    });

    test('should validate the implicit .env.vault when DOTENV_KEY and plaintext .env both exist', async () => {
      withInputs({ 'env-files': '' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = filePath.toString();
        return (
          value.endsWith(`${path.sep}.env`) ||
          value.endsWith(`${path.sep}.env.vault`)
        );
      });

      const dotenv = await import('dotenv');
      const originalDotenvKey = process.env.DOTENV_KEY;
      const originalBaseUrl = process.env.OPENAI_BASE_URL;
      process.env.DOTENV_KEY = 'trusted-dotenv-key';
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.vault')
            ? { OPENAI_BASE_URL: 'http://attacker.invalid/v1' }
            : { CUSTOM_PROVIDER_SETTING: 'plaintext' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('OPENAI_BASE_URL'),
        );
        expect(dotenv.config).toHaveBeenCalledWith(
          expect.objectContaining({
            path: expect.stringMatching(/(?:^|[\\/])\.env\.vault$/),
          }),
        );
        expect(mockCore.info).toHaveBeenCalledWith(
          expect.stringMatching(
            /Loading environment variables from .*\.env\.vault$/,
          ),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env.OPENAI_BASE_URL).toBe(originalBaseUrl);
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        if (originalDotenvKey === undefined) {
          delete process.env.DOTENV_KEY;
        } else {
          process.env.DOTENV_KEY = originalDotenvKey;
        }
        if (originalBaseUrl === undefined) {
          delete process.env.OPENAI_BASE_URL;
        } else {
          process.env.OPENAI_BASE_URL = originalBaseUrl;
        }
      }
    });

    test('should mask every supported provider fallback loaded from an environment file', async () => {
      withInputs({ 'env-files': '.env.local' });
      mockFs.existsSync.mockImplementation(
        (filePath: fs.PathLike) =>
          filePath.toString().endsWith('.env.local') ||
          filePath.toString().endsWith('promptfooconfig.yaml'),
      );

      const providerKeys = {
        OPENAI_API_KEY: 'env-openai-key',
        AZURE_OPENAI_API_KEY: 'env-azure-key',
        ANTHROPIC_API_KEY: 'env-anthropic-key',
        HF_API_TOKEN: 'env-huggingface-key',
        HF_TOKEN: 'env-hf-token',
        HUGGING_FACE_HUB_TOKEN: 'env-hugging-face-hub-token',
        GOOGLE_API_KEY: 'env-google-api-key',
        GEMINI_API_KEY: 'env-gemini-api-key',
        GOOGLE_GENERATIVE_AI_API_KEY: 'env-google-generative-ai-key',
        REPLICATE_API_TOKEN: 'env-replicate-api-token',
        AZURE_API_KEY: 'env-azure-api-key',
        AZURE_CLIENT_SECRET: 'env-azure-client-secret',
        CF_AIG_TOKEN: 'env-cf-aig-token',
        DATABRICKS_TOKEN: 'env-databricks-token',
        FAL_KEY: 'env-fal-key',
        ABLIT_KEY: 'env-ablit-key',
        LANGFUSE_SECRET_KEY: 'env-langfuse-secret-key',
        WATSONX_AI_APIKEY: 'env-watsonx-api-key',
        COMETAPI_KEY: 'env-comet-api-key',
        mIxEd_CuStOm_aPi_KeY: 'env-mixed-case-api-key',
        AWS_ACCESS_KEY_ID: 'env-aws-access-key-id',
        AWS_SECRET_ACCESS_KEY: 'env-aws-secret-access-key',
        REPLICATE_API_KEY: 'env-replicate-key',
        PALM_API_KEY: 'env-palm-key',
        VERTEX_API_KEY: 'env-vertex-key',
        COHERE_API_KEY: 'env-cohere-key',
        MISTRAL_API_KEY: 'env-mistral-key',
        GROQ_API_KEY: 'env-groq-key',
      };
      const originals = Object.fromEntries(
        Object.keys(providerKeys).map((key) => [key, process.env[key]]),
      );
      for (const key of Object.keys(providerKeys)) {
        delete process.env[key];
      }

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = {
            ...providerKeys,
            AWS_SAGEMAKER_MAX_TOKENS: 'do-not-mask-max-tokens',
          };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        for (const value of Object.values(providerKeys)) {
          expect(mockCore.setSecret).toHaveBeenCalledWith(value);
        }
        expect(mockCore.setSecret).not.toHaveBeenCalledWith(
          'do-not-mask-max-tokens',
        );
      } finally {
        for (const key of Object.keys(providerKeys)) {
          const value = originals[key];
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        delete process.env.AWS_SAGEMAKER_MAX_TOKENS;
      }
    });

    test('should mask trusted provider aliases before skipping unrelated changes', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue(['prompts/prompt1.txt']);
      const providerValues = {
        HF_TOKEN: 'trusted-hf-token',
        GOOGLE_API_KEY: 'trusted-google-api-key',
        GEMINI_API_KEY: 'trusted-gemini-api-key',
        AWS_BEARER_TOKEN_BEDROCK: 'trusted-bedrock-token',
        WATSONX_AI_BEARER_TOKEN: 'trusted-watsonx-token',
        mIxEd_CuStOm_aPi_KeY: 'trusted-mixed-case-api-key',
        AWS_SAGEMAKER_MAX_TOKENS: 'do-not-mask-max-tokens',
        AZURE_TOKEN_SCOPE: 'do-not-mask-token-scope',
      };
      const originals = Object.fromEntries(
        Object.keys(providerValues).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, providerValues);

      try {
        await run();

        for (const [key, value] of Object.entries(providerValues)) {
          if (key.endsWith('_MAX_TOKENS') || key.endsWith('_TOKEN_SCOPE')) {
            expect(mockCore.setSecret).not.toHaveBeenCalledWith(value);
          } else {
            expect(mockCore.setSecret).toHaveBeenCalledWith(value);
          }
        }
        expect(mockExec.exec).not.toHaveBeenCalled();
      } finally {
        for (const key of Object.keys(providerValues)) {
          const value = originals[key];
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    test.each([
      { envFiles: '.missing', loadedFile: '.env' },
      { envFiles: '.env.local,.missing', loadedFile: '.env.local' },
    ])('should mask a provider key loaded from $loadedFile before a later error', async ({
      envFiles,
      loadedFile,
    }) => {
      withInputs({ 'env-files': envFiles });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith(`${path.sep}${loadedFile}`),
      );

      const dotenv = await import('dotenv');
      const originalOpenaiKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { OPENAI_API_KEY: 'loaded-openai-key' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setSecret).toHaveBeenCalledWith('loaded-openai-key');
        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('.missing'),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
      } finally {
        if (originalOpenaiKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalOpenaiKey;
        }
      }
    });

    test('should reject an own __proto__ key before merging an environment file', async () => {
      withInputs({ 'env-files': '.env.local' });
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        filePath.toString().endsWith('.env.local'),
      );

      const dotenv = await import('dotenv');
      let parseTargetPrototype: object | null | undefined;
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parseTarget = options?.processEnv ?? process.env;
          parseTargetPrototype = Object.getPrototypeOf(parseTarget);
          Object.defineProperty(parseTarget, '__proto__', {
            configurable: true,
            enumerable: true,
            value: { polluted: true },
            writable: true,
          });
          parseTarget.CUSTOM_PROVIDER_SETTING = 'value';
          return { parsed: parseTarget };
        },
      );

      try {
        await run();

        expect(parseTargetPrototype).toBeNull();
        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('__proto__'),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env.CUSTOM_PROVIDER_SETTING).toBeUndefined();
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        Reflect.deleteProperty(process.env, '__proto__');
      }
    });

    test('should reject a forbidden variable introduced by a later env file', async () => {
      withInputs({ 'env-files': '.env,.env.local' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      const originalNodeOptions = process.env.NODE_OPTIONS;
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.local')
            ? { NODE_OPTIONS: '--require /tmp/evil.js' }
            : { CUSTOM_PROVIDER_SETTING: 'first' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('NODE_OPTIONS'),
        );
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env.NODE_OPTIONS).toBe(originalNodeOptions);
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        if (originalNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = originalNodeOptions;
        }
      }
    });

    test.each([
      'PROMPTFOO_API_KEY',
      'PROMPTFOO_REMOTE_API_BASE_URL',
      'promptfoo_remote_api_base_url',
    ])('should reject authentication variable %s from environment files', async (variableName) => {
      withInputs({ 'env-files': '.env' });
      mockFs.existsSync.mockReturnValue(true);
      process.env.PROMPTFOO_API_KEY = 'trusted-workflow-key';

      const dotenv = await import('dotenv');
      const originalValue = process.env[variableName];
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = {
            [variableName]:
              variableName.toUpperCase() === 'PROMPTFOO_API_KEY'
                ? 'repository-key'
                : 'https://capture.example',
          };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining(variableName),
        );
        expect(mockAuth.validatePromptfooApiKey).not.toHaveBeenCalled();
        expect(mockExec.exec).not.toHaveBeenCalled();
        expect(process.env[variableName]).toBe(originalValue);
      } finally {
        if (originalValue === undefined) {
          delete process.env[variableName];
        } else {
          process.env[variableName] = originalValue;
        }
      }
    });

    test('should forward non-auth PROMPTFOO_ variables from environment files', async () => {
      // Auth and process controls are blocked individually, not by a broad
      // PROMPTFOO_ prefix, so ordinary application settings still pass through.
      withInputs({ 'env-files': '.env' });
      mockFs.existsSync.mockReturnValue(true);

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { PROMPTFOO_CUSTOM_SETTING: 'allowed' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).not.toHaveBeenCalled();
        expect(mockExec.exec.mock.calls[0][2]?.env).toEqual(
          expect.objectContaining({ PROMPTFOO_CUSTOM_SETTING: 'allowed' }),
        );
      } finally {
        delete process.env.PROMPTFOO_CUSTOM_SETTING;
      }
    });

    test('should preserve trusted workflow authentication while loading application variables', async () => {
      withInputs({ 'env-files': '.env' });
      mockFs.existsSync.mockReturnValue(true);
      process.env.PROMPTFOO_API_KEY = 'trusted-workflow-key';
      process.env.PROMPTFOO_REMOTE_API_BASE_URL = 'https://trusted.example';
      mockAuth.getApiHost.mockReturnValue('https://trusted.example');
      mockAuth.validatePromptfooApiKey.mockResolvedValue({
        user: { id: '1', name: 'Test', email: 'test@example.com' },
        organization: { id: '1', name: 'Test Org' },
      });

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { processEnv?: Record<string, string> }) => {
          const parsed = { CUSTOM_PROVIDER_SETTING: 'allowed' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockAuth.validatePromptfooApiKey).toHaveBeenCalledWith(
          'trusted-workflow-key',
          'https://trusted.example',
        );
        expect(mockExec.exec).toHaveBeenCalledOnce();
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        delete process.env.PROMPTFOO_API_KEY;
        delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;
      }
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

    test('should reject a protected endpoint from config-declared envPath before evaluation', async () => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.late`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: .env.late'
            : '{}',
      );

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.late')
            ? { PROMPTFOO_CLOUD_API_URL: 'https://capture.example' }
            : {};
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('PROMPTFOO_CLOUD_API_URL'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should load safe config-declared envPath files before evaluation', async () => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.first`) ||
          value.endsWith(`${path.sep}.env.second`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: [".env.first, .env.second"]'
            : '{"results":{"stats":{"successes":1,"failures":0}}}',
      );

      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: {
          path?: string | string[];
          processEnv?: Record<string, string>;
        }) => {
          const paths = Array.isArray(options?.path)
            ? options.path
            : [options?.path ?? ''];
          const parsed = paths.some((filePath) =>
            filePath.endsWith('.env.second'),
          )
            ? {
                CUSTOM_PROVIDER_SETTING: 'second',
                OPENAI_API_KEY: 'config-openai-key',
                DATABRICKS_TOKEN: 'config-databricks-token',
                HF_TOKEN: 'config-hf-token',
                GOOGLE_API_KEY: 'config-google-key',
                GEMINI_API_KEY: 'config-gemini-key',
                GOOGLE_GENERATIVE_AI_API_KEY: 'config-genai-key',
                HUGGING_FACE_HUB_TOKEN: 'config-hf-hub-token',
                REPLICATE_API_TOKEN: 'config-replicate-token',
                OPENAI_MAX_TOKENS: 'not-a-secret',
              }
            : { CUSTOM_PROVIDER_SETTING: 'first' };
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).not.toHaveBeenCalled();
        expect(dotenv.config).toHaveBeenCalledWith(
          expect.objectContaining({
            path: [
              path.join(process.cwd(), '.env.first'),
              path.join(process.cwd(), '.env.second'),
            ],
          }),
        );
        expect(mockExec.exec.mock.calls[0][2]?.env).toEqual(
          expect.objectContaining({
            CUSTOM_PROVIDER_SETTING: 'second',
            OPENAI_API_KEY: 'config-openai-key',
            DATABRICKS_TOKEN: 'config-databricks-token',
            HF_TOKEN: 'config-hf-token',
            GOOGLE_API_KEY: 'config-google-key',
            GEMINI_API_KEY: 'config-gemini-key',
            GOOGLE_GENERATIVE_AI_API_KEY: 'config-genai-key',
            HUGGING_FACE_HUB_TOKEN: 'config-hf-hub-token',
            REPLICATE_API_TOKEN: 'config-replicate-token',
          }),
        );
        expect(mockCore.setSecret).toHaveBeenCalledWith('config-openai-key');
        expect(mockCore.setSecret).toHaveBeenCalledWith(
          'config-databricks-token',
        );
        for (const secret of [
          'config-hf-token',
          'config-google-key',
          'config-gemini-key',
          'config-genai-key',
          'config-hf-hub-token',
          'config-replicate-token',
        ]) {
          expect(mockCore.setSecret).toHaveBeenCalledWith(secret);
        }
        expect(mockCore.setSecret).not.toHaveBeenCalledWith('not-a-secret');
      } finally {
        delete process.env.CUSTOM_PROVIDER_SETTING;
        delete process.env.OPENAI_API_KEY;
        delete process.env.DATABRICKS_TOKEN;
        delete process.env.HF_TOKEN;
        delete process.env.GOOGLE_API_KEY;
        delete process.env.GEMINI_API_KEY;
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        delete process.env.HUGGING_FACE_HUB_TOKEN;
        delete process.env.REPLICATE_API_TOKEN;
        delete process.env.OPENAI_MAX_TOKENS;
      }
    });

    test('should not leave config-loaded secrets unmasked when a later envPath is missing', async () => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.first`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: [.env.first, .env.missing]'
            : '{}',
      );
      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.first')
            ? { OPENAI_API_KEY: 'config-first-secret' }
            : {};
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      try {
        await run();

        expect(mockCore.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('.env.missing'),
        );
        expect(process.env.OPENAI_API_KEY).not.toBe('config-first-secret');
        expect(mockExec.exec).not.toHaveBeenCalled();
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });

    test('should reject config-declared envPath traversal before evaluation', async () => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        String(filePath).endsWith('promptfooconfig.yaml'),
      );
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: ../outside.env'
            : '{}',
      );

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('must stay within the working directory'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      'envPath: 7',
      'envPath: [.env.valid, 7]',
    ])('should reject malformed config-declared %s before evaluation', async (envPath) => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        String(filePath).endsWith('promptfooconfig.yaml'),
      );
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? `commandLineOptions:\n  ${envPath}`
            : '{}',
      );

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Invalid commandLineOptions.envPath'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should reject a missing config-declared envPath before evaluation', async () => {
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
        String(filePath).endsWith('promptfooconfig.yaml'),
      );
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: .env.missing'
            : '{}',
      );

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Config environment file'),
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
        'Using manually specified files: ["prompts/file1.txt","prompts/file2.txt"]',
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
        'Using manually specified files: ["action-input-file.txt"]',
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

    test('should fail closed when config dependency extraction returns the workspace root', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['./']);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should detect a config dependency renamed away in a pull request', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          filename: ' configs/renamed.yaml ',
          previous_filename: ' configs/base.yaml ',
          status: 'renamed',
        },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' configs/base.yaml ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should preserve whitespace and newlines in a single pull-request filename', async () => {
      mockOctokit.paginate.mockResolvedValue([
        { filename: ' configs/base\nname.yaml ' },
      ]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' configs/base\nname.yaml ',
      ]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockCore.debug).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify([' configs/base\nname.yaml '])),
      );
      expect(mockExec.exec).toHaveBeenCalled();
    });

    test('should reject a matched prompt filename that could forge a workflow command', async () => {
      const forgedPrompt = 'prompts/policy\n::error::forged.txt';
      mockOctokit.paginate.mockResolvedValue([{ filename: forgedPrompt }]);
      mockGlob.sync.mockReturnValue([forgedPrompt]);

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Prompt filenames must not contain CR or LF'),
      );
      expect(mockCore.setFailed).not.toHaveBeenCalledWith(
        expect.stringContaining('forged.txt'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test.each([
      {
        eventName: 'push',
        payload: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        diffArgs: [
          '--name-only',
          '--no-renames',
          '-z',
          'a'.repeat(40),
          'b'.repeat(40),
          '--',
        ],
      },
      {
        eventName: 'workflow_dispatch',
        payload: { inputs: { base: 'main' } },
        diffArgs: ['--name-only', '--no-renames', '-z', 'main', 'HEAD', '--'],
      },
    ])('should preflight a dependency renamed away during $eventName', async ({
      eventName,
      payload,
      diffArgs,
    }) => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: eventName,
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: payload,
        configurable: true,
      });
      mockGitInterface.diff.mockResolvedValueOnce(
        ' configs/base\tname.yaml \0 configs/renamed\tname.yaml \0',
      );
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue([
        ' configs/base\tname.yaml ',
      ]);
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.late`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: .env.late'
            : '{}',
      );
      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.late')
            ? { PROMPTFOO_REMOTE_API_BASE_URL: 'https://capture.example' }
            : {};
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      await run();

      expect(mockGitInterface.diff).toHaveBeenCalledWith(diffArgs);
      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        expect.stringContaining(
          JSON.stringify([
            ' configs/base\tname.yaml ',
            ' configs/renamed\tname.yaml ',
          ]),
        ),
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('PROMPTFOO_REMOTE_API_BASE_URL'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should normalize CRLF and whitespace in workflow_dispatch files before preflight', async () => {
      Object.defineProperty(mockGithub.context, 'eventName', {
        value: 'workflow_dispatch',
        configurable: true,
      });
      Object.defineProperty(mockGithub.context, 'payload', {
        value: { inputs: { files: '  configs/base.yaml  \r\n   \r\n' } },
        configurable: true,
      });
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['configs/base.yaml']);
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.late`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: .env.late'
            : '{}',
      );
      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.late')
            ? { PROMPTFOO_REMOTE_API_BASE_URL: 'https://capture.example' }
            : {};
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('PROMPTFOO_REMOTE_API_BASE_URL'),
      );
      expect(mockExec.exec).not.toHaveBeenCalled();
    });

    test('should preflight config envPath when dependency extraction fails closed', async () => {
      mockOctokit.paginate.mockResolvedValue([{ filename: 'README.md' }]);
      mockGlob.sync.mockReturnValue([]);
      mockConfig.extractFileDependencies.mockReturnValue(['./']);
      mockFs.existsSync.mockImplementation((filePath: fs.PathLike) => {
        const value = String(filePath);
        return (
          value.endsWith('promptfooconfig.yaml') ||
          value.endsWith(`${path.sep}.env.late`)
        );
      });
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) =>
          String(filePath).endsWith('promptfooconfig.yaml')
            ? 'commandLineOptions:\n  envPath: .env.late'
            : '{}',
      );
      const dotenv = await import('dotenv');
      (dotenv.config as Mock).mockImplementation(
        (options?: { path?: string; processEnv?: Record<string, string> }) => {
          const parsed = options?.path?.endsWith('.env.late')
            ? { PROMPTFOO_REMOTE_API_BASE_URL: 'https://capture.example' }
            : {};
          Object.assign(options?.processEnv ?? process.env, parsed);
          return { parsed };
        },
      );

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        'Detected changes in config file dependencies',
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('PROMPTFOO_REMOTE_API_BASE_URL'),
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
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith('promptfooconfig.yaml')) {
          return '{}';
        }
        throw new Error('ENOENT');
      },
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'Promptfoo tests failed (exit code 100) but no output was generated',
      ),
    );
  });

  test('should report invalid output after a successful exit', async () => {
    mockExec.exec.mockResolvedValue(0);
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('promptfooconfig.yaml') ? '{}' : '{not-json',
    );

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read or parse output file'),
    );
  });

  test('should format non-Error output read failures', async () => {
    mockExec.exec.mockResolvedValue(0);
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith('promptfooconfig.yaml')) {
          return '{}';
        }
        throw 'read failed';
      },
    );

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
