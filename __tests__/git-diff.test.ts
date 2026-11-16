import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { expect, test } from 'vitest';

test('compares revisions with the options used for push events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'promptfoo-action-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (message: string) =>
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      message,
    );

  try {
    git('init', '-q');
    writeFileSync(join(dir, 'prompt.txt'), 'first');
    git('add', 'prompt.txt');
    commit('Initial prompt');
    const before = git('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'prompt.txt'), 'second');
    git('add', 'prompt.txt');
    commit('Update prompt');
    const after = git('rev-parse', 'HEAD');

    const changed = await simpleGit(dir).diff([
      '--name-only',
      before,
      after,
      '--',
    ]);
    expect(changed.trim()).toBe('prompt.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
