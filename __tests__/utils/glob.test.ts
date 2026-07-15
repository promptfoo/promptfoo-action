import { describe, expect, it } from 'vitest';
import {
  getGlobRangeError,
  hasBalancedGlobDelimiters,
  normalizeGlobPattern,
} from '../../src/utils/glob';

describe('glob safety helpers', () => {
  it('should preserve POSIX escapes and normalize Windows separators', () => {
    const pattern = String.raw`prompts\{literal\}\[file\]\(copy\).txt`;

    expect(normalizeGlobPattern(pattern, 'linux')).toBe(pattern);
    expect(normalizeGlobPattern(pattern, 'win32')).toBe(
      'prompts/{literal/}/[file/]/(copy/).txt',
    );
    expect(normalizeGlobPattern('prompts/trailing\\', 'linux')).toBe(
      'prompts/trailing/',
    );
  });

  it.each([
    ['prompts/*.txt', 'linux', undefined],
    ['prompts/{1..1024}.txt', 'linux', undefined],
    ['prompts/{-100..100}.txt', 'linux', undefined],
    ['prompts/{1..100000..1000}.txt', 'linux', undefined],
    ['prompts/{1..1025}.txt', 'linux', 'too-many'],
    ['prompts/{1..1000000000}.txt', 'linux', 'too-many'],
    ['prompts/[{1..5000000}].txt', 'linux', 'too-many'],
    ['prompts/{1..0..0}.txt', 'linux', 'invalid'],
    ['prompts/{a..z..0}.txt', 'linux', 'invalid'],
    ['prompts/{000000000000000001..2}.txt', 'linux', 'invalid'],
    [`prompts/{${'0'.repeat(32_000)}1..1024}.txt`, 'linux', 'invalid'],
    ['prompts/{9007199254740992..2}.txt', 'linux', 'invalid'],
    ['prompts/{1..9007199254740992}.txt', 'linux', 'invalid'],
    ['prompts/{1..2..9007199254740992}.txt', 'linux', 'invalid'],
    [String.raw`prompts/\{1..1000000000\}.txt`, 'linux', undefined],
    [String.raw`prompts/\\{1..5000000}.txt`, 'linux', 'too-many'],
    [String.raw`prompts/\\\{1..5000000\}.txt`, 'linux', undefined],
    [String.raw`prompts/\{1..1000000000\}.txt`, 'win32', undefined],
    [String.raw`C:\prompts\{1..1000000000}.txt`, 'win32', 'too-many'],
    ['prompts/trailing\\', 'linux', undefined],
  ] as const)('should classify brace ranges safely: %s (%s)', (pattern, platform, expected) => {
    expect(getGlobRangeError(pattern, 1024, platform)).toBe(expected);
  });

  it.each([
    ['{prompts,other}/[!)]*.txt', 'linux', true],
    ['{prompts,other}/[!}]*.txt', 'linux', true],
    ['prompts/@(first|second).txt', 'linux', true],
    ['prompts/literal).txt', 'linux', true],
    [String.raw`prompts/\{literal\}\[file\]\(copy\).txt`, 'linux', true],
    ['{prompts,other/*.txt', 'linux', false],
    ['{prompts),../outside}/*.txt', 'linux', false],
    ['prompts/[first.txt', 'linux', false],
    [String.raw`C:\prompts\{first,second}.txt`, 'win32', true],
  ] as const)('should check glob delimiters without breaking escapes: %s (%s)', (pattern, platform, expected) => {
    expect(hasBalancedGlobDelimiters(pattern, platform)).toBe(expected);
  });
});
