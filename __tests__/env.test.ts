import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as actionFs from 'fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  findForbiddenAuthKey,
  findForbiddenEnvFileKey,
  loadConfigEnvironmentFiles,
  loadEnvironmentFile,
} from '../src/utils/env';
import { ErrorCodes, PromptfooActionError } from '../src/utils/errors';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

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
    'OPENSSL_CONF',
    'OPENSSL_CONF_INCLUDE',
    'oPeNsSl_MoDuLeS',
    'OPENSSL_ENGINES',
    'OPENSSL_TRACE',
    'OPENSSL_MALLOC_FAILURES',
    'OPENSSL_FUTURE_CONTROL',
    'NODE_DEBUG',
    'node_debug_native',
    'NODE_TLS_REJECT_UNAUTHORIZED',
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
    'PERL5OPT',
    'PERL5LIB',
    'PYTHONHOME',
    'PYTHON',
    'PYTHONPATH',
    'PYTHONWARNINGS',
    '_PYTHON_SYSCONFIGDATA_NAME',
    'pythonuserbase',
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
    'RUBYOPT',
    'RUBYLIB',
    'RUBYGEMS_GEMDEPS',
    'bundle_gemfile',
    'BUNDLE_APP_CONFIG',
    'BUNDLE_PATH',
    'GEM_HOME',
    'GEM_PATH',
    'GEM_SPEC_CACHE',
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
    'PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION',
    'PROMPTFOO_DISABLE_REMOTE_GENERATION',
    'PROMPTFOO_DISABLE_TELEMETRY',
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
    'GIT_SSH_COMMAND',
    'git_config_count',
    'GIT_EXTERNAL_DIFF',
    'NPM_CONFIG_REGISTRY',
    'npm_config_script_shell',
    'DOTENV_KEY',
    'dotenv_config_path',
    'DOTENV_CONFIG_OVERRIDE',
    '__proto__',
    'CoNsTrUcToR',
    'pRoToTyPe',
    'GITHUB_STEP_SUMMARY',
    'GITHUB_OUTPUT',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'GITHUB_STATE',
  ])('flags forbidden key %s and returns the original-case key', (key) => {
    const environment: Record<string, string> = Object.create(null);
    environment[key] = 'x';
    expect(findForbiddenEnvFileKey(environment)).toBe(key);
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
    vi.restoreAllMocks();
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

  test.each([
    'constructor',
    'prototype',
  ])('rejects reserved object key %s without changing a normal target', (key) => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'keep' };
    const file = writeEnv('.env', key.concat('=polluted\nSAFE=ok\n'));

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
    expect((error as PromptfooActionError).message).toContain(key);
    expect(target).toEqual({ EXISTING: 'keep' });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
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
    expect((error as PromptfooActionError).helpText).toContain(
      'Promptfoo authentication variables only in the trusted workflow environment',
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

  test('preserves trusted application credentials when implicit loading disables override', () => {
    const target: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'trusted-anthropic-key',
      OPENAI_API_KEY: 'trusted-openai-key',
    };
    const file = writeEnv(
      '.env',
      'ANTHROPIC_API_KEY=attacker-key\nOPENAI_API_KEY=attacker-key\nCUSTOM_SETTING=allowed\n',
    );

    loadEnvironmentFile(file, target, false);

    expect(target).toEqual({
      ANTHROPIC_API_KEY: 'trusted-anthropic-key',
      OPENAI_API_KEY: 'trusted-openai-key',
      CUSTOM_SETTING: 'allowed',
    });
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

describe('loadConfigEnvironmentFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfoo-config-env-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFile = (name: string, contents: string): string => {
    const filePath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
  };

  test.each([
    ['promptfooconfig.yaml', 'commandLineOptions:\n  envPath: .env.late\n'],
    ['promptfooconfig.json', '{"commandLineOptions":{"envPath":".env.late"}}'],
  ])('rejects protected values from a %s envPath', (name, config) => {
    const configPath = writeFile(name, config);
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test.each([
    'OPENSSL_MODULES',
    'PROMPTFOO_DISABLE_TELEMETRY',
    'PROMPTFOO_DISABLE_REMOTE_GENERATION',
    'PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION',
  ])('rejects %s from a config-declared envPath', (variableName) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    writeFile('.env.late', `${variableName}=false\n`);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      new RegExp(variableName),
    );
  });

  test('resolves envPath relative to a nested config directory', () => {
    const target: NodeJS.ProcessEnv = {};
    const configPath = writeFile(
      'configs/promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    writeFile('configs/.env.late', 'CUSTOM_PROVIDER_SETTING=nested\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    loadConfigEnvironmentFiles(configPath, tmpDir, target);

    expect(target.CUSTOM_PROVIDER_SETTING).toBe('nested');
  });

  test('matches Promptfoo comma splitting for a nested config envPath', () => {
    const configPath = writeFile(
      'configs/promptfooconfig.yaml',
      "commandLineOptions:\n  envPath: '.env.first, .env.second'\n",
    );
    writeFile('configs/.env.first', 'CUSTOM_PROVIDER_SETTING=first\n');
    writeFile('configs/.env.second', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile(
      '.env.second',
      'PROMPTFOO_CLOUD_API_URL=https://capture.example\n',
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('follows local commandLineOptions fragment refs', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'defs:',
        '  options:',
        '    envPath: .env.late',
        'commandLineOptions:',
        "  $ref: '#/defs/options'",
      ].join('\n'),
    );
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('follows external root and commandLineOptions fragment refs', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './defs/configs.yaml#/configs/real'\n",
    );
    writeFile(
      'defs/configs.yaml',
      [
        'configs:',
        '  decoy:',
        '    commandLineOptions:',
        '      envPath: .env.missing',
        '  real:',
        '    commandLineOptions:',
        "      $ref: './options.json#/items/a~1b~0c'",
      ].join('\n'),
    );
    writeFile(
      'defs/options.json',
      '{"items":{"a/b~c":{"envPath":".env.late"}}}',
    );
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('ignores nested envPath decoys that Promptfoo does not consume', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'metadata:',
        '  commandLineOptions:',
        '    envPath: .env.missing-metadata',
        'commandLineOptions:',
        '  nested:',
        '    envPath: .env.missing-nested',
      ].join('\n'),
    );

    expect(() =>
      loadConfigEnvironmentFiles(configPath, tmpDir, {}),
    ).not.toThrow();
  });

  test('resolves the first external ref from the working directory', () => {
    const configPath = writeFile(
      'evals/promptfooconfig.yaml',
      "$ref: './shared.yaml'\n",
    );
    writeFile(
      'evals/shared.yaml',
      'commandLineOptions:\n  envPath: .env.safe\n',
    );
    writeFile('evals/.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('shared.yaml', 'commandLineOptions:\n  envPath: .env.late\n');
    writeFile(
      'evals/.env.late',
      'PROMPTFOO_CLOUD_API_URL=https://capture.example\n',
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('follows a root ref when local commandLineOptions siblings are present', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      ["$ref: './base.yaml'", 'commandLineOptions:', '  repeat: 2'].join('\n'),
    );
    writeFile('base.yaml', 'commandLineOptions:\n  envPath: .env.late\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('rejects encoded slash characters in config ref paths', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './safe%2Fopts.yaml'\n",
    );
    writeFile('safe/opts.yaml', 'commandLineOptions:\n  envPath: .env.safe\n');
    writeFile(
      'safe%2Fopts.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses an encoded path and cannot be safely preflighted/,
    );
  });

  test('rejects encoded hash characters in config ref paths', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './safe%23opts.yaml'\n",
    );
    writeFile(
      'safe%23opts.yaml',
      'commandLineOptions:\n  envPath: .env.safe\n',
    );
    writeFile('safe#opts.yaml', 'commandLineOptions:\n  envPath: .env.late\n');
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses an encoded path and cannot be safely preflighted/,
    );
  });

  test('rejects an encoded config ref fragment before Promptfoo can decode it twice', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        "  $ref: '#/defs/re%2561l'",
        'defs:',
        "  're%61l':",
        '    envPath: .env.safe',
        '  real:',
        '    envPath: .env.late',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses an encoded fragment and cannot be safely preflighted/,
    );
  });

  test('rejects a config ref fragment with backslashes before Promptfoo normalizes it', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        "  $ref: '#/defs/a\\\\b'",
        'defs:',
        "  'a\\b':",
        '    envPath: .env.safe',
        '  a:',
        '    b:',
        '      envPath: .env.late',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses backslashes in a fragment and cannot be safely preflighted/,
    );
  });

  test('rejects a config ref path with a tab before Promptfoo normalizes it', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  $ref: "./sa\\tfe.yaml"\n',
    );
    writeFile('sa\tfe.yaml', 'envPath: .env.safe\n');
    writeFile('safe.yaml', 'envPath: .env.late\n');
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses control characters and cannot be safely preflighted/,
    );
  });

  test('rejects a config ref path with leading whitespace before Promptfoo normalizes it', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "commandLineOptions:\n  $ref: ' safe.yaml'\n",
    );
    writeFile(' safe.yaml', 'envPath: .env.safe\n');
    writeFile('safe.yaml', 'envPath: .env.late\n');
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses control characters and cannot be safely preflighted/,
    );
  });

  test('rejects a config ref fragment with a tab before Promptfoo normalizes it', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        '  $ref: "#/defs/a\\tb"',
        'defs:',
        '  "a\\tb":',
        '    envPath: .env.safe',
        '  ab:',
        '    envPath: .env.late',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses control characters and cannot be safely preflighted/,
    );
  });

  test('rejects raw backslashes in config refs before Promptfoo normalizes them', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './safe\\\\opts.yaml'\n",
    );
    writeFile('safe\\opts.yaml', 'commandLineOptions:\n  envPath: .env.safe\n');
    writeFile('safe/opts.yaml', 'commandLineOptions:\n  envPath: .env.late\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses backslashes and cannot be safely preflighted/,
    );
  });

  test('rejects a root ref with a local string envPath', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$ref: './base.yaml'",
        'commandLineOptions:',
        '  envPath: .env.safe',
      ].join('\n'),
    );
    writeFile('base.yaml', 'commandLineOptions:\n  envPath: .env.missing\n');
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /combines root and commandLineOptions refs and cannot be safely preflighted/,
    );
  });

  test.each([
    '[]',
    '[.env.safe]',
    '.env.safe',
  ])('rejects an extended commandLineOptions ref with envPath %s', (localPaths) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        "  $ref: '#/defs/options'",
        `  envPath: ${localPaths}`,
        'defs:',
        '  options:',
        '    envPath: [.env.safe, .env.late]',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /combines a commandLineOptions ref with a local envPath and cannot be safely preflighted/,
    );
  });

  test.each([
    '[]',
    '[.env.safe]',
  ])('rejects a root ref with local envPath %s and a nested commandLineOptions ref', (localPaths) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$ref: '#/defs/base'",
        'commandLineOptions:',
        `  envPath: ${localPaths}`,
        'defs:',
        '  base:',
        '    commandLineOptions:',
        "      $ref: '#/defs/options'",
        '  options:',
        '    envPath: [.env.safe, .env.late]',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /combines root and commandLineOptions refs and cannot be safely preflighted/,
    );
  });

  test('rejects nested extended refs whose envPath precedence is ambiguous', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$ref: '#/defs/base'",
        'commandLineOptions:',
        "  $ref: '#/defs/localopts'",
        'defs:',
        '  base:',
        '    commandLineOptions:',
        '      envPath: .env.late',
        '  localopts:',
        '    envPath: .env.safe',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /combines root and commandLineOptions refs and cannot be safely preflighted/,
    );
  });

  test('rejects refs whose resolution scope can be changed by a root $id', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$schema: 'https://json-schema.org/draft/2020-12/schema'",
        "$id: 'https://capture.example/config'",
        'commandLineOptions:',
        "  $ref: './opts.yaml'",
      ].join('\n'),
    );
    writeFile('opts.yaml', 'envPath: .env.late\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses \$id and cannot be safely preflighted/,
    );
  });

  test('rejects refs whose resolution scope can be changed by a nested $id', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$schema: 'https://json-schema.org/draft/2020-12/schema'",
        "$ref: '#/defs/eval'",
        'defs:',
        '  eval:',
        "    $id: './alt/'",
        '    commandLineOptions:',
        "      $ref: './opts.yaml'",
      ].join('\n'),
    );
    writeFile('opts.yaml', 'envPath: .env.safe\n');
    writeFile('alt/opts.yaml', 'envPath: .env.late\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses \$id and cannot be safely preflighted/,
    );
  });

  test('rejects templated envPath values before Promptfoo can compute them', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'env:',
        "  PICK: '.env.late'",
        'commandLineOptions:',
        "  envPath: '{{ env.PICK }}'",
      ].join('\n'),
    );
    writeFile('{{ env.PICK }}', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /cannot be safely preflighted/,
    );
  });

  test.each([
    'promptfooconfig.js',
    'promptfooconfig.ts',
  ])('rejects executable config %s before evaluation', (name) => {
    const configPath = writeFile(name, 'export default {};\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Executable Promptfoo config/,
    );
  });

  test('rejects a config glob that cannot be preflighted', () => {
    writeFile(
      'evals/promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );

    expect(() =>
      loadConfigEnvironmentFiles(
        path.join(tmpDir, 'evals', 'promptfoo*.yaml'),
        tmpDir,
        {},
      ),
    ).toThrow(/config glob.*cannot be safely preflighted/i);
  });

  test('rejects a brace-expanded config glob that cannot be preflighted', () => {
    writeFile(
      'evals/promptfooconfig-a.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    writeFile(
      'evals/promptfooconfig-b.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    writeFile(
      'evals/promptfooconfig-{a,b}.yaml',
      'commandLineOptions:\n  envPath: .env.safe\n',
    );

    expect(() =>
      loadConfigEnvironmentFiles(
        path.join(tmpDir, 'evals', 'promptfooconfig-{a,b}.yaml'),
        tmpDir,
        {},
      ),
    ).toThrow(/cannot be safely preflighted/);
  });

  test('ignores unrelated provider parameter schemas that contain $id', () => {
    const target: NodeJS.ProcessEnv = {};
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'providers:',
        '  - id: openai:gpt-4.1-mini',
        '    config:',
        '      tools:',
        '        - type: function',
        '          function:',
        '            parameters:',
        "              $id: 'https://example.com/tool-schema'",
        'commandLineOptions:',
        '  envPath: .env.safe',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');

    loadConfigEnvironmentFiles(configPath, tmpDir, target);

    expect(target.CUSTOM_PROVIDER_SETTING).toBe('safe');
  });

  test('rejects a remote config identifier that cannot be preflighted', () => {
    expect(() =>
      loadConfigEnvironmentFiles(
        '123e4567-e89b-12d3-a456-426614174000',
        tmpDir,
        {},
      ),
    ).toThrow(/cannot be safely preflighted/);
  });

  test('rejects executable config refs before evaluation', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './computed.ts'\n",
    );
    writeFile('computed.ts', 'export default {};\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Executable Promptfoo config/,
    );
  });

  test('rejects an executable config hidden behind a symlink', () => {
    const executable = writeFile('computed.js', 'export default {};\n');
    const configPath = path.join(tmpDir, 'promptfooconfig.yaml');
    fs.symlinkSync(executable, configPath);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Executable Promptfoo config/,
    );
  });

  test('rejects an executable lexical config symlink with a YAML target', () => {
    const actualConfig = writeFile(
      'configs/actual.yaml',
      'module.exports = {};\n',
    );
    const configPath = path.join(tmpDir, 'promptfooconfig.js');
    fs.symlinkSync(actualConfig, configPath);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Executable Promptfoo config/,
    );
  });

  test.each([
    ['promptfooconfig', 'cjs'],
    ['promptfooconfig', 'cts'],
    ['promptfooconfig', 'js'],
    ['promptfooconfig', 'mjs'],
    ['promptfooconfig', 'mts'],
    ['promptfooconfig', 'ts'],
    ['redteam', 'js'],
  ])('rejects an implicit executable %s.%s alongside a selected config', (configName, extension) => {
    const configPath = writeFile(
      'evals/promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.safe\n',
    );
    writeFile(`${configName}.${extension}`, 'module.exports = {};\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Implicit Promptfoo config.*cannot be safely preflighted/,
    );
  });

  test('rejects an implicit YAML config alongside a selected config', () => {
    const configPath = writeFile(
      'evals/promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.safe\n',
    );
    writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  grader: file://./evil.js\n',
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Implicit Promptfoo config.*cannot be safely preflighted/,
    );
  });

  test('resolves envPath from the lexical directory of a symlinked config', () => {
    const actualConfig = writeFile(
      'configs/actual.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );
    const configPath = path.join(tmpDir, 'promptfooconfig.yaml');
    fs.symlinkSync(actualConfig, configPath);
    writeFile('configs/.env.late', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('resolves nested refs from the lexical path of a symlinked ref', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './shared.yaml'\n",
    );
    const actualRef = writeFile(
      'defs/actual.yaml',
      "commandLineOptions:\n  $ref: './opts.yaml'\n",
    );
    fs.symlinkSync(actualRef, path.join(tmpDir, 'shared.yaml'));
    writeFile('defs/opts.yaml', 'envPath: .env.safe\n');
    writeFile('opts.yaml', 'envPath: .env.late\n');
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    writeFile('.env.late', 'PROMPTFOO_CLOUD_API_URL=https://capture.example\n');

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /PROMPTFOO_CLOUD_API_URL/,
    );
  });

  test('rejects an envPath symlink that escapes the working directory', () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'promptfoo-outside-'),
    );
    const outsideFile = path.join(outsideDir, '.env.late');
    fs.writeFileSync(outsideFile, 'CUSTOM_PROVIDER_SETTING=outside\n');
    fs.symlinkSync(outsideFile, path.join(tmpDir, '.env.late'));
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.late\n',
    );

    try {
      expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
        /must stay within the working directory/,
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects an oversized config before reading it', () => {
    const configPath = writeFile('promptfooconfig.yaml', '');
    fs.truncateSync(configPath, 2 * 1024 * 1024 + 1);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /exceeds the envPath preflight size limit/,
    );
  });

  test('rejects a non-regular config before reading it', () => {
    const configPath = path.join(tmpDir, 'promptfooconfig.yaml');
    fs.mkdirSync(configPath);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /must be a regular file/,
    );
  });

  test('propagates unexpected errors while checking implicit configs', () => {
    const configPath = writeFile('promptfooconfig.yaml', '{}');

    expect(() =>
      loadConfigEnvironmentFiles(
        configPath,
        path.join(tmpDir, 'x'.repeat(256)),
        {},
      ),
    ).toThrow(/ENAMETOOLONG|name too long/i);
  });

  test('rejects a config that exceeds the size limit after it is read', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'x'.repeat(2 * 1024 * 1024 + 1),
    );
    vi.mocked(actionFs.statSync).mockReturnValueOnce({
      isFile: () => true,
      size: 1,
    } as fs.Stats);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /exceeds the envPath preflight size limit/,
    );
  });

  test('rejects a config with more than 10,000 YAML nodes', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      `items:\n${'- {}\n'.repeat(10_001)}`,
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /exceeds the envPath preflight traversal limit/,
    );
  });

  test('does not expand atomic YAML values during config traversal', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        `payload: !!binary ${Buffer.alloc(128 * 1024).toString('base64')}`,
        'createdAt: 2024-01-01T00:00:00Z',
        'labels: !!set { safe: null }',
        'commandLineOptions:',
        '  envPath: .env.safe',
      ].join('\n'),
    );
    writeFile('.env.safe', 'CUSTOM_PROVIDER_SETTING=safe\n');
    const target: NodeJS.ProcessEnv = {};

    loadConfigEnvironmentFiles(configPath, tmpDir, target);

    expect(target.CUSTOM_PROVIDER_SETTING).toBe('safe');
  });

  test('rejects a remote protocol config ref', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: 'https://capture.example/config.yaml'\n",
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /must stay within the working directory/,
    );
  });

  test.each([
    ['#options', /Unsupported Promptfoo config \$ref fragment/],
    ['#/defs/bad~2key', /Invalid Promptfoo config \$ref fragment/],
    ['#/defs/missing', /Promptfoo config \$ref fragment.*was not found/],
  ])('rejects the invalid commandLineOptions fragment %s', (fragment, error) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        `  $ref: '${fragment}'`,
        'defs:',
        '  options:',
        '    envPath: .env.safe',
      ].join('\n'),
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      error,
    );
  });

  test('rejects an ancestor $id encountered while traversing a ref pointer', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        "$ref: '#/defs/wrapper/eval'",
        'defs:',
        '  wrapper:',
        "    $id: './alternate/'",
        '    eval:',
        '      commandLineOptions:',
        '        envPath: .env.safe',
      ].join('\n'),
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /uses \$id and cannot be safely preflighted/,
    );
  });

  test.each([
    'null',
    '7',
    '[]',
    "'value'",
  ])('ignores a non-object commandLineOptions value %s', (value) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      `commandLineOptions: ${value}\n`,
    );

    expect(() =>
      loadConfigEnvironmentFiles(configPath, tmpDir, {}),
    ).not.toThrow();
  });

  test('rejects a commandLineOptions ref chain that exceeds the depth limit', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "commandLineOptions:\n  $ref: './options-0.yaml'\n",
    );
    for (let index = 0; index <= 100; index++) {
      writeFile(
        `options-${index}.yaml`,
        `$ref: './options-${index + 1}.yaml'\n`,
      );
    }

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /exceeds the envPath preflight traversal limit/,
    );
  });

  test('rejects a root config ref chain that exceeds the reference limit', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      "$ref: './config-0.yaml'\n",
    );
    for (let index = 0; index <= 100; index++) {
      writeFile(`config-${index}.yaml`, `$ref: './config-${index + 1}.yaml'\n`);
    }

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /exceeds the envPath preflight reference limit/,
    );
  });

  test('stops safely when a config ref chain is circular', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      [
        'commandLineOptions:',
        "  $ref: '#/defs/first'",
        'defs:',
        '  first:',
        "    $ref: '#/defs/second'",
        '  second:',
        "    $ref: '#/defs/first'",
      ].join('\n'),
    );

    expect(() =>
      loadConfigEnvironmentFiles(configPath, tmpDir, {}),
    ).not.toThrow();
  });

  test('loads an absolute envPath within the working directory', () => {
    const target: NodeJS.ProcessEnv = {};
    const envPath = writeFile(
      '.env.absolute',
      'CUSTOM_PROVIDER_SETTING=safe\n',
    );
    const configPath = writeFile(
      'promptfooconfig.yaml',
      `commandLineOptions:\n  envPath: ${JSON.stringify(envPath)}\n`,
    );

    loadConfigEnvironmentFiles(configPath, tmpDir, target);

    expect(target.CUSTOM_PROVIDER_SETTING).toBe('safe');
  });

  test('rejects an envPath that lexically escapes the working directory', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: ../outside.env\n',
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /must stay within the working directory/,
    );
  });

  test('rejects a missing config-declared envPath', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.missing\n',
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Config environment file.*not found/,
    );
  });

  test('rejects a config-declared envPath that is not a regular file', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: env-directory\n',
    );
    fs.mkdirSync(path.join(tmpDir, 'env-directory'));

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Config environment file.*must be a regular file/,
    );
  });

  test('rejects an oversized config-declared envPath before parsing it', () => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: .env.large\n',
    );
    const envPath = writeFile('.env.large', 'CUSTOM_PROVIDER_SETTING=safe\n');
    fs.truncateSync(envPath, 2 * 1024 * 1024 + 1);

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Config environment file.*exceeds the envPath preflight size limit/,
    );
  });

  test.each([
    '7',
    '[.env.safe, 7]',
  ])('rejects the malformed envPath value %s', (value) => {
    const configPath = writeFile(
      'promptfooconfig.yaml',
      `commandLineOptions:\n  envPath: ${value}\n`,
    );

    expect(() => loadConfigEnvironmentFiles(configPath, tmpDir, {})).toThrow(
      /Invalid commandLineOptions.envPath/,
    );
  });

  test('loads a valid list of config-declared envPath files', () => {
    const target: NodeJS.ProcessEnv = {};
    const configPath = writeFile(
      'promptfooconfig.yaml',
      'commandLineOptions:\n  envPath: [.env.first, .env.second]\n',
    );
    writeFile('.env.first', 'CUSTOM_PROVIDER_SETTING=first\n');
    writeFile('.env.second', 'CUSTOM_PROVIDER_SETTING=second\n');

    loadConfigEnvironmentFiles(configPath, tmpDir, target);

    expect(target.CUSTOM_PROVIDER_SETTING).toBe('second');
  });
});
