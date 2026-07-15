import { afterEach, describe, expect, it } from 'vitest';
import { canSafelyInspectGlob, safelyExpandGlob } from '../../src/utils/glob';

describe('safe glob expansion', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it.each([
    'prompts/{1..1000000000}.txt',
    String.raw`prompts/\\{1..1000000000}.txt`,
    'prompts/[{1..5000000}].txt',
    `prompts/{-${'9'.repeat(20)}..1}.txt`,
    `prompts/{1..${'9'.repeat(20)}}.txt`,
    `prompts/{1..10..${'9'.repeat(20)}}.txt`,
    `prompts/{${'0'.repeat(32_000)}1..1024}.txt`,
    `prompts/{1..${'0'.repeat(32_000)}1024}.txt`,
    `prompts/{1..1024..${'0'.repeat(32_000)}1}.txt`,
    'prompts/{-9007199254740991..9007199254740991}.txt',
    'prompts/{1..10..0}.txt',
    `prompts/{${Array.from({ length: 1_025 }, (_, index) => index).join(',')}}.txt`,
    `prompts/${'{'.repeat(65)}x${'}'.repeat(65)}.txt`,
    `prompts/[${'{'.repeat(65)}x${'}'.repeat(65)}].txt`,
    'prompts/{one,two.txt',
    'prompts/one}.txt',
    'prompts/one\0*.txt',
    `prompts/${'a'.repeat(65_537)}*.txt`,
  ])('rejects unsafe expansion before enumeration (%s)', (pattern) => {
    expect(safelyExpandGlob(pattern)).toBeUndefined();
  });

  it('preserves valid numeric and comma expansions', () => {
    expect(safelyExpandGlob('prompts/{one,two}.txt')).toEqual([
      'prompts/one.txt',
      'prompts/two.txt',
    ]);
    expect(safelyExpandGlob('prompts/{1..1024}.txt')).toHaveLength(1_024);
    expect(safelyExpandGlob('prompts/[{]*.txt')).toEqual(['prompts/[{]*.txt']);
  });

  it('preserves POSIX escaped brace, bracket, and extglob literals', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(
      safelyExpandGlob(
        String.raw`prompts/\{1..1000000000\}-\[text\]-\(group\).txt`,
      ),
    ).toEqual(['prompts/{1..1000000000}-\\[text\\]-\\(group\\).txt']);
    expect(safelyExpandGlob(String.raw`prompts/\\{1..2}.txt`)).toHaveLength(2);
    expect(
      safelyExpandGlob(String.raw`prompts/{\{1..1000000000}\}.txt`),
    ).toEqual(['prompts/{{1..1000000000}}.txt']);
    expect(
      safelyExpandGlob(String.raw`prompts/\\\{1..1000000000\}.txt`),
    ).toEqual(['prompts/\\{1..1000000000}.txt']);
  });

  it('treats Windows backslashes as separators during numeric preflight', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(canSafelyInspectGlob(String.raw`prompts\{1..1000000000}.txt`)).toBe(
      false,
    );
    expect(canSafelyInspectGlob(String.raw`prompts\{1..2}.txt`)).toBe(true);
  });
});
