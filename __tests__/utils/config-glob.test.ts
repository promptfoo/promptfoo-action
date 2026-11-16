import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { extractFileDependencies } from '../../src/utils/config';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  readFileSync: () =>
    'providers:\n  - file://direct.txt\n  - file://providers/{alpha,beta}/entry.js\n',
  statSync: () => ({ isDirectory: () => false }),
}));

vi.mock('glob', async (importOriginal) => {
  const glob = await importOriginal<typeof import('glob')>();
  const files = [
    'direct.txt',
    'providers/alpha/entry.js',
    'providers/beta/entry.js',
    'providers/gamma/entry.js',
  ].map((name) => path.resolve(name));

  return {
    ...glob,
    sync: (pattern: string) =>
      files.filter((file) => path.matchesGlob(file, pattern)),
  };
});

it('expands brace-only file references and tracks their common directory', () => {
  expect(
    extractFileDependencies(path.resolve('promptfooconfig.yaml')).sort(),
  ).toEqual([
    'direct.txt',
    'providers',
    'providers/alpha/entry.js',
    'providers/beta/entry.js',
  ]);
});
