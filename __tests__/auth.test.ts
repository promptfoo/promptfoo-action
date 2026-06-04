import * as core from '@actions/core';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiHost, validatePromptfooApiKey } from '../src/utils/auth';
import { ErrorCodes, PromptfooActionError } from '../src/utils/errors';

// Mock global fetch
const mockFetch = vi.fn() as Mock<typeof fetch>;
global.fetch = mockFetch;

// Mock @actions/core
vi.mock('@actions/core');
const mockCore = core as { info: Mock };

async function getAuthError(
  promise: Promise<unknown>,
): Promise<PromptfooActionError> {
  try {
    await promise;
    throw new Error('Expected authentication to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(PromptfooActionError);
    return error as PromptfooActionError;
  }
}

describe('auth utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.PROMPTFOO_REMOTE_API_BASE_URL;
  });

  describe('getApiHost', () => {
    it('should return default host when no env var is set', () => {
      expect(getApiHost()).toBe('https://api.promptfoo.app');
    });

    it('should return custom host when PROMPTFOO_REMOTE_API_BASE_URL is set', () => {
      process.env.PROMPTFOO_REMOTE_API_BASE_URL = 'https://custom.api.com';
      expect(getApiHost()).toBe('https://custom.api.com');
    });
  });

  describe('validatePromptfooApiKey', () => {
    const mockApiKey = 'test-api-key-123';
    const mockApiHost = 'https://api.promptfoo.app';

    it('should successfully validate a valid API key', async () => {
      const mockResponse = {
        user: {
          id: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
        },
        organization: {
          id: 'org-1',
          name: 'Test Org',
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await validatePromptfooApiKey(mockApiKey, mockApiHost);

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockApiHost}/api/v1/users/me`,
        expect.objectContaining({
          method: 'GET',
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
            'Content-Type': 'application/json',
          },
        }),
      );
      expect(mockCore.info).toHaveBeenCalledWith(
        '✓ Authenticated as test@example.com (Test Org)',
      );
    });

    it('should throw PromptfooActionError for 401 Unauthorized', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid credentials',
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid PROMPTFOO_API_KEY'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should throw PromptfooActionError for 403 Forbidden', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid PROMPTFOO_API_KEY'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should throw PromptfooActionError for other HTTP errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('HTTP 500'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('uses a fallback when the HTTP error body cannot be read', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => {
          throw new Error('body stream failed');
        },
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        helpText: 'Response body: Unable to read error response',
      });
    });

    it('should throw PromptfooActionError for timeout', async () => {
      const timeoutError = new Error('timeout');
      timeoutError.name = 'AbortError';
      mockFetch.mockRejectedValue(timeoutError);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('timed out'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('handles the TimeoutError produced by AbortSignal.timeout', async () => {
      const timeoutError = new Error(
        'The operation was aborted due to timeout',
      );
      timeoutError.name = 'TimeoutError';
      mockFetch.mockRejectedValue(timeoutError);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: 'Authentication request timed out after 10 seconds',
        helpText: expect.stringContaining(mockApiHost),
      });
    });

    it('should throw PromptfooActionError for network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Network error'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('handles non-Error failures', async () => {
      mockFetch.mockRejectedValue('network unavailable');

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: 'An unknown error occurred during authentication',
      });
    });

    it('should throw PromptfooActionError for invalid response data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'data' }),
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid response'),
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('rejects response objects with missing user fields', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {},
          organization: {},
        }),
      } as Response);

      await expect(
        getAuthError(validatePromptfooApiKey(mockApiKey, mockApiHost)),
      ).resolves.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: 'Invalid response from authentication endpoint',
      });
    });

    it('should use default API host when not specified', async () => {
      const mockResponse = {
        user: {
          id: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
        },
        organization: {
          id: 'org-1',
          name: 'Test Org',
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await validatePromptfooApiKey(mockApiKey);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.promptfoo.app/api/v1/users/me',
        expect.any(Object),
      );
    });
  });
});
