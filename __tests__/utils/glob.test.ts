import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globSync } from 'glob';
import { braceExpand } from 'minimatch';
import { describe, expect, test } from 'vitest';
import { validateGlobPattern } from '../../src/utils/glob';

describe('validateGlobPattern', () => {
  test('should reject excessive extglob operators and nesting before compilation', () => {
    expect(() =>
      validateGlobPattern(
        `prompts/${'@(x)'.repeat(15_000)}.txt`,
        'prompt glob',
      ),
    ).toThrow('prompt glob contains too many extglob operators.');
    expect(() =>
      validateGlobPattern(
        `prompts/${'@('.repeat(65)}x${')'.repeat(65)}.txt`,
        'prompt glob',
      ),
    ).toThrow('prompt glob exceeds the safe extglob depth.');
  });

  test('should match minimatch and filesystem behavior for odd and even POSIX escapes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf983-glob-parity-'));
    const promptsDir = path.join(cwd, 'prompts');
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(path.join(promptsDir, '{.txt'), 'brace');
    fs.writeFileSync(path.join(promptsDir, '1.txt'), 'numeric');
    fs.writeFileSync(path.join(promptsDir, 'safe}.txt'), 'safe');
    fs.writeFileSync(
      path.join(promptsDir, '{1..5000000}.txt'),
      'literal-range',
    );

    try {
      for (const promptGlob of [
        'prompts/[{].txt',
        path.join(promptsDir, '[{].txt'),
      ]) {
        expect(braceExpand(promptGlob, { braceExpandMax: 1025 })).toHaveLength(
          1,
        );
        expect(() =>
          validateGlobPattern(promptGlob, 'prompt glob'),
        ).not.toThrow();
        expect(
          globSync(promptGlob, { cwd, nodir: true }).map((match) =>
            path.basename(match),
          ),
        ).toEqual(['{.txt']);
      }

      for (const promptGlob of [
        'prompts/[\\{1..5000000}].txt',
        path.join(promptsDir, '[\\{1..5000000}].txt'),
      ]) {
        expect(braceExpand(promptGlob, { braceExpandMax: 1025 })).toHaveLength(
          1,
        );
        expect(() =>
          validateGlobPattern(promptGlob, 'prompt glob'),
        ).not.toThrow();
        const matches = globSync(promptGlob, {
          cwd,
          nodir: true,
          braceExpandMax: 1024,
        });
        expect(matches.map((match) => path.basename(match)).sort()).toEqual([
          '1.txt',
          '{.txt',
        ]);
      }

      for (const promptGlob of [
        'prompts/{safe,\\{1..5000000}\\}.txt',
        path.join(promptsDir, '{safe,\\{1..5000000}\\}.txt'),
      ]) {
        expect(braceExpand(promptGlob, { braceExpandMax: 1025 })).toHaveLength(
          2,
        );
        expect(() =>
          validateGlobPattern(promptGlob, 'prompt glob'),
        ).not.toThrow();
        const matches = globSync(promptGlob, {
          cwd,
          nodir: true,
          braceExpandMax: 1024,
        });
        expect(matches.map((match) => path.basename(match)).sort()).toEqual([
          'safe}.txt',
          '{1..5000000}.txt',
        ]);
      }

      for (const promptGlob of [
        'prompts/[\\\\{1..5000000}].txt',
        path.join(promptsDir, '[\\\\{1..5000000}].txt'),
      ]) {
        expect(braceExpand(promptGlob, { braceExpandMax: 1025 })).toHaveLength(
          1025,
        );
        expect(() => validateGlobPattern(promptGlob, 'prompt glob')).toThrow(
          'prompt glob expands to more than 1024 alternatives.',
        );
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('should demonstrate Promptfoo config glob separator semantics on the filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf983-config-glob-'));
    const cwd = path.join(root, 'checkout');
    fs.mkdirSync(path.join(cwd, 'providers', 'safe'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(cwd, 'providers', '1.py'), 'one');
    fs.writeFileSync(path.join(cwd, 'providers', '2.py'), 'two');
    fs.writeFileSync(path.join(cwd, 'providers', 'safe', 'in.yaml'), 'safe');
    fs.writeFileSync(path.join(root, 'outside', 'secret.yaml'), 'outside');
    fs.writeFileSync(path.join(root, 'outside-one.yaml'), 'one');
    fs.writeFileSync(path.join(root, 'outside-two.yaml'), 'two');

    try {
      expect(
        globSync('providers/\\{1..2}.py', {
          cwd,
          nodir: true,
          windowsPathsNoEscape: true,
        }).sort(),
      ).toEqual(['providers/1.py', 'providers/2.py']);
      expect(
        globSync('providers/\\{safe,../../outside}/*.yaml', {
          cwd,
          nodir: true,
          windowsPathsNoEscape: true,
        }).sort(),
      ).toEqual(['../outside/secret.yaml', 'providers/safe/in.yaml']);
      expect(
        globSync('..\\@(outside-one|outside-two).yaml', {
          cwd,
          nodir: true,
          windowsPathsNoEscape: true,
        }).sort(),
      ).toEqual(['../outside-one.yaml', '../outside-two.yaml']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
