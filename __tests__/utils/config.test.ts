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
    realpathSync: vi.fn(),
    existsSync: vi.fn(),
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
    realpathSync: Mock;
    existsSync: Mock;
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
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath),
    );
  });

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

  it('should extract scalar file-backed tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests: file://tests.yaml
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/tests.yaml']);
  });

  it('should extract bare file-backed tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests: tests.jsonl
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/tests.jsonl']);
  });

  it('should extract array file-backed tests and inline dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://cases/*.yaml
  - vars:
      context: file://data/context.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/cases/safety.yaml',
      '/test/config/cases/quality.yaml',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/cases/safety.yaml');
    expect(deps).toContain('../config/cases/quality.yaml');
    expect(deps).toContain('../config/cases/');
    expect(deps).toContain('../config/data/context.txt');
  });

  it('should extract object-form file-backed tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/tests.js:generate_tests
  config:
    dataset: safety
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/generators/tests.js']);
  });

  it('should extract nested file references from test generator config', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/tests.py:generate_tests
  config:
    dataset: file://data/cases.json
    options:
      enabled: true
      missing: null
      inputs:
        - file://data/context.txt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/generators/tests.py');
    expect(deps).toContain('../config/data/cases.json');
    expect(deps).toContain('../config/data/context.txt');
  });

  it('should preserve the generator-config glob directory when its last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/tests.py:generate_tests
  config:
    dataset: file://data/*.json
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/data/');
  });

  it('should preserve dependencies when generator config uses a cyclic YAML alias', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/tests.py:generate_tests
  config: &config
    dataset: file://data/cases.json
    self: *config
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/generators/tests.py', '../config/data/cases.json']);
  });

  it('should extract dependencies nested in a file-backed YAML test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith('cases.yaml')) {
          return `
- vars:
    context: file://data/context.txt
  assert:
    - type: javascript
      value:
        file: validators/check.js
- vars: ../data/vars.yaml
`;
        }
        return 'tests: file://tests/cases.yaml';
      },
    );
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('cases.yaml'),
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/tests/cases.yaml');
    expect(deps).toContain('../config/data/context.txt');
    expect(deps).toContain('../config/data/vars.yaml');
    expect(deps).toContain('../config/validators/check.js');
  });

  it('should extract dependencies nested in a file-backed JSON test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith('cases.json')) {
          return JSON.stringify([
            {
              vars: { context: { file: 'data/context.json' } },
              assert: [
                { type: 'contains', value: 'file://expected/output.txt' },
              ],
            },
            {
              vars: [
                'file://../data/vars.json',
                'https://example.test/vars.json',
                '../data/extra.json',
              ],
            },
          ]);
        }
        return 'tests: file://tests/cases.json';
      },
    );
    mockFs.existsSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('cases.json'),
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/tests/cases.json');
    expect(deps).toContain('../config/data/context.json');
    expect(deps).toContain('../config/data/vars.json');
    expect(deps).toContain('../config/data/extra.json');
    expect(deps).toContain('../config/expected/output.txt');
  });

  it('should extract arbitrary metadata and options references in a file-backed test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? `
- metadata:
    dataset: file://data/metadata.json
  options:
    rubric:
      - file://data/rubrics/*.txt
`
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/data/metadata.json',
      '../config/data/rubrics/',
    ]);
  });

  it('should extract dependencies nested in a file-backed JSONL test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.jsonl')
          ? [
              JSON.stringify({
                metadata: { source: 'file://data/metadata.json' },
              }),
              '',
              JSON.stringify({
                assert: [
                  { type: 'contains', value: 'file://expected/output.txt' },
                ],
              }),
            ].join('\n')
          : 'tests: file://tests/cases.jsonl',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.jsonl',
      '../config/data/metadata.json',
      '../config/expected/output.txt',
    ]);
  });

  it('should ignore non-object entries in a file-backed test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? '- ignored\n- null'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml']);
  });

  it('should warn and retain a malformed file-backed test dependency', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? '[SYMLINK_SECRET_CANARY_019F62C3'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect test file dependency'),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SYMLINK_SECRET_CANARY_019F62C3'),
    );
  });

  it('should retain a null file-backed test dependency', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? 'null'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml']);
  });

  it('should inspect a single-object file-backed test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? 'vars:\n  context: file://data/context.txt'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml', '../config/data/context.txt']);
  });

  it('should warn when reading a file-backed test throws a non-Error', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith('cases.yaml')) {
          throw 'disk unavailable';
        }
        return 'tests: file://tests/cases.yaml';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect test file dependency'),
    );
  });

  it('should not inspect a file-backed test symlink outside the repository', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://tests/external.yaml');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('external.yaml')
        ? '/private/tmp/outside-secret.yaml'
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/external.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test file dependency must stay within'),
    );
  });

  it('should preserve the test glob directory when its last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://cases/*.yaml');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/cases/');
  });

  it('should preserve the nested vars glob directory when its last match is deleted', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? '- vars: ../data/*.yaml'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/data/');
  });

  it('should preserve the config directory for an empty root test glob', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://*.yaml');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/');
  });

  it('should preserve an absolute test glob directory when its last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file:///test/config/cases/*.yaml',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/cases/');
  });

  it('should extract sheet-qualified file-backed tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests: file://cases.xlsx#Safety
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/cases.xlsx']);
  });

  it('should preserve a hash in an Excel test parent directory', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file://tests#prod/cases.xlsx#Safety',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests#prod/cases.xlsx']);
  });

  it('should preserve a hash in a non-Excel test filename', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://tests/cases#prod.yaml');

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases#prod.yaml']);
  });

  it('should preserve a colon in a non-generator test filename', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://tests/cases:prod.yaml');

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases:prod.yaml']);
  });

  it('should extract an absolute file-backed test path inside the repository', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file:///test/config/tests/cases.yaml',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml']);
  });

  it('should ignore remote file-backed tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests: https://docs.google.com/spreadsheets/d/example
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should reject file-backed tests outside the repository', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - ../secrets/tests.yaml
  - file://../../outside/tests.json
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledTimes(2);
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

    expect(deps).toEqual(['providers/inherited.py', 'prompts/inherited.txt']);
  });

  it('should handle empty config', () => {
    mockFs.readFileSync.mockReturnValue('');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(0);
    expect(core.debug).toHaveBeenCalledWith('Config file is empty or invalid');
    expect(core.warning).not.toHaveBeenCalled();
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

    expect(deps).toHaveLength(0);
  });

  it('should handle file read errors gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(0);
  });

  it('should handle non-Error file read failures gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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

    expect(deps).toEqual([]);
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

    expect(deps).toEqual(['providers/custom.py', 'prompts/prompt.txt']);
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

    expect(deps).toEqual(['evals/..fixtures/custom.py']);
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

    expect(deps).toEqual(['evals/ prompts/custom.py ']);
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
});
