import * as core from '@actions/core';

/**
 * API key configuration with validation rules
 */
interface ApiKeyConfig {
  inputName: string;
  envVarName: string;
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
}

/**
 * Validates an API key against security rules
 */
export function validateApiKey(
  key: string,
  config: ApiKeyConfig,
): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: true }; // Empty keys are valid (optional)
  }

  // Check for common mistakes first
  if (key.includes(' ') || key.includes('\n') || key.includes('\t')) {
    return {
      valid: false,
      error: `${config.inputName} contains whitespace characters`,
    };
  }

  // Check minimum length
  if (config.minLength && key.length < config.minLength) {
    return {
      valid: false,
      error: `${config.inputName} is too short (minimum ${config.minLength} characters)`,
    };
  }

  // Check maximum length
  if (config.maxLength && key.length > config.maxLength) {
    return {
      valid: false,
      error: `${config.inputName} is too long (maximum ${config.maxLength} characters)`,
    };
  }

  // Check pattern if provided
  if (config.pattern && !config.pattern.test(key)) {
    return {
      valid: false,
      error: `${config.inputName} has invalid format`,
    };
  }

  // Check for placeholder values
  const placeholders = [
    'your-api-key',
    'YOUR_API_KEY',
    'xxx',
    'XXX',
    '123456',
    'test',
    'TEST',
    'demo',
    'DEMO',
    'example',
    'EXAMPLE',
    '<your-key>',
    '${',
    '{{',
  ];
  
  for (const placeholder of placeholders) {
    if (key.includes(placeholder)) {
      return {
        valid: false,
        error: `${config.inputName} appears to contain a placeholder value`,
      };
    }
  }

  return { valid: true };
}

/**
 * Securely handles API keys with validation and masking
 */
export function secureApiKey(
  key: string,
  config: ApiKeyConfig,
): string | undefined {
  if (!key) {
    return undefined;
  }

  // Validate the key
  const validation = validateApiKey(key, config);
  if (!validation.valid) {
    core.warning(validation.error || 'Invalid API key');
    return undefined;
  }

  // Mask the key in logs
  core.setSecret(key);

  // Log a masked version for debugging (show first 4 chars)
  const masked = key.substring(0, 4) + '*'.repeat(Math.max(0, key.length - 4));
  core.debug(`${config.inputName} configured: ${masked}`);

  return key;
}

/**
 * API key configurations for different providers
 */
export const API_KEY_CONFIGS: Record<string, ApiKeyConfig> = {
  openai: {
    inputName: 'openai-api-key',
    envVarName: 'OPENAI_API_KEY',
    pattern: /^sk-[a-zA-Z0-9]{48,}$/,
    minLength: 51,
  },
  azure: {
    inputName: 'azure-api-key',
    envVarName: 'AZURE_OPENAI_API_KEY',
    minLength: 32,
  },
  anthropic: {
    inputName: 'anthropic-api-key',
    envVarName: 'ANTHROPIC_API_KEY',
    pattern: /^sk-ant-[a-zA-Z0-9-_]{90,}$/,
    minLength: 95,
  },
  huggingface: {
    inputName: 'huggingface-api-key',
    envVarName: 'HF_API_TOKEN',
    pattern: /^hf_[a-zA-Z0-9]{30,}$/,
    minLength: 33,
  },
  awsAccessKeyId: {
    inputName: 'aws-access-key-id',
    envVarName: 'AWS_ACCESS_KEY_ID',
    pattern: /^[A-Z0-9]{16,}$/,
    minLength: 16,
    maxLength: 128,
  },
  awsSecretAccessKey: {
    inputName: 'aws-secret-access-key',
    envVarName: 'AWS_SECRET_ACCESS_KEY',
    minLength: 40,
  },
  replicate: {
    inputName: 'replicate-api-key',
    envVarName: 'REPLICATE_API_KEY',
    pattern: /^r8_[a-zA-Z0-9]{37}$/,
    minLength: 40,
  },
  palm: {
    inputName: 'palm-api-key',
    envVarName: 'PALM_API_KEY',
    minLength: 39,
  },
  vertex: {
    inputName: 'vertex-api-key',
    envVarName: 'VERTEX_API_KEY',
    minLength: 30,
  },
};

/**
 * Process all API keys with security validation
 */
export function processApiKeys(inputs: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [provider, config] of Object.entries(API_KEY_CONFIGS)) {
    const key = inputs[config.inputName];
    if (key) {
      const securedKey = secureApiKey(key, config);
      if (securedKey) {
        env[config.envVarName] = securedKey;
      }
    }
  }

  return env;
}

/**
 * Audit log for API key usage
 */
export function auditApiKeyUsage(provider: string, success: boolean): void {
  const timestamp = new Date().toISOString();
  core.debug(`[AUDIT] ${timestamp} - API key usage for ${provider}: ${success ? 'SUCCESS' : 'FAILURE'}`);
}