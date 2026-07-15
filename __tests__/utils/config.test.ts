import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFileDependencies } from '../../src/utils/config';

vi.mock('fs', async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...realFs,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
    statSync: vi.fn(),
    promises: {
      access: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});
vi.mock('glob');

describe('extractFileDependencies', () => {
  const mockFs = fs as unknown as {
    readFileSync: Mock;
    existsSync: Mock;
    lstatSync: Mock;
    realpathSync: Mock;
    statSync: Mock;
  };
  const mockGlob = glob as unknown as {
    hasMagic: Mock;
    sync: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue('/test/working');
    // Default mock implementations
    mockGlob.hasMagic.mockReturnValue(false);
    mockGlob.sync.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.lstatSync.mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 64,
    } as fs.Stats);
    mockFs.realpathSync.mockImplementation((value: string) => value);
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  const mockConfigFiles = (files: Record<string, string>): void => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    });
  };

  const implicitConfigDependencies = (
    selectedConfig: string,
    workingDirectory = '',
  ): string[] =>
    ['promptfooconfig', 'redteam']
      .flatMap((name) =>
        ['yaml', 'yml', 'json', 'cjs', 'cts', 'js', 'mjs', 'mts', 'ts'].map(
          (extension) => `${workingDirectory}${name}.${extension}`,
        ),
      )
      .filter((dependency) => dependency !== selectedConfig);

  it('should extract file:// providers', () => {
    const configContent = `
providers:
  - file://custom_provider.py
  - id: file://another_provider.js
    config:
      temperature: 0.5
  - openai:gpt-4
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/custom_provider.py');
    expect(deps).toContain('../config/another_provider.js');
  });

  it('should extract prompt files', () => {
    const configContent = `
prompts:
  - file://prompts/prompt1.txt
  - file: prompts/prompt2.txt
  - "This is an inline prompt"
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/prompts/prompt1.txt');
    expect(deps).toContain('../config/prompts/prompt2.txt');
  });

  it('should extract test variable files', () => {
    const configContent = `
tests:
  - vars:
      context: file://data/context.txt
      examples:
        file: data/examples.json
      inline: "This is inline"
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/data/context.txt');
    expect(deps).toContain('../config/data/examples.json');
  });

  it('should extract assert files', () => {
    const configContent = `
tests:
  - assert:
      - type: contains
        value: file://expected/output.txt
      - type: javascript
        value:
          file: validators/custom.js
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/expected/output.txt');
    expect(deps).toContain('../config/validators/custom.js');
  });

  it('should extract defaultTest files', () => {
    const configContent = `
defaultTest:
  vars:
    template: file://templates/default.txt
  assert:
    - type: contains
      value: file://expected/default.txt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/templates/default.txt');
    expect(deps).toContain('../config/expected/default.txt');
  });

  it('should extract dependencies inherited through YAML merge keys', () => {
    const configContent = `
shared: &shared
  providers:
    - file://providers/inherited.py
  prompts:
    - file://prompts/inherited.txt
<<: *shared
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/inherited.py',
      'prompts/inherited.txt',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('should handle empty config', () => {
    mockFs.readFileSync.mockReturnValue('');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(core.warning).not.toHaveBeenCalled();
    expect(deps).toHaveLength(0);
    expect(core.debug).toHaveBeenCalledWith('Config file is empty or invalid');
  });

  it('should handle an explicit null config', () => {
    mockFs.readFileSync.mockReturnValue('null');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.debug).toHaveBeenCalledWith('Config file is empty or invalid');
  });

  it('should handle invalid YAML gracefully', () => {
    mockFs.readFileSync.mockReturnValue('invalid: yaml: content:');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should handle file read errors gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should handle non-Error file read failures gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should ignore dependencies that escape the config directory', () => {
    const configContent = `
providers:
  - file://providers/custom.py
  - file://../secrets/provider.py
prompts:
  - file: ../secrets/prompt.txt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py']);
  });

  it('should ignore empty and null-byte dependencies', () => {
    const configContent = `
providers:
  - file://
  - "file://\\0provider.py"
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should ignore unsafe object-form variable and assertion dependencies', () => {
    const configContent = `
tests:
  - vars:
      context:
        file: ../../outside/context.txt
    assert:
      - type: javascript
        value:
          file: ../../outside/validator.js
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('should keep sibling dependencies inside the workspace', () => {
    const configContent = `
providers:
  - file://../providers/custom.py
prompts:
  - file: ../prompts/prompt.txt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'providers/custom.py',
      'prompts/prompt.txt',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('should keep dependencies whose names begin with two dots', () => {
    const configContent = `
providers:
  - file://..fixtures/custom.py
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/..fixtures/custom.py',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('should preserve whitespace in quoted dependency paths', () => {
    const configContent = `
providers:
  - "file:// prompts/custom.py "
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/ prompts/custom.py ',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('sanitizes CRLF in an unsafe direct dependency warning', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://../../secrets/policy\\n::error::forged.py"
`);

    extractFileDependencies('/test/working/evals/promptfooconfig.yaml');

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('policy\\n::error::forged.py'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it.each([
    'C:\\outside\\provider.py',
    'C:/outside/provider.py',
    'C:relative-provider.py',
    '\\\\server\\share\\provider.py',
    '\\root-relative\\provider.py',
  ])('rejects a foreign Windows dependency path %s', (providerPath) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({
        providers: [`file://${providerPath}`],
      }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('uses an unsupported Windows path'),
    );
  });

  it.each([
    'C:\\outside\\options.yaml',
    'C:/outside/options.yaml',
    'C:relative-options.yaml',
    '\\\\server\\share\\options.yaml',
  ])('fails closed for a foreign Windows config ref %s', (refPath) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({ $ref: refPath }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('unsafe Promptfoo config refs are unsupported'),
    );
  });

  it.each([
    'C:\\outside\\.env',
    'C:/outside/.env',
    'C:relative.env',
    '\\\\server\\share\\.env',
    '.env.safe, C:\\outside\\.env',
  ])('fails closed for a foreign Windows config envPath %s', (envPath) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({
        commandLineOptions: { envPath },
      }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('uses an unsupported Windows path'),
    );
  });

  it('should fail closed before expanding a cross-directory brace glob', () => {
    const configContent = `
providers:
  - file://{../secrets,providers}/*.py
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockGlob.hasMagic.mockImplementation(
      (path: string) =>
        path.includes('*') || path.includes('{') || path.includes('}'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/secrets/leaked.py',
      '/test/config/providers/custom.py',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('ignores a lexically escaping match returned for a safe glob pattern', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'providers:\n  - file://providers/*.py\n',
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/secrets/leaked.py',
      '/test/working/providers/safe.py',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/safe.py',
      'providers/',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('glob match must stay within'),
    );
  });

  it('should extract all file types from complex config', () => {
    const configContent = `
providers:
  - file://providers/custom.py
  - openai:gpt-4

prompts:
  - file://prompts/main.txt
  - file: prompts/secondary.txt

defaultTest:
  vars:
    context: file://data/default-context.txt

tests:
  - vars:
      input: file://data/test1.json
      expected:
        file: data/expected1.txt
    assert:
      - type: contains
        value: file://validators/contains.txt
      - type: javascript
        value:
          file: validators/custom.js
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(8);
    expect(deps).toContain('../config/providers/custom.py');
    expect(deps).toContain('../config/prompts/main.txt');
    expect(deps).toContain('../config/prompts/secondary.txt');
    expect(deps).toContain('../config/data/default-context.txt');
    expect(deps).toContain('../config/data/test1.json');
    expect(deps).toContain('../config/data/expected1.txt');
    expect(deps).toContain('../config/validators/contains.txt');
    expect(deps).toContain('../config/validators/custom.js');
  });

  it('should return relative paths from current working directory', () => {
    const configContent = `
providers:
  - file://provider.py
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    // Config is at /test/config/promptfooconfig.yaml
    // Working directory is /test/working/dir
    // Provider file will be at /test/config/provider.py
    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    // Relative path from /test/working/dir to /test/config/provider.py
    expect(deps).toContain('../config/provider.py');
  });

  it('should handle glob patterns in file:// URLs', () => {
    const configContent = `
providers:
  - file://providers/*.py
  - id: file://custom/**/*.js
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockGlob.hasMagic.mockImplementation(
      (path: string) => path.includes('*') || path.includes('**'),
    );

    mockGlob.sync.mockImplementation((pattern: string) => {
      const patternStr = String(pattern);
      if (patternStr.includes('providers/*.py')) {
        return [
          '/test/config/providers/provider1.py',
          '/test/config/providers/provider2.py',
        ];
      }
      if (patternStr.includes('custom/**/*.js')) {
        return [
          '/test/config/custom/lib/helper.js',
          '/test/config/custom/utils/format.js',
        ];
      }
      return [];
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/providers/provider1.py');
    expect(deps).toContain('../config/providers/provider2.py');
    expect(deps).toContain('../config/custom/lib/helper.js');
    expect(deps).toContain('../config/custom/utils/format.js');
    // Should also include directories for watching
    expect(deps).toContain('../config/providers/');
    expect(deps).toContain('../config/custom/');
  });

  it('should handle a glob without a base directory', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/provider.py']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/provider.py', '../config/']);
  });

  it('keeps a dependency-glob directory sentinel when the last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/']);
  });

  it('keeps a root dependency-glob sentinel when the last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./', ...implicitConfigDependencies('promptfooconfig.yaml')]);
  });

  it('ignores a dependency-glob match whose symlink escapes the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/leak.py',
      '/test/config/providers/safe.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('/providers/leak.py')
        ? '/test/secrets/leak.py'
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/safe.py', '../config/providers/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
    );
  });

  it('ignores an unverifiable dependency-glob match and preserves safe siblings', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/denied.py',
      '/test/config/providers/safe.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/denied.py')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/safe.py', '../config/providers/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
    );
  });

  it('ignores a dependency-glob match containing a line break', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/forged\n::error::entry.py',
      '/test/config/providers/safe.py',
    ]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/safe.py', '../config/providers/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path contains an invalid line break',
    );
  });

  it('preserves a checkout glob match when the unused external-config root is unverifiable', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/safe.py']);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === '/test/shared') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/safe.py', 'providers/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('fails closed when an in-checkout config root resolves outside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/direct.py
  - file://providers/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/shared-link/providers/glob.js',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).startsWith('/test/working/shared-link')
        ? String(filePath).replace('/test/working/shared-link', '/test/shared')
        : String(filePath),
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/working/shared-link/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Promptfoo config must stay within the repository workspace',
      ),
    );
  });

  it('preserves dependencies from an explicitly external symlinked config root', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/direct.py
  - file://providers/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config-link/providers/glob.js']);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).startsWith('/test/config-link')
        ? String(filePath).replace('/test/config-link', '/test/shared')
        : String(filePath),
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config-link/promptfooconfig.yaml'),
    ).toEqual([
      '../shared/promptfooconfig.yaml',
      '../config-link/providers/direct.py',
      '../config-link/providers/glob.js',
      '../config-link/providers/',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('ignores a direct dependency symlink that resolves outside the workspace', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - file://providers/leak.py',
        '  - file://providers/safe.py',
      ].join('\n'),
    });
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('/providers/leak.py')
        ? '/test/secrets/leak.py'
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/safe.py',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path must stay within'),
    );
  });

  it('ignores an existing dangling direct dependency symlink', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'providers:\n  - file://providers/dangling.py\n',
    });
    mockFs.lstatSync.mockImplementation(
      (filePath: fs.PathLike) =>
        ({
          isFile: () => !String(filePath).endsWith('/providers/dangling.py'),
          isSymbolicLink: () =>
            String(filePath).endsWith('/providers/dangling.py'),
          size: 64,
        }) as fs.Stats,
    );
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/dangling.py')) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('cannot be verified'),
    );
  });

  it.each([
    'ENOENT',
    'ENOTDIR',
  ])('preserves a genuinely missing direct dependency when lstat reports %s', (code) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'providers:\n  - file://providers/deleted.py\n',
    });
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/deleted.py')) {
        throw Object.assign(new Error('not found'), { code });
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 64,
      } as fs.Stats;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/deleted.py',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('ignores a direct dependency whose metadata cannot be read', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'providers:\n  - file://providers/denied.py\n',
    });
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/denied.py')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 64,
      } as fs.Stats;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('permission denied'),
    );
  });

  it.each([
    ['ENOENT', true],
    ['ENOTDIR', true],
    ['EACCES', false],
  ])('handles a regular direct dependency whose realpath reports %s', (code, tracked) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'providers:\n  - file://providers/transient.py\n',
    });
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/transient.py')) {
        throw Object.assign(new Error('path unavailable'), { code });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      ...(tracked ? ['providers/transient.py'] : []),
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('sanitizes a dependency-glob expansion error before emitting a warning', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('permission denied\n::error::forged');
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('permission denied\\n::error::forged'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('normalizes a direct repository-root directory dependency to the workspace sentinel', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://.
`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./', ...implicitConfigDependencies('promptfooconfig.yaml')]);
  });

  it.each([
    'file://validators/status.js',
    'file://validators/status.js:validateStatus',
  ])('tracks the HTTP validateStatus dependency %s', (validator) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        `      validateStatus: ${validator}`,
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks a named validateStatus export from a mapped HTTP provider', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - https:',
        '      config:',
        '        validateStatus: file://validators/status.js:validateStatus',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks an HTTP validateStatus dependency inherited through a local ref', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml':
        "$ref: './defs.yaml#/suite'\n",
      '/test/working/defs.yaml': [
        'suite:',
        '  providers:',
        '    - id: https',
        '      config:',
        '        validateStatus: file://validators/status.js:validateStatus',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'defs.yaml',
      'evals/validators/status.js',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it.each([
    'providers',
    'targets',
  ])('tracks mapped HTTP %s validator, file auth, TLS, and signature dependencies', (providerKey) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        `${providerKey}:`,
        "  - 'https://api.example.test/chat':",
        '      config:',
        '        validateStatus: file://validators/status.js:validateStatus',
        '        auth:',
        '          type: file',
        '          path: file://auth/get-token.ts:buildAuth',
        '        tls:',
        '          caPath: certs/ca.pem',
        '          certPath: certs/client.pem',
        '          keyPath: certs/client.key',
        '          pfxPath: certs/client.pfx',
        '          jksPath: certs/client.jks',
        '        signatureAuth:',
        '          privateKeyPath: signature/private.key',
        '          keystorePath: signature/keystore.jks',
        '          pfxPath: signature/client.pfx',
        '          certPath: signature/client.pem',
        '          keyPath: signature/client.key',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.js',
      'auth/get-token.ts',
      'certs/ca.pem',
      'certs/client.pem',
      'certs/client.key',
      'certs/client.pfx',
      'certs/client.jks',
      'signature/private.key',
      'signature/keystore.jks',
      'signature/client.pfx',
      'signature/client.pem',
      'signature/client.key',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks mapped HTTP target dependencies inherited through a local ref', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml':
        "$ref: './defs.yaml#/suite'\n",
      '/test/working/defs.yaml': [
        'suite:',
        '  targets:',
        "    - 'https://api.example.test/chat':",
        '        config:',
        '          validateStatus: file://validators/status.js:validateStatus',
        '          auth:',
        '            type: file',
        '            path: file://auth/get-token.py:get_auth',
        '          tls:',
        '            caPath: certs/ca.pem',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'defs.yaml',
      'evals/validators/status.js',
      'evals/auth/get-token.py',
      'evals/certs/ca.pem',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('does not treat non-HTTP auth or TLS path fields as HTTP dependencies', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        "  - 'openai:gpt-4.1-mini':",
        '      config:',
        '        auth:',
        '          type: file',
        '          path: auth/get-token.ts',
        '        tls:',
        '          caPath: certs/ca.pem',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('tracks an HTTP file-auth path without a file URL prefix', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      auth:',
        '        type: file',
        '        path: auth/get-token.ts',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'auth/get-token.ts',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('fails closed when an environment-templated provider id can dispatch HTTP files', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: "{{ env.HTTP_PROVIDER | default(\'https\') }}"',
        '    config:',
        '      url: https://example.test/invoke',
        '      tls:',
        '        caPath: tls/ca.pem',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('tracks HTTP file-auth and multipart paths behind templated discriminators', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      url: https://example.test/invoke',
        '      auth:',
        '        type: "{{ env.AUTH_TYPE | default(\'file\') }}"',
        '        path: auth/get-token.py',
        '      multipart:',
        '        parts:',
        '          - kind: "{{ env.PART_KIND | default(\'file\') }}"',
        '            name: attachment',
        '            source:',
        '              type: "{{ env.SOURCE_TYPE | default(\'path\') }}"',
        '              path: uploads/input.bin',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'auth/get-token.py',
      'uploads/input.bin',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('ignores non-file and malformed HTTP multipart entries safely', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      multipart:',
        '        parts:',
        '          - null',
        '          - kind: field',
        '            name: label',
        '            value: inline',
        '          - kind: file',
        '            name: generated',
        '            source:',
        '              type: generated',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));

    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      multipart: {}',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('fails closed for an env expression that can emit a file URL but ignores ordinary filtered env text', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      body:',
        "        context: \"{{ 'file://' ~ (env.CONTEXT_FILE | default('data/context.json')) }}\"",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);

    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      body:',
        '        context: "{% if env.LOAD_CONTEXT %}file://data/context.json{% endif %}"',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);

    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      headers:',
        '        x-label: "hello {{ env.LABEL | default(\'world\') | upper }}"',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('ignores an HTTP file-auth configuration without a path', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      auth:',
        '        type: file',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('tracks both uppercase validateStatus selector interpretations across Promptfoo versions', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        '      validateStatus: file://validators/status.JS:validateStatus',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.JS:validateStatus',
      'validators/status.JS',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('preserves an empty HTTP validateStatus selector as a literal filename', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        "      validateStatus: 'file://validators/status.js:'",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.js:',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it.each([
    'null',
    '"status >= 200 && status < 300"',
  ])('ignores a non-file HTTP validateStatus value %s', (validator) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: https',
        '    config:',
        `      validateStatus: ${validator}`,
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('does not treat validateStatus on a non-HTTP provider as an HTTP function reference', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: openai:gpt-4.1-mini',
        '    config:',
        '      validateStatus: file://validators/status.js:validateStatus',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'validators/status.js:validateStatus',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('preserves literal var filenames and tracks executable assertion files', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'defaultTest:',
        '  vars:',
        '    ruby: file://vars/build.rb:build',
        '    go: file://vars/build.go:Build',
        'tests:',
        '  - vars:',
        '      js: file://vars/build.js:build',
        '      python: file://vars/build.py:build',
        '    assert:',
        '      - type: javascript',
        '        value: file://assert/check.go:Check',
        '      - type: javascript',
        '        value: file://assert/check.rb:check',
        '      - type: javascript',
        '        value: file://assert/check.js:check',
        '      - type: python',
        '        value: file://assert/check.py:check',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'vars/build.rb:build',
      'vars/build.go:Build',
      'vars/build.js:build',
      'vars/build.py:build',
      'assert/check.go:Check',
      'assert/check.rb',
      'assert/check.js',
      'assert/check.py',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('preserves literal vars and tracks Ruby namespaces inherited through a local ref', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml':
        "$ref: './defs.yaml#/suite'\n",
      '/test/working/defs.yaml': [
        'suite:',
        '  defaultTest:',
        '    vars:',
        '      build: file://vars/build.go:Build',
        '    assert:',
        '      - type: javascript',
        '        value: file://assert/check.rb:Policy::check',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'defs.yaml',
      'evals/assert/check.rb',
      'evals/vars/build.go:Build',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('preserves uppercase and non-executable selector-like var filenames', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'tests:',
        '  - vars:',
        '      uppercaseJs: file://vars/build.JS:Build',
        '      uppercaseGo: file://vars/build.GO:Build',
        '      data: file://vars/context.json:literal',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'vars/build.JS:Build',
      'vars/build.GO:Build',
      'vars/context.json:literal',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks both uppercase JavaScript assertion selector interpretations across Promptfoo versions', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'tests:',
        '  - assert:',
        '      - type: javascript',
        '        value: file://assert/check.JS:Policy::check',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'assert/check.JS:Policy::check',
      'assert/check.JS',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks executable provider paths across strings, ids, and mapped targets', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - file://providers/build.py:call_api',
        '  - id: file://providers/build.go:CallApi',
        "  - 'file://providers/build.rb:call_api':",
        '      config: {}',
        '  - file://providers/build.JS:callApi',
        'targets:',
        '  - file://targets/build.js:callApi',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/build.py',
      'providers/build.go',
      'providers/build.JS:callApi',
      'providers/build.JS',
      'providers/build.rb',
      'targets/build.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks python, golang, and ruby provider prefixes across strings, ids, maps, and targets', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - python:providers/build.py:call_api',
        '  - id: golang:providers/build.go:CallApi',
        "  - 'ruby:providers/build.rb:call_api':",
        '      config: {}',
        '  - go:providers/ignored.go:CallApi',
        'targets:',
        '  - python:targets/build.py:call_api',
        '  - id: golang:targets/build.go:CallApi',
        "  - 'ruby:targets/build.rb:call_api':",
        '      config: {}',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/build.py',
      'providers/build.go',
      'providers/build.rb',
      'targets/build.py',
      'targets/build.go',
      'targets/build.rb',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks JavaScript provider selectors containing slashes and preserves namespaced Ruby provider paths', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - file://providers/build.js:policy/check',
        '  - ruby:providers/build.rb:Policy::check',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/build.js',
      'providers/build.rb:Policy::check',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('safely ignores null provider entries while preserving valid siblings', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - null',
        '  - python:providers/build.py:call_api',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/build.py',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('tracks nested assert-set validators and safely handles cyclic aliases', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'shared: &set',
        '  type: assert-set',
        '  assert:',
        '    - *set',
        '    - type: javascript',
        '      value: file://assert/check.js:check',
        '    - type: python',
        '      value: file://assert/check.py:check',
        '    - type: ruby',
        '      value: file://assert/check.rb:Policy::check',
        '    - type: javascript',
        '      value:',
        '        file: assert/object-check.js',
        'tests:',
        '  - assert:',
        '      - *set',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'assert/check.js',
      'assert/check.py',
      'assert/check.rb',
      'assert/object-check.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('visits a shared assert-set alias DAG once without exponential expansion', () => {
    const levels = 18;
    const aliases = [
      'leaf: &level0',
      '  - type: javascript',
      '    value: file://assert/check.js:check',
    ];
    for (let level = 1; level <= levels; level++) {
      aliases.push(`level${level}: &level${level}`);
      aliases.push('  - type: assert-set');
      aliases.push(`    assert: *level${level - 1}`);
      aliases.push('  - type: assert-set');
      aliases.push(`    assert: *level${level - 1}`);
    }
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        ...aliases,
        'tests:',
        '  - assert:',
        '      - type: assert-set',
        `        assert: *level${levels}`,
      ].join('\n'),
    });
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'assert/check.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('safely ignores malformed nested assertion shapes while tracking valid siblings', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'tests:',
        '  - assert:',
        '      - null',
        '      - []',
        '      - type: assert-set',
        '        assert: invalid',
        '      - type: assert-set',
        '        assert:',
        '          - type: javascript',
        '            value: file://assert/check.js:check',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'assert/check.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('tracks plain prompts, test generators, scenarios, and Nunjucks filter dependencies', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'prompts:',
        '  - prompts/base.txt',
        '  - prompts/**/*.txt',
        'tests:',
        '  - tests/cases.yaml',
        '  - path: file://generators/build-tests.py:generate',
        'scenarios:',
        '  - scenarios/shared.yaml',
        '  - tests: scenarios/cases.yaml',
        '  - tests:',
        '      - scenarios/extra.yaml',
        '      - path: file://scenarios/generate.js:build',
        '    config:',
        '      - vars:',
        '          input: file://scenarios/context.json',
        '        assert:',
        '          - type: python',
        '            value: file://scenarios/check.py:validate',
        'nunjucksFilters:',
        '  direct: filters/format.js',
        '  globbed: filters/custom/**/*.js',
      ].join('\n'),
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((pattern: string) => {
      if (pattern.endsWith('prompts/**/*.txt')) {
        return ['/test/working/prompts/nested/policy.txt'];
      }
      if (pattern.endsWith('filters/custom/**/*.js')) {
        return ['/test/working/filters/custom/shared.js'];
      }
      return [];
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/base.txt',
      'prompts/nested/policy.txt',
      'prompts/',
      'tests/cases.yaml',
      'generators/build-tests.py',
      'scenarios/shared.yaml',
      'scenarios/cases.yaml',
      'scenarios/extra.yaml',
      'scenarios/generate.js',
      'scenarios/context.json',
      'scenarios/check.py',
      'filters/format.js',
      'filters/custom/shared.js',
      'filters/custom/',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks a top-level TestGeneratorConfig object', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'tests:',
        '  path: file://generators/build-tests.py:generate',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'generators/build-tests.py',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks scalar prompt/default-test paths, plain generators, and a single scenario config', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'prompts: prompts/base.txt',
        'defaultTest: defaults/base.yaml',
        'tests:',
        '  path: generators/build-tests.py',
        'scenarios:',
        '  config:',
        '    - vars:',
        '        input: file://scenarios/context.json',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/base.txt',
      'defaults/base.yaml',
      'generators/build-tests.py',
      'scenarios/context.json',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('keeps punctuation-only inline prompts out of dependency globbing', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': "prompts:\n  - 'What is 2+2?'\n",
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('?'),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    'What is 2+2?\nExplain briefly.',
    'portkey://prompt-id',
    'langfuse://prompt-id',
    'helicone://prompt-id',
  ])('keeps a runtime-inline prompt out of dependency extraction: %s', (prompt) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({
        prompts: [prompt],
      }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('fails closed for an empty prompt reference and safely ignores a non-object entry', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({ prompts: [''] }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Promptfoo prompt dependency'),
    );

    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({ prompts: [7] }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('tracks executable and object prompt references while preserving inline map entries', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'prompts:',
        '  - exec:prompts/build.py:generate',
        '  - exec:file://prompts/build-file-url.py:generate',
        '  - exec:prompts/build.sh',
        '  - raw: file://prompts/object.rb:render',
        '    id: prompts/object.js:render',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/build.py',
      'prompts/build-file-url.py',
      'prompts/build.sh',
      'prompts/object.rb',
      'prompts/object.js',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);

    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': JSON.stringify({
        prompts: {
          inline: 'What is 2+2?',
          file: 'prompts/mapped.txt',
        },
      }),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/mapped.txt',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks a scalar file-backed tests reference', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': 'tests: file://tests/cases.yaml\n',
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'tests/cases.yaml',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('fails closed for a command-style executable prompt', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        "prompts:\n  - 'exec:node prompts/build.js'\n",
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Command-style Promptfoo exec prompts are unsafe',
      ),
    );
  });

  it('rejects an escaping executable file URL prompt dependency', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        "prompts:\n  - 'exec:file://../../outside.py:generate'\n",
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('safely ignores a prompt object without a file reference', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': 'prompts:\n  - {}\n',
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it('tracks HTTP request, response, and session parser modules', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'targets:',
        '  - id: https',
        '    config:',
        '      transformRequest: file://hooks/request.js:literal.ts:run',
        '      transformResponse: file://hooks/response.js:transform',
        '      responseParser: file://hooks/legacy.cjs:parse',
        '      sessionParser: file://hooks/session.mjs:parse',
        '      session:',
        '        responseParser: file://hooks/endpoint.ts:parse',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'hooks/request.js:literal.ts',
      'hooks/response.js',
      'hooks/legacy.cjs',
      'hooks/session.mjs',
      'hooks/endpoint.ts',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('ignores an inline HTTP session response parser', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'targets:',
        '  - id: https',
        '    config:',
        '      session:',
        '        responseParser: json.sessionId',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('promptfooconfig.yaml'));
  });

  it.each([
    'tests: false\n',
    'scenarios:\n  - false\n',
    'scenarios:\n  - tests: false\n',
    'nunjucksFilters: false\n',
    'nunjucksFilters: []\n',
    'nunjucksFilters:\n  invalid: false\n',
  ])('fails closed for a malformed runtime dependency surface: %s', (content) => {
    mockConfigFiles({ '/test/working/promptfooconfig.yaml': content });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extract dependencies from config'),
    );
  });

  it('tracks both uppercase HTTP file-auth selector interpretations across Promptfoo versions', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'targets:',
        '  - id: https',
        '    config:',
        '      auth:',
        '        type: file',
        '        path: file://auth/get-token.TS:buildAuth',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'auth/get-token.TS:buildAuth',
      'auth/get-token.TS',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('should build nested base directories for globs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/python/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/python/provider.py',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/providers/python/');
  });

  it('should handle directory paths in file:// URLs', () => {
    const configContent = `
providers:
  - file://providers/
  - file://lib
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockFs.existsSync.mockImplementation((path: unknown) => {
      const pathStr = String(path);
      return pathStr.includes('providers') || pathStr.includes('lib');
    });

    mockFs.statSync.mockImplementation(
      () =>
        ({
          isDirectory: () => true,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/providers/');
    expect(deps).toContain('../config/lib');
  });

  it('should handle wildcards in test vars and asserts', () => {
    const configContent = `
tests:
  - vars:
      data: file://test-data/*.json
    assert:
      - type: javascript
        value: file://validators/*.js
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockGlob.hasMagic.mockImplementation((path: string) => path.includes('*'));

    mockGlob.sync.mockImplementation((pattern: string) => {
      const patternStr = String(pattern);
      if (patternStr.includes('test-data/*.json')) {
        return ['/test/config/test-data/data1.json'];
      }
      if (patternStr.includes('validators/*.js')) {
        return ['/test/config/validators/validator.js'];
      }
      return [];
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/test-data/data1.json');
    expect(deps).toContain('../config/validators/validator.js');
    expect(deps).toContain('../config/test-data/');
    expect(deps).toContain('../config/validators/');
  });

  it('should ignore inline assertion values', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: contains
        value: inline expected text
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('tracks literal envPath entries from a nested config, including deleted files', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': [
        'commandLineOptions:',
        '  envPath:',
        '    - .env.first',
        "    - '.env.second, .env.deleted'",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/.env.first',
      'evals/.env.second',
      '.env.deleted',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it.each([
    "''",
    "'   '",
    "' , , '",
    "['', '   ', ' , ']",
  ])('ignores an empty config-declared envPath: %s', (value) => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': `commandLineOptions:\n  envPath: ${value}\n`,
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(implicitConfigDependencies('evals/promptfooconfig.yaml'));
  });

  it('ignores empty envPath list entries while tracking a valid entry', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml':
        "commandLineOptions:\n  envPath: ['', '   ', .env.safe, ' , ']\n",
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/.env.safe',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('tracks external root and local fragment refs using Promptfoo path semantics', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml':
        "$ref: './defs/configs.yaml#/configs/real'\n",
      '/test/working/defs/configs.yaml': [
        'configs:',
        '  decoy:',
        '    commandLineOptions:',
        '      envPath: .env.decoy',
        '  real:',
        '    commandLineOptions:',
        "      $ref: './options.json#/items/a~1b~0c'",
      ].join('\n'),
      '/test/working/defs/options.json':
        '{"items":{"a/b~c":{"envPath":".env.late"}}}',
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'defs/configs.yaml',
      'defs/options.json',
      'evals/.env.late',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('tracks an envPath inherited through an in-document fragment ref', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': [
        'defs:',
        '  options:',
        '    envPath: .env.fragment',
        'commandLineOptions:',
        "  $ref: '#/defs/options'",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/.env.fragment',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('ignores inactive config refs when the trusted ref parser is disabled', () => {
    const originalValue = process.env.PROMPTFOO_DISABLE_REF_PARSER;
    process.env.PROMPTFOO_DISABLE_REF_PARSER = 'YePpErS';
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': "$ref: './ignored.yaml'\n",
      '/test/working/ignored.yaml':
        'commandLineOptions:\n  envPath: .env.ignored\n',
    });

    try {
      expect(
        extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
      ).toEqual(implicitConfigDependencies('evals/promptfooconfig.yaml'));
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROMPTFOO_DISABLE_REF_PARSER;
      } else {
        process.env.PROMPTFOO_DISABLE_REF_PARSER = originalValue;
      }
    }
  });

  it('tracks a local envPath while ignoring its inactive commandLineOptions ref', () => {
    const originalValue = process.env.PROMPTFOO_DISABLE_REF_PARSER;
    process.env.PROMPTFOO_DISABLE_REF_PARSER = 'yes';
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': [
        'commandLineOptions:',
        "  $ref: './ignored.yaml'",
        '  envPath: .env.safe',
      ].join('\n'),
      '/test/working/ignored.yaml': 'envPath: .env.ignored\n',
    });

    try {
      expect(
        extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
      ).toEqual([
        'evals/.env.safe',
        ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
      ]);
    } finally {
      if (originalValue === undefined) {
        delete process.env.PROMPTFOO_DISABLE_REF_PARSER;
      } else {
        process.env.PROMPTFOO_DISABLE_REF_PARSER = originalValue;
      }
    }
  });

  it('tracks refs nested under tests that Promptfoo dereferences', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': [
        'tests:',
        "  - $ref: './cases.yaml#/tests/first'",
      ].join('\n'),
      '/test/working/cases.yaml': [
        'tests:',
        '  first:',
        '    vars:',
        '      input: hello',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'cases.yaml',
      ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
    ]);
  });

  it('resolves the first external ref from the Promptfoo working directory', () => {
    mockConfigFiles({
      '/test/working/evals/nested/promptfooconfig.yaml':
        "$ref: './shared.yaml'\n",
      '/test/working/evals/shared.yaml':
        'commandLineOptions:\n  envPath: .env.selected\n',
    });

    expect(
      extractFileDependencies(
        '/test/working/evals/nested/promptfooconfig.yaml',
        '/test/working',
        '/test/working/evals',
      ),
    ).toEqual([
      'evals/shared.yaml',
      'evals/nested/.env.selected',
      ...implicitConfigDependencies(
        'evals/nested/promptfooconfig.yaml',
        'evals/',
      ),
    ]);
  });

  it('ignores refs and ids inside provider function and tool parameter schemas', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: openai:gpt-4',
        '    config:',
        '      functions:',
        '        - name: lookup',
        '          parameters:',
        "            $id: 'https://schema.example/functions'",
        '            properties:',
        '              input:',
        "                $ref: '#/$defs/input'",
        '      tools:',
        '        - type: function',
        '          function:',
        '            name: search',
        '            parameters:',
        "              $id: 'https://schema.example/tools'",
        '              properties:',
        '                query:',
        "                  $ref: '#/$defs/query'",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([...implicitConfigDependencies('promptfooconfig.yaml')]);
  });

  it('tracks a provider parameter alias that is also a dereferenced test', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - id: openai:gpt-4',
        '    config:',
        '      tools:',
        '        - type: function',
        '          function:',
        '            name: lookup',
        '            parameters: &case',
        "              $ref: './case.yaml'",
        'tests:',
        '  - *case',
      ].join('\n'),
      '/test/working/case.yaml': 'vars:\n  input: case\n',
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'case.yaml',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('tracks literal wildcard-looking ref and envPath filenames without expanding them', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'tests:',
        "  - $ref: './defs/[v1].yaml'",
        "  - $ref: './opts*.yaml'",
        'commandLineOptions:',
        "  envPath: '.env.{dev,local}'",
      ].join('\n'),
      '/test/working/defs/[v1].yaml': 'vars:\n  input: first\n',
      '/test/working/opts*.yaml': 'vars:\n  input: second\n',
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('[') || value.includes('{'),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'opts*.yaml',
      'defs/[v1].yaml',
      '.env.{dev',
      'local}',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('tracks refs and file-backed dependencies inside an external base config', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': "$ref: './base.yaml'\n",
      '/test/working/base.yaml': [
        'providers:',
        '  - id: file://providers/custom.js',
        '    config:',
        '      functions:',
        '        - name: lookup',
        '          parameters:',
        "            $ref: './schema.yaml'",
        'prompts:',
        '  - file: prompts/referenced.txt',
        'tests:',
        '  - vars:',
        '      context: file://data/context.txt',
        '    assert:',
        '      - type: javascript',
        '        value: file://validators/check.js',
      ].join('\n'),
      '/test/working/schema.yaml': 'type: object\n',
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toHaveLength(24);
    expect(deps).toEqual(
      expect.arrayContaining([
        'base.yaml',
        'schema.yaml',
        'evals/providers/custom.js',
        'evals/prompts/referenced.txt',
        'evals/data/context.txt',
        'evals/validators/check.js',
        ...implicitConfigDependencies('evals/promptfooconfig.yaml'),
      ]),
    );
  });

  it('tracks the effective config envPath vault companion when DOTENV_KEY is set', () => {
    const originalDotenvKey = process.env.DOTENV_KEY;
    process.env.DOTENV_KEY = 'trusted-dotenv-key';
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'commandLineOptions:\n  envPath: [.env.first, .env.second]\n',
    });

    try {
      expect(
        extractFileDependencies('/test/working/promptfooconfig.yaml'),
      ).toEqual([
        '.env.first',
        '.env.second',
        '.env.second.vault',
        ...implicitConfigDependencies('promptfooconfig.yaml'),
      ]);
    } finally {
      if (originalDotenvKey === undefined) {
        delete process.env.DOTENV_KEY;
      } else {
        process.env.DOTENV_KEY = originalDotenvKey;
      }
    }
  });

  it('does not append a second vault suffix to an explicit vault envPath', () => {
    const originalDotenvKey = process.env.DOTENV_KEY;
    process.env.DOTENV_KEY = 'trusted-dotenv-key';
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'commandLineOptions:\n  envPath: .env.production.vault\n',
    });

    try {
      expect(
        extractFileDependencies('/test/working/promptfooconfig.yaml'),
      ).toEqual([
        '.env.production.vault',
        ...implicitConfigDependencies('promptfooconfig.yaml'),
      ]);
    } finally {
      if (originalDotenvKey === undefined) {
        delete process.env.DOTENV_KEY;
      } else {
        process.env.DOTENV_KEY = originalDotenvKey;
      }
    }
  });

  it('fails closed when a referenced config has been deleted', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': "$ref: './deleted.yaml'\n",
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('tracks both a safe config-ref symlink and its target', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': "$ref: './shared.yaml'\n",
      '/test/working/shared.yaml':
        "commandLineOptions:\n  $ref: './opts.yaml'\n",
      '/test/working/opts.yaml': 'envPath: .env.linked\n',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value === '/test/working/shared.yaml'
        ? '/test/working/defs/actual.yaml'
        : value,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'shared.yaml',
      'defs/actual.yaml',
      'opts.yaml',
      '.env.linked',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('fails closed when a config-ref or envPath symlink escapes the workspace', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': "$ref: './shared.yaml'\n",
      '/test/working/shared.yaml':
        'commandLineOptions:\n  envPath: .env.linked\n',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value === '/test/working/shared.yaml' ||
      value === '/test/working/.env.linked'
        ? `/test/outside/${value.split('/').at(-1)}`
        : value,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('fails closed when the root config symlink escapes the workspace', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': 'providers: []\n',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value === '/test/working/promptfooconfig.yaml'
        ? '/test/outside/promptfooconfig.yaml'
        : value,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('fails closed when only an envPath symlink escapes the workspace', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        'commandLineOptions:\n  envPath: .env.linked\n',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value === '/test/working/.env.linked'
        ? '/test/outside/.env.linked'
        : value,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['/test/working/evals/*.yaml', 'providers: []\n'],
    ['/test/working/promptfooconfig.ts', 'export default {};\n'],
  ])('fails closed for a dynamic or executable root config %s', (configPath, content) => {
    mockConfigFiles({ [configPath]: content });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
  });

  it('fails closed before inspecting an oversized root config pattern', () => {
    const configPath = `/test/working/${'a'.repeat(70_000)}.yaml`;
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) throw new TypeError('pattern is too long');
      return false;
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
  });

  it('fails closed before inspecting an oversized file dependency pattern', () => {
    const oversizedDependency = `providers/${'a'.repeat(70_000)}*.js`;
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - file://providers/safe.js',
        `  - file://${oversizedDependency}`,
      ].join('\n'),
    });
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) throw new TypeError('pattern is too long');
      return value.includes('*');
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(
      mockGlob.hasMagic.mock.calls.some(
        ([value]: [string]) => value.length > 65_536,
      ),
    ).toBe(false);
  });

  it.each([
    'file://{1..1000000000}',
    'file://{{a,b},{c,d}}',
    `file://${'{a,b}'.repeat(11)}`,
  ])('fails closed before expanding a complex brace dependency %s', (dependency) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': `metadata: ${dependency}\n`,
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('{'),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    'file://{foo),../providers}/*.py',
    'file://{foo),/absolute}/*.py',
    'file://@(foo}|../providers)/*.py',
  ])('fails closed before expanding a mismatched grouped dependency %s', (dependency) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': `metadata: ${dependency}\n`,
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*?{}()[\]]/.test(value),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unsafe grouped config dependency pattern'),
    );
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('preserves a safe grouped glob containing an escaped POSIX literal', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml':
        "providers:\n  - 'file://providers/{literal\\\\*,other}/*.py'\n",
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*?{}()[\]]/.test(value),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/other/safe.py']);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'providers/other/safe.py',
      'providers/',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it.each([
    'file://{foo,bar}/[!)]*.py',
    'file://{foo,bar}/[!}]*.py',
    'file://{foo,bar}/literal).py',
  ])('preserves a valid grouped glob with literal closers %s', (dependency) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': `metadata: ${dependency}\n`,
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*?{}()[\]]/.test(value),
    );
    mockGlob.sync.mockReturnValue(['/test/working/foo/safe.py']);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'foo/safe.py',
      './',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('continues to expand a bounded brace dependency', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': 'metadata: file://{a,b}/*.js\n',
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('{') || value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/a/first.js',
      '/test/working/b/second.js',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(expect.arrayContaining(['a/first.js', 'b/second.js']));
  });

  it.each([
    "$ref: '../outside.yaml'\n",
    "$ref: './computed.ts'\n",
    "$ref: '{{ env.CONFIG }}'\n",
    "$ref: 'https://capture.example/config.yaml'\n",
    "$ref: './safe%2Fopts.yaml'\n",
    "$ref: './safe.yaml#/defs/a\\b'\n",
    '$ref: "./sa\\tfe.yaml"\n',
    '$ref: "./sa\\nfe.yaml"\n',
    '$ref: "./sa\\rfe.yaml"\n',
    "$ref: ' ./safe.yaml'\n",
    "$ref: './safe.yaml '\n",
    "commandLineOptions:\n  envPath: '../../outside.env'\n",
    "commandLineOptions:\n  envPath: '{{ env.PICK }}'\n",
  ])('fails closed for an unsafe or dynamic config dependency: %s', (content) => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': content,
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    [
      "$ref: './base.yaml'\ncommandLineOptions:\n  envPath: .env.local\n",
      'commandLineOptions:\n  envPath: .env.base\n',
    ],
    [
      "$ref: './base.yaml'\ncommandLineOptions:\n  $ref: './opts.yaml'\n",
      'commandLineOptions:\n  repeat: 2\n',
    ],
    [
      "commandLineOptions:\n  $ref: './opts.yaml'\n  envPath: .env.local\n",
      'envPath: .env.base\n',
    ],
  ])('fails closed for ambiguous extended envPath refs', (content, referenced) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': content,
      '/test/working/base.yaml': referenced,
      '/test/working/opts.yaml': referenced,
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('rejects non-regular and oversized configs before reading them', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    mockConfigFiles({ [configPath]: 'providers: []\n' });
    mockFs.lstatSync.mockReturnValue({
      isFile: () => false,
      isSymbolicLink: () => false,
      size: 64,
    } as fs.Stats);

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();

    mockFs.lstatSync.mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 2 * 1024 * 1024 + 1,
    } as fs.Stats);
    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-regular referenced config before reading it', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    mockConfigFiles({
      [configPath]: "$ref: './shared.yaml'\n",
      '/test/working/shared.yaml': 'providers: []\n',
    });
    mockFs.lstatSync.mockImplementation((filePath: string) => ({
      isFile: () => filePath === configPath,
      isSymbolicLink: () => false,
      size: 64,
    }));

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/shared.yaml',
      'utf8',
    );
  });

  it('fails closed when the Promptfoo working directory escapes the workspace', () => {
    mockConfigFiles({
      '/test/working/evals/promptfooconfig.yaml': 'providers: []\n',
    });

    expect(
      extractFileDependencies(
        '/test/working/evals/promptfooconfig.yaml',
        '/test/working',
        '/test/outside',
      ),
    ).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('fails closed for an executable config hidden behind a symlink', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    mockConfigFiles({ [configPath]: 'providers: []\n' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.lstatSync.mockReturnValue({
      isFile: () => false,
      isSymbolicLink: () => true,
      size: 12,
    } as fs.Stats);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 12,
    } as fs.Stats);
    mockFs.realpathSync.mockImplementation((filePath: string) =>
      filePath === configPath ? '/test/working/computed.js' : filePath,
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it.each([
    "$ref: '#options'\n",
    "$ref: '#/defs/bad~2key'\ndefs: {}\n",
    "$ref: '#/defs/missing'\n",
    "$ref: '#/defs/wrapper/options'\ndefs:\n  wrapper:\n    $id: './alt/'\n    options: {}\n",
    '$ref: null\n',
    "$id: './alt/'\nproviders: []\n",
    'commandLineOptions:\n  envPath: null\n',
    'commandLineOptions:\n  envPath: [7]\n',
    'commandLineOptions:\n  envPath: "\\0"\n',
  ])('fails closed for malformed refs, ids, or envPath values', (content) => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': content,
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('handles mapped providers and ignores malformed function/tool schema entries', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'providers:',
        '  - empty:',
        '  - mapped:',
        '      config:',
        '        functions:',
        '          - null',
        '          - name: valid',
        '            parameters:',
        "              $ref: '#/$defs/function'",
        '        tools:',
        '          - null',
        '          - function:',
        '          - function:',
        '              name: valid',
        '              parameters:',
        "                $ref: '#/$defs/tool'",
        '  - id: invalid-config',
        '    config:',
        'commandLineOptions:',
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([...implicitConfigDependencies('promptfooconfig.yaml')]);
  });

  it('stops safely on a circular commandLineOptions ref chain', () => {
    mockConfigFiles({
      '/test/working/promptfooconfig.yaml': [
        'commandLineOptions:',
        "  $ref: '#/defs/first'",
        'defs:',
        '  first:',
        "    $ref: '#/defs/second'",
        '  second:',
        "    $ref: '#/defs/first'",
      ].join('\n'),
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([...implicitConfigDependencies('promptfooconfig.yaml')]);
  });

  it('fails closed for excessive config depth or aggregate referenced nodes', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    let deeplyNested = 'true';
    for (let depth = 0; depth < 102; depth++) {
      deeplyNested = `{"value":${deeplyNested}}`;
    }
    mockConfigFiles({ [configPath]: deeplyNested });
    expect(extractFileDependencies(configPath)).toEqual(['./']);

    mockConfigFiles({
      [configPath]: `$ref: './base.yaml'\nitems:\n${'- {}\n'.repeat(5001)}`,
      '/test/working/base.yaml': `items:\n${'- {}\n'.repeat(5001)}`,
    });
    expect(extractFileDependencies(configPath)).toEqual(['./']);
  });

  it('tracks an absolute envPath when only its parent can be resolved', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    mockConfigFiles({
      [configPath]:
        'commandLineOptions:\n  envPath: /test/working/env/.env.absolute\n',
    });
    mockFs.existsSync.mockImplementation(
      (filePath: string) =>
        filePath !== '/test/working' &&
        filePath !== '/test/working/env/.env.absolute',
    );

    expect(extractFileDependencies(configPath)).toEqual([
      'env/.env.absolute',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });

  it('fails closed when config traversal, size, or ref limits are exceeded', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    const refs: Record<string, string> = {
      [configPath]: "$ref: './config-0.yaml'\n",
    };
    for (let index = 0; index <= 100; index++) {
      refs[`/test/working/config-${index}.yaml`] =
        `$ref: './config-${index + 1}.yaml'\n`;
    }

    mockConfigFiles({ [configPath]: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(extractFileDependencies(configPath)).toEqual(['./']);

    mockConfigFiles({ [configPath]: `items:\n${'- {}\n'.repeat(10_001)}` });
    expect(extractFileDependencies(configPath)).toEqual(['./']);

    mockConfigFiles(refs);
    expect(extractFileDependencies(configPath)).toEqual(['./']);
  });

  it('does not expand atomic YAML values while extracting dependencies', () => {
    const configPath = '/test/working/promptfooconfig.yaml';
    mockConfigFiles({
      [configPath]: [
        `payload: !!binary ${Buffer.alloc(128 * 1024).toString('base64')}`,
        'createdAt: 2024-01-01T00:00:00Z',
        'labels: !!set { safe: null }',
        'commandLineOptions:',
        '  envPath: .env.safe',
      ].join('\n'),
    });

    expect(extractFileDependencies(configPath)).toEqual([
      '.env.safe',
      ...implicitConfigDependencies('promptfooconfig.yaml'),
    ]);
  });
});
