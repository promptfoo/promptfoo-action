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
    lstatSync: vi.fn(),
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
    lstatSync: Mock;
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
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
  });

  it('should extract file:// providers', () => {
    const configContent = `
providers:
  - file://custom_provider.py
  - id: file://another_provider.js
    config:
      temperature: 0.5
  - id: openai:gpt-4
  - openai:gpt-4
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toHaveLength(2);
    expect(deps).toContain('../config/custom_provider.py');
    expect(deps).toContain('../config/another_provider.js');
  });

  it('should extract a scalar file-backed provider', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/custom.py:call_api',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should extract a file-backed provider map entry', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py:call_api:
      label: custom
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should inspect a file-backed provider config for nested dependencies', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('providers/provider.yaml')
          ? 'id: file://providers/custom.py:call_api'
          : 'providers: file://providers/provider.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/provider.yaml',
      '../config/providers/custom.py',
    ]);
  });

  it('should inspect a file-backed HTTP provider config for security dependencies', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('providers/http.yaml')
          ? [
              'id: https://example.test/infer',
              'config:',
              '  auth:',
              '    type: file',
              '    path: auth/get-token.js',
              '  tls:',
              '    caPath: credentials/ca.pem',
              '    jksPath: credentials/client.jks',
            ].join('\n')
          : 'providers: file://providers/http.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/http.yaml',
      '../config/auth/get-token.js',
      '../config/credentials/ca.pem',
      '../config/credentials/client.jks',
    ]);
  });

  it('should inspect a shared provider config in both ref and provider contexts', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('/a.yaml')) {
          return '$ref: shared.yaml';
        }
        if (target.endsWith('/shared.yaml')) {
          return [
            'id: https://example.test/infer',
            'config:',
            '  auth:',
            '    type: file',
            '    path: auth/get-token.js',
          ].join('\n');
        }
        return [
          'providers:',
          '  - file://../a.yaml',
          '  - file://../shared.yaml',
        ].join('\n');
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies(
        '/test/workspace/evals/promptfooconfig.yaml',
        '/test/workspace',
      ),
    ).toEqual(['a.yaml', 'shared.yaml', 'evals/auth/get-token.js']);
  });

  it.each([
    [
      'inline options',
      [
        'providers:',
        '  - id: https://example.test/infer',
        '    config:',
        '      auth:',
        '        type: file',
        '        path: auth/get-token.js',
      ].join('\n'),
    ],
    [
      'provider map',
      [
        'providers:',
        '  - https://example.test/infer:',
        '      config:',
        '        auth:',
        '          type: file',
        '          path: auth/get-token.js',
      ].join('\n'),
    ],
  ])('should extract %s provider config dependencies', (_source, configContent) => {
    mockFs.readFileSync.mockReturnValue(configContent);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/auth/get-token.js']);
  });

  it('should extract a top-level Python provider dependency', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: python:providers/custom.py:call_api',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should extract a scalar file-backed target alias', () => {
    mockFs.readFileSync.mockReturnValue(
      'targets: file://providers/custom.py:call_api',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it.each([
    "''",
    'false',
  ])('should fall back to providers when targets is the falsy value %s', (targets) => {
    mockFs.readFileSync.mockReturnValue(`
targets: ${targets}
providers: file://providers/custom.py:call_api
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should extract HTTP target config dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: https://example.test/infer
    config:
      auth:
        type: file
        path: auth/get-token.js
      tls:
        caPath: credentials/ca.pem
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/auth/get-token.js', '../config/credentials/ca.pem']);
  });

  it.each([
    [
      'provider',
      [
        'providers:',
        '  - id: https://example.test/infer',
        '    config:',
        '      validateStatus: file://validators/status.js:accept_status',
      ].join('\n'),
    ],
    [
      'target',
      [
        'targets:',
        '  - id: http://example.test/infer',
        '    config:',
        '      validateStatus: file://validators/status.mjs:accept_status',
      ].join('\n'),
    ],
    [
      'per-test provider',
      [
        'tests:',
        '  - provider:',
        '      id: https://example.test/infer',
        '      config:',
        '        validateStatus: file://validators/status.cjs:accept_status',
      ].join('\n'),
    ],
  ])('should extract an HTTP %s status-validator module and strip its export selector', (_source, configContent) => {
    mockFs.readFileSync.mockReturnValue(configContent);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      expect.stringMatching(/^\.\.\/config\/validators\/status\.(?:m?js|cjs)$/),
    ]);
  });

  it('should conservatively track literal and underlying uppercase HTTP status-validator files', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/infer
    config:
      validateStatus: file://validators/status.JS:accept_status
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/validators/status.JS:accept_status',
      '../config/validators/status.JS',
    ]);
  });

  it.each([
    'py',
    'rb',
    'go',
  ])('should preserve the literal HTTP status-validator filename for unsupported %s selectors', (extension) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/infer
    config:
      validateStatus: file://validators/status.${extension}:accept_status
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([`../config/validators/status.${extension}:accept_status`]);
  });

  it.each([
    ['provider', 'providers'],
    ['target', 'targets'],
  ])('should extract HTTP %s-map validator and security dependencies', (_source, field) => {
    mockFs.readFileSync.mockReturnValue(`
${field}:
  - https://example.test/infer:
      config:
        validateStatus: file://validators/status.js:accept_status
        auth:
          type: file
          path: auth/get-token.js
        tls:
          caPath: credentials/ca.pem
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/auth/get-token.js',
      '../config/credentials/ca.pem',
      '../config/validators/status.js',
    ]);
  });

  it('should not treat non-HTTP provider config as bare security paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      auth:
        type: file
        path: payload/not-auth.js
      tls:
        caPath: payload/not-ca.pem
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should conservatively track a top-level executable provider', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(
      'providers: exec:python3 providers/custom.py',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['/']);
  });

  it('should ignore invalid top-level provider entries without dropping dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - null
  - {}
  - "": {}
  - file://providers/custom.py:call_api
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it.each([
    'top-level',
    'per-test',
  ])('should reject a pathological %s provider reference in linear time', (source) => {
    const invalidProvider = `python:${'.py:'.repeat(16_384)}/`;
    mockFs.readFileSync.mockReturnValue(
      source === 'top-level'
        ? `providers: ${JSON.stringify(invalidProvider)}`
        : `tests:\n  - provider: ${JSON.stringify(invalidProvider)}`,
    );

    const startedAt = performance.now();
    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it('should preserve supported provider prefixes and safely ignore malformed or unsupported selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/direct.py
  - ruby:providers/ruby.rb:Checks::Safety.call
  - golang:providers/golang.go:Call
  - python:providers/not-script.txt
  - 'python:providers/invalid.py:not/allowed'
  - 'ruby:providers/invalid.rb:not\\allowed'
  - go:providers/unsupported.go:Call
  - python:providers/mapped.py:call_api:
      label: mapped
targets: false
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/direct.py',
      '../config/providers/ruby.rb',
      '../config/providers/golang.go',
      '../config/providers/mapped.py',
    ]);
  });

  it('should preserve provider selectors in target id and map forms', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: python:providers/target.py:call_api
  - golang:providers/mapped.go:Call:
      label: mapped
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/target.py',
      '../config/providers/mapped.go',
    ]);
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

  it('should extract executable prompt, scenario, filter, and HTTP-transform dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/main.txt
  - prompts/globbed/*.md
providers:
  - id: https
    config:
      transformRequest: file://hooks/request.js:transform
      transformResponse: file://hooks/response.cjs:transform
      responseParser: file://hooks/parser.mts:parse
      sessionParser: file://hooks/session.cts:parse
      session:
        responseParser: file://hooks/endpoint.ts:parse
tests:
  path: file://generators/build.py:generate
scenarios:
  - scenarios/shared.yaml
  - tests: scenarios/cases.yaml
  - tests:
      - scenarios/extra.yaml
      - path: file://scenarios/generate.js:build
    config:
      - vars:
          input: file://scenarios/context.json
        assert:
          - type: python
            value: file://scenarios/check.py:validate
        provider: file://scenarios/provider.rb:call_api
nunjucksFilters:
  direct: filters/format.js
  globbed: filters/custom/**/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((value: string) => {
      if (value.endsWith('/prompts/globbed/*.md')) {
        return ['/test/config/prompts/globbed/one.md'];
      }
      if (value.endsWith('/filters/custom/**/*.js')) {
        return ['/test/config/filters/custom/one.js'];
      }
      return [];
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/prompts/main.txt',
      '../config/prompts/globbed/one.md',
      '../config/prompts/globbed',
      '../config/hooks/request.js',
      '../config/hooks/response.cjs',
      '../config/hooks/parser.mts',
      '../config/hooks/session.cts',
      '../config/hooks/endpoint.ts',
      '../config/generators/build.py',
      '../config/scenarios/shared.yaml',
      '../config/scenarios/cases.yaml',
      '../config/scenarios/extra.yaml',
      '../config/scenarios/generate.js',
      '../config/scenarios/context.json',
      '../config/scenarios/check.py',
      '../config/scenarios/provider.rb',
      '../config/filters/format.js',
      '../config/filters/custom/one.js',
      '../config/filters/custom/',
    ]);
  });

  it('should safely ignore malformed scenario and Nunjucks-filter entries', () => {
    mockFs.readFileSync.mockReturnValue(`
scenarios:
  - false
  - null
  - tests: 42
  - tests:
      - false
      - {}
      - path: 42
nunjucksFilters:
  invalid: false
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should reject foreign Windows absolute and drive-relative dependencies before resolution', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://C:/outside/provider.py'
  - 'file://C:\\outside\\provider.py'
  - 'file://C:outside\\provider.py'
tests:
  - 'file://\\\\server\\share\\cases.yaml'
  - $ref: 'D:\\outside\\cases.yaml#/0'
defaultTest: 'file://E:outside\\defaults.yaml'
nunjucksFilters:
  absolute: 'F:\\outside\\filter.js'
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
    expect((core.warning as Mock).mock.calls.flat().join('\n')).not.toMatch(
      /(?:\r|\n)::(?:error|warning)::/,
    );
  });

  it.each([
    ['scalar', 'prompts: file://prompts/prompt.txt'],
    ['legacy map', 'prompts:\n  file://prompts/prompt.txt: labeled-prompt'],
  ])('should extract a %s file-backed prompt', (_source, configContent) => {
    mockFs.readFileSync.mockReturnValue(configContent);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/prompts/prompt.txt']);
  });

  it.each([
    ['id', 'prompts:\n  - id: file://prompts/prompt.txt'],
    ['raw', 'prompts:\n  - raw: file://prompts/prompt.txt'],
    ['bare path', 'prompts: prompts/prompt.txt'],
  ])('should extract a %s file-backed prompt', (_source, configContent) => {
    mockFs.readFileSync.mockReturnValue(configContent);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/prompts/prompt.txt']);
  });

  it('should conservatively track computed Nunjucks prompt and provider paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - "{{ 'file://prompts/' + env.PROMPT_FILE }}"
providers:
  - "{{ 'python:providers/' + env.PROVIDER_FILE }}"
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['/']);
  });

  it('should ignore a prompt object without a path', () => {
    mockFs.readFileSync.mockReturnValue('prompts:\n  - label: inline-label');

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
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

  it('should preserve dependencies when generator config has an arbitrary assert map', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/tests.cjs:generate_tests
  config:
    assert:
      owner: qa
    dataset: file://data/cases.json
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/generators/tests.cjs', '../config/data/cases.json']);
  });

  it.each([
    'py',
    'js',
    'cjs',
    'mjs',
    'ts',
    'cts',
    'mts',
  ])('should conservatively evaluate all changes for an existing %s test generator', (extension) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(
      `tests: file://generators/tests.${extension}:generate_tests`,
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([`generators/tests.${extension}`, '/']);
  });

  it('should ignore null and non-string vars entries without dropping dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - null
  - 7
  - vars:
      - null
      - 9
      - file://data/vars.yaml
    assert:
      - null
      - type: contains
        value: file://expected/output.txt
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/data/vars.yaml', '../config/expected/output.txt']);
  });

  it('should ignore truthy non-string test paths without dropping inline dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - path: 1
    vars:
      context: file://data/context.txt
  - path: {}
    assert:
      - type: contains
        value: file://expected/output.txt
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/data/context.txt', '../config/expected/output.txt']);
  });

  it('should not enumerate atomic YAML values while extracting nested dependencies', () => {
    const entries = vi.spyOn(Object, 'entries');
    const values = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      blob: !!binary AAECAwQFBgcICQ==
      generated: 2026-07-15T00:00:00Z
      context: file://data/context.txt
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/data/context.txt']);
    expect(
      [...entries.mock.calls, ...values.mock.calls].some(
        ([value]) => value instanceof Uint8Array || value instanceof Date,
      ),
    ).toBe(false);
    entries.mockRestore();
    values.mockRestore();
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
- vars: data/vars.yaml
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
    expect(deps).toContain('../config/tests/data/vars.yaml');
    expect(deps).toContain('../config/validators/check.js');
  });

  it('should resolve a file-backed per-test provider from the test directory', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? '- provider: file://providers/custom.py:call_api'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/tests/providers/custom.py',
    ]);
  });

  it('should conservatively inspect an object-form generator nested in an external test', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? '- path: file://generators/build.py:make_tests'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', 'generators/build.py', '/']);
  });

  it('should extract an inline per-test provider dependency', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests:\n  - provider: file://providers/custom.py:call_api',
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should extract a bare file-auth path from an inline HTTP provider', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      id: https://example.test/infer
      config:
        auth:
          type: file
          path: ./auth/get-token.ts
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/auth/get-token.ts']);
  });

  it('should extract file URLs nested in an inline assertion config', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: contains
        config:
          dataset: file://expected/dataset.json
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/expected/dataset.json']);
  });

  it('should extract a bare file-auth path and assertion config from an external test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- provider:',
              '    id: https://example.test/infer',
              '    config:',
              '      auth:',
              '        type: file',
              '        path: ./auth/get-token.ts',
              '  assert:',
              '    - type: contains',
              '      config:',
              '        dataset: file://expected/dataset.json',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/auth/get-token.ts',
      '../config/expected/dataset.json',
    ]);
  });

  it('should not treat arbitrary file-shaped data as provider file auth', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      id: https://example.test/infer
      config:
        body:
          auth:
            type: file
            path: ./payload/not-auth.ts
    assert:
      - type: contains
        config:
          auth:
            type: file
            path: ./expected/not-auth.ts
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should track an aliased HTTP file-auth configuration', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      id: https://example.test/infer
      config:
        body: &file_auth
          type: file
          path: ./auth/get-token.ts
        auth: *file_auth
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/auth/get-token.ts']);
  });

  it('should track security assets and computed schema refs from an external provider', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- provider:',
              '    id: https://example.test/infer',
              '    config:',
              '      response_format:',
              '        type: json_schema',
              `        schema: "{{ 'file://schemas/' + env.SCHEMA }}"`,
              '        json_schema:',
              `          schema: "{{ 'file://schemas/' + env.SCHEMA }}"`,
              '      signatureAuth:',
              '        privateKeyPath: ./credentials/private.pem',
              '        keystorePath: ./credentials/signing.jks',
              '        pfxPath: ./credentials/signing.pfx',
              '      tls:',
              '        certPath: ./credentials/client.crt',
              '        keyPath: ./credentials/client.key',
              '        caPath: ./credentials/ca.pem',
              '- provider:',
              '    id: http://example.test/infer',
              '    config:',
              '      responseFormat:',
              '        type: json_schema',
              '        json_schema: null',
              '- provider:',
              '    id: openai:gpt-4',
              '    config:',
              '      response_format:',
              '        type: json_schema',
              '        json_schema:',
              `          schema: "{{ 'file://schemas/' + env.OTHER_SCHEMA }}"`,
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      'tests/cases.yaml',
      'credentials/private.pem',
      'credentials/signing.jks',
      'credentials/signing.pfx',
      'credentials/client.crt',
      'credentials/client.key',
      'credentials/ca.pem',
      '/',
    ]);
  });

  it.each([
    'go',
    'rb',
  ])('should strip a %s function qualifier from a file-backed per-test provider', (extension) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? `- provider: file://providers/custom.${extension}:call_api`
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      `../config/tests/providers/custom.${extension}`,
    ]);
  });

  it('should retain config dependencies of a file-backed object provider', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- provider:',
              '    id: file://providers/custom.py:call_api',
              '    config:',
              '      dataset: file://data/dataset.json',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/tests/providers/custom.py',
      '../config/data/dataset.json',
    ]);
  });

  it.each([
    ['python', 'py'],
    ['golang', 'go'],
    ['ruby', 'rb'],
  ])('should resolve a %s per-test provider from the test directory', (scheme, extension) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? `- provider: ${scheme}:providers/custom.${extension}:call_api`
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      `../config/tests/providers/custom.${extension}`,
    ]);
  });

  it('should preserve nested refs for missing-id and non-local test providers', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- provider:',
              '    config:',
              '      dataset: file://data/dataset.json',
              '- provider: https://example.test/provider',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml', '../config/data/dataset.json']);
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
                'file://data/vars.json',
                'https://example.test/vars.json',
                'data/extra.json',
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
    expect(deps).toContain('../config/tests/data/extra.json');
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

  it.each([
    'yaml',
    'json',
    'jsonl',
  ])('should extract contained $ref dependencies from a file-backed %s test', (extension) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith(`cases.${extension}`)) {
          if (extension === 'yaml') {
            return '- $ref: data/case.yaml#/case';
          }
          return JSON.stringify({ $ref: 'data/case.yaml#/case' });
        }
        if (target.endsWith('data/case.yaml')) {
          return '$ref: nested/case.json#/case';
        }
        if (target.endsWith('data/nested/case.json')) {
          return JSON.stringify({ case: { vars: 'vars/inputs.yaml' } });
        }
        return `tests: file://tests/cases.${extension}`;
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      `tests/cases.${extension}`,
      'data/case.yaml',
      'data/nested/case.json',
      'tests/vars/inputs.yaml',
    ]);
  });

  it('should extract a contained $ref from the main config tests field', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('tests-pointer.yaml')
          ? [
              'cases:',
              '  - vars: vars/inputs.yaml',
              '    assert:',
              '      - type: javascript',
              '        value:',
              '          file: validators/check.js',
            ].join('\n')
          : 'tests:\n  $ref: tests-pointer.yaml#/cases',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      'tests-pointer.yaml',
      'vars/inputs.yaml',
      'validators/check.js',
    ]);
  });

  it('should extract bare test paths selected through a main-config $ref', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests-index.yaml')) {
          return 'cases:\n  - tests/cases.yaml';
        }
        if (target.endsWith('tests/cases.yaml')) {
          return '- vars:\n    value: file://data/value.txt';
        }
        return 'tests:\n  $ref: tests-index.yaml#/cases';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests-index.yaml', 'tests/cases.yaml', 'data/value.txt']);
  });

  it('should decode URI-encoded local $ref filenames before tracking them', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('suite index.yaml')
          ? 'cases:\n  - vars:\n      value: tracked'
          : 'tests:\n  $ref: suite%20index.yaml#/cases',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['suite index.yaml']);
  });

  it('should resolve a main-config $ref from the configured working directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('/workspace/cases.yaml')
          ? 'cases:\n  - vars:\n      value: tracked'
          : 'tests:\n  $ref: cases.yaml#/cases',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies(
        '/test/workspace/evals/promptfooconfig.yaml',
        '/test/workspace',
      ),
    ).toEqual(['cases.yaml']);
  });

  it('should preserve malformed UTF-8 $ref paths without dropping sibling dependencies', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - $ref: suite%E0%A4.yaml#/cases
  - vars:
      context: file://data/context.txt
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['suite%E0%A4.yaml', 'data/context.txt']);
  });

  it('should conservatively evaluate all changes for nested JSON-schema id scopes', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('tests/cases.yaml')
          ? [
              '$schema: https://json-schema.org/draft/2020-12/schema',
              '$id: nested/',
              '$ref: case.yaml#/case',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('/');
  });

  it('should decode URI-encoded JSON pointer tokens before selecting tests', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests-index.yaml')) {
          return 'active cases:\n  - tests/cases.yaml';
        }
        if (target.endsWith('tests/cases.yaml')) {
          return '- vars:\n    value: tracked';
        }
        return 'tests:\n  $ref: tests-index.yaml#/active%20cases';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests-index.yaml', 'tests/cases.yaml']);
  });

  it('should inspect bare test paths selected by a local JSON pointer', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('tests/cases.yaml')
          ? '- vars:\n    value: tracked'
          : [
              'tests:',
              '  $ref: "#/suites/active"',
              'suites:',
              '  active:',
              '    - tests/cases.yaml',
            ].join('\n'),
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml']);
  });

  it('should preserve an external ref base across local JSON pointers', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests/root.yaml')) {
          return '- $ref: data/common.yaml#/case';
        }
        if (target.endsWith('data/common.yaml')) {
          return [
            'case:',
            '  $ref: "#/definitions/case"',
            'definitions:',
            '  case:',
            '    $ref: nested/case.yaml#/case',
          ].join('\n');
        }
        if (target.endsWith('data/nested/case.yaml')) {
          return 'case:\n  vars:\n    value: tracked';
        }
        return 'tests: file://tests/root.yaml';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/root.yaml', 'data/common.yaml', 'data/nested/case.yaml']);
  });

  it('should inspect a shared test file for each ref-resolution base', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('suites/root.yaml')) {
          return '- $ref: suites/shared.yaml';
        }
        if (target.endsWith('suites/shared.yaml')) {
          return '- $ref: nested/case.yaml#/case';
        }
        if (target.endsWith('nested/case.yaml')) {
          return 'case:\n  vars:\n    value: tracked';
        }
        return [
          'tests:',
          '  - file://suites/shared.yaml',
          '  - file://suites/root.yaml',
        ].join('\n');
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      'suites/shared.yaml',
      'nested/case.yaml',
      'suites/root.yaml',
      'suites/nested/case.yaml',
    ]);
  });

  it('should retain a ref dependency when its JSON pointer crosses a scalar', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('tests-index.yaml')
          ? 'cases:\n  - 7'
          : 'tests:\n  $ref: tests-index.yaml#/cases/0/value',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests-index.yaml']);
  });

  it('should inspect a shared $ref with test-relative vars', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (/\/tests\/[ab]\/cases\.yaml$/.test(target)) {
          return '- $ref: data/common.yaml#/case';
        }
        if (target.endsWith('/data/common.yaml')) {
          return 'case:\n  vars: vars/inputs.yaml';
        }
        return [
          'tests:',
          '  - file://tests/a/cases.yaml',
          '  - file://tests/b/cases.yaml',
        ].join('\n');
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      'tests/a/cases.yaml',
      'data/common.yaml',
      'tests/a/vars/inputs.yaml',
      'tests/b/cases.yaml',
      'tests/b/vars/inputs.yaml',
    ]);
  });

  it('should ignore fragment-only, remote, and outside-workspace test $refs', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- $ref: ""',
              '- $ref: "#/definitions/case"',
              '- $ref: https://example.test/case.yaml#/case',
              '- $ref: data:application/json,%7B%7D',
              '- $ref: ../outside.yaml#/case',
              '- $ref: file:///test/outside.yaml#/case',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test $ref dependency must stay within'),
    );
  });

  it.each([
    String.raw`/test/workspace/tests\..\..\outside\leak.yaml#/0`,
    String.raw`file:///test/workspace/tests\..\..\outside\leak.yaml#/0`,
  ])('should reject mixed-separator test $ref traversal before reading %s', (ref) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? `- $ref: '${ref}'`
          : String(filePath).includes('outside')
            ? '[OUTSIDE_SECRET_CANARY]'
            : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test $ref dependency must stay within'),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('OUTSIDE_SECRET_CANARY'),
    );
  });

  it('should strip supported function qualifiers from nested file URLs', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- assertScoringFunction: file://validators/score.py:calculate_score',
              '  options:',
              '    transform: file://transforms/output.js:customTransform',
              '    transformVars: file://transforms/vars.ts:customTransformVars',
              '  assert:',
              '    - type: javascript',
              '      value: file://validators/assert.js:customFunction',
              '    - type: contains',
              '      value: file://expected/cases:prod.yaml',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/validators/assert.js',
      '../config/expected/cases:prod.yaml',
      '../config/validators/score.py',
      '../config/transforms/output.js',
      '../config/transforms/vars.ts',
    ]);
  });

  it.each([
    [
      'Ruby variable',
      'vars:\n      context: file://vars/build.rb:build',
      '../config/vars/build.rb:build',
    ],
    [
      'Go variable',
      'vars:\n      context: file://vars/build.go:Build',
      '../config/vars/build.go:Build',
    ],
    [
      'Go assertion',
      'assert:\n      - type: javascript\n        value: file://validators/check.go:Check',
      '../config/validators/check.go:Check',
    ],
  ])('should preserve the literal colon filename for a %s file URL', (_source, testBody, expectedDependency) => {
    mockFs.readFileSync.mockReturnValue(`tests:\n  - ${testBody}`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([expectedDependency]);
  });

  it('should strip a Ruby assertion method qualifier', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: ruby
        value: file://validators/check.rb:custom_assert
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/validators/check.rb']);
  });

  it('should strip a namespaced Ruby assertion method qualifier', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: ruby
        value: file://validators/check.rb:Checks::Safety.check
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/validators/check.rb']);
  });

  it('should extract executable selectors from nested default and test assertion sets', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  assert:
    - type: assert-set
      assert:
        - type: javascript
          value: file://validators/default.js:check
tests:
  - assert:
      - type: assert-set
        assert:
          - type: ruby
            value: file://validators/nested.rb:Validators::Format.check
          - type: assert-set
            assert:
              - type: python
                value: file://validators/deep.py:check
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/validators/default.js',
      '../config/validators/nested.rb',
      '../config/validators/deep.py',
    ]);
  });

  it('should safely stop a cyclic assertion set while preserving sibling validators', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - &recursive
        type: assert-set
        assert:
          - *recursive
      - type: javascript
        value: file://validators/safe.js:check
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/validators/safe.js']);
  });

  it('should inspect a shared assertion alias graph without repeated traversal', () => {
    const levels = Array.from({ length: 18 }, (_, index) => {
      const previous = index === 0 ? 'leaf' : `level${index - 1}`;
      return [
        `      - &level${index}`,
        '        type: assert-set',
        `        assert: [*${previous}, *${previous}]`,
      ].join('\n');
    }).join('\n');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - &leaf
        type: javascript
        value: file://validators/shared.js:check
${levels}
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/validators/shared.js']);
    expect(mockFs.lstatSync.mock.calls.length).toBeLessThan(100);
  });

  it('should conservatively track literal and underlying uppercase JavaScript provider and assertion files', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://providers/custom.JS:call_api
tests:
  - assert:
      - type: javascript
        value: file://validators/check.MJS:check
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/custom.JS:call_api',
      '../config/providers/custom.JS',
      '../config/validators/check.MJS:check',
      '../config/validators/check.MJS',
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

  it('should inspect a file-backed YAML test with supported binary metadata', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- metadata:',
              '    blob: !!binary dGVzdA==',
              '    tags: !!set { smoke: null, safety: null }',
              '    pairs: !!pairs [ { owner: qa } ]',
              '    ordered: !!omap [ { suite: safety } ]',
              '    generated: 2026-07-14T12:00:00Z',
              '  vars:',
              '    value: file://data/value.txt',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml', '../config/data/value.txt']);
  });

  it('should preserve Promptfoo-compatible implicit YAML scalar test paths', () => {
    mockFs.readFileSync.mockReturnValue('tests: on');

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/on']);
  });

  it('should extract file URLs embedded in a file-backed CSV test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? 'value,expected\nfile://data/value.txt,ok\n'
          : 'tests: file://tests/cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.csv', '../config/data/value.txt']);
  });

  it.each([
    'contains-all',
    'contains-any',
    'icontains-all',
    'icontains-any',
    'not-contains-all',
    'not-contains-any',
    'not-icontains-all',
    'not-icontains-any',
  ])('should extract each file URL from a CSV %s assertion', (assertion) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? `value,__expected\nignored,"${assertion}:file://expected/a.txt,file://expected/b.txt"\n`
          : 'tests: file://cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/cases.csv',
      '../config/expected/a.txt',
      '../config/expected/b.txt',
    ]);
  });

  it('should preserve a quoted comma in a CSV assertion file URL', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? 'value,__expected\nignored,"contains-all:""file://expected/a,prod.txt"",file://expected/b.txt"\n'
          : 'tests: file://cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/cases.csv',
      '../config/expected/a,prod.txt',
      '../config/expected/b.txt',
    ]);
  });

  it.each([
    [
      'surrounding whitespace',
      'contains-all: "file://expected/a,prod.txt" , file://expected/b.txt',
      'a,prod.txt',
    ],
    [
      'a doubled quote',
      'contains-all:"file://expected/a""prod,one.txt",file://expected/b.txt',
      'a"prod,one.txt',
    ],
    [
      'a backslash-escaped quote',
      'contains-all:"file://expected/a\\"prod,one.txt",file://expected/b.txt',
      'a"prod,one.txt',
    ],
  ])('should preserve %s in a CSV assertion file URL', (_name, assertion, expectedFile) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? `value,__expected\nignored,"${assertion.replaceAll('"', '""')}"\n`
          : 'tests: file://cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/cases.csv',
      `../config/expected/${expectedFile}`,
      '../config/expected/b.txt',
    ]);
  });

  it.each([
    [
      'an unterminated quote',
      'contains-all:"file://expected/CSV_SECRET_CANARY.txt,file://expected/b.txt',
    ],
    [
      'text after a closing quote',
      'contains-all:"file://expected/CSV_SECRET_CANARY.txt"junk,file://expected/b.txt',
    ],
    [
      'a quote after unquoted text',
      'contains-all:file://expected/CSV_SECRET_CANARY.txt"junk,file://expected/b.txt',
    ],
  ])('should conservatively invalidate a CSV assertion with %s', (_name, assertion) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? `value,__expected\nignored,"${assertion.replaceAll('"', '""')}"\n`
          : 'tests: file://cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['cases.csv', '/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect CSV assertion'),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('CSV_SECRET_CANARY'),
    );
  });

  it.each([
    ['yaml', '- vars:\n    value: file://data/{{ env.SUITE }}.txt'],
    ['csv', 'value,expected\nfile://data/{{ env.SUITE }}.txt,ok\n'],
  ])('should expand env templates in nested file URLs from a %s-backed test', (extension, testContent) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith(`cases.${extension}`)
          ? testContent
          : `tests: file://tests/cases.${extension}`,
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/data/prod.txt']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      `../config/tests/cases.${extension}`,
      '../config/',
      '../config/data/prod.txt',
      '../config/data/',
    ]);
  });

  it('should strip Nunjucks comments from a file-backed assertion path', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- assert:',
              '    - type: contains',
              '      value: "file://expected/{# note #}real.txt"',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml', '../config/expected/real.txt']);
  });

  it('should safely strip an adversarial Nunjucks comment from a provider path', () => {
    const comment = `{#${'#'.repeat(50_000)}#}`;
    mockFs.readFileSync.mockReturnValue(
      `providers: 'file://providers/${comment}custom.py'`,
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
  });

  it('should preserve an unterminated Nunjucks comment in a provider path', () => {
    mockFs.readFileSync.mockReturnValue(
      "providers: 'file://providers/{#unterminated.py'",
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/{#unterminated.py']);
  });

  it('should conservatively expand Nunjucks blocks in a file-backed assertion path', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? [
              '- assert:',
              '    - type: contains',
              '      value: "file://expected/{% if env.SUITE %}prod/{% endif %}real.txt"',
            ].join('\n')
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/expected/prod/real.txt']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/',
      '../config/expected/prod/real.txt',
      '../config/expected/',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/config/expected/**/*prod/**/*real.txt',
      expect.objectContaining({ nodir: true }),
    );
  });

  it('should inspect file URLs nested inside a referenced vars file', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests/cases.yaml')) {
          return '- vars: vars/inputs.yaml';
        }
        if (target.endsWith('vars/inputs.yaml')) {
          return 'context: file://data/context.txt';
        }
        return 'tests: file://tests/cases.yaml';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      'tests/cases.yaml',
      'tests/vars/inputs.yaml',
      'data/context.txt',
    ]);
  });

  it('should resolve vars imported by an external test from the config directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests/cases.yaml')) {
          return '- vars: file://data/vars.yaml';
        }
        if (target.endsWith('data/vars.yaml')) {
          return 'context: file://data/context.txt';
        }
        return 'tests: file://tests/cases.yaml';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', 'data/vars.yaml', 'data/context.txt']);
  });

  it('should resolve bare vars imported by an external test from the test directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('tests/cases.yaml')) {
          return '- vars: vars/inputs.yaml';
        }
        if (target.endsWith('tests/vars/inputs.yaml')) {
          return 'context: tracked';
        }
        return 'tests: file://tests/cases.yaml';
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', 'tests/vars/inputs.yaml']);
  });

  it('should expand env templates in object-form vars and assertion files', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      context:
        file: data/{{ env.SUITE }}.txt
    assert:
      - type: contains
        value:
          file: expected/{{ env.SUITE }}.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((pattern: string) =>
      String(pattern).includes('expected')
        ? ['/test/config/expected/prod.txt']
        : ['/test/config/data/prod.txt'],
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '/',
      'data/prod.txt',
      'data/',
      'expected/prod.txt',
      'expected/',
    ]);
  });

  it.each([
    'csv',
    'jsonl',
  ])('should record but not parse an imported %s vars dataset', (extension) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - vars: file://data/vars.${extension}`,
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([`data/vars.${extension}`]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('should preserve commas in quoted file URLs from a file-backed CSV test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? 'value,expected\n"file://data/value,prod.txt",ok\n'
          : 'tests: file://tests/cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.csv', '../config/data/value,prod.txt']);
  });

  it('should retain a file-backed CSV test without embedded file URLs', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? 'value,expected\ninline,ok\n'
          : 'tests: file://tests/cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.csv']);
  });

  it('should retain an empty file-backed CSV test', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.csv')
          ? ''
          : 'tests: file://tests/cases.csv',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.csv']);
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
    ).toEqual([]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: resolved path must stay within the repository workspace',
    );
  });

  it('should stop inspecting a test whose symlink target escapes after the direct-path check', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://tests/changed.yaml');
    mockFs.existsSync.mockReturnValue(true);
    let testRealpathCalls = 0;
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (!value.endsWith('changed.yaml')) {
        return value;
      }
      testRealpathCalls++;
      return testRealpathCalls === 1
        ? value
        : '/private/tmp/outside-secret.yaml';
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
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
          ? '- vars: data/*.yaml'
          : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toContain('../config/tests/data/');
  });

  it('should inspect supported test files inside a file-backed test directory', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases/smoke.yaml')
          ? '- vars:\n    context: file://data/context.txt'
          : 'tests: file://cases',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation(
      (filePath: fs.PathLike) =>
        ({
          isDirectory: () => String(filePath).endsWith('/cases'),
        }) as fs.Stats,
    );
    mockGlob.sync.mockReturnValue(['/test/config/cases/smoke.yaml']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/cases', '../config/data/context.txt']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '**/*.{yaml,yml,json,jsonl,csv,xls,xlsx,py,js,cjs,mjs,ts,cts,mts}',
      expect.objectContaining({
        cwd: '/test/config/cases',
        absolute: true,
        nodir: true,
      }),
    );
  });

  it('should conservatively inspect a generator inside a file-backed test directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue('tests: file://cases');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation(
      (filePath: fs.PathLike) =>
        ({
          isDirectory: () => String(filePath).endsWith('/cases'),
        }) as fs.Stats,
    );
    mockGlob.sync.mockImplementation((pattern: string) =>
      /(?:^|[,{}])js(?=[,}])/.test(pattern)
        ? ['/test/config/cases/generate_cases.js']
        : [],
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['cases', '/']);
  });

  it('should expand Windows-style direct and nested-vars test globs', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('cases.yaml')
          ? "- vars: 'vars\\\\*.yaml'"
          : "tests: ['file://tests\\\\*.yaml']",
    );
    mockFs.existsSync.mockReturnValue(true);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { windowsPathsNoEscape?: boolean }) =>
        value.includes('*') &&
        (!value.includes('\\') || options?.windowsPathsNoEscape === true),
    );
    mockGlob.sync.mockImplementation(
      (pattern: string, options?: { windowsPathsNoEscape?: boolean }) => {
        expect(options?.windowsPathsNoEscape).toBe(true);
        return String(pattern).includes('vars')
          ? ['/test/config/tests/vars/inputs.yaml']
          : ['/test/config/tests/cases.yaml'];
      },
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/tests/cases.yaml',
      '../config/tests/',
      '../config/tests/vars/inputs.yaml',
      '../config/tests/vars/',
    ]);
  });

  it('should expand mixed-separator test globs using Promptfoo semantics', () => {
    mockFs.readFileSync.mockReturnValue(
      String.raw`tests: ['file://tests/\*.yaml']`,
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { windowsPathsNoEscape?: boolean }) =>
        value.includes('*') &&
        (!value.includes('/\\*') || options?.windowsPathsNoEscape === true),
    );
    mockGlob.sync.mockReturnValue(['/test/config/tests/cases.yaml']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/tests/cases.yaml', '../config/tests/']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      expect.stringContaining('tests'),
      expect.objectContaining({ windowsPathsNoEscape: true }),
    );
  });

  it('should reject mixed-separator traversal before expanding a test glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue(
      String.raw`tests: 'file://tests\..\..\outside\*.yaml'`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leak.yaml']);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test file dependency must stay within'),
    );
  });

  it.each([
    'file://{../outside,tests}/*.yaml',
    'file://{tests/../../outside,tests}/*.yaml',
  ])('should reject brace-alternative traversal before expanding %s', (testPath) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue(`tests: '${testPath}'`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leak.yaml']);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test file dependency must stay within'),
    );
  });

  it('should reject bracket-encoded traversal before expanding a test glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue(
      `tests: 'file://tests/[.][.]/[.][.]/outside/*.yaml'`,
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('[') || value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leak.yaml']);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test file dependency must stay within'),
    );
  });

  it('should preserve contained brace-alternative test globs', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue(
      `tests: 'file://{tests,legacy}/*.yaml'`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/workspace/tests/cases.yaml']);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', '{tests,legacy}/*.yaml']);
  });

  it('should expand a brace-only workspace-root test glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue("tests: 'file://case-{one,two}.yaml'");
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([
      '/test/workspace/case-one.yaml',
      '/test/workspace/case-two.yaml',
    ]);

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual(['case-one.yaml', 'case-two.yaml', 'case-{one,two}.yaml']);
  });

  it('should bound brace-only test-glob expansion before enumeration', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue("tests: 'file://case-{1..1025}.yaml'");
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );

    expect(
      extractFileDependencies('/test/workspace/promptfooconfig.yaml'),
    ).toEqual(['/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should expand valid parent-directory brace alternatives inside the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue(
      "tests: 'file://{../shared,tests}/*.yaml'",
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([
      '/test/workspace/shared/case.yaml',
      '/test/workspace/evals/tests/case.yaml',
    ]);

    expect(
      extractFileDependencies('/test/workspace/evals/promptfooconfig.yaml'),
    ).toEqual([
      'shared/case.yaml',
      'evals/tests/case.yaml',
      'evals/{../shared,tests}/*.yaml',
    ]);
  });

  it('should expand env-templated test paths conservatively', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: "file://tests/{{ env.SUITE }}.yaml"',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/tests/active.yaml']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/',
      '../config/tests/active.yaml',
      '../config/tests/',
    ]);
  });

  it('should conservatively track env-templated paths from a nested config', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace');
    mockFs.readFileSync.mockReturnValue('tests: "file://{{ env.TEST_FILE }}"');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/workspace/evals/tests/active.yaml']);

    expect(
      extractFileDependencies('/test/workspace/evals/promptfooconfig.yaml'),
    ).toEqual(['/', 'evals/tests/active.yaml', 'evals/']);
  });

  it('should expand a full Nunjucks env expression that renders nested paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(
      `providers: ["file://{{ 'providers/' + env.SUITE }}.cjs"]`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/providers/prod.cjs']);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['/', 'providers/prod.cjs']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/config/**/*.cjs',
      expect.objectContaining({ nodir: true }),
    );
  });

  it('should avoid a redundant root-glob marker after a dynamic dependency', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{{ env.PROVIDER }}.py
  - file://*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['/']);
  });

  it('should preserve non-env Nunjucks provider templates', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers: ["file://{{ vars.suite }}.cjs"]`,
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/{{ vars.suite }}.cjs']);
  });

  it('should preserve the pattern for an empty workspace-root test glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue('tests: file://*.yaml');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['*.yaml']);
  });

  it('should preserve the pattern for an empty workspace-root prompt glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue('prompts: [file://*.txt]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['*.txt']);
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

  it('should conservatively evaluate all changes for an existing Excel-backed test', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/config');
    mockFs.readFileSync.mockReturnValue('tests: file://cases.xlsx#Safety');
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['cases.xlsx', '/']);
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

  it('should preserve absolute checkout test and provider files from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file:///test/working/providers/custom.py:call_api
tests: file:///test/working/tests/cases.yaml
`);

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/custom.py', 'tests/cases.yaml']);
  });

  it('should preserve absolute checkout test and provider glob matches from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file:///test/working/providers/*.py
tests: file:///test/working/tests/*.yaml
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((value: string) =>
      value.includes('/providers/')
        ? ['/test/working/providers/custom.py']
        : ['/test/working/tests/cases.yaml'],
    );

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual([
      'providers/custom.py',
      'providers',
      'tests/cases.yaml',
      'tests/',
    ]);
  });

  it('should inspect an absolute checkout test file from an external config using real paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('cases.yaml')
        ? 'vars: fixtures/context.txt'
        : 'tests: file:///test/working/tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/shared') {
        return '/real/shared';
      }
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/real/workspace');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', 'tests/fixtures/context.txt']);
  });

  it('should inspect a checkout test file when an unused external config root is inaccessible', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('cases.yaml')
        ? 'vars: fixtures/context.txt'
        : 'tests: file:///test/working/tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/shared') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/real/workspace');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['tests/cases.yaml', 'tests/fixtures/context.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should watch the checkout root for an executable test when an external config root is inaccessible', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file:///test/working/tests/generate.py',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/shared') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/real/workspace');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['tests/generate.py', '/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject a symlinked in-checkout config root that resolves outside the checkout', () => {
    mockFs.readFileSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('cases.yaml')
        ? 'vars: fixtures/context.txt'
        : 'tests: file://tests/cases.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/working') {
        return '/real/workspace';
      }
      if (value.startsWith('/test/working/shared-link')) {
        return value.replace('/test/working/shared-link', '/real/shared');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/working/shared-link/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependencies: config directory resolves outside the repository workspace',
    );
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

  it('should extract and inspect a scalar file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) =>
        String(filePath).endsWith('defaults.yaml')
          ? [
              'provider: file://providers/custom.py:call_api',
              'assert:',
              '  - type: contains',
              '    value: file://expected/default.txt',
            ].join('\n')
          : 'defaultTest: file://defaults/defaults.yaml',
    );
    mockFs.existsSync.mockReturnValue(true);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/defaults/defaults.yaml',
      '../config/expected/default.txt',
      '../config/providers/custom.py',
    ]);
  });

  it('should ignore an empty file-backed defaultTest', () => {
    mockFs.readFileSync.mockReturnValue('defaultTest: file://');

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('test file dependency is empty'),
    );
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

  it('should conservatively watch the checkout after an unexpected post-parse extraction error', () => {
    const canary = 'EXTRACTION_ERROR_CANARY_019F62C3';
    mockFs.readFileSync.mockReturnValue('providers: file://providers/*.py');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error(`glob failed\r\n::error::${canary}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['/']);
    const warnings = (core.warning as Mock).mock.calls.flat().join('\n');
    expect(warnings).toContain(`::error::${canary}`);
    expect(warnings).not.toMatch(/(?:\r|\n)::error::EXTRACTION_ERROR/);
  });

  it('should represent a direct checkout-root directory dependency with the root sentinel', () => {
    mockFs.readFileSync.mockReturnValue('tests: file://.');
    mockFs.statSync.mockImplementation((filePath: fs.PathLike) => ({
      isDirectory: () => String(filePath) === '/test/working',
    }));

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['/']);
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

  it('should reject a null-byte glob before glob parsing without dropping dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
tests: "file://tests/\\0*.yaml"
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new Error('glob parser received a null byte');
      }
      return value.includes('*');
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it.each([
    ['an Error', new TypeError('pattern is too long')],
    ['a non-Error', 'pattern is too long'],
  ])('should preserve dependencies when glob parsing throws %s', (_source, error) => {
    const longGlob = `tests/${'x'.repeat(70_000)}*.yaml`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
tests: file://${longGlob}
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw error;
      }
      return value.includes('*');
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py', '../config/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse config dependency glob'),
    );
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

  it.each([
    ['main-config', 'tests:\n  $ref: data/cases.yaml#/cases'],
    ['external-test', 'tests: file://tests/cases.yaml'],
  ])('should resolve %s test $refs from the configured working directory', (source, configContent) => {
    mockFs.readFileSync.mockImplementation(
      (filePath: fs.PathOrFileDescriptor) => {
        const target = String(filePath);
        if (target.endsWith('/tests/cases.yaml')) {
          return '- $ref: data/cases.yaml#/cases/0';
        }
        if (target.endsWith('/data/cases.yaml')) {
          return 'cases:\n  - vars:\n      subject: tracked';
        }
        return configContent;
      },
    );
    mockFs.existsSync.mockReturnValue(true);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working/evals',
    );

    expect(deps).toContain('evals/data/cases.yaml');
    if (source === 'external-test') {
      expect(deps).toContain('evals/tests/cases.yaml');
    }
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

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it.each([
    '{foo),../../outside}/*.py',
    '{foo),/absolute}/*.py',
    '{foo),[.][.]/[.][.]/outside}/*.py',
  ])('should reject an unsafe brace alternative with a mismatched closer before globbing %s', (pattern) => {
    mockFs.readFileSync.mockReturnValue(
      `providers: ${JSON.stringify(`file://${pattern}`)}`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*{}]/.test(value),
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should filter an escaping match returned for a contained glob pattern', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://providers/*.py]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/secrets/leaked.py',
      '/test/config/providers/custom.py',
    ]);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/custom.py', '../config/providers']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('glob match must stay within'),
    );
  });

  it('should filter a checkout glob match whose symlink escapes an external config and preserve safe siblings', () => {
    const escapedMatch =
      '/test/working/providers/leak\n::error::GLOB_ESCAPE_CANARY_019F62C3.py';
    const safeMatch = '/test/working/providers/custom.py';
    mockFs.readFileSync.mockReturnValue(
      'providers: [file:///test/working/providers/*.py]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([escapedMatch, safeMatch]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath) === escapedMatch
        ? '/test/secrets/leaked.py'
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/custom.py', 'providers']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
    );
    expect((core.warning as Mock).mock.calls.flat().join('\n')).not.toContain(
      'GLOB_ESCAPE_CANARY_019F62C3',
    );
  });

  it('should filter an unverifiable checkout glob match and preserve safe siblings', () => {
    const deniedMatch = '/test/working/providers/denied.py';
    const safeMatch = '/test/working/providers/custom.py';
    mockFs.readFileSync.mockReturnValue(
      'providers: [file:///test/working/providers/*.py]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([deniedMatch, safeMatch]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === deniedMatch) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/custom.py', 'providers']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
    );
  });

  it('should preserve checkout glob matches when an unused external config root is inaccessible', () => {
    const safeMatches = [
      '/test/working/providers/one.py',
      '/test/working/providers/two.py',
    ];
    mockFs.readFileSync.mockReturnValue(
      'providers: [file:///test/working/providers/*.py]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(safeMatches);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === '/test/shared') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/one.py', 'providers/two.py', 'providers']);
    expect(core.warning).not.toHaveBeenCalled();
    expect(
      mockFs.realpathSync.mock.calls.filter(
        ([filePath]) => String(filePath) === '/test/shared',
      ),
    ).toHaveLength(1);
    expect(
      mockFs.realpathSync.mock.calls.filter(
        ([filePath]) => String(filePath) === '/test/working',
      ),
    ).toHaveLength(1);
  });

  it('should compare canonical glob matches against independently canonicalized roots', () => {
    const safeMatch = '/test/working/providers/shared.py';
    mockFs.readFileSync.mockReturnValue(
      'providers: [file:///test/working/providers/*.py]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([safeMatch]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/shared') {
        return '/real/shared';
      }
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/real/workspace');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject an existing direct dependency symlink outside both allowed roots', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/leak.py
  - file:///test/working/providers/shared.py
`);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('/providers/leak.py')
        ? '/test/secrets/leak.py'
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/shared.py']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: resolved path must stay within the repository workspace',
    );
  });

  it('should reject an existing dangling direct dependency symlink', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/dangling.py
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/dangling.py')) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: resolved path cannot be verified',
    );
  });

  it.each([
    'ENOENT',
    'ENOTDIR',
  ])('should preserve a missing direct dependency when realpath reports %s', (code) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/missing.py
`);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/missing.py')) {
        throw Object.assign(new Error('not found'), { code });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual(['providers/missing.py']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['realpath', 'EACCES'],
    ['lstat', 'EACCES'],
  ])('should reject a direct dependency whose %s check reports %s', (stage, code) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/denied.py
`);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/denied.py')) {
        throw Object.assign(new Error('not found'), {
          code: stage === 'realpath' ? code : 'ENOENT',
        });
      }
      return String(filePath);
    });
    if (stage === 'lstat') {
      mockFs.lstatSync.mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code });
      });
    }

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: resolved path cannot be verified',
    );
  });

  it('should reject direct and glob dependencies from a symlinked in-checkout config root', () => {
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
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value === '/test/working') {
        return '/real/workspace';
      }
      if (value.startsWith('/test/working/shared-link')) {
        return value.replace('/test/working/shared-link', '/real/shared');
      }
      return value;
    });

    expect(
      extractFileDependencies('/test/working/shared-link/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependencies: config directory resolves outside the repository workspace',
    );
  });

  it.each([
    '\n',
    '\r',
    '\r\n',
  ])('should sanitize unsafe templated dependency-path warnings', (lineBreak) => {
    const canary = 'TEMPLATE_WARNING_CANARY_019F62C3';
    const unsafeProvider = `file://../outside${lineBreak}::error::${canary}.py`;
    mockFs.readFileSync.mockReturnValue(
      `providers: ${JSON.stringify(unsafeProvider)}`,
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
    const warnings = (core.warning as Mock).mock.calls.flat().join('\n');
    expect(warnings).toContain(`::error::${canary}`);
    expect(warnings).not.toMatch(/(?:\r|\n)::error::TEMPLATE_WARNING/);
  });

  it.each([
    'EACCES',
    'ENOENT',
  ])('should sanitize %s inspection warnings for CRLF test paths', (code) => {
    const canary = `INSPECT_${code}_CANARY_019F62C3`;
    const testPath = `tests/cases\r\n::error::${canary}.yaml`;
    mockFs.readFileSync.mockReturnValue(
      `tests: ${JSON.stringify(`file://${testPath}`)}`,
    );
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).includes(canary)) {
        throw Object.assign(new Error('permission denied'), { code });
      }
      return String(filePath);
    });

    extractFileDependencies('/test/config/promptfooconfig.yaml');

    const warnings = (core.warning as Mock).mock.calls.flat().join('\n');
    if (code === 'ENOENT') {
      expect(warnings).toContain(`::error::${canary}`);
    } else {
      expect(warnings).not.toContain(canary);
    }
    expect(warnings).not.toMatch(/(?:\r|\n)::error::INSPECT_/);
  });

  it('should sanitize CRLF glob-parser errors in dependency warnings', () => {
    const canary = 'GLOB_WARNING_CANARY_019F62C3';
    mockFs.readFileSync.mockReturnValue('providers: file://providers/*.py');
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error(`invalid pattern\r\n::error::${canary}`);
    });

    extractFileDependencies('/test/config/promptfooconfig.yaml');

    const warnings = (core.warning as Mock).mock.calls.flat().join('\n');
    expect(warnings).toContain(`::error::${canary}`);
    expect(warnings).not.toMatch(/(?:\r|\n)::error::GLOB_WARNING/);
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

    expect(deps).toEqual(['../config/provider.py', '../config/*.py']);
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
    expect(deps).toContain('../config/test-data/');
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
