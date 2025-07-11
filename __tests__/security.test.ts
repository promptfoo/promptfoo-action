import { validateApiKey, secureApiKey, processApiKeys, API_KEY_CONFIGS } from '../src/utils/security';
import * as core from '@actions/core';

jest.mock('@actions/core');

describe('Security Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateApiKey', () => {
    it('should accept empty keys as valid', () => {
      const result = validateApiKey('', API_KEY_CONFIGS.openai);
      expect(result.valid).toBe(true);
    });

    it('should reject keys that are too short', () => {
      const result = validateApiKey('sk-short', API_KEY_CONFIGS.openai);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
    });

    it('should reject keys that are too long', () => {
      const config = {
        inputName: 'test-key',
        envVarName: 'TEST_KEY',
        maxLength: 10,
      };
      const result = validateApiKey('this-is-a-very-long-key', config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject keys with invalid pattern', () => {
      // Use a key that passes length check but fails pattern
      const invalidKey = 'invalid-' + 'a'.repeat(50); // Total length > 51
      const result = validateApiKey(invalidKey, API_KEY_CONFIGS.openai);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid format');
    });

    it('should reject keys with whitespace', () => {
      // Use a key that would pass length check but has whitespace
      const keyWithSpace = 'sk-' + 'a'.repeat(25) + ' ' + 'b'.repeat(25);
      const result = validateApiKey(keyWithSpace, API_KEY_CONFIGS.openai);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('whitespace');
    });

    it('should reject placeholder values', () => {
      const config = {
        inputName: 'test-key',
        envVarName: 'TEST_KEY',
      };
      const placeholders = [
        'your-api-key',
        'YOUR_API_KEY',
        'xxx',
        'test-key',
        '<your-key>',
        '${API_KEY}',
        '{{api_key}}',
      ];

      for (const placeholder of placeholders) {
        const result = validateApiKey(placeholder, config);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('placeholder');
      }
    });

    it('should accept valid OpenAI keys', () => {
      const validKey = 'sk-' + 'a'.repeat(48);
      const result = validateApiKey(validKey, API_KEY_CONFIGS.openai);
      expect(result.valid).toBe(true);
    });

    it('should accept valid Anthropic keys', () => {
      const validKey = 'sk-ant-' + 'a'.repeat(90);
      const result = validateApiKey(validKey, API_KEY_CONFIGS.anthropic);
      expect(result.valid).toBe(true);
    });
  });

  describe('secureApiKey', () => {
    it('should return undefined for empty keys', () => {
      const result = secureApiKey('', API_KEY_CONFIGS.openai);
      expect(result).toBeUndefined();
    });

    it('should mask valid keys', () => {
      const validKey = 'sk-' + 'a'.repeat(48);
      const result = secureApiKey(validKey, API_KEY_CONFIGS.openai);
      expect(result).toBe(validKey);
      expect(core.setSecret).toHaveBeenCalledWith(validKey);
    });

    it('should log warning for invalid keys', () => {
      const result = secureApiKey('invalid', API_KEY_CONFIGS.openai);
      expect(result).toBeUndefined();
      expect(core.warning).toHaveBeenCalled();
    });

    it('should log masked debug info', () => {
      const validKey = 'sk-' + 'a'.repeat(48);
      secureApiKey(validKey, API_KEY_CONFIGS.openai);
      expect(core.debug).toHaveBeenCalledWith(
        expect.stringContaining('sk-a****')
      );
    });
  });

  describe('processApiKeys', () => {
    it('should process multiple valid API keys', () => {
      const inputs = {
        'openai-api-key': 'sk-' + 'a'.repeat(48),
        'anthropic-api-key': 'sk-ant-' + 'b'.repeat(90),
      };

      const result = processApiKeys(inputs);
      expect(result).toEqual({
        OPENAI_API_KEY: inputs['openai-api-key'],
        ANTHROPIC_API_KEY: inputs['anthropic-api-key'],
      });
    });

    it('should skip invalid API keys', () => {
      const inputs = {
        'openai-api-key': 'invalid',
        'anthropic-api-key': 'sk-ant-' + 'b'.repeat(90),
      };

      const result = processApiKeys(inputs);
      expect(result).toEqual({
        ANTHROPIC_API_KEY: inputs['anthropic-api-key'],
      });
    });

    it('should handle empty inputs', () => {
      const result = processApiKeys({});
      expect(result).toEqual({});
    });
  });
});