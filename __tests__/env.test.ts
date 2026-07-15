import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  findForbiddenAuthKey,
  findForbiddenEnvFileKey,
  loadEnvironmentFile,
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

  test.each([
    'NODE_OPTIONS',
    'nOdE_oPtIoNs',
    'PATH',
    'LD_PRELOAD',
    'LD_AUDIT',
    'ld_debug_output',
    'DYLD_INSERT_LIBRARIES',
    'dyld_image_suffix',
    'HTTPS_PROXY',
    'HOME',
    'XDG_CONFIG_HOME',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'GOFLAGS',
    'goenv',
    'GOTOOLCHAIN',
    'GOPROXY',
    'GOSUMDB',
    'GOINSECURE',
    'GONOSUMDB',
    'GONOPROXY',
    'GOPRIVATE',
    'GOMODCACHE',
    'GOCACHE',
    'GOPATH',
    'GOROOT',
    'CC',
    'CXX',
    'CGO_CFLAGS',
    'CGO_CPPFLAGS',
    'CGO_CXXFLAGS',
    'CGO_LDFLAGS',
    'PKG_CONFIG',
    'AWS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'requests_ca_bundle',
    'PERL5OPT',
    'PERL5LIB',
    'PYTHONHOME',
    'PYTHONPATH',
    'pythonuserbase',
    'PROMPTFOO_PYTHON',
    'RUBYOPT',
    'RUBYLIB',
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
    'OPENAI_BASE_URL',
    'openai_api_base_url',
    'OPENAI_API_HOST',
    'ANTHROPIC_BASE_URL',
    'aPi_HoSt',
    'AWS_ENDPOINT_URL',
    'aws_config_file',
    'AWS_SHARED_CREDENTIALS_FILE',
    'aws_endpoint_url_bedrock_runtime',
    'AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME',
    'AZURE_OPENAI_API_HOST',
    'AZURE_AI_PROJECT_URL',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'CLOUDFLARE_GATEWAY_ID',
    'SNOWFLAKE_ACCOUNT_IDENTIFIER',
    'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_GATEWAY_PORT',
    'opencode_config',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_GIT_BASH_PATH',
    'SHAREPOINT_CERT_PATH',
    'PROMPTFOO_CLOUD_API_URL',
    'promptfoo_remote_api_base_url',
    'PROMPTFOO_REMOTE_GENERATION_URL',
    'PROMPTFOO_UNALIGNED_INFERENCE_ENDPOINT',
    'PROMPTFOO_OTEL_ENDPOINT',
    'otel_exporter_otlp_endpoint',
    'PROMPTFOO_REMOTE_APP_BASE_URL',
    'PROMPTFOO_SHARING_APP_BASE_URL',
    'PROMPTFOO_CACHE_PATH',
    'PROMPTFOO_CONFIG_DIR',
    'PROMPTFOO_PASS_RATE_THRESHOLD',
    'PROMPTFOO_FAILED_TEST_EXIT_CODE',
    'PROMPTFOO_LOG_DIR',
    'PROMPTFOO_MEDIA_PATH',
    'GIT_SSH_COMMAND',
    'git_config_count',
    'GIT_EXTERNAL_DIFF',
    'NPM_CONFIG_REGISTRY',
    'npm_config_script_shell',
  ])('flags forbidden key %s and returns the original-case key', (key) => {
    expect(findForbiddenEnvFileKey({ [key]: 'x' })).toBe(key);
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

  test('detects forbidden keys case-insensitively', () => {
    const file = writeEnv('.env', 'nOdE_oPtIoNs=--inspect\n');
    expect(() => loadEnvironmentFile(file, {})).toThrow(/nOdE_oPtIoNs/);
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

  test('preserves process controls that came from the trusted workflow environment', () => {
    const target: NodeJS.ProcessEnv = {
      PYTHONPATH: '/trusted/provider-lib',
      OPENAI_BASE_URL: 'https://trusted.example/v1',
      PROMPTFOO_CACHE_PATH: '/trusted/cache',
      PROMPTFOO_PASS_RATE_THRESHOLD: '90',
    };
    const file = writeEnv('.env', 'CUSTOM_PROVIDER_SETTING=allowed\n');

    loadEnvironmentFile(file, target);

    expect(target).toEqual({
      PYTHONPATH: '/trusted/provider-lib',
      OPENAI_BASE_URL: 'https://trusted.example/v1',
      PROMPTFOO_CACHE_PATH: '/trusted/cache',
      PROMPTFOO_PASS_RATE_THRESHOLD: '90',
      CUSTOM_PROVIDER_SETTING: 'allowed',
    });
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
});
