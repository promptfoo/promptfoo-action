import * as fs from 'fs';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isDirectory } from '../../src/utils/fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: vi.fn(),
  };
});

const mockStatSync = fs.statSync as Mock;

describe('isDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns true for directories', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    expect(isDirectory('/tmp/cache')).toBe(true);
  });

  test('returns false for files', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    expect(isDirectory('/tmp/cache.json')).toBe(false);
  });

  test('returns false when the path cannot be inspected', () => {
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(isDirectory('/missing')).toBe(false);
  });
});
