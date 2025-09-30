export class PromptfooActionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly helpText?: string,
  ) {
    super(message);
    this.name = 'PromptfooActionError';
  }
}

export const ErrorCodes = {
  NO_PULL_REQUEST: 'NO_PULL_REQUEST',
  INVALID_GIT_REF: 'INVALID_GIT_REF',
  INVALID_THRESHOLD: 'INVALID_THRESHOLD',
  THRESHOLD_NOT_MET: 'THRESHOLD_NOT_MET',
  PROMPTFOO_EXECUTION_FAILED: 'PROMPTFOO_EXECUTION_FAILED',
  INVALID_OUTPUT_FILE: 'INVALID_OUTPUT_FILE',
  ENV_FILE_NOT_FOUND: 'ENV_FILE_NOT_FOUND',
  ENV_FILE_LOAD_ERROR: 'ENV_FILE_LOAD_ERROR',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  AUTH_FAILED: 'AUTH_FAILED',
} as const;

export function formatErrorMessage(error: unknown): string {
  if (error instanceof PromptfooActionError) {
    let message = `Error: ${error.message}`;
    if (error.helpText) {
      message += `\n\nHelp: ${error.helpText}`;
    }
    return message;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}
