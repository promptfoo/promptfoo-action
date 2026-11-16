import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { extractFileDependencies } from '../../src/utils/config';

it('tracks files and the watch directory for a nested provider glob', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfoo-action-'));
  try {
    const providers = path.join(root, 'providers');
    const file = path.join(providers, 'nested', 'provider.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.mkdirSync(path.join(providers, 'directory.js'));
    const config = path.join(root, 'promptfooconfig.yaml');
    fs.writeFileSync(config, 'providers:\n  - file://providers/**/*.js\n');

    const dependencies = extractFileDependencies(config);
    expect(dependencies.map((entry) => path.resolve(entry)).sort()).toEqual(
      [providers, file].sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
