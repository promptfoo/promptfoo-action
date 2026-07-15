import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findForbiddenEnvFileKey, loadEnvironmentFile } from '../src/utils/env';
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
    'METADATA_SERVER_DETECTION',
    'VERTEX_REGION',
    'VERTEX_PROJECT_ID',
    'WATSONX_AI_PROJECT_ID',
    'WATSONX_AI_AUTH_TYPE',
    'WATSONX_AI_BEARER_TOKEN',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'GCLOUD_PROJECT',
    'cloudsdk_config',
    'CLOUDSDK_PYTHON',
    'AZURE_AI_PROJECT_URL',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
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
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    'PROMPTFOO_REMOTE_APP_BASE_URL',
    'PROMPTFOO_SHARING_APP_BASE_URL',
    'PROMPTFOO_CACHE_PATH',
    'PROMPTFOO_CONFIG_DIR',
    'PROMPTFOO_PASS_RATE_THRESHOLD',
    'PROMPTFOO_API_KEY',
    'PROMPTFOO_CACHE_TTL',
    'PROMPTFOO_AUTHOR',
    'CI',
    'PROMPTFOO_DISABLE_SHARING',
    'PROMPTFOO_DISABLE_TELEMETRY',
    'PROMPTFOO_DISABLE_REMOTE_GENERATION',
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
    'PROMPTFOO_CACHE_MAX_SIZE',
    'PROMPTFOO_CACHE_MAX_FILE_COUNT',
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

  test.each([
    'PROMPTFOO_DISABLE_TELEMETRY',
    'PROMPTFOO_DISABLE_REMOTE_GENERATION',
    'PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION',
  ])('rejects privacy control %s without leaking sibling values', (key) => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'keep' };
    const file = writeEnv('.env', `SAFE=must-not-merge\n${key}=false\n`);

    expect(() => loadEnvironmentFile(file, target)).toThrow(key);
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
