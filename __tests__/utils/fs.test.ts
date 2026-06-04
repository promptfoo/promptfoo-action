import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  normalizePathWithin,
  normalizeSafeGlobPattern,
  resolvePathWithin,
} from '../../src/utils/fs';

describe('path safety helpers', () => {
  const baseDir = path.join(path.sep, 'repo', 'workspace');

  it('resolves paths inside the base directory', () => {
    expect(resolvePathWithin(baseDir, 'configs/promptfoo.yaml', 'config')).toBe(
      path.join(baseDir, 'configs', 'promptfoo.yaml'),
    );
  });

  it('normalizes relative paths to POSIX separators', () => {
    expect(
      normalizePathWithin(baseDir, 'configs/../promptfoo.yaml', 'config'),
    ).toBe('promptfoo.yaml');
  });

  it('rejects relative traversal outside the base directory', () => {
    expect(() =>
      resolvePathWithin(baseDir, '../secret.env', 'env-files'),
    ).toThrow('Invalid env-files');
  });

  it('allows absolute paths only when explicitly requested', () => {
    expect(
      resolvePathWithin(baseDir, '/tmp/promptfoo-cache', 'cache-path', {
        allowAbsolute: true,
      }),
    ).toBe(path.join(path.sep, 'tmp', 'promptfoo-cache'));
  });

  it('rejects unsafe glob patterns', () => {
    expect(() => normalizeSafeGlobPattern('../**/*.txt', 'prompts')).toThrow(
      'Invalid prompts',
    );
  });
});
