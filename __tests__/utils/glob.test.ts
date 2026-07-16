import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sync as globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import {
  createBoundedGlobFs,
  createContainedGlobIgnore,
  hasUnsafeGlobTraversal,
  normalizeGlobSeparators,
  preflightGlob,
} from '../../src/utils/glob';

const options = { maxLength: 65_536, maxBraceExpansions: 1024 };

describe('createContainedGlobIgnore', () => {
  it('prunes escaping or unreadable symlink directories before descent', () => {
    const root = '/workspace';
    const resolve = (filePath: string): string => {
      if (filePath.endsWith('/broken')) throw new Error('ENOENT');
      return filePath.endsWith('/outside')
        ? '/private/outside'
        : '/workspace/inside';
    };
    const ignore = createContainedGlobIgnore([root], resolve);
    const entry = (filePath: string, symbolicLink: boolean) => ({
      fullpath: () => filePath,
      isSymbolicLink: () => symbolicLink,
    });

    expect(ignore.childrenIgnored(entry('/workspace/plain', false))).toBe(
      false,
    );
    expect(ignore.childrenIgnored(entry('/workspace/link', true))).toBe(false);
    expect(ignore.childrenIgnored(entry('/workspace/outside', true))).toBe(
      true,
    );
    expect(ignore.childrenIgnored(entry('/workspace/broken', true))).toBe(true);

    const traversal = { entries: 4096, exhausted: false };
    const boundedIgnore = createContainedGlobIgnore([root], resolve, traversal);
    expect(
      boundedIgnore.childrenIgnored(entry('/workspace/plain', false)),
    ).toBe(true);
    expect(traversal.exhausted).toBe(true);
  });
});

describe('createBoundedGlobFs', () => {
  it('bounds entries in a single large directory and always closes the handle', () => {
    const makeDirectory = (count: number) => {
      let remaining = count;
      let closed = false;
      return {
        handle: {
          closeSync: () => {
            closed = true;
          },
          readSync: () =>
            remaining-- > 0 ? ({ name: 'entry' } as Dirent) : null,
        },
        closed: () => closed,
      };
    };

    const small = makeDirectory(2);
    const smallTraversal = { entries: 0, exhausted: false };
    const smallFs = createBoundedGlobFs(
      () => small.handle,
      smallTraversal,
      ['/workspace'],
      (filePath) => filePath,
    );
    expect(smallFs.readdirSync('/workspace/small')).toHaveLength(2);
    expect(small.closed()).toBe(true);
    expect(smallTraversal).toEqual({ entries: 2, exhausted: false });

    const canonical = makeDirectory(1);
    let openedPath = '';
    const canonicalTraversal = { entries: 0, exhausted: false };
    const canonicalFs = createBoundedGlobFs(
      (filePath) => {
        openedPath = filePath;
        return canonical.handle;
      },
      canonicalTraversal,
      ['/workspace'],
      () => '/workspace/canonical',
    );
    expect(
      canonicalFs.readdirSync('/workspace/retargetable-link'),
    ).toHaveLength(1);
    expect(openedPath).toBe('/workspace/canonical');
    expect(canonical.closed()).toBe(true);

    const large = makeDirectory(5000);
    const largeTraversal = { entries: 0, exhausted: false };
    const largeFs = createBoundedGlobFs(
      () => large.handle,
      largeTraversal,
      ['/workspace'],
      (filePath) => filePath,
    );
    expect(largeFs.readdirSync('/workspace/large')).toEqual([]);
    expect(large.closed()).toBe(true);
    expect(largeTraversal.exhausted).toBe(true);
    expect(largeTraversal.entries).toBe(4097);
    expect(largeFs.readdirSync('/workspace/skipped')).toEqual([]);

    const escaped = makeDirectory(2);
    const escapedTraversal = { entries: 0, exhausted: false };
    const escapedFs = createBoundedGlobFs(
      () => escaped.handle,
      escapedTraversal,
      ['/workspace'],
      () => '/private/outside',
    );
    expect(escapedFs.readdirSync('/workspace/[e]scape')).toEqual([]);
    expect(escaped.closed()).toBe(false);
    expect(escapedTraversal.exhausted).toBe(true);

    const unreadable = makeDirectory(2);
    const unreadableTraversal = { entries: 0, exhausted: false };
    const unreadableFs = createBoundedGlobFs(
      () => unreadable.handle,
      unreadableTraversal,
      ['/workspace'],
      () => {
        throw new Error('EACCES');
      },
    );
    expect(unreadableFs.readdirSync('/workspace/unreadable')).toEqual([]);
    expect(unreadable.closed()).toBe(false);
    expect(unreadableTraversal.exhausted).toBe(true);
  });

  it('blocks an optimized escaped-literal symlink before Glob can descend', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pf-action-glob-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    mkdirSync(path.join(workspace, 'inputs'), { recursive: true });
    mkdirSync(path.join(outside, 'nested'), { recursive: true });
    writeFileSync(path.join(outside, 'nested', 'secret.txt'), 'secret');
    symlinkSync(outside, path.join(workspace, 'inputs', 'a*b'), 'dir');
    const pattern = 'inputs/a\\*b/**/*.txt';
    const traversal = { entries: 0, exhausted: false };
    const opened: string[] = [];

    try {
      expect(globSync(pattern, { cwd: workspace, nodir: true })).toEqual([
        'inputs/a*b/nested/secret.txt',
      ]);
      const guarded = globSync(pattern, {
        cwd: workspace,
        nodir: true,
        fs: createBoundedGlobFs(
          (filePath) => {
            opened.push(filePath);
            return opendirSync(filePath);
          },
          traversal,
          [realpathSync(workspace)],
          realpathSync,
        ),
        ignore: createContainedGlobIgnore(
          [realpathSync(workspace)],
          realpathSync,
          traversal,
        ),
      });

      expect(guarded).toEqual([]);
      expect(opened.some((filePath) => filePath.includes('a*b'))).toBe(false);
      expect(traversal.exhausted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('preflightGlob', () => {
  it.each([
    'prompts/{1..1000000000}.txt',
    'prompts/{1000000000..1}.txt',
    'prompts/{-1000000000..1000000000..2}.txt',
    'prompts/[{1..5000000}].txt',
    'prompts/\\\\{1..5000000}.txt',
    `prompts/{${'0'.repeat(20)}..1}.txt`,
    `prompts/{${'0'.repeat(32_000)}1..1024}.txt`,
  ])('rejects an oversized numeric range before brace expansion: %s', (glob) => {
    expect(preflightGlob(glob, options)).toBe('too-many-braces');
  });

  it.each([
    'prompts/{1..1024}.txt',
    'prompts/{1024..1}.txt',
    'prompts/{1..1000000000..1000000}.txt',
    'prompts/{one,two}/*.txt',
    'prompts/[!)]*.txt',
    'prompts/[[]*.txt',
    'prompts/[{].txt',
    'prompts/literal).txt',
    'prompts/literal].txt',
    'prompts/\\{1..1000000000\\}.txt',
    'prompts/\\\\\\{1..5000000\\}.txt',
    'prompts/\\[literal\\].txt',
    'prompts/\\(literal\\).txt',
    `prompts/${'@(x)'.repeat(1024)}.txt`,
    `prompts/${'@('.repeat(64)}x${')'.repeat(64)}.txt`,
  ])('preserves a valid POSIX glob or escaped literal: %s', (glob) => {
    expect(preflightGlob(glob, options)).toBe('safe');
  });

  it('treats Windows backslashes as separators when requested', () => {
    expect(
      preflightGlob('prompts\\{1..1000000000}.txt', {
        ...options,
        windowsPathsNoEscape: true,
      }),
    ).toBe('too-many-braces');
  });

  it.each([
    `prompts/${'a'.repeat(65_537)}.txt`,
    'prompts/*\0.txt',
    'prompts/*\r.txt',
    'prompts/*\n.txt',
    'prompts/{one,two/*.txt',
    'prompts/{one].txt',
    'prompts/{one),two}/*.txt',
    `prompts/${'{'.repeat(129)}one,two${'}'.repeat(129)}.txt`,
    `prompts/${'@('.repeat(127)}[{1..2}]${')'.repeat(127)}.txt`,
    `prompts/${'@('.repeat(129)}one${')'.repeat(129)}.txt`,
    `prompts/${'@(x)'.repeat(1025)}.txt`,
    `prompts/${'@(x)'.repeat(15_000)}.txt`,
    `prompts/${'@('.repeat(65)}x${')'.repeat(65)}.txt`,
    `prompts/[${'{'.repeat(128)}x${'}'.repeat(128)}].txt`,
    `prompts/${'{'.repeat(127)}[{]${'}'.repeat(127)}.txt`,
  ])('rejects malformed or invalid input before glob parsing: %s', (glob) => {
    expect(preflightGlob(glob, options)).toBe('invalid');
  });
});

describe('normalizeGlobSeparators', () => {
  it('preserves escaped POSIX delimiters while normalizing path separators', () => {
    expect(
      normalizeGlobSeparators(
        'prompts\\nested\\{literal\\}\\[file\\]\\(one\\).txt',
      ),
    ).toBe('prompts/nested\\{literal\\}\\[file\\]\\(one\\).txt');
  });

  it('normalizes every Windows backslash as a path separator', () => {
    expect(normalizeGlobSeparators('prompts\\{one,two}\\*.txt', true)).toBe(
      'prompts/{one,two}/*.txt',
    );
  });

  it('normalizes a Windows file-URL drive path before path resolution', () => {
    expect(normalizeGlobSeparators('/C:/repo/prompts/*.txt', true)).toBe(
      'C:/repo/prompts/*.txt',
    );
  });

  it('preserves POSIX backslash parity immediately before a brace range', () => {
    expect(normalizeGlobSeparators('prompts/\\\\{1..5000000}.txt')).toBe(
      'prompts/\\\\{1..5000000}.txt',
    );
    expect(normalizeGlobSeparators('prompts/\\\\\\{1..5000000\\}.txt')).toBe(
      'prompts/\\\\\\{1..5000000\\}.txt',
    );
  });

  it('preserves a POSIX leading slash before a foreign drive path', () => {
    expect(normalizeGlobSeparators('/C:/repo/prompts/*.txt')).toBe(
      '/C:/repo/prompts/*.txt',
    );
  });

  it('normalizes a maximum-length separator-heavy glob within a bounded time', () => {
    const pattern = 'a\\'.repeat(32_768);
    const startedAt = performance.now();

    const normalized = normalizeGlobSeparators(pattern, true);

    expect(normalized).toBe('a/'.repeat(32_768));
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

describe('hasUnsafeGlobTraversal', () => {
  it.each([
    'evals/**/../../outside/*.yaml',
    'evals/**/[.][.]/[.][.]/outside/*.yaml',
    'evals/**/[.]./outside/*.yaml',
    'evals/**/.[.]/outside/*.yaml',
    'evals/**/\\.\\./\\.\\./outside/*.yaml',
    'evals/**/[.]\\./[.]\\./outside/*.yaml',
    'evals/**/.\\./.\\./outside/*.yaml',
    'evals/@(..)/outside/*.yaml',
    'evals/@(safe|..)/outside/*.yaml',
  ])('rejects traversal hidden after glob magic: %s', (glob) => {
    expect(hasUnsafeGlobTraversal(glob)).toBe(true);
  });

  it.each([
    '../outside/**/*.yaml',
    'evals/safe/../*.yaml',
    'evals/**/file..name.yaml',
    'evals/@(one|two)/*.yaml',
  ])('preserves traversal-free or lexically-resolvable globs: %s', (glob) => {
    expect(hasUnsafeGlobTraversal(glob)).toBe(false);
  });

  it('recognizes post-magic traversal in a Windows glob', () => {
    expect(hasUnsafeGlobTraversal('evals\\**\\..\\outside\\*.yaml', true)).toBe(
      true,
    );
  });
});
