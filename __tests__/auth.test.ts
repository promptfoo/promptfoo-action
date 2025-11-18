import * as core from '@actions/core';
import { getApiHost, validatePromptfooApiKey } from '../src/utils/auth';
import { ErrorCodes, PromptfooActionError } from '../src/utils/errors';

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// Mock @actions/core
jest.mock('@actions/core');
const mockCore = core as jest.Mocked<typeof core>;

describe('auth utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid PROMPTFOO_API_KEY'),
      });
    });

    it('should throw PromptfooActionError for 403 Forbidden', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      } as Response);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid PROMPTFOO_API_KEY'),
      });
    });

    it('should throw PromptfooActionError for other HTTP errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      } as Response);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('HTTP 500'),
      });
    });

    it('should throw PromptfooActionError for timeout', async () => {
      const timeoutError = new Error('timeout');
      timeoutError.name = 'AbortError';
      mockFetch.mockRejectedValue(timeoutError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('timed out'),
      });
    });

    it('should throw PromptfooActionError for network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Network error'),
      });
    });

    it('should throw PromptfooActionError for invalid response data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'data' }),
      } as Response);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toThrow(PromptfooActionError);

      await expect(
        validatePromptfooApiKey(mockApiKey, mockApiHost),
      ).rejects.toMatchObject({
        code: ErrorCodes.AUTH_FAILED,
        message: expect.stringContaining('Invalid response'),
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
