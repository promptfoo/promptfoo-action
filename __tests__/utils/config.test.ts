import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { binaryTag, CORE_SCHEMA, mergeTag } from 'js-yaml';
import { Minimatch } from 'minimatch';
import * as path from 'path';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFileDependencies } from '../../src/utils/config';

const pathState = vi.hoisted(() => ({ sep: '/' }));
const nonblockingReadFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

vi.mock('fs', async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...realFs,
    readFileSync: vi.fn(),
    openSync: vi.fn(),
    fstatSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn(),
    realpathSync: vi.fn((filePath: fs.PathLike) => filePath.toString()),
    statSync: vi.fn(),
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
    promises: {
      access: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});
vi.mock('glob');
vi.mock('path', async () => {
  const realPath = await vi.importActual<typeof import('path')>('path');
  const activePath = () =>
    pathState.sep === '\\' ? realPath.win32 : realPath.posix;
  return {
    ...realPath,
    get sep() {
      return pathState.sep;
    },
    dirname: (value: string) => activePath().dirname(value),
    isAbsolute: (value: string) => activePath().isAbsolute(value),
    join: (...values: string[]) => activePath().join(...values),
    relative: (from: string, to: string) => activePath().relative(from, to),
    resolve: (...values: string[]) => activePath().resolve(...values),
  };
});

describe('extractFileDependencies', () => {
  const mockFs = fs as unknown as {
    readFileSync: Mock;
    openSync: Mock;
    fstatSync: Mock;
    closeSync: Mock;
    existsSync: Mock;
    statSync: Mock;
    lstatSync: Mock;
    realpathSync: Mock;
  };
  const mockGlob = glob as unknown as {
    hasMagic: Mock;
    sync: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pathState.sep = '/';
    vi.spyOn(process, 'cwd').mockReturnValue('/test/working');
    // Default mock implementations
    mockGlob.hasMagic.mockReturnValue(false);
    mockGlob.sync.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString(),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
    } as fs.Stats);
    mockFs.openSync.mockImplementation(
      (filePath: fs.PathLike) => filePath as unknown as number,
    );
    mockFs.fstatSync.mockImplementation((fileDescriptor: number) =>
      mockFs.statSync(fileDescriptor as unknown as fs.PathLike),
    );
    mockFs.closeSync.mockImplementation(() => undefined);
    mockFs.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);
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

    expect(deps).toEqual(['./']);
  });

  it.each([
    '/test/working/evals/promptfooconfig.js',
    '/test/working/evals/promptfooconfig.ts',
  ])('should conservatively workspace-watch an executable primary config %s', (configPath) => {
    mockFs.readFileSync.mockReturnValue('module.exports = { providers: [] };');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
  });

  it.each([
    "$ref: './fragments/root.yaml#/config'",
    "prompts:\n  $ref: './fragments/prompts.yaml#/prompts'",
  ])('should conservatively workspace-watch an external config $ref', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'file://providers/custom.py',
    'python:providers/custom.py:run',
    'golang:providers/custom.go:Run',
    'ruby:providers/custom.rb:Run',
    'providers/custom.js',
    'exec:file://providers/custom.py:run',
    'exec:providers/custom.sh',
  ])('should conservatively workspace-watch side inputs of a file-backed provider %s', (provider) => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - '${provider}'`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    `extensions:\n  - file://hooks/extension.py:onEvent`,
    `tests:\n  - assert:\n      - type: javascript\n        value: file://validators/check.js:run`,
    `tests:\n  - assert:\n      - type: not-ruby\n        value: file://validators/check.rb:validate`,
    `nunjucksFilters:\n  format: filters/format.js`,
    `providers:\n  - id: openai:gpt-4.1\n    transform: file://hooks/provider.py:transform`,
    `tests:\n  - assertScoringFunction: file://hooks/score.py:score`,
    `tests:\n  - options:\n      postprocess: file://hooks/postprocess.js:run`,
    `tests:\n  - options:\n      transform: file://hooks/transform.py:run`,
    `defaultTest:\n  options:\n    transformVars: file://hooks/vars.js:run`,
    `providers:\n  - id: https\n    config:\n      validateStatus: file://hooks/status.js:validate`,
    `providers:\n  - id: https\n    config:\n      transformResponse: file://hooks/response.js:transform`,
    `providers:\n  - id: https\n    config:\n      auth:\n        type: file\n        path: file://hooks/auth.py:getToken`,
    `providers:\n  - id: https\n    config:\n      auth:\n        type: file\n        path: file://hooks/auth.py`,
  ])('should conservatively workspace-watch side inputs of an executed hook', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    `providers:\n  - "{{ 'python:providers/' + env.PROVIDER_FILE }}"`,
    `providers:\n  - id: openai:gpt-4.1\n    transform: "{{ 'file://hooks/' + env.HOOK_FILE }}"`,
    `providers:\n  - id: openai:gpt-4.1\n    transform: "{{ 'file:' + '//' + env.HOOK_FILE }}"`,
    `providers:\n  - id: https\n    config:\n      transformResponse: "{{ env.RESPONSE_HOOK }}"`,
    `providers:\n  - id: https\n    config:\n      validateStatus: "{{ env.STATUS_HOOK }}"`,
    `providers:\n  - id: https\n    config:\n      session:\n        responseParser: "{{ env.SESSION_HOOK }}"`,
    `tests:\n  - assertScoringFunction: "{{ env.SCORE_HOOK }}"`,
    `tests:\n  - assertScoringFunction: "{% if env.SCORE_HOOK %}hook{% endif %}"`,
    `tests:\n  - assert:\n      - type: contains\n        transform: "{{ env.ASSERT_HOOK }}"`,
    `tests:\n  - assert:\n      - type: contains\n        transform: "{% if env.ASSERT_HOOK %}hook{% endif %}"`,
    `defaultTest:\n  options:\n    transformVars: "{{ env.VARS_HOOK }}"`,
    `defaultTest:\n  options:\n    transformVars: "{% if env.VARS_HOOK %}hook{% endif %}"`,
  ])('should conservatively workspace-watch a templated executable provider or transform', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    `prompts:\n  - file: prompts/base.txt\n    config:\n      formatter: "{{ env.PROMPT_HOOK }}"`,
    `scenarios:\n  - config:\n      - options:\n          response_format: "{{ env.SCENARIO_SCHEMA }}"`,
  ])('should conservatively workspace-watch a structured prompt or scenario containing an unresolved template', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    {
      config: 'tests: test-data/cases.yaml',
      contents: '- provider: "{{ env.PROVIDER_ID }}"',
    },
    {
      config: 'tests: test-data/cases.csv',
      contents: 'prompt,__expected\nhello,"{{ env.EXPECTED }}"',
    },
    {
      config: 'providers:\n  - file://providers/external.yaml',
      contents: '- id: "{{ env.PROVIDER_ID }}"',
    },
  ])('should conservatively workspace-watch an unresolved template in an external config source', ({
    config,
    contents,
  }) => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml') ? config : contents,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively evaluate a remote config reference with sibling local dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
$ref: https://example.test/config.yaml#/config
tests:
  - vars:
      context: file://data/context.json
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
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

  it.each([
    [
      `prompts:\n  "file://prompts/customer.txt": customer`,
      ['evals/prompts/customer.txt'],
    ],
    [`prompts:\n  customer: "file://prompts/customer.txt"`, []],
  ])('should track prompt-map definitions from mapping keys', (config, expected) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(expected);
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

    expect(deps).toEqual(['./']);
  });

  it('should track config-level environment files relative to the config directory', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  envPath:
    - environments/base.env
    - environments/team.env
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/environments/base.env', 'evals/environments/team.env']);
  });

  it('should conservatively handle a malformed config-level environment path', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  envPath: false
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively workspace-watch a comma-separated config-level environment path', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  envPath: environments/base.env,environments/team.env
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively workspace-watch a file-backed command-line grader', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  grader: python:graders/custom.py:grade
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'tests: cases.js:build',
    'tests: file://cases.py:generate',
  ])('should conservatively workspace-watch an executable test module', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract nested default-test and test variable file references', () => {
    const config = `
defaultTest:
  vars:
    context:
      document: file://data/default-context.json
tests:
  - vars:
      payload:
        nested:
          document: file://data/test-context.json
`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml') ? config : '{}',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/data/default-context.json',
      'evals/data/test-context.json',
    ]);
  });

  it('should conservatively track a nested reference inside a vars file', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const varsPath = '/test/working/evals/vars/context.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? 'defaultTest:\n  vars:\n    context: file://vars/context.yaml'
        : 'document: file://data/context.json',
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(varsPath, 'utf8');
  });

  it('should conservatively workspace-watch a provider nested in test variables', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      context:
        provider:
          id: python:providers/nested.py:run
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should handle empty config', () => {
    mockFs.readFileSync.mockReturnValue('');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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

    expect(deps).toEqual(['./']);
  });

  it.each([
    {
      type: 'FIFO',
      stat: { isFile: () => false, isFIFO: () => true, size: 0 },
    },
    {
      type: 'oversized file',
      stat: { isFile: () => true, isFIFO: () => false, size: 1024 * 1024 + 1 },
    },
  ])('should reject a primary config $type before reading it', ({ stat }) => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? ({ ...stat, isDirectory: () => false } as fs.Stats)
        : ({
            isFile: () => true,
            isDirectory: () => false,
            size: 0,
          } as fs.Stats),
    );
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(configPath, 'utf8');
  });

  it('should reject a primary config that grows beyond the byte limit while reading', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.readFileSync.mockReturnValue(' '.repeat(1024 * 1024 + 1));

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(configPath, 'utf8');
    expect(mockFs.openSync).toHaveBeenCalledWith(
      configPath,
      nonblockingReadFlags,
    );
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

    expect(deps).toEqual(['./']);
  });

  it('should ignore empty and null-byte dependencies', () => {
    const configContent = `
providers:
  - file://
  - "file://\\0provider.py"
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
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

    expect(deps).toEqual(['./']);
  });

  it('should keep sibling dependencies inside the workspace', () => {
    const configContent = `
tests:
  - vars:
      input: file://../providers/custom.py
prompts:
  - file: ../prompts/prompt.txt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/prompt.txt', 'providers/custom.py']);
  });

  it('should keep dependencies whose names begin with two dots', () => {
    const configContent = `
tests:
  - vars:
      input: file://..fixtures/custom.py
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/..fixtures/custom.py']);
  });

  it('should preserve whitespace in quoted dependency paths', () => {
    const configContent = `
tests:
  - vars:
      input: "file:// prompts/custom.py "
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

    expect(deps).toEqual(['./']);
  });

  it('should conservatively handle an oversized glob without invoking glob', () => {
    const oversized = `${'a'.repeat(65537)}*`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - "file://${oversized}"`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65536) {
        throw new Error('pattern exceeds maximum length\n::error::forged');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
    expect(warnings).not.toContain(oversized.slice(0, 128));
  });

  it('should avoid an eager glob walk when a base-directory sentinel is sufficient', () => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/*.py`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('EACCES: denied\n::error::forged');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
  });

  it.each([
    'escape',
    'eacces',
  ])('should reject a glob match with an unsafe physical path (%s)', (mode) => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/*.py`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    const match = '/test/working/evals/providers/linked.py';
    mockGlob.sync.mockReturnValue([match]);
    mockFs.existsSync.mockImplementation(
      (filePath: fs.PathLike) => filePath.toString() === match,
    );
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() !== match) {
        return filePath.toString();
      }
      if (mode === 'eacces') {
        throw new Error('EACCES\n::error::forged');
      }
      return '/test/outside/secret.py';
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
    expect(deps).not.toContain('evals/providers/linked.py');
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
  });

  it('should retain a trailing-slash glob sentinel when the last match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/*.py`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
  });

  it('should conservatively root a transitive provider YAML glob without enumerating matches', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/*.yaml`,
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('provider glob must not be enumerated');
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should recognize a brace-only glob and return a durable root sentinel', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - "file://{data/a.json,data/b.json}"`,
    );
    mockGlob.hasMagic.mockReturnValue(false);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    '[{]',
    '[}]',
    '[{}]',
  ])('should conservatively track an optimized brace character class %s as a pattern', (characterClass) => {
    const rawPath = `/test/working/evals/providers/${characterClass}.yaml`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'file://providers/${characterClass}.yaml'`,
    );
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === rawPath) {
        throw new Error('optimized character class must not be realpathed');
      }
      return filePath.toString();
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockFs.realpathSync).not.toHaveBeenCalledWith(rawPath);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should match runtime no-escape semantics for a backslash-prefixed numeric brace range', () => {
    const reference = 'providers/\\{1..16}.py';
    expect(
      new Minimatch(reference, { windowsPathsNoEscape: true }).globSet,
    ).toEqual(
      Array.from({ length: 16 }, (_, index) => `providers//${index + 1}.py`),
    );
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: 'file://${reference}'`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/providers/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively root a no-escape brace glob with a traversing branch', () => {
    const reference = 'providers/\\{safe,../../outside}/*.yaml';
    expect(
      new Minimatch(reference, { windowsPathsNoEscape: true }).globSet,
    ).toEqual(['providers//safe/*.yaml', 'providers//../../outside/*.yaml']);
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      documents: 'file://${reference}'`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    '{../providers,providers}',
    '{../../outside,providers}',
    '{..,providers}',
    '@(../providers|providers)',
    '?(../providers|providers)',
    '*(../providers|providers)',
    '?(/absolute|providers)',
    '*(/absolute|providers)',
    '{foo),../providers}',
    '{foo),/absolute}',
    '{providers,other}/../../shared',
    'providers/*/../../shared',
  ])('should conservatively watch the workspace for a cross-directory brace glob %s', (branches) => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - "file://${branches}/*.py"`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should process a long malformed grouped glob conservatively in linear time', () => {
    const malformedGroup = '{'.repeat(64000);
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - "file://providers/${malformedGroup}"`,
    );
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively root magic separated by a POSIX backslash inside a grouped glob', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'file://providers/{literal\\*,other}/*.py'`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should match standard file-loader no-escape semantics for backslash globs', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      first: 'file://providers\\nested\\*.py'
      second: 'file://providers/\\{1..16}.py'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/providers/nested/', 'evals/providers/']);
  });

  it('should handle Windows separators for grouped and ordinary globs', () => {
    pathState.sep = '\\';
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\repo');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      first: 'file://providers\\{nested\\branch,other}\\*.py'
      second: 'file://providers\\nested\\*.py'
      third: 'file://providers/literal\\name.js'
`);

    expect(
      extractFileDependencies('C:\\repo\\evals\\promptfooconfig.yaml'),
    ).toEqual([
      './',
      'evals/providers/nested/',
      'evals/providers/literal/name.js',
    ]);
    expect(mockFs.lstatSync).toHaveBeenCalledWith(
      'C:\\repo\\evals\\providers\\nested',
    );
    expect(path.resolve('C:\\repo\\evals', '..', 'prompts\\one.txt')).toBe(
      'C:\\repo\\prompts\\one.txt',
    );
    expect(
      path.relative('C:\\repo', 'C:\\repo\\evals\\providers\\nested'),
    ).toBe('evals\\providers\\nested');
  });

  it.each([
    ['literal\\*.js', 'evals/providers/literal/'],
    ['literal\\[id\\].js', 'evals/providers/literal/'],
    ['literal\\\\name.js', 'evals/providers/literal/name.js'],
  ])('should match no-escape POSIX path semantics for %s', (escapedName, dependency) => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: 'file://providers/${escapedName}'`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([dependency]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    '@',
    '+',
    '!',
  ])('should recognize a bounded extglob (%s) without an eager walk', (operator) => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: "file://providers/${operator}(a|b).js"`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively handle stat permission errors for direct dependencies', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/custom.py`,
    );
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === configPath) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 0,
        } as fs.Stats;
      }
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
  });

  it('should represent a root file://. dependency as a durable root sentinel', () => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://.`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should retain a root sentinel for a zero-match no-base glob', () => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://*.py`);
    mockGlob.hasMagic.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    'escape',
    'eacces',
  ])('should conservatively reject an unsafe direct dependency (%s)', (mode) => {
    const linked = '/test/working/evals/providers/linked.py';
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/linked.py`,
    );
    mockFs.existsSync.mockImplementation(
      (filePath: fs.PathLike) => filePath.toString() === linked,
    );
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() !== linked) {
        return filePath.toString();
      }
      if (mode === 'eacces') {
        throw new Error('EACCES\n::error::forged');
      }
      return '/test/outside/secret.py';
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
  });

  it('should reject an escaping symlink ancestor even when the leaf is missing', () => {
    const linkedDirectory = '/test/working/evals/providers';
    const missingLeaf = `${linkedDirectory}/missing.py`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/missing.py`,
    );
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === missingLeaf) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => false } as fs.Stats;
    });
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === linkedDirectory
        ? '/test/outside/providers'
        : filePath.toString(),
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should reject an escaping glob-base symlink ancestor when nested paths are missing', () => {
    const linkedDirectory = '/test/working/evals/providers';
    const missingBase = `${linkedDirectory}/nested`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/nested/*.py`,
    );
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === missingBase) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => false } as fs.Stats;
    });
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === linkedDirectory
        ? '/test/outside/providers'
        : filePath.toString(),
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should reject an in-workspace config directory symlink that escapes the workspace', () => {
    const logicalConfigDir = '/test/working/linked-evals';
    const physicalConfigDir = '/test/shared/evals';
    const logicalDependency = `${logicalConfigDir}/providers/custom.py`;
    const physicalDependency = `${physicalConfigDir}/providers/custom.py`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/custom.py`,
    );
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = filePath.toString();
      if (value === logicalConfigDir) return physicalConfigDir;
      if (value === logicalDependency) return physicalDependency;
      return value;
    });

    expect(() =>
      extractFileDependencies(`${logicalConfigDir}/promptfooconfig.yaml`),
    ).toThrow(
      'Invalid config directory: the config must stay within the working directory.',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject an in-workspace config-file symlink that escapes before reading it', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? '/test/outside/promptfooconfig.yaml'
        : filePath.toString(),
    );

    expect(() => extractFileDependencies(configPath)).toThrow(
      'Invalid config directory: the config must stay within the working directory.',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should accept an in-workspace primary-config symlink and open its contained target', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const physicalConfigPath = '/test/working/shared/promptfooconfig.yaml';
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? physicalConfigPath
        : filePath.toString(),
    );
    mockFs.readFileSync.mockReturnValue('providers: []');
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      dev: 1,
      ino: 2,
    } as fs.Stats);

    expect(extractFileDependencies(configPath)).toEqual([]);
    expect(mockFs.openSync).toHaveBeenCalledWith(
      physicalConfigPath,
      nonblockingReadFlags,
    );
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      physicalConfigPath,
      'utf8',
    );
  });

  it('should reject a primary-config parent symlink swapped outside after opening', () => {
    const configPath = '/test/working/linked/promptfooconfig.yaml';
    const containedPath = '/test/working/evals/promptfooconfig.yaml';
    const escapedPath = '/test/outside/promptfooconfig.yaml';
    let configResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() !== configPath) return filePath.toString();
      configResolutions++;
      return configResolutions < 3 ? containedPath : escapedPath;
    });
    mockFs.readFileSync.mockReturnValue('providers: []');
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      dev: 1,
      ino: 2,
    } as fs.Stats);

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.openSync).toHaveBeenCalledWith(
      containedPath,
      nonblockingReadFlags,
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(containedPath, 'utf8');
    expect(mockFs.closeSync).toHaveBeenCalledWith(containedPath);
  });

  it('should reject a primary-config symlink swapped outside before opening', () => {
    const configPath = '/test/working/linked/promptfooconfig.yaml';
    const containedPath = '/test/working/evals/promptfooconfig.yaml';
    const escapedPath = '/test/outside/promptfooconfig.yaml';
    let configResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() !== configPath) return filePath.toString();
      configResolutions++;
      return configResolutions === 1 ? containedPath : escapedPath;
    });
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.openSync).not.toHaveBeenCalled();
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject a primary config replaced with a different inode after opening', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.fstatSync.mockReturnValue({
      isFile: () => true,
      size: 0,
      dev: 1,
      ino: 2,
    } as fs.Stats);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      dev: 1,
      ino: 3,
    } as fs.Stats);
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.openSync).toHaveBeenCalledWith(
      configPath,
      nonblockingReadFlags,
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockFs.closeSync).toHaveBeenCalledWith(configPath);
  });

  it('should reject a primary config whose metadata changes before reading', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.fstatSync.mockReturnValue({
      isFile: () => true,
      size: 8,
      dev: 1,
      ino: 2,
      mtimeMs: 10,
      ctimeMs: 10,
    } as fs.Stats);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 9,
      dev: 1,
      ino: 2,
      mtimeMs: 11,
      ctimeMs: 11,
    } as fs.Stats);
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject a primary config mutated while its descriptor is being read', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const stable = {
      isDirectory: () => false,
      isFile: () => true,
      size: 13,
      dev: 1,
      ino: 2,
      mtimeMs: 10,
      ctimeMs: 10,
    } as fs.Stats;
    const mutated = {
      ...stable,
      mtimeMs: 11,
      ctimeMs: 11,
    } as fs.Stats;
    mockFs.fstatSync.mockReturnValueOnce(stable).mockReturnValueOnce(mutated);
    mockFs.statSync.mockReturnValue(stable);
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.closeSync).toHaveBeenCalledWith(configPath);
  });

  it('should reject a primary-config parent symlink swapped outside during reading', () => {
    const configPath = '/test/working/linked/promptfooconfig.yaml';
    const containedPath = '/test/working/evals/promptfooconfig.yaml';
    const escapedPath = '/test/outside/promptfooconfig.yaml';
    let configResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() !== configPath) return filePath.toString();
      configResolutions++;
      return configResolutions < 4 ? containedPath : escapedPath;
    });
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 13,
      dev: 1,
      ino: 2,
      mtimeMs: 10,
      ctimeMs: 10,
    } as fs.Stats);
    mockFs.readFileSync.mockReturnValue('providers: []');

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.closeSync).toHaveBeenCalledWith(containedPath);
  });

  it('should reject an unreadable config ancestor before reading the config', () => {
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    expect(() =>
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toThrow(
      'Invalid config directory: the config must stay within the working directory.',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should walk an ENOTDIR config ancestor and reject root exhaustion safely', () => {
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      throw Object.assign(new Error('missing'), {
        code:
          filePath.toString() === '/test/working/evals' ? 'ENOTDIR' : 'ENOENT',
      });
    });

    expect(() =>
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toThrow(
      'Invalid config directory: the config must stay within the working directory.',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should allow an explicitly external config directory as its own dependency root', () => {
    const externalConfigDir = '/test/external/evals';
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/custom.py`,
    );

    expect(
      extractFileDependencies(`${externalConfigDir}/promptfooconfig.yaml`),
    ).toEqual(['../external/evals/providers/custom.py']);
  });

  it('should reject a config dependency containing line breaks without log injection', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - "file://providers/bad\\n::error::forged.py"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
  });

  it.each([
    '',
    'bad\\n::error::forged.txt',
    `too-long-${'a'.repeat(65536)}`,
  ])('should conservatively reject an invalid object-form dependency', (file) => {
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input:\n        file: "${file}"`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'file:///etc/provider.py',
    'file://C:\\\\private\\\\provider.py',
    'file://\\\\\\\\server\\\\share\\\\provider.py',
  ])('should conservatively reject an absolute file dependency %s', (provider) => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - '${provider}'`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should emit at most one sanitized warning for repeated unsafe dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///etc/first.py
  - file:///etc/second.py
  - file:///etc/third.py
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring an unsafe config dependency; running a full evaluation.',
    );
  });

  it('should keep an ENOTDIR direct dependency as a deletion sentinel', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars:\n      input: file://providers/deleted.py`,
    );
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === configPath) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 0,
        } as fs.Stats;
      }
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    });

    expect(extractFileDependencies(configPath)).toEqual([
      'evals/providers/deleted.py',
    ]);
  });

  it('should extract an HTTP validateStatus file dependency and strip its export suffix', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/status.js:validateStatus
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'js',
    'cjs',
    'mjs',
    'ts',
    'cts',
    'mts',
  ])('should strip an HTTP validateStatus export suffix for .%s', (extension) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/status.${extension}:validateStatus
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['build.rb:MyModule::Nested.method', 'build.rb'],
    ['build.go:Func', 'build.go:Func'],
    ['check.py:check', 'check.py'],
  ])('should preserve literal vars and strip only assertion-supported selectors for %s', (reference, expectedAssertion) => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      input: file://scripts/${reference}
    assert:
      - type: javascript
        value: file://validators/${reference}
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(
      reference === 'build.go:Func'
        ? [`scripts/${reference}`, `validators/${expectedAssertion}`]
        : ['./'],
    );
  });

  it.each([
    ['file://providers/Foo.JS:run', 'providers/Foo.JS:run', 'providers/Foo.JS'],
    ['file://providers/Foo.TS:run', 'providers/Foo.TS:run', 'providers/Foo.TS'],
  ])('should conservatively track both uppercase provider selector interpretations for %s', (provider) => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - '${provider}'`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively track both uppercase assertion selector interpretations', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: javascript
        value: file://validators/Foo.JS:run
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['validators/Foo.JS:run', 'validators/Foo.JS']);
  });

  it('should recursively extract nested assert-set validators and their runtime selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: assert-set
        assert:
          - type: javascript
            value: file://validators/check.js:run
          - type: python
            value: file://validators/check.py:check
          - type: assert-set
            assert:
              - type: ruby
                value: file://validators/check.rb:MyModule::Nested.method
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'invalid',
    '[invalid]',
  ])('should conservatively handle malformed nested assertion arrays %s', (nested) => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: assert-set
        assert: ${nested}
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively stop cyclic nested assertion arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert: &cycle
      - type: assert-set
        assert: *cycle
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively stop excessively deep nested assertion arrays', () => {
    let nested = '[]';
    for (let depth = 0; depth < 130; depth++) {
      nested = `[{type: assert-set, assert: ${nested}}]`;
    }
    mockFs.readFileSync.mockReturnValue(`tests:\n  - assert: ${nested}`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should precisely track plain scalar tests and defaultTest references', () => {
    const config = `
prompts: file://prompts/main.txt
tests: test-data/cases.yaml
defaultTest: file://defaults/base.yaml
`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml') ? config : '[]',
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/main.txt',
      'defaults/base.yaml',
      'test-data/cases.yaml',
    ]);
  });

  it('should conservatively track transitive scalar tests globs', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts: prompts/**/*.txt
tests: test-data/**/*.yaml
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should extract plain prompt paths and globs from a prompt array', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/a.txt
  - prompts/**/*.txt
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/a.txt', 'evals/prompts/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should not treat wildcard prose in an inline prompt as a dependency', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - Return * when unknown
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should retain path-shaped prompt globs that contain spaces', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/team prompt*.txt
  - team prompt*.txt
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/', 'evals/']);
  });

  it('should conservatively workspace-watch mixed dynamic prompt references', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://prompts/build.py:generate
  - build.py:generate
  - exec:file://prompts/exec-build.py:generate
  - prompts/build.go:Generate
  - exec:prompts/build.sh
  - raw: file://prompts/object.rb:render
    id: prompts/object.js:render
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively evaluate command-style prompt exec references', () => {
    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  - 'exec:node scripts/prompt.js'`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'exec:prompts/build.sh',
    'exec:file://prompts/build.py:generate',
    'file://prompts/build.py:generate',
    'prompts/build.py',
    'file://prompts/build.js:generate',
    'prompts/build.ts',
    'prompts/build:literal.py',
    'file://prompts/build:literal.js',
    'prompts/generate.bash',
    'file://prompts/build.rb:render',
    'prompts/generator',
  ])('should conservatively workspace-watch a dynamic prompt %s', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts:\n  - '${prompt}'`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should retain bare-root inline prompt text without treating it as an executable', () => {
    mockFs.readFileSync.mockReturnValue(`prompts:\n  - generator`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should conservatively workspace-watch inline exec providers with arguments in tests and scenarios', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider: 'exec:python3 providers/custom.py'
scenarios:
  - config:
      - provider: 'exec:python3 providers/scenario.py'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively workspace-watch a zero-match YAML provider glob in a config subdirectory', () => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://*.yaml`);
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should reject a malformed prompt selector before bounded prompt-path detection', () => {
    const malformed = `${'.x:'.repeat(16000)}\\n::error::forged`;
    mockFs.readFileSync.mockReturnValue(`prompts:\n  - "${malformed}"`);
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect((core.warning as Mock).mock.calls.join('\\n')).not.toContain(
      '::error::forged',
    );
  });

  it('should reject a malformed spreadsheet reference before transitive suffix matching', () => {
    const malformed = `${'.xls#'.repeat(12000)}\\n::error::forged`;
    mockFs.readFileSync.mockReturnValue(`tests: "${malformed}"`);
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect((core.warning as Mock).mock.calls.join('\\n')).not.toContain(
      '::error::forged',
    );
  });

  it('should conservatively handle Nunjucks-generated file paths while ignoring ordinary templated text', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://{{ env.ROOT }}/provider.py'
prompts:
  - '{% if env.USE_FILE %}file://prompts/generated.py{% endif %}'
  - '{{ env.GREETING | lower }} ordinary inline text'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);

    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  - "{{ env.GREETING | replace('a/b', 'x') }} ordinary inline text"`,
    );
    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should fail closed for a templated generic file reference with a static directory prefix', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config:
      response_format: 'file://schemas/{{ env.SCHEMA }}.json'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should fail closed for nested references in an external defaultTest', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const defaultPath = '/test/working/evals/defaults/base.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? 'defaultTest: file://defaults/base.yaml'
        : 'vars:\n  context: file://data/context.json',
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(defaultPath, 'utf8');
  });

  it('should track tests and scenarios directories as durable sentinels', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const directories = new Set([
      '/test/working/evals/tests-dir',
      '/test/working/evals/scenarios-dir',
    ]);
    mockFs.readFileSync.mockReturnValue(`
tests: tests-dir
scenarios: scenarios-dir
`);
    mockFs.statSync.mockImplementation(
      (filePath: fs.PathLike) =>
        ({
          isDirectory: () => directories.has(filePath.toString()),
          isFile: () => !directories.has(filePath.toString()),
          size: 0,
        }) as fs.Stats,
    );

    expect(extractFileDependencies(configPath)).toEqual([
      'evals/tests-dir/',
      'evals/scenarios-dir/',
    ]);
  });

  it.each([
    ['tests: file://cases.py:generate', ['./']],
    ['tests: cases.js:build', ['./']],
    ["tests: 'cases.py:'", ['./']],
    ['tests:\n  - cases.js:literal.py:build', ['./']],
    ['tests:\n  - path: generators/build.py:generate', ['./']],
  ])('should parse runtime test references with JS/Python last-colon semantics', (config, expected) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(expected);
  });

  it('should precisely track plain array and scenario test files', () => {
    const config = `
tests:
  - test-data/cases.yaml
  - path: file://generators/build-tests.yaml
scenarios:
  - scenarios/shared.yaml
  - tests: scenarios/cases.yaml
  - tests:
      - scenarios/extra.yaml
      - path: file://scenarios/generate.yaml
    config:
      - vars:
          input: file://scenarios/context.json
        assert:
          - type: contains
            value: file://scenarios/check.txt
`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml') ? config : '[]',
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'test-data/cases.yaml',
      'generators/build-tests.yaml',
      'scenarios/shared.yaml',
      'scenarios/cases.yaml',
      'scenarios/extra.yaml',
      'scenarios/generate.yaml',
      'scenarios/context.json',
      'scenarios/check.txt',
    ]);
  });

  it('should conservatively handle unsafe scalar and malformed scenario references', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts: "prompts/main\\n::error::forged.txt"
tests: /etc/cases.yaml
defaultTest: file://C:\\\\private\\\\defaults.yaml
scenarios:
  - false
  - tests: 42
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect((core.warning as Mock).mock.calls.join('\\n')).not.toContain(
      '::error::forged',
    );
  });

  it('should conservatively handle malformed test-array entries', () => {
    mockFs.readFileSync.mockReturnValue(`tests:\n  - false`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should safely ignore unsupported primitive providers and fileless prompt objects', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - false
prompts:
  - {}
  - null
scenarios:
  config: []
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should precisely track a plain scalar scenario reference', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? `scenarios: scenarios/shared.yaml`
        : `description: Plain scenario`,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['scenarios/shared.yaml']);
  });

  it.each([
    'tests: https://example.test/cases.yaml',
    'tests:\n  - path: http://example.test/cases.json',
    'scenarios: https://example.test/scenarios.yaml',
    'scenarios:\n  - tests: http://example.test/cases.csv',
  ])('should ignore remote test and scenario references without local filesystem access', (config) => {
    mockFs.readFileSync.mockReturnValue(config);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString().includes('example.test')) {
        throw new Error('remote URL must not be realpathed');
      }
      return filePath.toString();
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(
      mockFs.realpathSync.mock.calls.some(([filePath]) =>
        filePath.toString().includes('example.test'),
      ),
    ).toBe(false);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively evaluate when a test generator contains nested config', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - path: generators/build.py:generate
    config:
      dataset: file://data/cases.json
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract raw scalar and array vars-file references', () => {
    const config = [
      'defaultTest:',
      '  vars: vars/default.yaml',
      'tests:',
      '  - vars: vars/shared.yaml',
      '  - vars:',
      '      - vars/first.yaml',
      '      - vars/second.yml',
    ].join('\n');
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? config
        : `key: value`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/vars/default.yaml',
      'evals/vars/shared.yaml',
      'evals/vars/first.yaml',
      'evals/vars/second.yml',
    ]);
  });

  it('should conservatively handle raw vars globs and malformed vars arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      - vars/**/*.yml
      - false
  - vars: 42
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract raw Nunjucks filter files and durable glob sentinels', () => {
    mockFs.readFileSync.mockReturnValue(`
nunjucksFilters:
  direct: filters/format.js
  globbed: filters/custom/**/*.js
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively handle malformed or absolute Nunjucks filter paths', () => {
    mockFs.readFileSync.mockReturnValue(`
nunjucksFilters:
  invalid: false
  absolute: /etc/filter.js
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should reject a malformed selector with line breaks before bounded selector matching', () => {
    const malformedSelector = `${'.js:'.repeat(12000)}\\n::error::forged`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - "file://providers/${malformedSelector}"`,
    );
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect((core.warning as Mock).mock.calls.join('\\n')).not.toContain(
      '::error::forged',
    );
  });

  it('should split provider selectors at the last colon and assertion selectors at the first colon', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/model.js:literal.py:run
tests:
  - assert:
      - type: javascript
        value: file://validators/check.js:literal.rb:Module.method
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should track both interpretations for an uppercase JS extension at the last selector colon', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'file://providers/Foo.js:literal.JS:run'`,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should strip an uppercase HTTP validator extension selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/status.JS:validateStatus
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should track HTTP-like non-HTTP provider config references with nested selector semantics', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: httpWhatever
    config:
      validateStatus: file://validators/status.js:validateStatus
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['validators/status.js']);
  });

  it('should ignore non-file validators and track uppercase HTTP-like config references literally', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: status < 500
  - id: HTTP://example.test/invoke
    config:
      validateStatus: file://validators/status.js
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['validators/status.js']);
  });

  it('should split an HTTP validator selector at the last colon', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/check.js:literal.ts:run
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should strip trailing provider, assertion, and auth selectors but retain an empty HTTP selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://providers/custom.py:'
  - id: https
    config:
      validateStatus: 'file://validators/status.js:'
      auth:
        type: file
        path: 'file://auth/token.py:'
tests:
  - assert:
      - type: ruby
        value: 'file://validators/check.rb:'
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract exact Python, Golang, and Ruby provider prefixes across provider forms', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/direct.py:run
  - id: golang:providers/object.go:Run
  - "ruby:providers/map.rb:MyModule::Nested.method": {}
  - go:providers/ignored.go:Run
targets:
  - python:targets/direct.py:run
  - id: ruby:targets/object.rb:Run
  - "golang:targets/map.go:Run": {}
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract bare JavaScript-family and direct exec provider paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - providers/custom.js
  - providers/custom.TS
  - exec:providers/run.sh
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively evaluate command-style provider exec references', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'exec:node scripts/provider.js'`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract all executed HTTP transform and session-parser hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      transformRequest: file://hooks/request.js:literal.ts:run
      transformResponse: file://hooks/response.js:transform
      responseParser: file://hooks/legacy.cjs:parse
      sessionParser: file://hooks/session.mjs:parse
      session:
        responseParser: file://hooks/endpoint.ts:parse
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should preserve literal POSIX backslashes and strip selectors from all direct HTTP hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: 'file://validators\\STATUS\\{one,two}.JS:validateStatus'
      transformRequest: 'file://hooks\\request\\*.TS:run'
      transformResponse: 'file://hooks\\response\\[literal].js:transform'
      responseParser: 'file://hooks\\nested\\legacy\\{literal}.CJS:parse'
      sessionParser: 'file://hooks\\session\\*.MTS:parse'
      session:
        responseParser: 'file://hooks\\nested\\endpoint\\[literal].ts:parse'
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should extract raw paths for bare and env-computed HTTP providers, auth types, and multipart discriminators', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      url: https://bare.example/invoke
      tls:
        caPath: tls/bare.pem
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: payloads/bare.bin
  - id: '{{ env.HTTP_ID }}'
    config:
      url: '{{ env.HTTP_URL }}'
      auth:
        type: '{{ env.AUTH_TYPE }}'
        path: auth/dynamic.py:get_auth
      tls:
        caPath: tls/dynamic.pem
      multipart:
        parts:
          - kind: '{{ env.PART_KIND }}'
            source:
              type: '{{ env.SOURCE_TYPE }}'
              path: payloads/dynamic.bin
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract a file URL multipart upload dependency', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: file://fixtures/sample-report45.pdf
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['fixtures/sample-report45.pdf']);
  });

  it('should preserve literal POSIX backslashes and glob characters in direct HTTP file paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      tls:
        caPath: 'tls/ca\\bundle*.pem'
      signatureAuth:
        privateKeyPath: 'signature/key\\{literal}.pem'
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: 'payloads/raw\\*.bin'
          - kind: file
            source:
              type: path
              path: 'file://payloads/url\\{literal}.bin'
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'tls/ca\\bundle*.pem',
      'signature/key\\{literal}.pem',
      'payloads/raw\\*.bin',
      'payloads/url\\{literal}.bin',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively track a templated multipart file path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: 'file://{{documentPath}}'
tests:
  - vars:
      documentPath: payloads/sample.bin
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should extract HTTP validator, file auth, TLS, and signature paths from a provider map', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "https://example.test/invoke":
      config:
        validateStatus: file://validators/status.js:validateStatus
        auth:
          type: file
          path: file://auth/token.py:get_auth
        tls:
          caPath: tls/ca.pem
          certPath: tls/client.pem
          keyPath: tls/client.key
          pfxPath: tls/client.pfx
          jksPath: tls/client.jks
        signatureAuth:
          privateKeyPath: signature/private.pem
          keystorePath: signature/store.jks
          pfxPath: signature/store.pfx
          certPath: signature/cert.pem
          keyPath: signature/key.pem
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['targets', 'map'],
    ['targets', 'options'],
    ['providers', 'singleton'],
  ])('should extract HTTP file dependencies from %s in %s form', (key, form) => {
    const provider =
      form === 'map'
        ? `  - "http://example.test/invoke":\n      config:`
        : form === 'options'
          ? `  - id: http://example.test/invoke\n    config:`
          : `  id: http://example.test/invoke\n  config:`;
    const indentation =
      form === 'map' ? '        ' : form === 'options' ? '      ' : '    ';
    mockFs.readFileSync.mockReturnValue(`
${key}:
${provider}
${indentation}validateStatus: file://validators/status.ts:check
${indentation}auth:
${indentation}  type: file
${indentation}  path: auth/token.py:get_auth
${indentation}tls:
${indentation}  caPath: tls/ca.pem
${indentation}signatureAuth:
${indentation}  privateKeyPath: signature/private.pem
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should track HTTP-specific file references literally on a non-HTTP provider map', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "openai:gpt-4.1":
      config:
        validateStatus: file://validators/status.js
        auth:
          type: file
          path: file://auth/token.py
        tls:
          caPath: tls/ca.pem
        signatureAuth:
          privateKeyPath: signature/private.pem
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['validators/status.js', 'auth/token.py']);
  });

  it('should preserve raw HTTP auth, TLS, and signature paths with colons', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      auth:
        type: file
        path: ./auth/get-token.js:fn
      tls:
        caPath: tls/ca.pem:literal
      signatureAuth:
        privateKeyPath: signature/key.js:literal
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'auth/get-token.js:fn',
      'tls/ca.pem:literal',
      'signature/key.js:literal',
    ]);
  });

  it('should preserve literal POSIX backslashes in a file-auth path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      auth:
        type: file
        path: 'file://auth/token\\{literal}.py:get_auth'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively workspace-watch an extensionless prompt executable', () => {
    mockFs.readFileSync.mockReturnValue(`prompts:\n  - exec:prompt-generator`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively workspace-watch an executable .bash prompt', () => {
    mockFs.readFileSync.mockReturnValue(`prompts:\n  - prompts/generate.bash`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should track TLS paths from map-style test and scenario providers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      "https://test.example":
        config:
          tls:
            caPath: tls/test.pem
scenarios:
  - config:
      - provider:
          "https://scenario.example":
            config:
              tls:
                caPath: tls/scenario.pem
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tls/test.pem', 'evals/tls/scenario.pem']);
  });

  it('should preserve literal HTTP hook and auth paths in inline scenario options', () => {
    mockFs.readFileSync.mockReturnValue(`
scenarios:
  - config:
      - options:
          provider:
            id: https://scenario.example
            config:
              validateStatus: 'file://validators\\numeric\\{1..1000000000}.JS:validate'
              transformRequest: 'file://hooks\\request\\{one,two}.TS:transform'
              transformResponse: 'file://hooks\\response\\*.js:transform'
              session:
                responseParser: 'file://hooks\\session\\[literal].TS:parse'
              auth:
                type: file
                path: 'file://auth\\tokens\\{one,two}.py:get_auth'
              body:
                document:
                  path: 'file://fixtures\\payload\\{literal}.json'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should skip inline binary views while extracting scenario, test, and provider file references', () => {
    const binarySchema = CORE_SCHEMA.withTags(mergeTag, binaryTag);
    const schemaSpy = vi
      .spyOn(CORE_SCHEMA, 'withTags')
      .mockReturnValue(binarySchema);
    const objectValues = Object.values;
    const valuesSpy = vi
      .spyOn(Object, 'values')
      .mockImplementation((value: object) => {
        if (ArrayBuffer.isView(value)) {
          throw new Error('binary view must not be enumerated');
        }
        return objectValues(value);
      });
    const binary = Buffer.alloc(128 * 1024).toString('base64');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config:
      payload: !!binary ${binary}
      schema: file://schemas/provider.json
tests:
  - options:
      payload: !!binary ${binary}
      response_format: file://schemas/test.json
scenarios:
  - config:
      - options:
          payload: !!binary ${binary}
          response_format: file://schemas/scenario.json
`);

    try {
      expect(
        extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
      ).toEqual([
        'evals/schemas/provider.json',
        'evals/schemas/test.json',
        'evals/schemas/scenario.json',
      ]);
      expect(valuesSpy).not.toHaveBeenCalledWith(expect.any(Uint8Array));
    } finally {
      valuesSpy.mockRestore();
      schemaSpy.mockRestore();
    }
  });

  it('should extract executed provider, test, assertion, and extension hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    transform: file://hooks/provider.py:transform
  - "openai:gpt-4.1-mini":
      transform: file://hooks/mapped.js:transform
tests:
  - provider:
      id: https://override.example
      config:
        tls:
          caPath: tls/override.pem
    assertScoringFunction: file://hooks/score.py:score
    assert:
      - type: javascript
        value: file://validators/check.js:run
        transform: file://hooks/assert-transform.js:run
        contextTransform: file://hooks/context.py:run
        provider:
          id: https://grader.example
          config:
            tls:
              caPath: tls/grader.pem
extensions:
  - file://hooks/extension.py:onEvent
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should preserve literal POSIX backslashes and glob characters in extension-hook filenames', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - 'file://hooks\\nested\\{one,two}*.js:afterAll'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should recursively track nested provider-config IDs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config:
      fallback:
        provider:
          id: python:providers/nested.py:run
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['providers/nested.js', ['./']],
    ['exec:python3 providers/nested.py', ['./']],
    ['exec:providers/nested.sh', ['./']],
    ['exec:file://providers/nested.py:run', ['./']],
  ])('should recursively handle a runtime-supported nested provider ID %s', (providerId, expected) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config:
      fallback:
        provider:
          id: '${providerId}'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(expected);
  });

  it('should conservatively handle a transitive file provider nested in provider config', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const childPath = '/test/working/evals/providers/child.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? `providers:\n  - id: openai:gpt-4.1\n    config:\n      fallback:\n        provider:\n          id: file://providers/child.yaml`
        : 'providers:\n  - python:providers/child.py:run',
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(childPath, 'utf8');
  });

  it('should track provider-specific file references in inline test options', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - options:
      response_format: file://schemas/math-response.json
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/schemas/math-response.json']);
  });

  it('should extract executable default-test and test-options hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  provider:
    id: https://default.example
    config:
      tls:
        caPath: tls/default.pem
  assertScoringFunction: file://hooks/default-score.py:score
  options:
    postprocess: file://hooks/default-post.js:run
    transform: file://hooks/default-transform.py:run
    transformVars: file://hooks/default-vars.js:run
    provider:
      id: https://default-grader.example
      config:
        tls:
          caPath: tls/default-grader.pem
tests:
  - options:
      postprocess: file://hooks/test-post.py:run
      transform: file://hooks/test-transform.js:run
      transformVars: file://hooks/test-vars.py:run
      provider:
        id: https://test-grader.example
        config:
          tls:
            caPath: tls/test-grader.pem
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract a nested HTTP body file reference', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      body:
        messages:
          - content:
              data: file://payloads/context.json
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/payloads/context.json']);
  });

  it.each([
    [
      `providers:\n  - id: openai:gpt-4.1\n    config:\n      tools:\n        - schema: file://schemas/tool.json`,
      ['evals/schemas/tool.json'],
    ],
    [
      `providers:\n  - id: python:providers/custom.py:run\n    config:\n      nested:\n        values:\n          - file://data/context.json`,
      ['./'],
    ],
    [
      `providers:\n  - "openai:gpt-4.1":\n      config:\n        response_format:\n          schema: file://schemas/response.json`,
      ['evals/schemas/response.json'],
    ],
    [
      `providers:\n  - id: python:providers/custom.py:run\n    config:\n      body:\n        nested: file://payloads/context.json`,
      ['./'],
    ],
  ])('should extract nested provider-config file references', (config, expected) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(expected);
  });

  it('should conservatively evaluate a cyclic provider config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config: &cycle
      nested: *cycle
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively stop a nested assert-set alias DAG', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: assert-set
        assert: &shared
          - type: javascript
            value: file://validators/shared.js:run
      - type: assert-set
        assert: *shared
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract rubric and object-prompt provider-config file references', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: prompts/base.txt
    config:
      tools:
        - schema: file://schemas/prompt-tool.json
tests:
  - options:
      rubricPrompt:
        - file://rubrics/options.json
    assert:
      - type: llm-rubric
        rubricPrompt: file://rubrics/assert.json
defaultTest:
  options:
    rubricPrompt: file://rubrics/default.json
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/prompts/base.txt',
      'evals/schemas/prompt-tool.json',
      'evals/rubrics/default.json',
      'evals/rubrics/assert.json',
      'evals/rubrics/options.json',
    ]);
  });

  it('should strip selectors on nested provider-config, prompt-config, and rubric references', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1
    config:
      tools:
        - schema: file://tools/build.py:generate
prompts:
  - id: prompts/base.txt
    config:
      tools:
        - schema: file://tools/prompt.js:build
tests:
  - options:
      rubricPrompt: file://rubrics/options.js:generate
    assert:
      - type: llm-rubric
        rubricPrompt: file://rubrics/assert.py:generate
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/tools/build.py',
      'evals/prompts/base.txt',
      'evals/tools/prompt.js',
      'evals/rubrics/assert.py',
      'evals/rubrics/options.js',
    ]);
  });

  it.each([
    `providers:\n  - file://providers/external.yaml`,
    `tests: test-data/cases.json`,
    `defaultTest: file://defaults/base.yml`,
  ])('should conservatively track transitive external config references', (config) => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? config
        : 'nested: file://validators/check.py:run',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['jsonl', '\\u002f'],
    ['json', '\\u002f'],
    ['jsonl', '\\/'],
  ])('should conservatively detect JSON-escaped file references in external .%s tests', (extension, escapedSlash) => {
    const row = `{"vars":{"context":"file:${escapedSlash}${escapedSlash}payloads/context.txt"}}`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? `tests: test-data/cases.${extension}`
        : extension === 'jsonl'
          ? row
          : `[${row}]`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['jsonl', '\\u0066ile://payloads/context.txt'],
    ['json', 'file\\u003a//payloads/context.txt'],
  ])('should conservatively detect an escaped JSON scheme in external .%s tests', (extension, reference) => {
    const row = `{"vars":{"context":"${reference}"}}`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? `tests: test-data/cases.${extension}`
        : extension === 'jsonl'
          ? row
          : `[${row}]`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively detect a file reference in a quoted-comma CSV value', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? 'tests: test-data/cases(1).csv'
        : 'description,context\n"quoted, literal (value)","file://payloads/context.txt"',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    ['__expected', 'equals:file://rubrics/expected.txt'],
    ['__expected', 'javascript:file://validators/check.js:validate'],
    ['__expected_result', 'equals:file://rubrics/expected.txt'],
  ])('should conservatively detect a typed file assertion in CSV tests', (header, assertion) => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? 'tests: test-data/cases.csv'
        : `prompt,${header}\nhello,${assertion}`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should ignore a file-like example embedded in CSV prose without preflighting its brace text', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? 'tests: test-data/cases.csv'
        : 'description\n"The example is file://assets/{1..1000000000}.txt"',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/test-data/cases.csv']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should scan a newline-heavy external tests file in linear time', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? 'tests: test-data/cases.csv'
        : `${'\n'.repeat(256 * 1024)}not-a-reference`,
    );
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/test-data/cases.csv']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('should reject an unclosed config-path character class before any eager glob work', () => {
    const malformed = `providers/[${'a'.repeat(32000)}`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'file://${malformed}'`,
    );
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('malformed pattern reached glob.hasMagic');
    });
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively track a map-style file provider inside an external tests file', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const testsPath = '/test/working/evals/suites/cases.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      const candidate = filePath.toString();
      if (candidate === configPath) return `tests: suites/cases.yaml`;
      if (candidate === testsPath) {
        return `- provider:\n    "python:providers/test_provider.py":\n      config: {}`;
      }
      throw new Error('unexpected external tests dependency');
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(testsPath, 'utf8');
  });

  it('should conservatively track nested file references in a YAML prompt', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const promptPath = '/test/working/evals/prompts/chat.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      const candidate = filePath.toString();
      if (candidate === configPath) {
        return `prompts:\n  - file://prompts/chat.yaml`;
      }
      if (candidate === promptPath) {
        return `- role: user\n  content: file://data/context.txt`;
      }
      throw new Error('unexpected prompt dependency');
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(promptPath, 'utf8');
  });

  it('should inspect the runtime-normalized transitive config instead of a backslash-named decoy', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const runtimePath = '/test/working/evals/test-data/cases.yaml';
    const decoyPath = '/test/working/evals/test-data\\cases.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      const candidate = filePath.toString();
      if (candidate === configPath) return `tests: 'test-data\\cases.yaml'`;
      if (candidate === runtimePath) {
        return 'nested: file://validators/check.py:run';
      }
      if (candidate === decoyPath) return 'plain: safe';
      throw new Error('unexpected transitive path');
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(runtimePath, 'utf8');
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(decoyPath, 'utf8');
  });

  it('should conservatively handle an unreadable transitive file with a selector suffix', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString().endsWith('promptfooconfig.yaml')) {
        return `tests: test-data/cases.yaml:sheet`;
      }
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should reject an oversized transitive file before reading it', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const externalPath = '/test/working/evals/test-data/cases.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === configPath) {
        return `tests: test-data/cases.yaml`;
      }
      throw new Error('oversized file must not be read');
    });
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === externalPath
        ? ({
            size: 1024 * 1024 + 1,
            isDirectory: () => false,
            isFile: () => true,
          } as fs.Stats)
        : ({
            size: 0,
            isDirectory: () => false,
            isFile: () => true,
          } as fs.Stats),
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(externalPath, 'utf8');
  });

  it('should reject a non-regular transitive file before reading it', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const fifoPath = '/test/working/evals/test-data/cases.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath ? `tests: test-data/cases.yaml` : '[]',
    );
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === fifoPath
        ? ({
            isDirectory: () => false,
            isFile: () => false,
            isFIFO: () => true,
            size: 0,
          } as fs.Stats)
        : ({
            isDirectory: () => false,
            isFile: () => true,
            size: 0,
          } as fs.Stats),
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(fifoPath, 'utf8');
  });

  it('should reject a transitive file swapped to a FIFO after opening without reading it', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const fifoPath = '/test/working/evals/test-data/cases.yaml';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath ? `tests: test-data/cases.yaml` : '',
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
    } as fs.Stats);
    mockFs.fstatSync.mockImplementation((fileDescriptor: number) =>
      fileDescriptor.toString() === fifoPath
        ? ({ isFile: () => false, isFIFO: () => true, size: 0 } as fs.Stats)
        : ({ isFile: () => true, isFIFO: () => false, size: 0 } as fs.Stats),
    );

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.openSync).toHaveBeenCalledWith(
      fifoPath,
      nonblockingReadFlags,
    );
    expect(mockFs.fstatSync).toHaveBeenCalledWith(fifoPath);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(fifoPath, 'utf8');
    expect(mockFs.closeSync).toHaveBeenCalledWith(fifoPath);
  });

  it('should conservatively handle spreadsheet tests with a sheet suffix without reading binary data', () => {
    const configPath = '/test/working/evals/promptfooconfig.yaml';
    const spreadsheetPath = '/test/working/evals/test-data/cases.xlsx#Security';
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) => {
      if (filePath.toString() === configPath) {
        return `tests: test-data/cases.xlsx#Security`;
      }
      throw new Error('spreadsheet must not be UTF-8 read');
    });

    expect(extractFileDependencies(configPath)).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      spreadsheetPath,
      'utf8',
    );
  });

  it('should conservatively stop cyclic and oversized nested HTTP bodies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      body: &cycle
        nested: *cycle
`);
    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);

    const oversized = Array.from({ length: 100001 }, () => '0').join(',');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      body: [${oversized}]
`);
    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should safely handle malformed multipart entries and block-style dynamic discriminators', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      auth:
        type: '{% if env.FILE_AUTH %}file{% endif %}'
        path: auth/block.py:get_auth
      multipart:
        parts:
          - false
          - kind: file
            source: false
          - kind: text
            source:
              type: path
              path: payloads/source-type.bin
          - kind: '{% if env.FILE_PART %}file{% endif %}'
            source:
              type: inline
              path: payloads/kind.bin
          - kind: text
            source:
              type: '{% if env.PATH_SOURCE %}path{% endif %}'
              path: payloads/source.bin
  - id: https
    config:
      multipart:
        parts: invalid
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/auth/block.py:get_auth',
      'evals/payloads/source-type.bin',
      'evals/payloads/kind.bin',
      'evals/payloads/source.bin',
    ]);
  });

  it('should extract an exec file URL provider selector', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'exec:file://providers/run.py:execute'`,
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively stop cycles in prompt config and rubric references', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: prompts/base.txt
    config: &promptCycle
      nested: *promptCycle
tests:
  - options:
      rubricPrompt: &optionCycle
        nested: *optionCycle
    assert:
      - type: llm-rubric
        rubricPrompt: &assertCycle
          nested: *assertCycle
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it.each([
    'vars: vars/shared.yaml',
    'providers:\n  - id: python:providers/custom.py:run',
    'providers:\n  - providers/custom.js',
    'tests: scenarios/cases.yaml',
    'tests: scenarios/cases.xls#Regression',
  ])('should conservatively detect raw nested references in an external config', (nested) => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? 'tests: test-data/cases.yaml'
        : nested,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively track an external provider config with raw TLS and multipart paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? `providers:\n  - file://providers/http.yaml`
        : `
- id: https
  config:
    auth:
      type: file
      path: credentials/get-token
    tls:
      caPath: certificates/ca.bundle
      certPath: certificates/client.pem
      keyPath: certificates/client.key
      pfxPath: certificates/client.p12
      jksPath: certificates/client.store
    signatureAuth:
      privateKeyPath: signatures/private.secret
      keystorePath: signatures/store.bin
    multipart:
      parts:
        - kind: file
          source:
            type: path
            path: payloads/request.bin
`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should scan whitespace-heavy transitive files in bounded time without widening plain content', () => {
    const whitespaceHeavy = `${' '.repeat(64000)}x`;
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString().endsWith('promptfooconfig.yaml')
        ? `tests: test-data/cases.yaml`
        : whitespaceHeavy,
    );
    const startedAt = performance.now();

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/test-data/cases.yaml']);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it.each([
    'extensions: invalid',
    'extensions:\n  - false',
  ])('should conservatively handle malformed extensions', (config) => {
    mockFs.readFileSync.mockReturnValue(config);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should strip JS and Python file-auth selectors but preserve unsupported Ruby selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https:first
    config:
      auth:
        type: file
        path: file://auth/token.js:literal.py:get_auth
  - id: https:second
    config:
      auth:
        type: file
        path: file://auth/token.rb:get_auth
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should reject an unsafe raw HTTP path without interpolating it in warnings', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      tls:
        caPath: "tls/ca\\n::error::forged.pem"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect((core.warning as Mock).mock.calls.join('\\n')).not.toContain(
      '::error::forged',
    );
  });

  it.each([
    '/etc/ca.pem',
    'C:\\\\private\\\\ca.pem',
    '\\\\\\\\server\\\\share\\\\ca.pem',
  ])('should conservatively reject an absolute raw HTTP dependency %s', (caPath) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      tls:
        caPath: '${caPath}'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should handle malformed maps, file map keys, and primitive map options safely', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "https://first.example": {}
    "https://second.example": {}
  - "file://providers/custom.py": {}
  - "https://primitive.example": false
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should use the provider-map key, not an inner display id, for HTTP dispatch', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "openai:gpt-4.1":
      id: http://display-only.example
      config:
        tls:
          caPath: tls/ignored.pem
  - "https://runtime.example":
      id: openai:gpt-4.1
      config:
        tls:
          caPath: tls/tracked.pem
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tls/tracked.pem']);
  });

  it('should return a conservative root sentinel after a parse error without log injection', () => {
    mockFs.readFileSync.mockReturnValue(
      'invalid: yaml: content: "::error::forged"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = (core.warning as Mock).mock.calls
      .map(([message]) => message)
      .join('\n');
    expect(warnings).not.toContain('::error::forged');
  });

  it('should extract all file types from complex config', () => {
    const configContent = `
providers:
  - openai:gpt-4

prompts:
  - file://prompts/main.txt
  - file: prompts/secondary.txt

defaultTest:
  vars:
    providerFile: file://providers/custom.py
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
tests:
  - vars:
      input: file://provider.py
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
tests:
  - vars:
      first: file://providers/*.py
      second: file://custom/**/*.js
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

    expect(deps).toEqual(['../config/providers/', '../config/custom/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should handle a glob without a base directory', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      input: file://*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/provider.py']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/']);
  });

  it('should build nested base directories for globs', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      input: file://providers/python/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/python/provider.py',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/python/']);
  });

  it('should handle directory paths in file:// URLs', () => {
    const configPath = '/test/config/promptfooconfig.yaml';
    const configContent = `
tests:
  - vars:
      first: file://providers/
      second: file://lib
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockFs.existsSync.mockImplementation((path: unknown) => {
      const pathStr = String(path);
      return pathStr.includes('providers') || pathStr.includes('lib');
    });

    mockFs.statSync.mockImplementation((filePath: fs.PathLike) =>
      filePath.toString() === configPath
        ? ({
            isDirectory: () => false,
            isFile: () => true,
            size: 0,
          } as fs.Stats)
        : ({ isDirectory: () => true } as fs.Stats),
    );

    const deps = extractFileDependencies(configPath);

    expect(deps).toContain('../config/providers/');
    expect(deps).toContain('../config/lib/');
  });

  it('should handle wildcards in test vars and asserts', () => {
    const configContent = `
tests:
  - vars:
      data: file://test-data/*.json
    assert:
      - type: contains
        value: file://validators/*.txt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    mockGlob.hasMagic.mockImplementation((path: string) => path.includes('*'));

    mockGlob.sync.mockImplementation((pattern: string) => {
      const patternStr = String(pattern);
      if (patternStr.includes('test-data/*.json')) {
        return ['/test/config/test-data/data1.json'];
      }
      if (patternStr.includes('validators/*.txt')) {
        return ['/test/config/validators/validator.txt'];
      }
      return [];
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/test-data/', '../config/validators/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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

  it('should extract file references from assertion value arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: llm-rubric
        value:
          - file://rubrics/expected.json
          - file://validators/check.txt
          - ordinary inline value
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/rubrics/expected.json', 'evals/validators/check.txt']);
  });
});
