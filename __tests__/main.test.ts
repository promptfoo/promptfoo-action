import {expect, describe, beforeEach, afterEach, jest, test} from '@jest/globals';

// Create manual mocks
const mockCore = {
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setSecret: jest.fn(),
  setFailed: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
};

const mockGithub = {
  context: {
    eventName: 'pull_request',
    payload: {
      pull_request: {
        number: 123,
        base: { ref: 'main' },
        head: { ref: 'feature-branch' }
      }
    },
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    }
  },
  getOctokit: jest.fn()
};

const mockExec = {
  exec: jest.fn()
};

const mockFs = {
  readFileSync: jest.fn()
};

const mockGlob = {
  sync: jest.fn()
};

const mockSimpleGit = jest.fn();

// Set up module mocks
jest.mock('@actions/core', () => mockCore);
jest.mock('@actions/github', () => mockGithub);
jest.mock('@actions/exec', () => mockExec);
jest.mock('fs', () => mockFs);
jest.mock('glob', () => mockGlob);
jest.mock('simple-git', () => ({ simpleGit: mockSimpleGit }));

// Import the module under test
import {run, handleError} from '../src/main';

describe('promptfoo-action', () => {
  let mockOctokit: any;
  let mockGitInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup git mock
    mockGitInstance = {
      revparse: jest.fn().mockResolvedValue('abc123\n'),
      diff: jest.fn().mockResolvedValue('prompts/test.txt\npromptfooconfig.yaml')
    };
    mockSimpleGit.mockReturnValue(mockGitInstance);
    
    // Setup Octokit mock
    mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    mockGithub.getOctokit.mockReturnValue(mockOctokit);
    
    // Setup core mocks
    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'test-token',
        'config': 'promptfooconfig.yaml',
        'prompts': 'prompts/*.txt',
        'working-directory': '',
        'promptfoo-version': 'latest'
      };
      return inputs[name] || '';
    });
    
    mockCore.getBooleanInput.mockReturnValue(false);
    
    // Setup GitHub context
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.payload = {
      pull_request: {
        number: 123,
        base: { ref: 'main' },
        head: { ref: 'feature-branch' }
      }
    };
    
    // Setup exec mock
    mockExec.exec.mockResolvedValue(0);
    
    // Setup glob mock
    mockGlob.sync.mockReturnValue(['prompts/test.txt']);
    
    // Setup fs mock
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      results: {
        stats: {
          successes: 10,
          failures: 2
        }
      },
      shareableUrl: 'https://example.com/results'
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleError', () => {
    test('calls core.setFailed with error message', () => {
      const error = new Error('Test error');
      handleError(error);
      expect(mockCore.setFailed).toHaveBeenCalledWith('Test error');
    });
  });

  describe('run', () => {
    test('successful execution with changed prompt files', async () => {
      await run();
      
      expect(mockCore.setSecret).toHaveBeenCalledWith('test-token');
      expect(mockExec.exec).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main']);
      expect(mockExec.exec).toHaveBeenCalledWith('git', ['fetch', 'origin', 'feature-branch']);
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.arrayContaining(['eval', '-c', 'promptfooconfig.yaml']),
        expect.any(Object)
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('LLM prompt was modified')
      });
    });

    test('skips execution when no files changed', async () => {
      mockGitInstance.diff.mockResolvedValue('other-file.js');
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('No LLM prompt or config files were modified.');
      expect(mockExec.exec).not.toHaveBeenCalledWith(
        expect.stringContaining('promptfoo'),
        expect.any(Array),
        expect.any(Object)
      );
    });

    test('warns when not run on pull request event', async () => {
      mockGithub.context.eventName = 'push';

      await run();

      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('pull request events only')
      );
    });

    test('throws error when no pull request found', async () => {
      mockGithub.context.payload = {};

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith('No pull request found.');
    });

    test('handles all API keys correctly', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'test-token',
          'config': 'promptfooconfig.yaml',
          'prompts': 'prompts/*.txt',
          'openai-api-key': 'openai-key',
          'azure-api-key': 'azure-key',
          'anthropic-api-key': 'anthropic-key',
          'huggingface-api-key': 'hf-key',
          'aws-access-key-id': 'aws-key',
          'aws-secret-access-key': 'aws-secret',
          'replicate-api-key': 'replicate-key',
          'palm-api-key': 'palm-key',
          'vertex-api-key': 'vertex-key',
          'cache-path': '/tmp/cache'
        };
        return inputs[name] || '';
      });

      await run();

      expect(mockCore.setSecret).toHaveBeenCalledWith('openai-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('azure-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('anthropic-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('hf-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('aws-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('aws-secret');
      expect(mockCore.setSecret).toHaveBeenCalledWith('replicate-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('palm-key');
      expect(mockCore.setSecret).toHaveBeenCalledWith('vertex-key');
      
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENAI_API_KEY: 'openai-key',
            AZURE_OPENAI_API_KEY: 'azure-key',
            ANTHROPIC_API_KEY: 'anthropic-key',
            HF_API_TOKEN: 'hf-key',
            AWS_ACCESS_KEY_ID: 'aws-key',
            AWS_SECRET_ACCESS_KEY: 'aws-secret',
            REPLICATE_API_KEY: 'replicate-key',
            PALM_API_KEY: 'palm-key',
            VERTEX_API_KEY: 'vertex-key',
            PROMPTFOO_CACHE_PATH: '/tmp/cache'
          })
        })
      );
    });

    test('runs when config file changed', async () => {
      mockGitInstance.diff.mockResolvedValue('promptfooconfig.yaml');
      mockGlob.sync.mockReturnValue([]);

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.any(Array),
        expect.any(Object)
      );
    });

    test('uses config prompts when flag is set', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        return name === 'use-config-prompts';
      });

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.not.arrayContaining(['--prompts']),
        expect.any(Object)
      );
    });

    test('adds share flag when no-share is false', async () => {
      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.arrayContaining(['--share']),
        expect.any(Object)
      );
    });

    test('omits share flag when no-share is true', async () => {
      mockCore.getBooleanInput.mockImplementation((name: string) => {
        return name === 'no-share';
      });

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.not.arrayContaining(['--share']),
        expect.any(Object)
      );
    });

    test('handles custom working directory', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'test-token',
          'config': 'promptfooconfig.yaml',
          'prompts': 'prompts/*.txt',
          'working-directory': 'subdir'
        };
        return inputs[name] || '';
      });

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.any(Array),
        expect.objectContaining({
          cwd: expect.stringContaining('subdir')
        })
      );
    });

    test('uses custom promptfoo version', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'test-token',
          'config': 'promptfooconfig.yaml',
          'prompts': 'prompts/*.txt',
          'promptfoo-version': '0.1.2'
        };
        return inputs[name] || '';
      });

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@0.1.2',
        expect.any(Array),
        expect.any(Object)
      );
    });

    test('handles non-Error exceptions', async () => {
      mockCore.getInput.mockImplementation(() => {
        throw 'String error';
      });

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith('String error');
    });

    test('continues after promptfoo execution error', async () => {
      const testError = new Error('Promptfoo execution failed');
      mockExec.exec.mockImplementation(async (command: string) => {
        if (command.includes('promptfoo')) {
          throw testError;
        }
        return 0;
      });

      await run();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(mockCore.setFailed).toHaveBeenCalledWith('Promptfoo execution failed');
    });

    test('handles multiple prompt globs', async () => {
      mockCore.getInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'test-token',
          'config': 'promptfooconfig.yaml',
          'prompts': 'prompts/*.txt\ntemplates/*.yaml',
        };
        return inputs[name] || '';
      });
      
      mockGlob.sync.mockImplementation((pattern: string) => {
        if (pattern === 'prompts/*.txt') return ['prompts/test1.txt', 'prompts/test2.txt'];
        if (pattern === 'templates/*.yaml') return ['templates/template1.yaml'];
        return [];
      });
      
      mockGitInstance.diff.mockResolvedValue('prompts/test1.txt\ntemplates/template1.yaml');

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.arrayContaining(['--prompts', 'prompts/test1.txt', 'templates/template1.yaml']),
        expect.any(Object)
      );
    });

    test('includes shareable URL in comment when available', async () => {
      await run();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('View eval results](https://example.com/results)')
        })
      );
    });

    test('shows console message when no shareable URL', async () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        results: {
          stats: {
            successes: 10,
            failures: 2
          }
        }
      }));

      await run();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('View eval results in CI console')
        })
      );
    });

    test('filters out config file from prompt files', async () => {
      mockGlob.sync.mockReturnValue(['prompts/test.txt', 'promptfooconfig.yaml']);
      mockGitInstance.diff.mockResolvedValue('prompts/test.txt\npromptfooconfig.yaml');

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.arrayContaining(['--prompts', 'prompts/test.txt']),
        expect.any(Object)
      );
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.not.arrayContaining(['promptfooconfig.yaml']),
        expect.any(Object)
      );
    });

    test('filters only changed files from glob matches', async () => {
      mockGlob.sync.mockReturnValue(['prompts/test1.txt', 'prompts/test2.txt', 'prompts/test3.txt']);
      mockGitInstance.diff.mockResolvedValue('prompts/test1.txt\nprompts/test3.txt\nother-file.js');

      await run();

      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.arrayContaining(['--prompts', 'prompts/test1.txt', 'prompts/test3.txt']),
        expect.any(Object)
      );
      expect(mockExec.exec).toHaveBeenCalledWith(
        'npx promptfoo@latest',
        expect.not.arrayContaining(['prompts/test2.txt']),
        expect.any(Object)
      );
    });
  });

  describe('module execution', () => {
    test('runs when executed as main module', () => {
      // This test verifies the module guard works correctly
      const mainPath = require.resolve('../src/main');
      delete require.cache[mainPath];
      
      const originalMain = require.main;
      require.main = { filename: mainPath } as any;
      
      // Import should trigger run()
      jest.isolateModules(() => {
        require('../src/main');
      });
      
      require.main = originalMain;
      
      // Since run is async, we just verify it was called
      expect(mockCore.getInput).toHaveBeenCalled();
    });
  });
});