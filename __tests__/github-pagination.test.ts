import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('reads every page of PR files through the bundled GitHub client', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'promptfoo-action-'));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    if (!url.searchParams.has('page')) {
      res.setHeader(
        'link',
        `<http://${req.headers.host}${url.pathname}?page=2>; rel="next"`,
      );
    }
    res.end(JSON.stringify([{ filename: 'README.md' }]));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing port');
    fs.writeFileSync(
      path.join(root, 'event.json'),
      JSON.stringify({ pull_request: { number: 7 } }),
    );
    fs.writeFileSync(path.join(root, 'config.yaml'), 'prompts: []\n');
    const env: NodeJS.ProcessEnv = {
      PATH: root,
      HOME: root,
      INPUT_PROMPTS: 'prompts/*.txt',
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: path.join(root, 'event.json'),
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      INPUT_CONFIG: 'config.yaml',
      'INPUT_GITHUB-TOKEN': 'test-token',
    };
    for (const name of [
      'no-share',
      'use-config-prompts',
      'no-table',
      'no-progress-bar',
      'no-cache',
      'disable-comment',
      'force-run',
    ]) {
      env[`INPUT_${name.toUpperCase()}`] = 'false';
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve('dist/index.js')],
      { cwd: root, env, timeout: 8000 },
    );
    expect(requests).toEqual(
      Array(2).fill('/repos/test-owner/test-repo/pulls/7/files'),
    );
    expect(stdout).toContain(
      'No LLM prompt, config files, or dependencies were modified.',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
