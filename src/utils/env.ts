import * as dotenv from 'dotenv';
import { ErrorCodes, PromptfooActionError } from './errors';

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
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
]);

const FORBIDDEN_ENV_FILE_PREFIXES = ['NPM_CONFIG_'];

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
      'Remove Node, npm, executable-resolution, dynamic-loader, and proxy control variables from repository environment files. Configure trusted process controls in the workflow environment instead.',
    );
  }

  // Preserve the documented later-file-wins behavior after validation.
  for (const [key, value] of Object.entries(fileEnvironment)) {
    targetEnvironment[key] = value;
  }
}
