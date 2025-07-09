import {run, handleError} from '../src/main';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import {expect, test, jest, beforeEach, afterEach} from '@jest/globals';

// Mock all the dependencies
jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('@actions/exec');
jest.mock('glob');
jest.mock('simple-git');

beforeEach(() => {
  // Clear all mocks before each test
  jest.clearAllMocks();

  // Reset environment variables
  delete process.env.TEST_VAR_1;
  delete process.env.TEST_VAR_2;
});

afterEach(() => {
  // Clean up any test files
  const testFiles = ['.env.test', '.env.test.local'];
  testFiles.forEach(file => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
});

test('test runs', async () => {
  await run();
});

test('handleError calls core.setFailed with error message', () => {
  const error = new Error('Test error');
  const setFailedMock = jest.spyOn(core, 'setFailed');
  handleError(error);
  expect(setFailedMock).toHaveBeenCalledWith('Test error');
});

test('loads .env files when env-files input is provided', async () => {
  // Create test .env files
  fs.writeFileSync('.env.test', 'TEST_VAR_1=value1\nTEST_VAR_2=value2');
  fs.writeFileSync(
    '.env.test.local',
    'TEST_VAR_2=overridden\nTEST_VAR_3=value3',
  );

  // Mock core.getInput to return our test values
  (core.getInput as jest.Mock).mockImplementation((...args: any[]) => {
    const name = args[0];
    if (name === 'env-files') return '.env.test,.env.test.local';
    if (name === 'working-directory') return '.';
    if (name === 'github-token') return 'test-token';
    if (name === 'config') return 'test-config.yaml';
    if (name === 'promptfoo-version') return 'latest';
    return '';
  });

  (core.getBooleanInput as jest.Mock).mockReturnValue(false);

  // Mock github context
  jest.mock('@actions/github', () => ({
    context: {
      eventName: 'pull_request',
      payload: {
        pull_request: {
          number: 1,
          base: {ref: 'main'},
          head: {ref: 'feature'},
        },
      },
      repo: {owner: 'test', repo: 'test'},
    },
    getOctokit: jest.fn(),
  }));

  try {
    await run();
  } catch (error) {
    // Expected to fail due to mocked dependencies
  }

  // Check that environment variables were loaded
  expect(process.env.TEST_VAR_1).toBe('value1');
  expect(process.env.TEST_VAR_2).toBe('overridden'); // Should be overridden by second file
  expect(process.env.TEST_VAR_3).toBe('value3');

  // Check that info logs were called
  expect(core.info).toHaveBeenCalledWith(
    expect.stringContaining('Loading environment variables from'),
  );
  expect(core.info).toHaveBeenCalledWith(
    expect.stringContaining('Successfully loaded'),
  );
});

test('warns when .env file does not exist', async () => {
  // Mock core.getInput to return a non-existent file
  (core.getInput as jest.Mock).mockImplementation((...args: any[]) => {
    const name = args[0];
    if (name === 'env-files') return 'non-existent.env';
    if (name === 'working-directory') return '.';
    if (name === 'github-token') return 'test-token';
    if (name === 'config') return 'test-config.yaml';
    if (name === 'promptfoo-version') return 'latest';
    return '';
  });

  (core.getBooleanInput as jest.Mock).mockReturnValue(false);

  // Mock github context
  jest.mock('@actions/github', () => ({
    context: {
      eventName: 'pull_request',
      payload: {
        pull_request: {
          number: 1,
          base: {ref: 'main'},
          head: {ref: 'feature'},
        },
      },
      repo: {owner: 'test', repo: 'test'},
    },
    getOctokit: jest.fn(),
  }));

  try {
    await run();
  } catch (error) {
    // Expected to fail due to mocked dependencies
  }

  // Check that warning was called
  expect(core.warning).toHaveBeenCalledWith(
    expect.stringContaining('not found'),
  );
});

test('does not load .env files when env-files input is empty', async () => {
  // Mock core.getInput to return empty env-files
  (core.getInput as jest.Mock).mockImplementation((...args: any[]) => {
    const name = args[0];
    if (name === 'env-files') return '';
    if (name === 'working-directory') return '.';
    if (name === 'github-token') return 'test-token';
    if (name === 'config') return 'test-config.yaml';
    if (name === 'promptfoo-version') return 'latest';
    return '';
  });

  (core.getBooleanInput as jest.Mock).mockReturnValue(false);

  // Mock github context
  jest.mock('@actions/github', () => ({
    context: {
      eventName: 'pull_request',
      payload: {
        pull_request: {
          number: 1,
          base: {ref: 'main'},
          head: {ref: 'feature'},
        },
      },
      repo: {owner: 'test', repo: 'test'},
    },
    getOctokit: jest.fn(),
  }));

  try {
    await run();
  } catch (error) {
    // Expected to fail due to mocked dependencies
  }

  // Check that info was not called for loading env files
  expect(core.info).not.toHaveBeenCalledWith(
    expect.stringContaining('Loading environment variables from'),
  );
});
