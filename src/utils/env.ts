import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { hasMagic as hasGlobMagic } from 'glob';
import {
  binaryTag,
  CORE_SCHEMA,
  load as loadYaml,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from 'js-yaml';
import * as path from 'path';
import { ErrorCodes, PromptfooActionError } from './errors';

// Variables that let a repository-controlled env file execute code, redirect an
// inherited provider credential, or change the action's pass/fail/filesystem
// behavior. Keep this explicit and grouped so the trust boundary is easy
// to audit. Legitimate overrides belong in the trusted workflow environment.
const FORBIDDEN_ENV_FILE_KEYS = new Set([
  '__PROTO__',
  'ABLIT_API_BASE_URL',
  'AI21_API_BASE_URL',
  'ALL_PROXY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_ENVIRONMENT_ID',
  'ANTHROPIC_ENVIRONMENT_KEY',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_SCOPE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'API_HOST',
  'APPDATA',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_BEDROCK_BASE_URL',
  'AWS_BEDROCK_REGION',
  'AWS_CA_BUNDLE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONFIG_FILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_DEFAULT_REGION',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_ENDPOINT_URL',
  'AWS_LOGIN_CACHE_DIRECTORY',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_ADDITIONALLY_ALLOWED_TENANTS',
  'AZURE_AI_PROJECT_URL',
  'AZURE_API_BASE_URL',
  'AZURE_API_HOST',
  'AZURE_AUTHORITY_HOST',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_ID',
  'AZURE_CONTENT_SAFETY_ENDPOINT',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_OPENAI_API_BASE_URL',
  'AZURE_OPENAI_API_HOST',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_POD_IDENTITY_AUTHORITY_HOST',
  'AZURE_REGIONAL_AUTHORITY_NAME',
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_TENANT_ID',
  'AZURE_TOKEN_CREDENTIALS',
  'AZURE_TOKEN_SCOPE',
  'AR',
  'AR_HOST',
  'AR_TARGET',
  'BASH_ENV',
  'CDP_DOMAIN',
  'CC',
  'CC_HOST',
  'CC_TARGET',
  'CGO_CFLAGS',
  'CGO_CPPFLAGS',
  'CGO_CXXFLAGS',
  'CGO_LDFLAGS',
  'CI',
  'CFLAGS',
  'CFLAGS_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'CLAWDBOT_GATEWAY_URL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
  'CONSTRUCTOR',
  'COMPILER_PATH',
  'CODEX_HOME',
  'COMSPEC',
  'CURL_CA_BUNDLE',
  'CPATH',
  'CPPFLAGS',
  'CPPFLAGS_HOST',
  'CPLUS_INCLUDE_PATH',
  'C_INCLUDE_PATH',
  'CXX',
  'CXX_HOST',
  'CXX_TARGET',
  'CXXFLAGS',
  'CXXFLAGS_HOST',
  'DATABRICKS_WORKSPACE_URL',
  'DOCKER_MODEL_RUNNER_BASE_URL',
  'DOTENV_KEY',
  'ENVOY_API_BASE_URL',
  'ENV',
  'FIREWORKS_API_BASE_URL',
  'FC',
  'GCCGO',
  'GCCGOTOOLDIR',
  'GCC_EXEC_PREFIX',
  'GCE_METADATA_HOST',
  'GCE_METADATA_IP',
  'GCLOUD_PROJECT',
  'GEM_HOME',
  'GEM_PATH',
  'GEM_SPEC_CACHE',
  'GENAI_ENDPOINT',
  'GOAUTH',
  'GOBIN',
  'GOCACHE',
  'GOCACHEPROG',
  'GOCOVERDIR',
  'GODEBUG',
  'GOENV',
  'GOFLAGS',
  'GOINSECURE',
  'GOMODCACHE',
  'GONOPROXY',
  'GONOSUMDB',
  'GOPATH',
  'GOPRIVATE',
  'GOPROXY',
  'GOROOT',
  'GOSUMDB',
  'GOTELEMETRYDIR',
  'GOTMPDIR',
  'GOTOOLDIR',
  'GOTOOLCHAIN',
  'GOVCS',
  'GOWORK',
  'GYP_DEFINES',
  'GYP_CONFIG_DIR',
  'GYP_GENERATORS',
  'GYP_GENERATOR_OUTPUT',
  'GYP_MSVS_OVERRIDE_PATH',
  'GOOGLE_API_BASE_URL',
  'GOOGLE_API_HOST',
  'GOOGLE_API_CERTIFICATE_CONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GHA_CREDS_PATH',
  'GOOGLE_LOCATION',
  'GOOGLE_PROJECT_ID',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
  'IDENTITY_SERVER_THUMBPRINT',
  'IMDS_ENDPOINT',
  'LANGFUSE_HOST',
  'LDFLAGS',
  'LDFLAGS_HOST',
  'LITELLM_API_BASE',
  'LINK_HOST',
  'LINK_TARGET',
  'LIBRARY_PATH',
  'LLAMA_BASE_URL',
  'LOCALAPPDATA',
  'LOCALAI_BASE_URL',
  'MAKE',
  'MAKEFLAGS',
  'MAKEFILES',
  'MISTRAL_API_BASE_URL',
  'MISTRAL_API_HOST',
  'METADATA_SERVER_DETECTION',
  'MLFLOW_GATEWAY_URL',
  'MSI_ENDPOINT',
  'MSI_SECRET',
  'NVIDIA_API_BASE_URL',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_GYP_FORCE_PYTHON',
  'NODEJS_ORG_MIRROR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NO_PROXY',
  'OLLAMA_BASE_URL',
  'OBJC_INCLUDE_PATH',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_HOST',
  'OPENAI_BASE_URL',
  'OPENAI_CUSTOM_HEADERS',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_GATEWAY_PORT',
  'OPENCLAW_GATEWAY_URL',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_GIT_BASH_PATH',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'PALM_API_HOST',
  'PATH',
  'PATHEXT',
  'PKG_CONFIG',
  'PKG_CONFIG_LIBDIR',
  'PKG_CONFIG_PATH',
  'PKG_CONFIG_SYSROOT_DIR',
  'PERL5LIB',
  'PERL5OPT',
  'PERLLIB',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST',
  'PLAYWRIGHT_DOWNLOAD_HOST',
  'PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST',
  'PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST',
  'PORTKEY_API_BASE_URL',
  'PROMPTFOO_API_KEY',
  'PROMPTFOO_AUTHOR',
  'PROMPTFOO_CACHE_ENABLED',
  'PROMPTFOO_CACHE_MAX_FILE_COUNT',
  'PROMPTFOO_CACHE_MAX_SIZE',
  'PROMPTFOO_CACHE_PATH',
  'PROMPTFOO_CACHE_TTL',
  'PROMPTFOO_CACHE_TYPE',
  'PROMPTFOO_CA_CERT_PATH',
  'PROMPTFOO_CLOUD_API_URL',
  'PROMPTFOO_CONFIG_DIR',
  'PROMPTFOO_DISABLE_CONVERSATION_VAR',
  'PROMPTFOO_DISABLE_DEBUG_LOG',
  'PROMPTFOO_DISABLE_ERROR_LOG',
  'PROMPTFOO_DISABLE_OBJECT_STRINGIFY',
  'PROMPTFOO_DISABLE_REDTEAM_MODERATION',
  'PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION',
  'PROMPTFOO_DISABLE_REF_PARSER',
  'PROMPTFOO_DISABLE_REMOTE_GENERATION',
  'PROMPTFOO_DISABLE_SHARING',
  'PROMPTFOO_DISABLE_TELEMETRY',
  'PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS',
  'PROMPTFOO_DISABLE_TEMPLATING',
  'PROMPTFOO_DISABLE_VAR_EXPANSION',
  'PROMPTFOO_FAILED_TEST_EXIT_CODE',
  'PROMPTFOO_INSECURE_SSL',
  'PROMPTFOO_JKS_CERT_PATH',
  'PROMPTFOO_LOG_DIR',
  'PROMPTFOO_MEDIA_PATH',
  'PROMPTFOO_OTEL_DEBUG',
  'PROMPTFOO_OTEL_ENABLED',
  'PROMPTFOO_OTEL_ENDPOINT',
  'PROMPTFOO_OTEL_LOCAL_EXPORT',
  'PROMPTFOO_OTEL_SERVICE_NAME',
  'PROMPTFOO_PASS_RATE_THRESHOLD',
  'PROMPTFOO_PFX_CERT_PATH',
  'PROMPTFOO_PYTHON',
  'PROMPTFOO_REMOTE_API_BASE_URL',
  'PROMPTFOO_REMOTE_APP_BASE_URL',
  'PROMPTFOO_REMOTE_GENERATION_URL',
  'PROMPTFOO_RUBY',
  'PROMPTFOO_SELF_HOSTED',
  'PROMPTFOO_SHARING_APP_BASE_URL',
  'PROMPTFOO_STRICT_FILES',
  'PROMPTFOO_TRACING_ENABLED',
  'PROMPTFOO_UNALIGNED_INFERENCE_ENDPOINT',
  'PROTOTYPE',
  'PUPPETEER_CACHE_DIR',
  'PUPPETEER_CHROME_DOWNLOAD_BASE_URL',
  'PUPPETEER_DOWNLOAD_BASE_URL',
  'PUPPETEER_DOWNLOAD_HOST',
  'PUPPETEER_EXECUTABLE_PATH',
  'PYTHONEXECUTABLE',
  'PYTHONHOME',
  'PYTHON',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHONWARNINGS',
  '_PYTHON_SYSCONFIGDATA_NAME',
  'REQUESTS_CA_BUNDLE',
  'RUBYGEMS_GEMDEPS',
  'RUBYLIB',
  'RUBYOPT',
  'SHELL',
  'SHAREPOINT_BASE_URL',
  'SHAREPOINT_CERT_PATH',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_TENANT_ID',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SNOWFLAKE_ACCOUNT_IDENTIFIER',
  'USERPROFILE',
  'VERCEL_AI_GATEWAY_BASE_URL',
  'VERTEX_API_HOST',
  'VERTEX_REGION',
  'VERTEX_PROJECT_ID',
  'WATSONX_AI_AUTH_TYPE',
  'WATSONX_AI_BEARER_TOKEN',
  'WATSONX_AI_PROJECT_ID',
  'VOYAGE_API_BASE_URL',
  'XAI_API_BASE_URL',
  'XDG_CONFIG_HOME',
]);

// Cover AWS endpoint overrides plus Bundler, dotenv preload, Google Cloud SDK,
// cgo/native/OpenSSL loader (including LD_AUDIT), and git/npm controls inherited by children.
const FORBIDDEN_ENV_FILE_PREFIXES = [
  'AWS_ENDPOINT_URL_',
  'BUNDLE_',
  'CGO_',
  'CLOUDSDK_',
  'DOTENV_CONFIG_',
  'GITHUB_',
  'DYLD_',
  'GIT_',
  'LD_',
  'NPM_CONFIG_',
  'OPENSSL_',
  'OTEL_EXPORTER_OTLP_',
  'PROMPTFOO_STRIP_',
];

// Promptfoo authentication settings. A repository-controlled env file must not
// be able to pair an inherited API key with an attacker-chosen host — the
// action's preflight would otherwise send the bearer token to that host — so
// both the credential and its destination must come from trusted workflow
// state, not from a checked-in file.
const FORBIDDEN_AUTH_KEYS = new Set([
  'PROMPTFOO_API_KEY',
  'PROMPTFOO_REMOTE_API_BASE_URL',
]);

export function findForbiddenEnvFileKey(
  environment: Record<string, string>,
): string | undefined {
  return Object.keys(environment).find((key) => {
    const normalizedKey = key.toUpperCase();
    return (
      FORBIDDEN_ENV_FILE_KEYS.has(normalizedKey) ||
      FORBIDDEN_ENV_FILE_PREFIXES.some((prefix) =>
        normalizedKey.startsWith(prefix),
      )
    );
  });
}

export function findForbiddenAuthKey(
  environment: Record<string, string>,
): string | undefined {
  return Object.keys(environment).find((key) =>
    FORBIDDEN_AUTH_KEYS.has(key.toUpperCase()),
  );
}

export function loadEnvironmentFile(
  envFilePath: string | string[],
  targetEnvironment: NodeJS.ProcessEnv = process.env,
  override = true,
): void {
  // Parse into an isolated object so untrusted values cannot affect this action
  // or a child process before they have passed the process-control check.
  const fileEnvironment: Record<string, string> = Object.create(null);
  const result = dotenv.config({
    path: envFilePath,
    override: true,
    processEnv: fileEnvironment,
    quiet: true,
  });

  if (result.error) {
    throw new PromptfooActionError(
      `Failed to load ${envFilePath}: ${result.error.message}`,
      ErrorCodes.ENV_FILE_LOAD_ERROR,
      'Check that the file exists and has valid .env format',
    );
  }

  const forbiddenAuthKey = findForbiddenAuthKey(fileEnvironment);
  if (forbiddenAuthKey) {
    throw new PromptfooActionError(
      `Environment file ${envFilePath} sets protected authentication variable ${forbiddenAuthKey}`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Configure Promptfoo authentication variables only in the trusted workflow environment.',
    );
  }

  const forbiddenKey = findForbiddenEnvFileKey(fileEnvironment);
  if (forbiddenKey) {
    throw new PromptfooActionError(
      `Environment file ${envFilePath} sets forbidden process-control variable ${forbiddenKey}`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Remove reserved object keys and process, interpreter, provider-endpoint, TLS/proxy, cache/config-path, telemetry/tracing, and pass-rate controls from repository environment files. Configure trusted controls in the workflow environment instead.',
    );
  }

  // Merge into the shared environment (process.env by default) only after the
  // file has fully passed the process-control and authentication checks. This
  // action forwards process.env to the promptfoo child. Validation therefore
  // has to happen here, at the untrusted-file boundary — not on the final child
  // environment, which legitimately inherits the trusted runner's own PATH,
  // provider endpoints, cache path, threshold, and workflow-set auth. Preserves
  // the documented later-file-wins ordering for ordinary application variables.
  for (const [key, value] of Object.entries(fileEnvironment)) {
    if (override || targetEnvironment[key] === undefined) {
      targetEnvironment[key] = value;
    }
  }
}

function assertWorkspacePath(
  filePath: string,
  workingDirectory: string,
  source: string,
): string {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(workingDirectory, resolvedPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new PromptfooActionError(
      `${source} ${filePath} must stay within the working directory`,
      ErrorCodes.INVALID_CONFIGURATION,
      `Use a repository-local ${source}.`,
    );
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new PromptfooActionError(
      `${source} ${resolvedPath} not found`,
      ErrorCodes.INVALID_CONFIGURATION,
      `Check the configured ${source}.`,
    );
  }
  const realWorkingDirectory = fs.realpathSync(workingDirectory);
  const realPath = fs.realpathSync(resolvedPath);
  const realRelativePath = path.relative(realWorkingDirectory, realPath);
  if (
    realRelativePath === '..' ||
    realRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelativePath)
  ) {
    throw new PromptfooActionError(
      `${source} ${filePath} must stay within the working directory`,
      ErrorCodes.INVALID_CONFIGURATION,
      `Use a repository-local ${source}.`,
    );
  }
  return realPath;
}

function isUnsupportedWindowsPath(filePath: string): boolean {
  return (
    /^[A-Za-z]:(?![\\/])/.test(filePath) ||
    (!path.isAbsolute(filePath) && path.win32.isAbsolute(filePath))
  );
}

/** Preflight environment files that Promptfoo loads after resolving config. */
export function loadConfigEnvironmentFiles(
  configPath: string,
  workingDirectory: string,
  targetEnvironment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    isUnsupportedWindowsPath(configPath) ||
    hasGlobMagic(configPath, {
      magicalBraces: true,
      windowsPathsNoEscape: true,
    })
  ) {
    throw new PromptfooActionError(
      `Promptfoo config glob ${configPath} cannot be safely preflighted for commandLineOptions.envPath`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Use a single YAML or JSON Promptfoo config.',
    );
  }
  if (!fs.existsSync(configPath)) {
    throw new PromptfooActionError(
      `Promptfoo config ${configPath} cannot be safely preflighted for commandLineOptions.envPath`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Use a repository-local YAML or JSON Promptfoo config.',
    );
  }
  const lexicalConfigPath = path.resolve(configPath);
  const realSelectedConfigPath = fs.realpathSync(lexicalConfigPath);
  for (const configName of ['promptfooconfig', 'redteam']) {
    for (const extension of [
      'yaml',
      'yml',
      'json',
      'cjs',
      'cts',
      'js',
      'mjs',
      'mts',
      'ts',
    ]) {
      const defaultConfigPath = path.resolve(
        workingDirectory,
        `${configName}.${extension}`,
      );
      try {
        fs.lstatSync(defaultConfigPath);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue;
        }
        throw error;
      }
      if (
        defaultConfigPath !== lexicalConfigPath &&
        (!/\.(?:ya?ml|json)$/i.test(defaultConfigPath) ||
          !/\.(?:ya?ml|json)$/i.test(lexicalConfigPath) ||
          fs.realpathSync(defaultConfigPath) !== realSelectedConfigPath)
      ) {
        throw new PromptfooActionError(
          `Implicit Promptfoo config ${defaultConfigPath} cannot be safely preflighted alongside ${configPath}`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Remove the implicit promptfooconfig or redteam config, or select it directly.',
        );
      }
      break;
    }
  }
  if (!/\.(?:ya?ml|json)$/i.test(lexicalConfigPath)) {
    throw new PromptfooActionError(
      `Executable Promptfoo config ${configPath} cannot be safely preflighted for commandLineOptions.envPath`,
      ErrorCodes.INVALID_CONFIGURATION,
      "Use a YAML or JSON config and move environment files to the action's env-files input.",
    );
  }
  const realConfigPath = assertWorkspacePath(
    lexicalConfigPath,
    workingDirectory,
    'Promptfoo config',
  );
  const maxConfigBytes = 2 * 1024 * 1024;
  const maxConfigDepth = 100;
  const maxConfigNodes = 10_000;
  const maxConfigRefs = 100;
  const schema = CORE_SCHEMA.withTags(
    mergeTag,
    binaryTag,
    timestampTag,
    omapTag,
    pairsTag,
    setTag,
  );
  const loadedConfigs = new Map<string, unknown>();
  const readConfigFile = (filePath: string): unknown => {
    if (!/\.(?:ya?ml|json)$/i.test(filePath)) {
      throw new PromptfooActionError(
        `Executable Promptfoo config ${filePath} cannot be safely preflighted for commandLineOptions.envPath`,
        ErrorCodes.INVALID_CONFIGURATION,
        "Use a YAML or JSON config and move environment files to the action's env-files input.",
      );
    }
    const cachedConfig = loadedConfigs.get(filePath);
    if (cachedConfig !== undefined) {
      return cachedConfig;
    }
    const configStats = fs.statSync(filePath);
    if (!configStats.isFile()) {
      throw new PromptfooActionError(
        `Promptfoo config ${filePath} must be a regular file`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use a regular YAML or JSON Promptfoo config file.',
      );
    }
    if (configStats.size > maxConfigBytes) {
      throw new PromptfooActionError(
        `Promptfoo config ${filePath} exceeds the envPath preflight size limit`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Reduce the Promptfoo config or referenced config size.',
      );
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > maxConfigBytes) {
      throw new PromptfooActionError(
        `Promptfoo config ${filePath} exceeds the envPath preflight size limit`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Reduce the Promptfoo config or referenced config size.',
      );
    }
    const config = loadYaml(content, { schema }) as unknown;
    const inspectedObjects = new WeakSet<object>();
    const pendingValues: unknown[] = [config];
    let inspectedNodeCount = 0;
    while (pendingValues.length > 0) {
      const value = pendingValues.pop();
      if (
        typeof value !== 'object' ||
        value === null ||
        (!Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype) ||
        inspectedObjects.has(value)
      ) {
        continue;
      }
      inspectedObjects.add(value);
      inspectedNodeCount++;
      if (inspectedNodeCount > maxConfigNodes) {
        throw new PromptfooActionError(
          `Promptfoo config ${filePath} exceeds the envPath preflight traversal limit`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Reduce the Promptfoo config nesting or referenced config size.',
        );
      }
      pendingValues.push(...Object.values(value));
    }
    loadedConfigs.set(filePath, config);
    return config;
  };

  const config = readConfigFile(realConfigPath);
  const inspectedRefs = new Set<string>();
  const configuredPaths: string[] = [];
  const refsDisabled = ['1', 'true', 'yes', 'yup', 'yeppers'].includes(
    (targetEnvironment.PROMPTFOO_DISABLE_REF_PARSER ?? '').toLowerCase(),
  );

  const resolveRef = (
    ref: string,
    sourceFile: string,
  ): { config: unknown; file: string; fragment: string } => {
    const hashIndex = ref.indexOf('#');
    const refPath = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex);
    if (refPath && /^[a-z][a-z\d+.-]*:/i.test(refPath)) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${refPath} must stay within the working directory`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use a repository-local Promptfoo config $ref.',
      );
    }
    if (refPath.includes('\\')) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${refPath} uses backslashes and cannot be safely preflighted`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use forward slashes in repository-local Promptfoo config refs.',
      );
    }
    const hasControlCharacters = [...(refPath + fragment)].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    const hasOuterWhitespace =
      refPath.length > 0 &&
      (refPath.charCodeAt(0) <= 32 ||
        refPath.charCodeAt(refPath.length - 1) <= 32);
    if (hasControlCharacters || hasOuterWhitespace) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${ref} uses control characters and cannot be safely preflighted`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use a repository-local Promptfoo config ref without control characters.',
      );
    }
    if (refPath.includes('%')) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${refPath} uses an encoded path and cannot be safely preflighted`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use an unencoded repository-local Promptfoo config ref path.',
      );
    }
    if (fragment.includes('%')) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${fragment} uses an encoded fragment and cannot be safely preflighted`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use an unencoded JSON pointer fragment in the Promptfoo config ref.',
      );
    }
    if (fragment.includes('\\')) {
      throw new PromptfooActionError(
        `Promptfoo config $ref ${fragment} uses backslashes in a fragment and cannot be safely preflighted`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use forward slashes in the Promptfoo config JSON pointer fragment.',
      );
    }
    const refBase =
      sourceFile === lexicalConfigPath
        ? path.resolve(workingDirectory)
        : path.dirname(sourceFile);
    const lexicalRefFile = refPath
      ? path.resolve(refBase, refPath)
      : sourceFile;
    if (!/\.(?:ya?ml|json)$/i.test(lexicalRefFile)) {
      throw new PromptfooActionError(
        `Executable Promptfoo config ${lexicalRefFile} cannot be safely preflighted for commandLineOptions.envPath`,
        ErrorCodes.INVALID_CONFIGURATION,
        "Use a YAML or JSON config and move environment files to the action's env-files input.",
      );
    }
    const realRefFile = assertWorkspacePath(
      lexicalRefFile,
      workingDirectory,
      'Promptfoo config $ref',
    );
    const referencedConfig = readConfigFile(realRefFile);
    if (!fragment || fragment === '#') {
      return { config: referencedConfig, file: lexicalRefFile, fragment };
    }
    const pointer = fragment.slice(1);
    if (!pointer.startsWith('/')) {
      throw new PromptfooActionError(
        `Unsupported Promptfoo config $ref fragment ${fragment}`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use a JSON pointer fragment in the Promptfoo config $ref.',
      );
    }
    let selectedConfig: unknown = referencedConfig;
    for (const encodedPart of pointer.slice(1).split('/')) {
      if (/~(?![01])/.test(encodedPart)) {
        throw new PromptfooActionError(
          `Invalid Promptfoo config $ref fragment ${fragment}`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Use a valid JSON pointer fragment in the Promptfoo config $ref.',
        );
      }
      const part = encodedPart.replace(/~1/g, '/').replace(/~0/g, '~');
      if (
        typeof selectedConfig === 'object' &&
        selectedConfig !== null &&
        '$id' in selectedConfig
      ) {
        throw new PromptfooActionError(
          `Promptfoo config $ref ${ref} uses $id and cannot be safely preflighted for commandLineOptions.envPath`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Remove $id from the Promptfoo config ref chain.',
        );
      }
      if (
        typeof selectedConfig !== 'object' ||
        selectedConfig === null ||
        !(part in selectedConfig)
      ) {
        throw new PromptfooActionError(
          `Promptfoo config $ref fragment ${fragment} was not found`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Check the JSON pointer fragment in the Promptfoo config $ref.',
        );
      }
      selectedConfig = (selectedConfig as Record<string, unknown>)[part];
    }
    return { config: selectedConfig, file: lexicalRefFile, fragment };
  };

  const inspectConfig = (
    value: unknown,
    sourceFile: string,
    isCommandLineOptions: boolean,
    depth: number,
  ): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    if (depth > maxConfigDepth) {
      throw new PromptfooActionError(
        `Promptfoo config ${configPath} exceeds the envPath preflight traversal limit`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Reduce the Promptfoo config nesting or referenced config size.',
      );
    }
    const record = value as Record<string, unknown>;
    if (!refsDisabled && '$id' in record) {
      throw new PromptfooActionError(
        `Promptfoo config ${configPath} uses $id and cannot be safely preflighted for commandLineOptions.envPath`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Remove $id from the Promptfoo config ref chain.',
      );
    }
    if (
      !refsDisabled &&
      !isCommandLineOptions &&
      typeof record.$ref === 'string' &&
      typeof record.commandLineOptions === 'object' &&
      record.commandLineOptions !== null &&
      ('$ref' in record.commandLineOptions ||
        'envPath' in record.commandLineOptions)
    ) {
      throw new PromptfooActionError(
        `Promptfoo config ${configPath} combines root and commandLineOptions refs and cannot be safely preflighted for commandLineOptions.envPath`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Resolve one of the Promptfoo config ref layers into a static YAML or JSON config.',
      );
    }
    if (isCommandLineOptions && 'envPath' in record) {
      const envPath = record.envPath;
      if (!refsDisabled && typeof record.$ref === 'string') {
        throw new PromptfooActionError(
          `Promptfoo config ${configPath} combines a commandLineOptions ref with a local envPath and cannot be safely preflighted`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Resolve commandLineOptions into a static YAML or JSON config before using a local envPath.',
        );
      }
      if (
        typeof envPath !== 'string' &&
        (!Array.isArray(envPath) ||
          envPath.some((entry) => typeof entry !== 'string'))
      ) {
        throw new PromptfooActionError(
          `Invalid commandLineOptions.envPath in ${configPath}`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Use a string or list of strings for commandLineOptions.envPath.',
        );
      }
      const entries: string[] = Array.isArray(envPath) ? envPath : [envPath];
      for (const entry of entries) {
        if (entry.split(',').every((part) => part.trim().length === 0)) {
          continue;
        }
        if (entry.includes('{{')) {
          throw new PromptfooActionError(
            `Computed commandLineOptions.envPath in ${configPath} cannot be safely preflighted`,
            ErrorCodes.INVALID_CONFIGURATION,
            "Use a literal envPath or move environment files to the action's env-files input.",
          );
        }
        if (
          entry.split(',').some((part) => isUnsupportedWindowsPath(part.trim()))
        ) {
          throw new PromptfooActionError(
            'commandLineOptions.envPath uses an unsupported Windows path',
            ErrorCodes.INVALID_CONFIGURATION,
            'Use repository-local POSIX paths when the action runs on a POSIX runner.',
          );
        }
        const resolvedEntry = path.isAbsolute(entry)
          ? entry
          : path.resolve(path.dirname(lexicalConfigPath), entry);
        configuredPaths.push(
          ...resolvedEntry.split(',').map((part) => part.trim()),
        );
      }
      return true;
    }

    if (!isCommandLineOptions && 'commandLineOptions' in record) {
      if (
        inspectConfig(record.commandLineOptions, sourceFile, true, depth + 1)
      ) {
        return true;
      }
    }

    if (!refsDisabled && typeof record.$ref === 'string') {
      const referenced = resolveRef(record.$ref, sourceFile);
      const inspectionKey = `${referenced.file}\0${referenced.fragment}\0${isCommandLineOptions}`;
      if (inspectedRefs.has(inspectionKey)) {
        return false;
      }
      if (inspectedRefs.size >= maxConfigRefs) {
        throw new PromptfooActionError(
          `Promptfoo config ${configPath} exceeds the envPath preflight reference limit`,
          ErrorCodes.INVALID_CONFIGURATION,
          'Reduce the number of referenced Promptfoo config files.',
        );
      }
      inspectedRefs.add(inspectionKey);
      return inspectConfig(
        referenced.config,
        referenced.file,
        isCommandLineOptions,
        depth + 1,
      );
    }
    return false;
  };

  inspectConfig(config, lexicalConfigPath, false, 0);
  const envFilePaths = configuredPaths
    .filter(Boolean)
    .map((configuredPath) => path.resolve(workingDirectory, configuredPath));
  const validateEnvFile = (envFilePath: string): void => {
    const realEnvFilePath = assertWorkspacePath(
      envFilePath,
      workingDirectory,
      'Config environment file',
    );
    const envFileStats = fs.statSync(realEnvFilePath);
    if (!envFileStats.isFile()) {
      throw new PromptfooActionError(
        `Config environment file ${envFilePath} must be a regular file`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Use a regular repository-local environment file.',
      );
    }
    if (envFileStats.size > maxConfigBytes) {
      throw new PromptfooActionError(
        `Config environment file ${envFilePath} exceeds the envPath preflight size limit`,
        ErrorCodes.INVALID_CONFIGURATION,
        'Reduce the configured environment-file size.',
      );
    }
  };

  for (const envFilePath of envFilePaths) {
    validateEnvFile(envFilePath);
  }

  const lastEnvFilePath = envFilePaths[envFilePaths.length - 1];
  if (process.env.DOTENV_KEY && lastEnvFilePath) {
    const vaultPath = lastEnvFilePath.endsWith('.vault')
      ? lastEnvFilePath
      : `${lastEnvFilePath}.vault`;
    if (fs.existsSync(vaultPath)) {
      validateEnvFile(vaultPath);
    }
  }

  if (envFilePaths.length > 0) {
    loadEnvironmentFile(
      envFilePaths.length === 1 ? envFilePaths[0] : envFilePaths,
      targetEnvironment,
    );
  }
}
