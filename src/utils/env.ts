import * as dotenv from 'dotenv';
import { ErrorCodes, PromptfooActionError } from './errors';

// Process-control variables that let a repository-controlled env file run code
// in, or redirect the trust of, the action's own process (`npx`/node, `git`) or
// any interpreter promptfoo later spawns — before the reviewed config is graded.
// Kept as an explicit, alphabetized blocklist so additions are easy to audit.
//
// Interpreter *option/relocation* controls (PERL5OPT, PYTHON{HOME,EXECUTABLE,
// STARTUP}, RUBYOPT) are rejected because they inject code with no legitimate
// reason to live in an application env file. Module *search-path* controls
// (PYTHONPATH, RUBYLIB, PERL5LIB) are intentionally NOT rejected: real
// promptfoo python/ruby providers rely on them, and pointing them at repo code
// grants nothing beyond what such a provider already runs during evaluation.
const FORBIDDEN_ENV_FILE_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'BASH_ENV',
  'COMSPEC',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PERL5OPT',
  'PYTHONEXECUTABLE',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
]);

// `GIT_` covers git process controls (GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF,
// GIT_PROXY_COMMAND, GIT_CONFIG_COUNT/KEY_n/VALUE_n, ...). The action shells out
// to `git` via simple-git after loading these files, and that child inherits
// process.env, so git controls belong in the same trust boundary as Node/npm.
const FORBIDDEN_ENV_FILE_PREFIXES = ['GIT_', 'NPM_CONFIG_'];

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
  envFilePath: string,
  targetEnvironment: NodeJS.ProcessEnv = process.env,
): void {
  // Parse into an isolated object so untrusted values cannot affect this action
  // or a child process before they have passed the process-control check.
  const fileEnvironment: Record<string, string> = {};
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

  const forbiddenKey = findForbiddenEnvFileKey(fileEnvironment);
  if (forbiddenKey) {
    throw new PromptfooActionError(
      `Environment file ${envFilePath} sets forbidden process-control variable ${forbiddenKey}`,
      ErrorCodes.INVALID_CONFIGURATION,
      'Remove Node, npm, git, executable-resolution, dynamic-loader, and proxy control variables from repository environment files. Configure trusted process controls in the workflow environment instead.',
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

  // Merge into the shared environment (process.env by default) only after the
  // file has fully passed the process-control and authentication checks. This
  // is deliberate: the action itself reads env-file values such as cache paths,
  // thresholds, and provider settings from process.env, and it also forwards
  // process.env to the promptfoo child. Validation therefore has to happen
  // here, at the untrusted-file boundary — not on the final child environment,
  // which legitimately inherits the trusted runner's own PATH, NODE_OPTIONS,
  // and workflow-set PROMPTFOO_API_KEY. Preserves later-file-wins ordering.
  for (const [key, value] of Object.entries(fileEnvironment)) {
    targetEnvironment[key] = value;
  }
}
