import { describe, expect, it } from 'vitest';
import { normalizeGlobSeparators, preflightGlob } from '../../src/utils/glob';

const options = { maxLength: 65_536, maxBraceExpansions: 1024 };

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
    'prompts/literal).txt',
    'prompts/\\{1..1000000000\\}.txt',
    'prompts/\\\\\\{1..5000000\\}.txt',
    'prompts/\\[literal\\].txt',
    'prompts/\\(literal\\).txt',
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
    'prompts/{one),two}/*.txt',
    `prompts/${'{'.repeat(129)}one,two${'}'.repeat(129)}.txt`,
    `prompts/${'@('.repeat(127)}[{1..2}]${')'.repeat(127)}.txt`,
    `prompts/${'@('.repeat(129)}one${')'.repeat(129)}.txt`,
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
});
