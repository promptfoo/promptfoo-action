import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractFileDependencies,
  normalizeConfigFilePath,
} from '../../src/utils/config';

vi.mock('fs', async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...realFs,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
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
    mockFs.realpathSync.mockImplementation((filePath: unknown) => filePath);
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
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

  it('should normalize canonical Windows file URL paths without changing POSIX paths', () => {
    expect(normalizeConfigFilePath('/C:/repo/prompts/build.py', 'win32')).toBe(
      'C:/repo/prompts/build.py',
    );
    expect(normalizeConfigFilePath('/C:/repo/prompts/*.txt', 'win32')).toBe(
      'C:/repo/prompts/*.txt',
    );
    expect(normalizeConfigFilePath('prompts\\*.txt', 'win32')).toBe(
      'prompts/*.txt',
    );
    expect(
      normalizeConfigFilePath('/test/working/prompts/build.py', 'linux'),
    ).toBe('/test/working/prompts/build.py');
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

  it('should preserve dependencies when prompts use the supported map form', () => {
    const configContent = `
providers:
  - file://providers/provider.py
prompts:
  mapped-prompt: mapping input
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.py']);
  });

  it('should extract file prompt keys from the supported map form', () => {
    const configContent = `
prompts:
  file://prompts/mapped.txt: mapped prompt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/mapped.txt']);
  });

  it('should extract function-backed prompt keys from the supported map form', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/build.py:create_prompt: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.py']);
  });

  it('should extract Ruby prompt-map keys with namespaced selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/build.rb:MyModule::Nested.method: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.rb']);
  });

  it('should extract bare file and function prompt-map keys', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  prompts/main.txt: main prompt
  prompts/build.py:create_prompt: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/main.txt',
      '../config/prompts/build.py',
    ]);
  });

  it('should ignore multiline inline prompt-map keys containing glob syntax', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ? |-
    What does [a-z] match?
    Explain with an example.
  : inline prompt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('[a-z]'),
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should ignore long inline prompt-map keys without passing them to glob', () => {
    const longPrompt = `Explain this passage: ${'a'.repeat(70_000)}`;
    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  "${longPrompt}": inline\n`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw new Error('pattern is too long');
      }
      return false;
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it.each([
    'Explain *carefully* how this works',
    'Summarize https://example.com/docs for the user',
    'Compare this / that for clarity',
  ])('should ignore single-line inline prompt-map keys containing path markers: %s', (prompt) => {
    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  "${prompt}": inline prompt\n`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should extract bare executable prompt paths and globs containing spaces', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ./tools/my generator: generated prompt
  tools/my other generator: another generated prompt
  prompts with spaces/*.tmpl: globbed prompt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts with spaces/generate.tmpl',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'tools/my generator',
      'tools/my other generator',
      'prompts with spaces/generate.tmpl',
      'prompts with spaces',
    ]);
  });

  it('should extract nested file references from mapped YAML and JSON prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://prompts/chat.yaml: yaml prompt
  file://prompts/chat.json: json prompt
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return 'system: file://partials/system.txt\n';
      }
      if (candidate.endsWith('/prompts/chat.json')) {
        return '{"messages":[{"content":"file://partials/user.txt"}]}';
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/prompts/chat.yaml',
      '../config/partials/system.txt',
      '../config/prompts/chat.json',
      '../config/partials/user.txt',
    ]);
  });

  it('should support Promptfoo legacy YAML tags in mapped configs and prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
metadata:
  binary: !!binary SGVsbG8=
  timestamp: 2024-01-02
  ordered: !!omap [{a: 1}, {b: 2}]
  pairs: !!pairs [{a: 1}, {b: 2}]
  set: !!set {a: null, b: null}
prompts:
  file://prompts/chat.yaml: yaml prompt
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `
metadata:
  binary: !!binary SGVsbG8=
  set: !!set {a: null}
system: file://partials/system.txt
`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
  });

  it('should tolerate self-referential arrays in mapped structured prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `prompts:\n  file://prompts/chat.yaml: yaml prompt\n`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `items: &items [*items, file://partials/system.txt]\n`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
  });

  it('should reject invalid Promptfoo legacy YAML sets', () => {
    mockFs.readFileSync.mockReturnValue(`
metadata: !!set {a: not-null}
prompts:
  file://prompts/main.txt: prompt
`);

    expect(() =>
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toThrow(/cannot resolve a set item/);
  });

  it('should extract safe globbed YAML prompts while tolerating cycles and unsafe matches', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://prompts/*.yaml: mapped prompts
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `
node: &node
  system: file://partials/system.txt
  self: *node
  optional: null
  count: 2
`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts/chat.yaml',
      '/outside/prompts/unsafe.yaml',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'prompts', 'partials/system.txt']);
  });

  it.each([
    'prompts/*.{yaml,json}',
    'prompts/*',
  ])('should extract nested references from mapped structured prompt glob %s', (promptGlob) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `prompts:\n  file://${promptGlob}: mapped prompts\n`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return 'system: file://partials/system.txt\n';
      }
      if (candidate.endsWith('/prompts/chat.json')) {
        return '{"user":"file://partials/user.txt"}';
      }
      throw new Error(`unexpected read: ${candidate}`);
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts/chat.yaml',
      '/test/working/prompts/chat.json',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/chat.yaml',
      'prompts/chat.json',
      'prompts',
      'partials/system.txt',
      'partials/user.txt',
    ]);
  });

  it('should ignore unsafe and malformed mapped structured prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://../outside.yaml: unsafe prompt
  file://prompts/broken.json: malformed prompt
`;
      }
      if (candidate.endsWith('/prompts/broken.json')) return '{not json';
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/broken.json']);
  });

  it('should not read mapped structured prompts that resolve outside the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/linked.yaml: linked prompt\n';
      }
      return 'secret: SENSITIVE-REVIEW-TOKEN\n';
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockReturnValue('/tmp/outside/secret.yaml');

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/linked.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe prompt file dependency "prompts/linked.yaml": resolved path must stay within the repository workspace',
    );
  });

  it('should extract executable prompt-map keys without command arguments', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:./prompts/generate.sh --tone formal: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/generate.sh']);
  });

  it('should retain a deleted file argument for mapped executable prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:node templates/generate.js --tone formal: generated prompt
`);
    mockFs.existsSync.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['node', 'templates/generate.js']);
  });

  it('should track existing file arguments for mapped executable prompts from the action working directory', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:../bin/python ../prompts/generate.py: generated prompt
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/prompts/generate.py'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working/custom',
    );

    expect(deps).toEqual(['bin/python', 'prompts/generate.py']);
  });

  it('should track contained absolute executable arguments and ignore directory arguments', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:../bin/python /test/working/prompts/generate.py ./templates: generated prompt
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      return (
        candidate.endsWith('/prompts/generate.py') ||
        candidate.endsWith('/templates')
      );
    });
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => String(filePath).endsWith('/templates'),
          isFile: () => String(filePath).endsWith('/prompts/generate.py'),
          mode: 0o644,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working/custom',
    );

    expect(deps).toEqual(['bin/python', 'prompts/generate.py']);
  });

  it('should resolve mapped executable prompt arguments from prompt config basePath', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: exec:../bin/python templates/generate.py
    config:
      basePath: custom
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/custom/templates/generate.py'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['bin/python', 'custom/templates/generate.py']);
  });

  it('should extract uncommon root-level executable prompt-map keys', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  generate.zsh: generated prompt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['generate.zsh']);
  });

  it.each([
    'generate.run',
    'generate.xy',
  ])('should extract root-level prompt-map executables with a short suffix: %s', (promptPath) => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ${promptPath}: generated prompt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([promptPath]);
  });

  it('should extract file-backed prompt ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: file://prompts/main.txt
    label: main prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/main.txt']);
  });

  it('should extract bare file and function prompt ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: prompts/main.txt
    label: main prompt
  - id: prompts/build.py:create_prompt
    label: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/main.txt',
      '../config/prompts/build.py',
    ]);
  });

  it('should prefer file-backed and executable prompt raw values over ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: file://prompts/from-raw.txt
    id: prompts/ignored.txt
    label: raw prompt
  - raw: exec:./prompts/generate.sh --tone formal
    label: generated prompt
  - raw: inline prompt
    label: inline
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/from-raw.txt',
      '../config/prompts/generate.sh',
    ]);
  });

  it('should ignore empty executable prompts and unsupported prompt objects', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - "exec:"
  - label: unsupported prompt object
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore null prompt and test entries from YAML', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - null
  - inline prompt
tests:
  - null
  - vars:
      context: file://data/context.txt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['data/context.txt']);
  });

  it('should extract dependencies from a singleton test generator', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/generate.py:create_tests
  config:
    dataset: file://data/cases.json
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/generate.py',
      '../config/data/cases.json',
    ]);
  });

  it('should extract nested config files from a bare-path test generator', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: tests/generate.py:create_tests
  config:
    dataset: file://data/cases.json
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/generate.py',
      '../config/data/cases.json',
    ]);
  });

  it('should extract nested generator config files and string test references', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/cases.yaml
  - inline test reference
  - path: file://tests/build.ts:create_tests
    config:
      datasets:
        - file://data/first.json
        - nested:
            source: file://data/second.json
            enabled: true
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/cases.yaml',
      '../config/tests/build.ts',
      '../config/data/first.json',
      '../config/data/second.json',
    ]);
  });

  it('should tolerate self-referential generator config objects and arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/generate.py:create_tests
  config:
    object: &object
      self: *object
      source: file://data/object.json
    array: &array [*array, file://data/array.json]
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tests/generate.py', 'data/object.json', 'data/array.json']);
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

  it('should preserve literal function-like suffixes in variable and assertion filenames', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      context: file://data/context.rb:v2
    assert:
      - type: contains
        value: file://expected/output.py:v3
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/data/context.rb:v2',
      '../config/expected/output.py:v3',
      '../config/expected/output.py',
    ]);
  });

  it('should track executable variable and assertion files with function selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      javascript: file://vars/build.cjs:generateValue
      python: file://vars/build.py:generate_value
    assert:
      - type: contains
        value: file://validators/check.cjs:knownValue
      - type: contains
        value: file://validators/check.py:known_value
      - type: contains
        value: file://validators/check.rb:MyModule::Nested.method
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(
      expect.arrayContaining([
        '../config/vars/build.cjs',
        '../config/vars/build.py',
        '../config/validators/check.cjs',
        '../config/validators/check.py',
        '../config/validators/check.rb',
      ]),
    );
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

  it('should fail closed for invalid YAML', () => {
    mockFs.readFileSync.mockReturnValue('invalid: yaml: content:');

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config');
  });

  it.each([
    ['providers', 'providers:\n  $ref: providers.yaml#/providers'],
    ['inline providers', 'providers: { $ref: providers.yaml#/providers }'],
    [
      'explicit-key providers',
      'providers:\n  ? $ref\n  : providers.yaml#/providers',
    ],
    [
      'assertions',
      'tests:\n  - assert:\n      $ref: assertions.yaml#/assertions',
    ],
  ])('should conservatively watch the repository for valid YAML $ref %s', (_name, section) => {
    mockFs.readFileSync.mockReturnValue(`prompts: []\n${section}\n`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('YAML $ref dependencies'),
    );
  });

  it('should match Promptfoo backslash-separated prompt globs on POSIX', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts\\*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompts/example.txt']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/example.txt', 'prompts']);
    expect(mockGlob.hasMagic).toHaveBeenCalledWith('prompts/*.txt', {
      windowsPathsNoEscape: true,
    });
  });

  it('should recognize Windows backslash-separated prompt globs', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts\\*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );

    try {
      const deps = extractFileDependencies(
        '/test/working/promptfooconfig.yaml',
      );

      expect(deps).toEqual(['prompts/']);
      expect(mockGlob.hasMagic).toHaveBeenCalledWith('prompts/*.txt', {
        windowsPathsNoEscape: true,
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('should conservatively watch all changes for JavaScript and TypeScript configs', () => {
    mockFs.readFileSync.mockReturnValue('export default { prompts: [] };');

    expect(extractFileDependencies('/test/working/promptfooconfig.ts')).toEqual(
      ['.'],
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('JavaScript/TypeScript config dependencies'),
    );
  });

  it('should fail closed for file read errors', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config: File not found');
  });

  it('should fail closed for non-Error file read failures', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config: permission denied');
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

  it('should preserve absolute file URLs that stay inside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/prompts/absolute.txt: absolute prompt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/absolute.txt']);
  });

  it('should preserve the watch root for an unmatched absolute prompt glob', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/prompts/*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/']);
  });

  it('should preserve the config directory for an unmatched root-level prompt glob', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/']);
  });

  it('should preserve an explicitly mapped prompt directory after its last file is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/: mapped prompts
`);
    mockFs.existsSync.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/']);
  });

  it('should preserve a repository-root directory sentinel', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/: repository prompts
`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['/']);
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

    expect(deps).toEqual(['../config/providers/custom.py', '../config']);
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

    expect(deps).toEqual(['../config/provider.py', '../config']);
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
