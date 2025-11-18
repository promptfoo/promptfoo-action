import * as core from '@actions/core';
import { ErrorCodes, PromptfooActionError } from './errors';

const DEFAULT_CLOUD_API_HOST = 'https://api.promptfoo.app';

interface CloudUser {
  id: string;
  name: string;
  email: string;
}

interface CloudOrganization {
  id: string;
  name: string;
}

interface ValidateApiKeyResponse {
  user: CloudUser;
  organization: CloudOrganization;
}

/**
 * Validates a Promptfoo API key by making a request to the /users/me endpoint.
 * This ensures the API key is valid before running the evaluation.
 *
 * @param apiKey - The Promptfoo API key to validate
 * @param apiHost - The API host URL (defaults to Promptfoo Cloud)
 * @returns Promise that resolves if valid, rejects if invalid
 * @throws {PromptfooActionError} If the API key is invalid or the request fails
 */
export async function validatePromptfooApiKey(
  apiKey: string,
  apiHost: string = DEFAULT_CLOUD_API_HOST,
): Promise<ValidateApiKeyResponse> {
  try {
    core.debug(`Validating API key with host: ${apiHost}`);

    const response = await fetch(`${apiHost}/api/v1/users/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      const errorBody = await response
        .text()
        .catch(() => 'Unable to read error response');

      if (response.status === 401 || response.status === 403) {
        throw new PromptfooActionError(
          `Invalid PROMPTFOO_API_KEY: Authentication failed with status ${response.status}. Please check your API key.`,
          ErrorCodes.AUTH_FAILED,
          'Ensure PROMPTFOO_API_KEY is set correctly. Get your API key from https://www.promptfoo.app/welcome',
        );
      }

      throw new PromptfooActionError(
        `Failed to validate PROMPTFOO_API_KEY: HTTP ${response.status} - ${response.statusText}`,
        ErrorCodes.AUTH_FAILED,
        `Response body: ${errorBody}`,
      );
    }

    const data = (await response.json()) as ValidateApiKeyResponse;

    if (!data.user || !data.organization) {
      throw new PromptfooActionError(
        'Invalid response from authentication endpoint',
        ErrorCodes.AUTH_FAILED,
        'The API returned a successful response but with invalid data structure',
      );
    }

    core.info(
      `✓ Authenticated as ${data.user.email} (${data.organization.name})`,
    );

    return data;
  } catch (error) {
    // Re-throw PromptfooActionError as-is
    if (error instanceof PromptfooActionError) {
      throw error;
    }

    // Handle network/timeout errors
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new PromptfooActionError(
          'Authentication request timed out after 10 seconds',
          ErrorCodes.AUTH_FAILED,
          `Unable to reach ${apiHost}. Check your network connection or PROMPTFOO_REMOTE_API_BASE_URL setting.`,
        );
      }

      throw new PromptfooActionError(
        `Authentication failed: ${error.message}`,
        ErrorCodes.AUTH_FAILED,
        'An unexpected error occurred during authentication',
      );
    }

    throw new PromptfooActionError(
      'An unknown error occurred during authentication',
      ErrorCodes.AUTH_FAILED,
    );
  }
}

/**
 * Determines the API host to use for authentication.
 * Checks environment variables in this order:
 * 1. PROMPTFOO_REMOTE_API_BASE_URL
 * 2. Falls back to default Promptfoo Cloud API
 *
 * @returns The API host URL to use
 */
export function getApiHost(): string {
  return process.env.PROMPTFOO_REMOTE_API_BASE_URL || DEFAULT_CLOUD_API_HOST;
}
