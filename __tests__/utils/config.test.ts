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

  it('should ignore expanded glob matches that escape the dependency root', () => {
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

    expect(deps).toEqual(['../config/providers/custom.py']);
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
    expect(deps).toContain('../config/providers');
    expect(deps).toContain('../config/custom');
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

    expect(deps).toEqual(['../config/provider.py']);
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

    expect(deps).toContain('../config/providers/python');
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
    expect(deps).toContain('../config/test-data');
    expect(deps).toContain('../config/validators');
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
