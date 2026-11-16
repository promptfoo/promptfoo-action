import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '@actions/core';
import { expect, test, vi } from 'vitest';
import { run } from '../src/main';

test('loads later env files over earlier files and the runner environment', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'promptfoo-action-env-'));
  const inputs: Record<string, string> = {
    'github-token': 'test-token',
    'working-directory': path.relative(process.cwd(), directory),
    'env-files': '.env, .env.local',
    config: 'eval.yaml',
    prompts: 'unchanged.txt',
  };
  vi.mocked(core.getInput).mockImplementation((name) => inputs[name] || '');
  vi.stubEnv('PROMPTFOO_ENV_PRECEDENCE_TEST', 'runner');
  try {
    writeFileSync(
      path.join(directory, '.env'),
      'PROMPTFOO_ENV_PRECEDENCE_TEST=first\n',
    );
    writeFileSync(
      path.join(directory, '.env.local'),
      'PROMPTFOO_ENV_PRECEDENCE_TEST=second\n',
    );
    writeFileSync(
      path.join(directory, 'eval.yaml'),
      'prompts: [unchanged.txt]\n',
    );
    await run();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(process.env.PROMPTFOO_ENV_PRECEDENCE_TEST).toBe('second');
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
