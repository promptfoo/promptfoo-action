import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  findForbiddenAuthKey,
  findForbiddenEnvFileKey,
  loadEnvironmentFile,
  preflightPromptfooEnvironmentFiles,
} from '../src/utils/env';
import { ErrorCodes, PromptfooActionError } from '../src/utils/errors';

// These tests exercise the real `dotenv` parser and real files on disk, unlike
// the integration tests in main.test.ts which mock `dotenv`. They lock in the
// isolation guarantee (a rejected file must not leak any value) end-to-end.

describe('findForbiddenEnvFileKey', () => {
  test('returns undefined for benign application variables', () => {
    expect(
      findForbiddenEnvFileKey({
        OPENAI_API_KEY: 'sk-test',
        NODE_ENV: 'production',
        CUSTOM_PROVIDER_SETTING: 'value',
      }),
    ).toBeUndefined();
  });

  test('intentionally allows interpreter module-path variables', () => {
    // PYTHONPATH/RUBYLIB/PERL5LIB are needed by real promptfoo providers and
    // grant nothing beyond what such a provider already runs during evaluation.
    expect(
      findForbiddenEnvFileKey({
        PYTHONPATH: '/repo/lib',
        RUBYLIB: '/repo/rb',
        PERL5LIB: '/repo/pl',
      }),
    ).toBeUndefined();
  });

  test.each([
    'NODE_OPTIONS',
    'PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'HTTPS_PROXY',
    'HOME',
    'XDG_CONFIG_HOME',
    'NODE_EXTRA_CA_CERTS',
    'PERL5OPT',
    'PYTHONHOME',
    'RUBYOPT',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'PROMPTFOO_CACHE_PATH',
    'PROMPTFOO_CLOUD_API_URL',
    'PROMPTFOO_FAILED_TEST_EXIT_CODE',
    'PROMPTFOO_PASS_RATE_THRESHOLD',
    'PROMPTFOO_REMOTE_API_BASE_URL',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'NPM_CONFIG_REGISTRY',
    'npm_config_script_shell',
    'https_proxy',
  ])('flags forbidden key %s and returns the original-case key', (key) => {
    expect(findForbiddenEnvFileKey({ [key]: 'x' })).toBe(key);
  });

  test('preserves case-sensitive POSIX application settings', () => {
    expect(
      findForbiddenEnvFileKey(
        { path: '/api/v1', home: 'local', git_config_count: '1' },
        'linux',
      ),
    ).toBeUndefined();
  });

  test('rejects mixed-case process controls on Windows', () => {
    expect(
      findForbiddenEnvFileKey({ nOdE_oPtIoNs: '--inspect' }, 'win32'),
    ).toBe('nOdE_oPtIoNs');
  });
});

describe('findForbiddenAuthKey', () => {
  test('returns undefined for benign and non-auth PROMPTFOO_ variables', () => {
    expect(
      findForbiddenAuthKey({
        OPENAI_API_KEY: 'sk-test',
        PROMPTFOO_CACHE_PATH: '/tmp/cache',
      }),
    ).toBeUndefined();
  });

  test.each([
    'PROMPTFOO_API_KEY',
    'PROMPTFOO_CLOUD_API_URL',
    'promptfoo_cloud_api_url',
    'PROMPTFOO_REMOTE_API_BASE_URL',
    'promptfoo_remote_api_base_url',
  ])('flags authentication key %s case-insensitively', (key) => {
    expect(findForbiddenAuthKey({ [key]: 'x' })).toBe(key);
  });
});

describe('loadEnvironmentFile (real dotenv parsing)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfoo-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeEnv = (name: string, contents: string): string => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  };

  test('merges benign variables into the target environment', () => {
    const target: NodeJS.ProcessEnv = {};
    const file = writeEnv('.env', 'OPENAI_API_KEY=sk-test\nNODE_ENV=test\n');

    loadEnvironmentFile(file, target);

    expect(target.OPENAI_API_KEY).toBe('sk-test');
    expect(target.NODE_ENV).toBe('test');
  });

  test('rejects a forbidden variable without leaking any value from the file', () => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'keep' };
    const file = writeEnv(
      '.env',
      'SAFE=ok\nNODE_OPTIONS=--require /tmp/evil.js\n',
    );

    let error: unknown;
    try {
      loadEnvironmentFile(file, target);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PromptfooActionError);
    expect((error as PromptfooActionError).code).toBe(
      ErrorCodes.INVALID_CONFIGURATION,
    );
    expect((error as PromptfooActionError).message).toContain('NODE_OPTIONS');
    // Isolation: the benign SAFE key from the rejected file must not leak.
    expect(target).toEqual({ EXISTING: 'keep' });
  });

  test('detects lowercase proxy controls accepted on POSIX', () => {
    const file = writeEnv('.env', 'https_proxy=https://capture.example\n');
    expect(() => loadEnvironmentFile(file, {})).toThrow(/https_proxy/);
  });

  test('preserves trusted policy and routing when an env file overrides them', () => {
    const target: NodeJS.ProcessEnv = {
      PROMPTFOO_PASS_RATE_THRESHOLD: '90',
      PROMPTFOO_REMOTE_API_BASE_URL: 'https://trusted.example',
    };
    const thresholdFile = writeEnv(
      '.env.threshold',
      'PROMPTFOO_PASS_RATE_THRESHOLD=0\n',
    );
    const hostFile = writeEnv(
      '.env.host',
      'PROMPTFOO_REMOTE_API_BASE_URL=https://capture.example\n',
    );

    expect(() => loadEnvironmentFile(thresholdFile, target)).toThrow(
      /PROMPTFOO_PASS_RATE_THRESHOLD/,
    );
    expect(() => loadEnvironmentFile(hostFile, target)).toThrow(
      /PROMPTFOO_REMOTE_API_BASE_URL/,
    );
    expect(target).toEqual({
      PROMPTFOO_PASS_RATE_THRESHOLD: '90',
      PROMPTFOO_REMOTE_API_BASE_URL: 'https://trusted.example',
    });
  });

  test('rejects a protected auth variable without leaking any value', () => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'keep' };
    const file = writeEnv(
      '.env',
      'SAFE=ok\nPROMPTFOO_REMOTE_API_BASE_URL=https://capture.example\n',
    );

    let error: unknown;
    try {
      loadEnvironmentFile(file, target);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PromptfooActionError);
    expect((error as PromptfooActionError).message).toContain(
      'PROMPTFOO_REMOTE_API_BASE_URL',
    );
    // Isolation: nothing from the rejected file leaks, so a workflow-set key
    // and host cannot be paired with an attacker value.
    expect(target).toEqual({ EXISTING: 'keep' });
  });

  test('rejects GIT_ and NPM_CONFIG_ prefixed controls', () => {
    const gitFile = writeEnv('.env.git', 'GIT_SSH_COMMAND=evil\n');
    expect(() => loadEnvironmentFile(gitFile, {})).toThrow(/GIT_SSH_COMMAND/);

    const npmFile = writeEnv('.env.npm', 'npm_config_registry=http://evil\n');
    expect(() => loadEnvironmentFile(npmFile, {})).toThrow(
      /npm_config_registry/,
    );
  });

  test('preserves later-file-wins semantics across successive loads', () => {
    const target: NodeJS.ProcessEnv = {};
    const first = writeEnv('.env', 'SETTING=first\nONLY_FIRST=1\n');
    const second = writeEnv('.env.local', 'SETTING=second\n');

    loadEnvironmentFile(first, target);
    loadEnvironmentFile(second, target);

    expect(target.SETTING).toBe('second');
    expect(target.ONLY_FIRST).toBe('1');
  });

  test('throws ENV_FILE_LOAD_ERROR when the file cannot be read', () => {
    const missing = path.join(tmpDir, 'does-not-exist.env');

    let error: unknown;
    try {
      loadEnvironmentFile(missing, {});
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PromptfooActionError);
    expect((error as PromptfooActionError).code).toBe(
      ErrorCodes.ENV_FILE_LOAD_ERROR,
    );
  });

  test('rejects protected routing values from Promptfoo implicit env files', () => {
    writeEnv('.env', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() =>
      preflightPromptfooEnvironmentFiles(
        path.join(tmpDir, 'missing.yaml'),
        tmpDir,
      ),
    ).toThrow(/PROMPTFOO_CLOUD_API_URL/);
  });

  test('resolves config-selected env files from the runtime working directory', () => {
    const configDirectory = path.join(tmpDir, 'configs');
    fs.mkdirSync(configDirectory);
    const configPath = path.join(configDirectory, 'promptfooconfig.yaml');
    fs.writeFileSync(
      configPath,
      'commandLineOptions:\n  envPath: .env.override\n',
    );
    writeEnv('.env.override', 'PROMPTFOO_REMOTE_API_BASE_URL=https://evil\n');

    expect(() =>
      preflightPromptfooEnvironmentFiles(configPath, tmpDir),
    ).toThrow(/PROMPTFOO_REMOTE_API_BASE_URL/);
  });

  test('preflights arrays and comma-separated env files without leaking values', () => {
    const configPath = path.join(tmpDir, 'promptfooconfig.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        commandLineOptions: { envPath: ['.env.first, , .env.second'] },
      }),
    );
    writeEnv('.env.first', 'AUDIT_PROVIDER_SETTING=first\n');
    writeEnv('.env.second', 'AUDIT_PROVIDER_SETTING=second\n');

    preflightPromptfooEnvironmentFiles(configPath, tmpDir);

    expect(process.env.AUDIT_PROVIDER_SETTING).toBeUndefined();
  });

  test('preserves executable config compatibility during env preflight', () => {
    const configPath = path.join(tmpDir, 'promptfooconfig.js');
    fs.writeFileSync(configPath, 'export default { providers: ["echo"] };');

    expect(() =>
      preflightPromptfooEnvironmentFiles(configPath, tmpDir),
    ).not.toThrow();
  });

  test('rejects executable configs when authenticated sharing requires inspection', () => {
    const configPath = path.join(tmpDir, 'promptfooconfig.ts');
    fs.writeFileSync(configPath, 'export default { providers: ["echo"] };');

    expect(() =>
      preflightPromptfooEnvironmentFiles(configPath, tmpDir, true),
    ).toThrow(/executable Promptfoo configuration/);
  });
});
