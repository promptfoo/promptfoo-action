import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { extractFileDependencies } from '../../src/utils/config';

it('expands brace-only file references and tracks their common directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfoo-action-'));
  try {
    const files = [
      'direct.txt',
      'providers/alpha/entry.js',
      'providers/beta/entry.js',
      'providers/gamma/entry.js',
    ];
    for (const name of files) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }

    const config = path.join(root, 'promptfooconfig.yaml');
    fs.writeFileSync(
      config,
      'providers:\n  - file://direct.txt\n  - file://providers/{alpha,beta}/entry.js\n',
    );

    const dependencies = extractFileDependencies(config);
    expect(
      dependencies
        .map((entry) => path.relative(root, path.resolve(entry)))
        .sort(),
    ).toEqual([
      'direct.txt',
      'providers',
      path.join('providers', 'alpha', 'entry.js'),
      path.join('providers', 'beta', 'entry.js'),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
