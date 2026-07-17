import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sync } from 'glob';
import { describe, expect, it } from 'vitest';
import {
  getGlobRangeError,
  hasBalancedGlobDelimiters,
  isForeignWindowsAbsoluteGlob,
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

  it('should distinguish POSIX wildcard escapes from Windows-style separators', () => {
    if (process.platform === 'win32') {
      return;
    }

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfoo-glob-'));
    const prompts = path.join(fixture, 'prompts');
    fs.mkdirSync(prompts);
    fs.writeFileSync(path.join(prompts, '*.txt'), 'literal star');
    fs.writeFileSync(path.join(prompts, '?.txt'), 'literal question');
    fs.writeFileSync(path.join(prompts, 'ordinary.txt'), 'ordinary');

    const match = (pattern: string) =>
      sync(normalizeGlobPattern(pattern, 'linux'), {
        cwd: fixture,
        nodir: true,
        braceExpandMax: 1024,
      }).sort();

    try {
      expect(match(String.raw`prompts/\*.txt`)).toEqual(['prompts/*.txt']);
      expect(match(String.raw`prompts/\?.txt`)).toEqual(['prompts/?.txt']);
      expect(normalizeGlobPattern(String.raw`prompts/\\*.txt`, 'linux')).toBe(
        String.raw`prompts/\\*.txt`,
      );
      expect(match(String.raw`prompts\*.txt`)).toEqual([
        'prompts/*.txt',
        'prompts/?.txt',
        'prompts/ordinary.txt',
      ]);
      expect(normalizeGlobPattern(String.raw`prompts\*.txt`, 'win32')).toBe(
        'prompts/*.txt',
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('should identify foreign Windows absolute glob patterns', () => {
    expect(isForeignWindowsAbsoluteGlob('C:/repo/prompts/*.txt', 'linux')).toBe(
      true,
    );
    expect(
      isForeignWindowsAbsoluteGlob(String.raw`\\server\repo\*.txt`, 'linux'),
    ).toBe(true);
    expect(isForeignWindowsAbsoluteGlob('C:/repo/prompts/*.txt', 'win32')).toBe(
      false,
    );
    expect(isForeignWindowsAbsoluteGlob('/repo/prompts/*.txt', 'linux')).toBe(
      false,
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
