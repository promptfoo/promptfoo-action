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
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('DOTENV_FAST', 'true');
  vi.stubEnv('PROMPTFOO_TEST_MULTILINE', undefined);
  try {
    writeFileSync(
      path.join(directory, '.env'),
      'PROMPTFOO_ENV_PRECEDENCE_TEST=first\n',
    );
    writeFileSync(
      path.join(directory, '.env.local'),
      'PROMPTFOO_TEST_MULTILINE=\n\n"line one\nline two"\n' +
        'PROMPTFOO_ENV_PRECEDENCE_TEST=second\nOPENAI_API_KEY=dotenv-test-key\n',
    );
    writeFileSync(
      path.join(directory, 'eval.yaml'),
      'prompts: [unchanged.txt]\n',
    );
    await run();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(process.env.PROMPTFOO_ENV_PRECEDENCE_TEST).toBe('second');
    expect(core.setSecret).toHaveBeenCalledWith('dotenv-test-key');
    expect(process.env.PROMPTFOO_TEST_MULTILINE).toBe('line one\nline two');
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
