import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import * as minimatch from 'minimatch';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractFileDependencies,
  hasSafeNumericBraceRanges,
  normalizeConfigFilePath,
} from '../../src/utils/config';

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
vi.mock('minimatch', async () => {
  const realMinimatch =
    await vi.importActual<typeof import('minimatch')>('minimatch');
  return {
    ...realMinimatch,
    braceExpand: vi.fn(realMinimatch.braceExpand),
  };
});

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
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath),
    );
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  it('should normalize standard Windows file URL drive prefixes', () => {
    expect(
      normalizeConfigFilePath('/C:/repo/evals/default.yaml', 'win32'),
    ).toBe('C:/repo/evals/default.yaml');
    expect(
      normalizeConfigFilePath('/C:\\repo\\evals\\default.yaml', 'win32'),
    ).toBe('C:\\repo\\evals\\default.yaml');
    expect(
      normalizeConfigFilePath('/C:/repo/evals/default.yaml', 'linux'),
    ).toBe('/C:/repo/evals/default.yaml');
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

  it('should track file-backed targets and nested target assets with a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return `
targets:
  - file://providers/target.py:call_api
  - id: https://example.com/target
    config:
      validateStatus: file://validators/status.js:isSuccess
      auth:
        type: file
        path: ./auth/get-token.ts
      tls:
        caPath: ./tls/ca.pem
defaultTest: file://defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/context.yaml';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/target.py',
      'evals/validators/status.js',
      'evals/auth/get-token.ts',
      'evals/tls/ca.pem',
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track string-form provider configs and their nested HTTP assets', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return `
providers: file://providers/provider.yaml
defaultTest: file://defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/providers/provider.yaml')) {
        return `
- id: https://example.com/target
  config:
    auth:
      type: file
      path: ./auth/get-token.ts
    tls:
      caPath: ./tls/ca.pem
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/context.yaml';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/provider.yaml',
      'evals/auth/get-token.ts',
      'evals/tls/ca.pem',
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    "''",
    'false',
  ])('should fall back to providers when targets is the falsy value %s', (targets) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return `
providers: file://providers/provider.yaml
targets: ${targets}
defaultTest: file://defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/providers/provider.yaml')) {
        return `
- id: https://example.com/target
  config:
    auth:
      type: file
      path: ./auth/get-token.ts
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'assert: []';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual([
      'evals/providers/provider.yaml',
      'evals/auth/get-token.ts',
      'evals/defaults/default.yaml',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should inspect nested file references in an object-form structured prompt', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  - file: prompts/structured.yaml
`;
      }
      if (String(filePath).endsWith('evals/prompts/structured.yaml')) {
        return `
messages:
  - role: user
    content: file://fixtures/context.txt
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/structured.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'prompts: file://prompts/structured.yaml',
    'prompts: prompts/structured.yaml',
    `prompts:\n  - raw: file://prompts/structured.yaml\n    label: structured`,
    `prompts:\n  - id: file://prompts/structured.yaml\n    label: structured`,
  ])('should inspect nested file references in supported structured prompt forms', (config) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) return config;
      if (String(filePath).endsWith('evals/prompts/structured.yaml')) {
        return `
messages:
  - role: user
    content: file://fixtures/context.txt
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/structured.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    [
      'prompts: file://prompts/json_prompt.txt',
      'evals/prompts/json_prompt.txt',
    ],
    ['prompts: prompts/yaml_prompt.txt', 'evals/prompts/yaml_prompt.txt'],
  ])('should not inspect a non-structured prompt whose name contains JSON or YAML', (config, promptPath) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) return config;
      throw new Error(`Unexpected prompt read: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([promptPath]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should inspect every JSON or YAML match in a structured prompt glob', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts: file://prompts/*.{yaml,json}';
      }
      if (String(filePath).endsWith('evals/prompts/one.yaml')) {
        return 'content: file://fixtures/one.txt';
      }
      if (String(filePath).endsWith('evals/prompts/two.json')) {
        return '{"content":"file://fixtures/two.txt"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/prompts/one.yaml',
      '/test/working/evals/prompts/two.json',
      '/test/working/evals/prompts/ignored.txt',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/one.yaml',
      'evals/prompts/two.json',
      'evals/prompts/ignored.txt',
      'evals/prompts/',
      'evals/fixtures/one.txt',
      'evals/fixtures/two.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject oversized structured dependencies before reading them', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
providers: file://providers/large.yaml
prompts:
  - file: prompts/large.yaml
defaultTest: file://defaults/large.yaml
tests:
  - vars: vars/large.yaml
  - tests/large.yaml
`;
      }
      throw new Error(`Unexpected structured read: ${String(filePath)}`);
    });
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          size: String(filePath).includes('/large.yaml') ? 3_000_000_000 : 0,
          isDirectory: () => false,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/large.yaml',
      './',
      'evals/prompts/large.yaml',
      'evals/defaults/large.yaml',
      'evals/vars/large.yaml',
      'evals/tests/large.yaml',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping oversized structured config dependency',
      ),
    );
  });

  it('should fail closed when a structured dependency size cannot be verified', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/unverifiable.yaml';
      }
      throw new Error(`Unexpected structured read: ${String(filePath)}`);
    });
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/providers/unverifiable.yaml')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return { size: 0, isDirectory: () => false } as fs.Stats;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/unverifiable.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('whose size cannot be verified'),
    );
  });

  it('should bound chains of nested structured config references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/0.yaml';
      }
      const current = Number(value.match(/\/(\d+)\.yaml$/)?.[1]);
      return `provider: file://providers/${current + 1}.yaml`;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toContain('evals/providers/0.yaml');
    expect(deps).toContain('evals/providers/256.yaml');
    expect(deps).not.toContain('evals/providers/257.yaml');
    expect(deps).toContain('./');
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(257);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many nested files'),
    );
  });

  it('should track inline top-level HTTP provider assets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.com/target
    config:
      validateStatus: file://validators/status.js:isSuccess
      auth:
        type: file
        path: ./auth/get-token.ts
      tls:
        caPath: ./tls/ca.pem
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/status.js',
      'evals/auth/get-token.ts',
      'evals/tls/ca.pem',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively track both uppercase HTTP status-validator candidates', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.com/target
    config:
      validateStatus: file://validators/status.JS:isSuccess
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/status.JS:isSuccess',
      'evals/validators/status.JS',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track HTTP ProviderOptionsMap assets in both providers and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - https://example.com/provider:
      config:
        validateStatus: file://validators/provider-status.js:isSuccess
        auth:
          type: file
          path: ./auth/provider-token.ts
        tls:
          caPath: ./tls/provider-ca.pem
targets:
  - http://example.com/target:
      config:
        validateStatus: file://validators/target-status.ts:isSuccess
        auth:
          type: file
          path: ./auth/target-token.ts
        tls:
          caPath: ./tls/target-ca.pem
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/provider-status.js',
      'evals/auth/provider-token.ts',
      'evals/tls/provider-ca.pem',
      'evals/validators/target-status.ts',
      'evals/auth/target-token.ts',
      'evals/tls/target-ca.pem',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not track HTTP-only ProviderOptionsMap assets for non-HTTP providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - openai:gpt-4.1:
      config:
        validateStatus: file://unused/status.js:isSuccess
        auth:
          type: file
          path: ./unused/token.ts
        tls:
          caPath: ./unused/ca.pem
targets:
  - openai:gpt-4.1-mini:
      config:
        validateStatus: file://unused/target-status.ts:isSuccess
        auth:
          type: file
          path: ./unused/target-token.ts
        tls:
          caPath: ./unused/target-ca.pem
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track both providers and targets when both collections are present', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py:call_api
targets:
  - file://targets/target.js:callApi
`);
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual([
      'evals/providers/provider.py',
      'evals/targets/target.js',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track executable and language provider prefixes across provider forms', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - exec:providers/string.sh
  - python:providers/string.py:call_api
  - python:file://providers/file-url.py:call_api
  - id: golang:providers/object.go:CallApi
  - 'ruby:providers/map.rb:call_api':
      config: {}
targets:
  - id: exec:targets/object.sh
  - ruby:targets/string.rb:call_api
  - id: python:targets/object.py:call_api
  - 'golang:targets/map.go:CallApi':
      config: {}
tests:
  - provider: exec:providers/test.sh
  - provider: python:providers/test.py:call_api
    options:
      provider:
        'ruby:graders/map.rb:grade':
          config: {}
  - provider: go:ignored.go:CallApi
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/string.sh',
      'evals/providers/string.py',
      'evals/providers/file-url.py',
      'evals/providers/object.go',
      'evals/providers/map.rb',
      'evals/targets/object.sh',
      'evals/targets/string.rb',
      'evals/targets/object.py',
      'evals/targets/map.go',
      'evals/providers/test.sh',
      'evals/providers/test.py',
      'evals/graders/map.rb',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track executable provider scripts and conservatively watch arguments', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'exec:providers/string.sh --mode fast'
  - id: 'exec:"providers/with space.sh" --mode fast'
  - 'exec:providers/map.sh --mode fast':
      config: {}
targets:
  - 'exec:targets/run.sh --mode fast'
tests:
  - provider: 'exec:providers/test.sh --mode fast'
    options:
      provider:
        'exec:graders/run.sh --mode fast':
          config: {}
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      './',
      'evals/providers/string.sh',
      'evals/providers/with space.sh',
      'evals/providers/map.sh',
      'evals/targets/run.sh',
      'evals/providers/test.sh',
      'evals/graders/run.sh',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch empty and unterminated executable provider commands', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'exec:'
  - 'exec:"providers/unterminated.sh'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track all file-backed HTTP transform and parser hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.com/target
    config:
      validateStatus: file://validators/status.js:isSuccess
      transformRequest: file://transforms/request.ts:request
      transformResponse: file://transforms/response.mjs:response
      responseParser: file://transforms/parser.cjs:parse
      sessionParser: file://transforms/session.mts:session
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/status.js',
      'evals/transforms/request.ts',
      'evals/transforms/response.mjs',
      'evals/transforms/parser.cjs',
      'evals/transforms/session.mts',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'http',
    'https',
  ])('should track HTTP auth, TLS, and multipart paths for shorthand id %s', (id) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: ${id}
    config:
      url: https://example.com/target
      auth:
        type: file
        path: auth/token.ts
      tls:
        caPath: tls/ca.pem
      multipart:
        parts:
          - kind: field
            name: note
            value: hello
          - kind: file
            name: generated
            source:
              type: generated
              format: pdf
              path: uploads/ignored.bin
          - kind: file
            name: attachment
            source:
              type: path
              path: file://uploads/input.bin
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/auth/token.ts',
      'evals/tls/ca.pem',
      'evals/uploads/input.bin',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track paths behind environment-computed HTTP discriminators', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: '{{ env.TARGET_ID }}'
    config:
      url: https://example.com/target
      auth:
        type: '{{ env.AUTH_TYPE }}'
        path: auth/token.ts
      tls:
        caPath: tls/ca.pem
      multipart:
        parts:
          - kind: '{{ env.PART_KIND }}'
            name: attachment
            source:
              type: '{{ env.SOURCE_TYPE }}'
              path: uploads/input.bin
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/auth/token.ts',
      'evals/tls/ca.pem',
      'evals/uploads/input.bin',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track arbitrary-extension HTTP assets in an external provider config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/http.yaml';
      }
      if (String(filePath).endsWith('evals/providers/http.yaml')) {
        return `
- id: https
  config:
    url: https://example.com/target
    signatureAuth:
      privateKeyPath: keys/signing.custom
    tls:
      caPath: tls/root.custom
    multipart:
      parts:
        - kind: file
          name: attachment
          source:
            type: path
            path: uploads/input.custom
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/http.yaml',
      'evals/keys/signing.custom',
      'evals/tls/root.custom',
      'evals/uploads/input.custom',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should inspect nested HTTP assets in every external provider-config glob match', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/*.yaml';
      }
      if (String(filePath).endsWith('evals/providers/custom.yaml')) {
        return `
- id: https
  config:
    url: https://example.com/target
    auth:
      type: file
      path: auth/token.custom
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/providers/custom.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/custom.yaml',
      'evals/providers/',
      'evals/auth/token.custom',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should widen only for a Nunjucks block that can emit a file reference', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      url: https://example.com/target
      body:
        filteredText: '{{ env.MESSAGE | default("hello") }}'
        maybeFile: '{% if env.USE_FILE %}file://fixtures/context.txt{% else %}inline{% endif %}'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not widen for ordinary filtered environment text', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      url: https://example.com/target
      body:
        message: '{{ env.MESSAGE | default("hello") }}'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track a JavaScript provider selector that contains a slash', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js:helpers/run
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/custom.js']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve Ruby and Go vars-file colon paths literally', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - file://vars/cases.rb:generate
  - file://vars/cases.go:Generate
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/vars/cases.rb:generate',
      'evals/vars/cases.go:Generate',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve an unsupported Go assertion colon path literally', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: go
        value: file://validators/check.go:Check
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/validators/check.go:Check']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve uppercase file-selector extensions as literal colon filenames', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.PY:call_api
  - file://providers/custom.JS:callApi
tests:
  - vars: file://vars/cases.RB:generate
    assert:
      - type: go
        value: file://validators/check.GO:Check
      - type: javascript
        value: file://validators/check.TS:Check
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/custom.PY:call_api',
      'evals/providers/custom.JS:callApi',
      'evals/providers/custom.JS',
      'evals/vars/cases.RB:generate',
      'evals/validators/check.GO:Check',
      'evals/validators/check.TS:Check',
      'evals/validators/check.TS',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track namespaced Ruby assertion selectors by their backing file', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: ruby
        value: file://validators/check.rb:MyModule::Nested.method
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/validators/check.rb']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve a Ruby-like assertion path whose suffix crosses a directory separator', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: ruby
        value: 'file://validators/check.rb:Module\\method'
      - type: ruby
        value: 'file://validators/empty.rb:'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/check.rb:Module\\method',
      'evals/validators/empty.rb:',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track per-test provider, option, and scoring dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider: file://providers/test.py:call_api
    assertScoringFunction: file://checks/score.js:score
    options:
      provider: file://graders/test.js:grade
      rubricPrompt: file://rubrics/test.txt
      transform: file://transforms/test.js:transform
      transformVars: file://transforms/vars.js:transformVars
`);
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual([
      'evals/checks/score.js',
      'evals/providers/test.py',
      'evals/graders/test.js',
      'evals/rubrics/test.txt',
      'evals/transforms/test.js',
      'evals/transforms/vars.js',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track a file-backed tests glob and preserve its directory watcher', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('promptfooconfig.yaml')
        ? 'tests: file://tests/*.yaml'
        : '[]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/tests/cases.yaml']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/tests/cases.yaml', 'evals/tests/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track file-backed tests mixed with inline tests and strip generator selectors', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
tests:
  - tests/cases.yaml
  - file://tests/generate.py:build
  - path: tests/cases.csv
    config:
      source: file://fixtures/generator-source.txt
  - file://tests/cases.xlsx#Sheet1
  - https://docs.google.com/spreadsheets/d/example
  - az://container/tests.csv
  - huggingface://datasets/example/tests
  - vars:
      context: file://fixtures/context.txt
`;
      }
      if (String(filePath).endsWith('evals/tests/cases.yaml')) {
        return `
- vars: variables.yaml
  provider: python:providers/custom.py:call_api
  assert:
    - type: javascript
      value: file://checks/check.js:grade
`;
      }
      if (String(filePath).endsWith('evals/tests/variables.yaml')) {
        return 'context: file://fixtures/nested.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tests/cases.yaml',
      'evals/tests/variables.yaml',
      'evals/tests/fixtures/nested.txt',
      'evals/tests/checks/check.js',
      'evals/tests/providers/custom.py',
      'evals/tests/generate.py',
      'evals/tests/cases.csv',
      'evals/fixtures/generator-source.txt',
      'evals/tests/cases.xlsx',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should strip spreadsheet sheet selectors in a nested file-backed tests document', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'tests: tests/nested.yaml';
      }
      if (String(filePath).endsWith('evals/tests/nested.yaml')) {
        return `
- file://sheets/cases.xls#Legacy
- file://sheets/cases.xlsx#Current
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tests/nested.yaml',
      'evals/tests/sheets/cases.xls',
      'evals/tests/sheets/cases.xlsx',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track top-level test-generator objects and scenario test dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/generate.py:build
  config:
    seed: file://fixtures/seed.txt
scenarios:
  - tests: file://scenarios/cases.csv
    config:
      - vars: scenarios/vars.yaml
        provider: golang:scenarios/provider.go:CallApi
        assert:
          - type: ruby
            value: file://scenarios/check.rb:score
  - {}
nunjucksFilters:
  allcaps: filters/allcaps.js
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tests/generate.py',
      'evals/fixtures/seed.txt',
      'evals/scenarios/cases.csv',
      'evals/scenarios/vars.yaml',
      'evals/scenarios/check.rb',
      'evals/scenarios/provider.go',
      'evals/filters/allcaps.js',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track templated prompts and rebased external test/scenario providers and vars', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
prompts: 'file://{{ env.PROMPT_DIR }}/main.txt'
sharedProvider: &shared
  python:providers/shared.py:call_api:
    config:
      response_format: file://schemas/shared.json
tests:
  - vars: *shared
    provider: *shared
  - tests/cases.yaml
scenarios:
  - tests: file://scenarios/cases.yaml
  - tests: file://tests/cases.yaml
  - tests:
      - scenarios/array-cases.yaml
  - file://scenarios/scenario.yaml
  - file://scenarios/invalid-scenarios.yaml
`;
      }
      if (String(filePath).endsWith('evals/tests/cases.yaml')) {
        return `
- vars: file://fixture.yaml
  provider: exec:providers/run.py:call_api
- vars:
    - vars-a.yaml
    - file://vars-b.yaml
  provider:
    file://providers/map.py:call_api:
      config:
        tools: file://schemas/tools.yaml
`;
      }
      if (String(filePath).endsWith('evals/scenarios/cases.yaml')) {
        return `
- vars: fixture.yaml
  provider: golang:providers/scenario.go:CallApi
`;
      }
      if (String(filePath).endsWith('evals/scenarios/array-cases.yaml')) {
        return `
- vars: array-fixture.yaml
  provider: golang:providers/array-case.go:CallApi
`;
      }
      if (String(filePath).endsWith('evals/scenarios/scenario.yaml')) {
        return `
config:
  - vars: scenario-config-fixture.yaml
    provider: ruby:providers/scenario-config.rb:call_api
tests:
  - scenarios/entry-cases.yaml
`;
      }
      if (String(filePath).endsWith('evals/scenarios/entry-cases.yaml')) {
        return `
- vars: entry-fixture.yaml
  provider: golang:providers/entry-case.go:CallApi
`;
      }
      if (String(filePath).endsWith('evals/scenarios/invalid-scenarios.yaml')) {
        return '[null, 42]';
      }
      if (
        /\/(?:(?:array|entry|scenario-config)-)?(?:fixture|vars-[ab])\.yaml$/.test(
          String(filePath),
        )
      ) {
        return '{}';
      }
      if (/\/(?:shared\.json|tools\.yaml)$/.test(String(filePath))) return '{}';
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      './',
      'evals/schemas/shared.json',
      'evals/providers/shared.py',
      'evals/tests/cases.yaml',
      'evals/tests/fixture.yaml',
      'evals/tests/providers/run.py',
      'evals/tests/vars-a.yaml',
      'evals/tests/vars-b.yaml',
      'evals/tests/providers/map.py',
      'evals/tests/schemas/tools.yaml',
      'evals/scenarios/cases.yaml',
      'evals/fixture.yaml',
      'evals/providers/scenario.go',
      'evals/providers/run.py',
      'evals/vars-a.yaml',
      'evals/vars-b.yaml',
      'evals/providers/map.py',
      'evals/schemas/tools.yaml',
      'evals/scenarios/array-cases.yaml',
      'evals/scenarios/array-fixture.yaml',
      'evals/scenarios/providers/array-case.go',
      'evals/scenarios/scenario.yaml',
      'evals/scenarios/entry-cases.yaml',
      'evals/scenarios/entry-fixture.yaml',
      'evals/scenarios/providers/entry-case.go',
      'evals/scenario-config-fixture.yaml',
      'evals/providers/scenario-config.rb',
      'evals/scenarios/invalid-scenarios.yaml',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track plain prompt paths and globs while ignoring inline and remote prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/base.txt
  - prompts/*.j2
  - exec:prompts/build.py:render
  - exec:prompts/build.sh
  - 'An inline prompt'
  - 'What is 2+2?'
  - portkey://prompts/example
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/prompts/extra.j2']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/base.txt',
      'evals/prompts/extra.j2',
      'evals/prompts/',
      'evals/prompts/build.py',
      'evals/prompts/build.sh',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track executable prompt scripts and conservatively watch arguments', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - exec:prompts/build.sh --mode fast
  - 'exec:"prompts/with space.py" --mode fast'
  - exec:file://prompts/file-url.py:render
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      './',
      'evals/prompts/build.sh',
      'evals/prompts/with space.py',
      'evals/prompts/file-url.py',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'prompts: prompts/*.j2',
    'prompts: { prompts/*.j2: custom-label }',
    `prompts:\n  - raw: prompts/*.j2`,
    `prompts:\n  - id: file://prompts/*.j2\n    label: main`,
  ])('should track scalar, legacy-map, and raw-object prompt globs', (config) => {
    mockFs.readFileSync.mockReturnValue(config);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/prompts/extra.j2']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/prompts/extra.j2', 'evals/prompts/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should visit a deep shared assert-set alias DAG only once per node', () => {
    const layers = Array.from({ length: 18 }, (_, index) =>
      index === 0
        ? `  layer0: &layer0\n    - type: javascript\n      value: file://checks/base.js:grade`
        : `  layer${index}: &layer${index}\n    - type: assert-set\n      assert: *layer${index - 1}\n    - type: assert-set\n      assert: *layer${index - 1}`,
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
anchors:
${layers}
tests:
  - assert: *layer17
`);

    const started = Date.now();
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/checks/base.js']);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should visit large shared vars and options alias maps only once', () => {
    const size = 300;
    const vars = Array.from(
      { length: size },
      (_, index) => `  var${index}: file://fixtures/vars-${index}.txt`,
    ).join('\n');
    const options = Array.from(
      { length: size },
      (_, index) => `  option${index}: file://fixtures/options-${index}.txt`,
    ).join('\n');
    const tests = Array.from(
      { length: size },
      () => '  - vars: *vars\n    options: *options',
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
sharedVars: &vars
${vars}
sharedOptions: &options
${options}
tests:
${tests}
`);

    const started = Date.now();
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toHaveLength(size * 2);
    expect(deps).toContain('evals/fixtures/vars-299.txt');
    expect(deps).toContain('evals/fixtures/options-299.txt');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should visit a repeated external-vars alias list only once', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('promptfooconfig.yaml')
        ? `
sharedVars: &vars
  - vars/cases.csv
tests:
  - vars: *vars
  - vars: *vars
`
        : '',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/vars/cases.csv']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should bound adversarial chains of nested file-backed tests', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('promptfooconfig.yaml')) return 'tests: tests/0.yaml';
      const current = Number(value.match(/\/(\d+)\.yaml$/)?.[1]);
      return `tests: ${current + 1}.yaml`;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toContain('./');
    expect(deps).toContain('evals/tests/0.yaml');
    expect(deps).toContain('evals/tests/256.yaml');
    expect(deps).not.toContain('evals/tests/257.yaml');
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(257);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many nested files'),
    );
  });

  it('should fail closed for invalid, oversized, and templated file-backed test paths', () => {
    const oversized = `tests/${'x'.repeat(65_537)}.yaml`;
    mockFs.readFileSync.mockReturnValue(`
tests:
  - "file://tests/bad\\0.yaml"
  - '${oversized}'
  - 'file://{{ env.TEST_FILE }}'
  - null
  - true
  - path: tests/generate.py:build
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./', 'evals/tests/generate.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('maximum glob pattern length'),
    );
  });

  it('should reject unverifiable and external file-backed test symlinks without reading them', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
tests:
  - tests/unverifiable.yaml
  - tests/external.yaml
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('/tests/unverifiable.yaml')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return value.endsWith('/tests/external.yaml')
        ? '/test/secrets/external.yaml'
        : value;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tests/unverifiable.yaml',
      './',
      'evals/tests/external.yaml',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed tests'),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unsafe file-backed tests'),
    );
  });

  it('should bound a cyclic test import and warn for an invalid nested test document', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('promptfooconfig.yaml')) {
        return `
tests:
  - tests/cycle.yaml
  - tests/invalid.yaml
`;
      }
      if (value.endsWith('/tests/cycle.yaml')) return 'tests: cycle.yaml';
      if (value.endsWith('/tests/invalid.yaml')) return 'tests: [unterminated';
      throw new Error(`Unexpected file: ${value}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tests/cycle.yaml',
      'evals/tests/invalid.yaml',
      './',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(3);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed tests'),
    );
  });

  it('should fail closed when a file-backed test document cannot be read', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'tests: tests/unreadable.yaml';
      }
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/tests/unreadable.yaml', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed tests'),
    );
  });

  it('should process adversarial template openers and Ruby-like suffixes without backtracking', () => {
    const templateOpeners = '{{'.repeat(12_000);
    const rubyLikePath = `${'.rb:'.repeat(8_000)}/tail`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://${templateOpeners}'
tests:
  - assert:
      - type: ruby
        value: 'file://${rubyLikePath}'
`);

    const started = Date.now();
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(core.warning).not.toHaveBeenCalled();
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

  it('should extract a file-backed defaultTest', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest: file://default.yaml
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/default.yaml']);
  });

  it('should extract nested dependencies from a file-backed YAML defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('defaults/default.yaml')) {
        return `
vars:
  context: file://../fixtures/context.txt
assert:
  - type: javascript
    value: file://validators/check.js
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'fixtures/context.txt',
      'evals/validators/check.js',
    ]);
  });

  it('should extract nested object-form dependencies from a file-backed JSON defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.json';
      }
      if (String(filePath).endsWith('defaults/default.json')) {
        return JSON.stringify({
          vars: { context: { file: '../fixtures/context.json' } },
          assert: [
            { type: 'javascript', value: { file: 'validators/check.js' } },
          ],
        });
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.json',
      'fixtures/context.json',
      'evals/validators/check.js',
    ]);
  });

  it('should keep other dependencies when a file-backed defaultTest cannot be loaded', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `
providers:
  - file://providers/custom.py
defaultTest: file://defaults/default.yaml
`;
      }
      throw new Error('Permission denied');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/custom.py',
      'evals/defaults/default.yaml',
      './',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed defaultTest'),
    );
  });

  it('should report a non-Error file-backed defaultTest read failure', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      throw 'Permission denied';
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed defaultTest'),
    );
  });

  it('should not read or leak a file-backed defaultTest symlink outside the workspace', () => {
    const canary = 'EXTERNAL_DEFAULT_TEST_SECRET_CANARY';
    const linkedDefaultTest =
      '/test/working/evals/defaults/external-default.yaml';
    const externalDefaultTest = '/test/secrets/external-default.yaml';

    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath) === linkedDefaultTest
        ? externalDefaultTest
        : String(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/external-default.yaml';
      }
      if (String(filePath) === linkedDefaultTest) {
        return `vars: [invalid\nsecret: ${canary}`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/external-default.yaml']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      linkedDefaultTest,
      'utf8',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      externalDefaultTest,
      'utf8',
    );
    expect(vi.mocked(core.warning).mock.calls.flat().join(' ')).not.toContain(
      canary,
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should not leak malformed file-backed defaultTest contents in warnings', () => {
    const canary = 'DEFAULT_TEST_PARSE_SECRET_CANARY';

    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `vars: [invalid\nsecret: ${canary}`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(vi.mocked(core.warning).mock.calls.flat().join(' ')).not.toContain(
      canary,
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect file-backed defaultTest'),
    );
  });

  it('should keep file-backed defaultTest glob dependencies inside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(
      'defaultTest: file://{../../secrets,defaults}/*.yaml',
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('{') || value.includes('}'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/secrets/external-default.yaml',
      '/test/working/evals/defaults/default.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      './',
      'evals/defaults/default.yaml',
      'evals/defaults/',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should not inspect a brace or Windows-style file-backed defaultTest glob as a file', () => {
    mockFs.readFileSync.mockReturnValue(
      "defaultTest: 'file://defaults\\{one,two}.yaml'",
    );
    mockGlob.hasMagic.mockImplementation(
      (
        value: string,
        options?: { magicalBraces?: boolean; windowsPathsNoEscape?: boolean },
      ) =>
        value.includes('{') &&
        options?.magicalBraces === true &&
        options?.windowsPathsNoEscape === true,
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/defaults/one.yaml',
      '/test/working/evals/defaults/two.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/one.yaml',
      'evals/defaults/two.yaml',
      'evals/defaults/',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should retain safe sibling brace alternatives before glob enumeration', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: "file://{../shared,tests}/*.yaml" }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/shared/shared.yaml',
      '/test/working/evals/tests/test.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/shared/*.yaml',
      '/test/working/evals/tests/*.yaml',
    ]);
    expect(deps).toEqual(
      expect.arrayContaining([
        'evals/defaults/default.yaml',
        'shared/shared.yaml',
        'evals/tests/test.yaml',
      ]),
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    '{foo),../providers}/*.py',
    '{foo),/absolute}/*.py',
    '+(foo],../providers)/*.py',
    '{foo,providers/*.py',
  ])('should reject mismatched or unclosed glob delimiters before enumeration: %s', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`providers: ['file://${pattern}']`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('mismatched or unclosed delimiters'),
    );
  });

  it('should accept balanced character classes and literal unmatched closers in glob patterns', () => {
    mockFs.readFileSync.mockReturnValue(
      "providers: ['file://providers/[ab]*.py', 'file://providers/[!)]*.py', 'file://providers/[!}]*.py', 'file://providers/foo)*.py']",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(4);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'C:\\outside\\provider.py',
    'C:outside\\provider.py',
    '\\\\server\\share\\provider.py',
    '\\outside\\provider.py',
  ])('should reject foreign Windows dependency paths on POSIX: %s', (input) => {
    mockFs.readFileSync.mockReturnValue(`providers: ['file://${input}']`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should warn only once for many foreign Windows dependency paths', () => {
    const providers = Array.from(
      { length: 512 },
      (_, index) => `'file://C:\\outside\\provider-${index}.py'`,
    ).join(', ');
    mockFs.readFileSync.mockReturnValue(`providers: [${providers}]`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should reject foreign Windows brace arms before glob enumeration while retaining safe arms', () => {
    mockFs.readFileSync.mockReturnValue(
      "providers: ['file://{safe,C:\\outside}/*.py']",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/safe/provider.py']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/safe/*.py',
    ]);
    expect(deps).toEqual(['./', 'evals/safe/provider.py', 'evals/safe/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should reject escaping brace alternatives before glob enumeration', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: "file://{../../../../secrets,tests}/*.yaml" }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/tests/test.yaml']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/tests/*.yaml',
    ]);
    expect(deps).toEqual(
      expect.arrayContaining([
        'evals/defaults/default.yaml',
        'evals/tests/test.yaml',
        './',
      ]),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should bound brace expansion before glob enumeration', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: "file://tests/test_{1..1025}.yaml" }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
  });

  it.each([
    'providers/{1..1000000000}.py',
    'providers/{-1000000000..1}.py',
    'providers/{1..1000000000..2}.py',
    'providers/{1..1024}{1..2}.py',
    'providers\\{1..1000000000}.py',
    'providers/[{1..1000000000}].py',
    `providers/{${'0'.repeat(32_000)}1..${'0'.repeat(32_000)}1024}.py`,
  ])('should reject an excessive numeric dependency brace range before magic detection: %s', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`providers: ['file://${pattern}']`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('unsafe numeric glob magic detection was reached');
    });
    vi.mocked(minimatch.braceExpand).mockImplementationOnce(() => {
      throw new Error('unsafe numeric brace expansion was reached');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(minimatch.braceExpand).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
    vi.mocked(minimatch.braceExpand).mockReset();
  });

  it('should validate malformed, stepped, and padded numeric brace ranges linearly', () => {
    expect(hasSafeNumericBraceRanges('providers/{1..x}.py', 1024)).toBe(true);
    expect(hasSafeNumericBraceRanges('providers/{1..2..x}.py', 1024)).toBe(
      true,
    );
    expect(hasSafeNumericBraceRanges('providers/{1..2foo}.py', 1024)).toBe(
      true,
    );
    expect(hasSafeNumericBraceRanges('providers/{1..5..2}.py', 1024)).toBe(
      true,
    );
    expect(hasSafeNumericBraceRanges('providers/{1..5..0}.py', 1024)).toBe(
      false,
    );
    expect(
      hasSafeNumericBraceRanges(
        'providers/{1..2..999999999999999999999}.py',
        1024,
      ),
    ).toBe(false);
    expect(
      hasSafeNumericBraceRanges('providers/{{1..32},{33..64}}{1..16}.py', 1024),
    ).toBe(true);
    const alternatives = Array.from({ length: 513 }, (_, index) => index).join(
      ',',
    );
    expect(
      hasSafeNumericBraceRanges(`providers/{1..2}{${alternatives}}.py`, 1024),
    ).toBe(false);
    expect(
      hasSafeNumericBraceRanges(`providers/\${1..1000000000}.py`, 1024),
    ).toBe(true);
    expect(
      hasSafeNumericBraceRanges(
        `providers/\${nested{1..1000000000}}{1..8}.py`,
        1024,
      ),
    ).toBe(true);
    expect(
      hasSafeNumericBraceRanges(
        `providers/{${'0'.repeat(32_000)}1..${'0'.repeat(32_000)}1024}.py`,
        1024,
      ),
    ).toBe(false);
  });

  it.each([
    `providers/\${1..1000000000}.py`,
    `providers/\${nested{1..1000000000}}.py`,
  ])('should preserve literal dollar-brace dependency filenames: %s', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`providers: ['file://${pattern}']`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([`evals/${pattern}`]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should allow mutually exclusive numeric dependency-brace arms at the expansion limit', () => {
    const pattern = 'providers/{{1..32},{33..64}}{1..16}.py';
    mockFs.readFileSync.mockReturnValue(`providers: ['file://${pattern}']`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(minimatch.braceExpand).toHaveBeenCalledWith(
      pattern,
      expect.objectContaining({ braceExpandMax: 1025 }),
    );
    expect(mockGlob.sync).toHaveBeenCalled();
    expect(deps).toEqual(['evals/providers/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject too many comma dependency-brace alternatives after bounded expansion', () => {
    const alternatives = Array.from({ length: 1026 }, (_, index) => index).join(
      ',',
    );
    mockFs.readFileSync.mockReturnValue(
      `providers: ['file://providers/{${alternatives}}.py']`,
    );
    mockGlob.hasMagic.mockReturnValue(true);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
  });

  it('should reject too many alphabetic dependency-brace alternatives after bounded expansion', () => {
    mockFs.readFileSync.mockReturnValue(
      "providers: ['file://providers/{a..z}{A..Z}{a..z}.py']",
    );
    mockGlob.hasMagic.mockReturnValue(true);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
  });

  it('should reject a NUL structured-prompt glob before magic detection', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "file://prompts/unsafe\\0{one,two}.txt"',
    );
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('unsafe NUL glob magic detection was reached');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(minimatch.braceExpand).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('mismatched or unclosed delimiters'),
    );
  });

  it('should skip glob enumeration when the workspace root cannot be resolved', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://providers/*.py]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    let rootReads = 0;
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('evals/promptfooconfig.yaml')) return value;
      if (value === '/test/working' && rootReads++ === 0) return value;
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('workspace root cannot be resolved'),
    );
  });

  it('should validate real paths and missing ancestors before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: ["file://{linked,denied,missing}/*.py"]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value === '/test/working') return value;
      if (value.includes('/linked/')) return '/test/secrets';
      if (value.includes('/denied/')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      if (value.includes('/missing/')) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      if (value.endsWith('/missing')) {
        throw Object.assign(new Error('not a directory'), {
          code: 'ENOTDIR',
        });
      }
      return value;
    });
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/missing/*.py',
    ]);
    expect(deps).toEqual(['./', 'evals/missing/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should stop validating a missing glob ancestor at the filesystem root', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://missing/*.py]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    let rootReads = 0;
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('evals/promptfooconfig.yaml')) return value;
      if (value === '/test/working' && rootReads++ < 2) {
        return '/test/working';
      }
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should preserve a workspace-root glob when its base resolves to cwd', () => {
    mockFs.readFileSync.mockReturnValue('providers: ["file://../*.py"]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['*.py']);
  });

  it('should reject nested defaultTest dependencies outside the repository', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('defaults/default.yaml')) {
        return `
vars:
  context: file://../../secrets/context.txt
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should resolve file-backed defaultTest dependencies from the main config directory', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  context: file://context.txt
assert:
  - type: javascript
    value: file://check.js
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/context.txt',
      'evals/check.js',
    ]);
  });

  it('should resolve an absolute file-backed defaultTest inside the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file:///test/working/evals/defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: file://context.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/context.txt']);
  });

  it('should conservatively watch the repository for a templated defaultTest path', () => {
    mockFs.readFileSync.mockReturnValue(
      'defaultTest: file://{{ env.DEFAULT_TEST_PATH }}',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('should conservatively watch the repository for a Nunjucks block in a defaultTest path', () => {
    mockFs.readFileSync.mockReturnValue(
      "defaultTest: 'file://{% if env.USE_DEFAULT %}defaults/default.yaml{% else %}other/default.yaml{% endif %}'",
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('should conservatively watch the repository for templated nested provider, assert, and vars paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - '{# external vars #}../../secrets/vars.yaml'
assert:
  - type: javascript
    value: 'file://{{ env.ASSERT_PATH }}:score'
    provider:
      id: 'file://{% if env.USE_GRADER %}graders/local.py{% else %}../../secrets/grader.py{% endif %}:call_api'
options:
  provider:
    'file://{{ env.MAP_GRADER }}:call_api':
      config:
        response_format: 'file://{# schema #}schemas/format.yaml'
        tools: 'file://{% if env.USE_TOOLS %}tools/local.py{% else %}../../secrets/tools.py{% endif %}:get_tools'
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the repository for templated references inside an external vars map', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/vars.yaml';
      }
      if (String(filePath).endsWith('evals/data/vars.yaml')) {
        return `
context: 'file://{# context #}fixtures/context.txt'
documents:
  - 'file://{{ env.DOCUMENT_PATH }}'
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/vars.yaml',
      './',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(3);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the repository for templated object-form references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  context:
    file: '{{ env.CTX_FILE }}'
assert:
  - type: javascript
    value:
      file: '{{ env.CHECK_FILE }}'
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track the backing file for a named defaultTest assertion export', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: javascript
    value: file://check-named.js:named
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/check-named.js',
    ]);
  });

  it('should track the backing file for a dotted defaultTest assertion export', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: javascript
    value: file://check-dot.js:named.with.dot
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/check-dot.js']);
  });

  it('should track nested assert-set dependencies in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: assert-set
    assert:
      - type: javascript
        value: file://nested-check.js:named
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/nested-check.js',
    ]);
  });

  it('should track a file-backed defaultTest assertion scoring function', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'assertScoringFunction: file://native-score.js';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-score.js',
    ]);
  });

  it('should track a file-backed defaultTest options transform', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'options: { transform: file://native-transform.js }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-transform.js',
    ]);
  });

  it('should track array assertion values in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: contains-any
    value:
      - file://native-assert-value.txt
      - fallback
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-assert-value.txt',
    ]);
  });

  it('should track string-form vars in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: file://native-vars.yaml';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-vars.yaml',
      './',
    ]);
  });

  it('should track bare and array-form vars paths in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - native-vars-a.yaml
  - file://native-vars-b.yaml
  - null
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-vars-a.yaml',
      './',
      'evals/native-vars-b.yaml',
    ]);
  });

  it('should track a bare scalar vars path in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: native-vars.yaml';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-vars.yaml',
      './',
    ]);
  });

  it('should preserve a scalar Python vars-file colon path without inspecting it as YAML', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: file://generators/vars.py:generate_tests';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/generators/vars.py:generate_tests',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve array-form JS and Python vars-file colon paths without inspecting them', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - file:///test/working/evals/generators/vars.cjs:generateTests
  - generators/more-vars.py:generate_tests
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/generators/vars.cjs:generateTests',
      'evals/generators/more-vars.py:generate_tests',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track a scalar XLSX vars file without its sheet selector or YAML inspection', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return "vars: 'file://data/vars.xlsx#Regression Cases'";
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/vars.xlsx',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track array-form XLS and XLSX vars files without sheet selectors or YAML inspection', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - file://data/legacy-vars.xls#2
  - data/current-vars.xlsx#Sheet1
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/legacy-vars.xls',
      'evals/data/current-vars.xlsx',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should keep a vars directory watcher without inspecting the directory as YAML', () => {
    const varsDirectory = '/test/working/evals/data/vars';
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => String(filePath) === varsDirectory,
        }) as fs.Stats,
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: file://data/vars/';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/data/vars/']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    '/',
    '\\',
  ])('should preserve an explicit missing vars directory watcher ending in %s', (separator) => {
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/defaults/default.yaml')) {
        return { size: 0, isDirectory: () => false } as fs.Stats;
      }
      const error = new Error('missing directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `vars: 'file://data${separator}'`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/data/']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should allow an external config to reference absolute checkout dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/external/promptfooconfig.yaml')) {
        return `
providers: file:///test/working/evals/providers/provider.py:call_api
defaultTest: file:///test/working/evals/defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: /test/working/evals/data/context.yaml';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file:///test/working/evals/fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    const deps = extractFileDependencies('/test/external/promptfooconfig.yaml');
    expect(deps).toEqual([
      'evals/providers/provider.py',
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should allow external-config globs and matches inside the checkout', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/external/promptfooconfig.yaml')) {
        return 'defaultTest: file:///test/working/evals/defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: /test/working/evals/data/*.yaml';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file:///test/working/evals/fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/data/context.yaml']);
    const deps = extractFileDependencies('/test/external/promptfooconfig.yaml');
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/data/',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should retain checkout dependencies when an unused external-config root cannot be resolved', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/external/promptfooconfig.yaml')) {
        return 'defaultTest: file:///test/working/evals/defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: /test/working/evals/data/*.yaml';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file:///test/working/evals/fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/data/context.yaml']);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath) === '/test/external') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });
    const deps = extractFileDependencies('/test/external/promptfooconfig.yaml');
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/data/',
      'evals/fixtures/context.txt',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should retain glob matches beneath independently symlinked dependency roots', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: [file:///test/working/evals/providers/*.py]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/providers/provider.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value === '/test/external') return '/mnt/configs';
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/mnt/checkout');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/external/promptfooconfig.yaml');

    expect(deps).toEqual(['evals/providers/provider.py', 'evals/providers/']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject a config directory symlinked outside the checkout before reading it', () => {
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.startsWith('/test/working/evals-link')) {
        return value.replace(
          '/test/working/evals-link',
          '/test/external/evals',
        );
      }
      return value;
    });

    const deps = extractFileDependencies(
      '/test/working/evals-link/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config file that resolves outside the repository workspace',
    );
  });

  it('should reject an unverifiable in-workspace config path before reading it', () => {
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('evals/promptfooconfig.yaml')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return value;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config file whose path cannot be verified safely',
    );
  });

  it('should reject dangling or unverifiable glob ancestors while preserving truly missing paths', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: ["file://{dangling,denied,missing}/*.py"]',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (/\/(?:dangling|denied|missing)(?:\/|$)/.test(value)) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return value;
    });
    mockFs.lstatSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('/dangling')) return {} as fs.Stats;
      if (value.endsWith('/denied')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/missing/*.py',
    ]);
    expect(deps).toEqual(['./', 'evals/missing/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository workspace',
      ),
    );
  });

  it('should reject external-config glob matches that traverse a symlink outside both roots', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/external/promptfooconfig.yaml')) {
        return 'defaultTest: file:///test/working/evals/defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: /test/working/evals/data/*/*.yaml';
      }
      if (String(filePath).endsWith('evals/data/safe/context.yaml')) {
        return 'context: file:///test/working/evals/fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/data/leak/secret.yaml',
      '/test/working/evals/data/safe/context.yaml',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('evals/data/leak/secret.yaml')
        ? '/test/secrets/secret.yaml'
        : String(filePath),
    );
    const deps = extractFileDependencies('/test/external/promptfooconfig.yaml');
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/safe/context.yaml',
      'evals/data/',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('glob match must stay within the repository'),
    );
  });

  it('should ignore glob matches whose real path cannot be verified', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://providers/*.py]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/providers/denied.py']);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/providers/denied.py')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual(['evals/providers/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path cannot be verified'),
    );
  });

  it('should track provider, options, and assertion file fields in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider: file://native-provider.js
options:
  provider:
    id: file://native-grader.js
  rubricPrompt: file://native-rubric.txt
  postprocess: file://native-postprocess.js
  transformVars: file://native-transform-vars.js
assert:
  - type: javascript
    provider: file://native-assert-provider.js
    rubricPrompt: file://native-assert-rubric.txt
    transform: file://native-assert-transform.js
    contextTransform: file://native-context-transform.js
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-assert-provider.js',
      'evals/native-assert-rubric.txt',
      'evals/native-assert-transform.js',
      'evals/native-context-transform.js',
      'evals/native-provider.js',
      'evals/native-grader.js',
      'evals/native-rubric.txt',
      'evals/native-postprocess.js',
      'evals/native-transform-vars.js',
    ]);
  });

  it('should track provider-specific options and grader type maps in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    text:
      id: file://native-text-grader.py:call_api
      config:
        response_format: file://native-schema.json
        tools: file://native-tools.json
    embedding:
      id: file://native-embedding-grader.js
    classification:
      id: file://native-classification-grader.rb:call_api
    moderation:
      id: file://native-moderation-grader.js
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-text-grader.py',
      'evals/native-schema.json',
      './',
      'evals/native-tools.json',
      'evals/native-embedding-grader.js',
      'evals/native-classification-grader.rb',
      'evals/native-moderation-grader.js',
    ]);
  });

  it('should inspect chained provider configs and nested response-format references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'options: { provider: { text: file://providers/first.yaml } }';
      }
      if (String(filePath).endsWith('evals/providers/first.yaml')) {
        return 'id: openai:responses:gpt-5.4\nconfig: file://providers/second.json';
      }
      if (String(filePath).endsWith('evals/providers/second.json')) {
        return `
response_format: file://schemas/format.yaml
tools: file://tools/native-tools.py:get_tools
`;
      }
      if (String(filePath).endsWith('evals/schemas/format.yaml')) {
        return 'type: json_schema\nschema: file://schemas/native-schema.json';
      }
      if (String(filePath).endsWith('evals/schemas/native-schema.json')) {
        return '{"type":"object"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/first.yaml',
      'evals/providers/second.json',
      'evals/schemas/format.yaml',
      'evals/schemas/native-schema.json',
      'evals/tools/native-tools.py',
    ]);
  });

  it('should track a file-backed ProviderOptionsMap key and its nested config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    file://graders/text-grader.go:call_api:
      config:
        response_format: file://schemas/map-schema.json
        tools: file://tools/map-tools.json
`;
      }
      if (String(filePath).endsWith('evals/schemas/map-schema.json')) {
        return '{"type":"object"}';
      }
      if (String(filePath).endsWith('evals/tools/map-tools.json')) {
        return '[]';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/graders/text-grader.go',
      'evals/schemas/map-schema.json',
      'evals/tools/map-tools.json',
    ]);
  });

  it('should inspect an object-form YAML grader id and its nested config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'options: { provider: { text: { id: file://graders/grader.yaml } } }';
      }
      if (String(filePath).endsWith('evals/graders/grader.yaml')) {
        return `
id: openai:responses:gpt-5.4
config:
  response_format: file://schemas/grader-schema.json
  tools: file://tools/grader-tools.py:get_tools
`;
      }
      if (String(filePath).endsWith('evals/schemas/grader-schema.json')) {
        return '{"type":"object"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/graders/grader.yaml',
      'evals/schemas/grader-schema.json',
      'evals/tools/grader-tools.py',
    ]);
  });

  it('should inspect a YAML ProviderOptionsMap key and its nested config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'options: { provider: { file://graders/map-grader.yaml: {} } }';
      }
      if (String(filePath).endsWith('evals/graders/map-grader.yaml')) {
        return `
id: openai:responses:gpt-5.4
config:
  response_format: file://schemas/map-grader-schema.json
  tools: file://tools/map-grader-tools.js:get_tools
`;
      }
      if (String(filePath).endsWith('evals/schemas/map-grader-schema.json')) {
        return '{"type":"object"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/graders/map-grader.yaml',
      'evals/schemas/map-grader-schema.json',
      'evals/tools/map-grader-tools.js',
    ]);
  });

  it('should preserve nested dependencies across safe legacy YAML tags', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return `
metadata:
  created: !!timestamp 2026-07-15T12:00:00Z
  payload: !!binary SGVsbG8=
defaultTest: file://defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
metadata:
  labels: !!set { smoke: null }
  ordered: !!omap [ { first: one } ]
  pairs: !!pairs [ { key: value } ]
vars: data/legacy-vars.yaml
options:
  provider:
    text: file://graders/legacy-grader.yaml
`;
      }
      if (String(filePath).endsWith('evals/data/legacy-vars.yaml')) {
        return `
created: !!timestamp 2026-07-15
context: file://fixtures/legacy-context.txt
`;
      }
      if (String(filePath).endsWith('evals/graders/legacy-grader.yaml')) {
        return `
id: openai:responses:gpt-5.4
config:
  labels: !!set { grading: null }
  response_format: file://schemas/legacy-format.yaml
  tools: file://tools/legacy-tools.py:get_tools
`;
      }
      if (String(filePath).endsWith('evals/schemas/legacy-format.yaml')) {
        return `
type: json_schema
schema: file://schemas/legacy-schema.json
metadata: !!pairs [ { version: one } ]
`;
      }
      if (String(filePath).endsWith('evals/schemas/legacy-schema.json')) {
        return '{"type":"object"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/legacy-vars.yaml',
      'evals/fixtures/legacy-context.txt',
      'evals/graders/legacy-grader.yaml',
      'evals/schemas/legacy-format.yaml',
      'evals/schemas/legacy-schema.json',
      'evals/tools/legacy-tools.py',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should treat an inline binary var value as atomic and retain later dependencies', () => {
    const entriesSpy = vi.spyOn(Object, 'entries');
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars:
    payload: !!binary SGVsbG8=
    context: file://fixtures/context.txt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/fixtures/context.txt']);
    expect(
      entriesSpy.mock.calls.some(([value]) => ArrayBuffer.isView(value)),
    ).toBe(false);
    entriesSpy.mockRestore();
  });

  it('should treat a top-level binary vars value as atomic and retain later dependencies', () => {
    const valuesSpy = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars: !!binary SGVsbG8=
  assert:
    - type: javascript
      value: file://checks/later.js:score
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/checks/later.js']);
    expect(
      valuesSpy.mock.calls.some(([value]) => ArrayBuffer.isView(value)),
    ).toBe(false);
    valuesSpy.mockRestore();
  });

  it('should track files nested in a defaultTest provider config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  id: openai:responses:gpt-5.4
  config:
    response_format:
      type: json_schema
      json_schema:
        schema: file://schemas/direct-schema.json
    tools:
      - file://tools/direct-tools.json
      - file://tools/direct-tools.js:get_tools
`;
      }
      if (String(filePath).endsWith('evals/schemas/direct-schema.json')) {
        return '{"type":"object"}';
      }
      if (String(filePath).endsWith('evals/tools/direct-tools.json')) {
        return '[]';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/schemas/direct-schema.json',
      'evals/tools/direct-tools.json',
      'evals/tools/direct-tools.js',
    ]);
  });

  it('should inspect provider configs nested in defaultTest assert sets', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: assert-set
    assert:
      - type: llm-rubric
        provider:
          id: openai:responses:gpt-5.4
          config: file://providers/assert-config.json
`;
      }
      if (String(filePath).endsWith('evals/providers/assert-config.json')) {
        return '{"tools":"file://tools/assert-tools.py:get_tools"}';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/assert-config.json',
      'evals/tools/assert-tools.py',
    ]);
  });

  it('should track contained HTTP file-auth paths in nested provider configs', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    text:
      id: https://example.com/grade
      config:
        auth:
          type: file
          path: ./auth/get-token.ts
    embedding:
      id: https://example.com/embed
      config:
        auth:
          type: file
          path: file://auth/get-embedding-token.py:get_auth
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/auth/get-token.ts',
      'evals/auth/get-embedding-token.py',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track HTTP file-auth paths in external provider config maps', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    text:
      id: https://example.com/grade
      config: file://providers/http-config.yaml
`;
      }
      if (String(filePath).endsWith('evals/providers/http-config.yaml')) {
        return `
auth:
  type: file
  path: ./auth/get-token.ts
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/http-config.yaml',
      'evals/auth/get-token.ts',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track plain HTTP credential and TLS paths in nested provider configs', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  id: https://example.com/grade
  label: grading
  config:
    validateStatus: file://validators/nested-status.js:isSuccess
    signatureAuth:
      privateKeyPath: ./credentials/signing.key
      keystorePath: ./credentials/signing.jks
      pfxPath: ./credentials/signing.pfx
      certPath: ./credentials/signing.crt
      keyPath: ./credentials/signing-key.pem
      jksPath: null
      keyAlias: signing
    tls:
      caPath: ./tls/ca.pem
      certPath: file://tls/client.crt
      keyPath: ./tls/client.key
      pfxPath: ./tls/client.pfx
      jksPath: ./tls/client.jks
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/validators/nested-status.js',
      'evals/credentials/signing.key',
      'evals/credentials/signing.jks',
      'evals/credentials/signing.pfx',
      'evals/credentials/signing.crt',
      'evals/credentials/signing-key.pem',
      'evals/tls/ca.pem',
      'evals/tls/client.crt',
      'evals/tls/client.key',
      'evals/tls/client.pfx',
      'evals/tls/client.jks',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not track bare auth and TLS paths for non-HTTP provider IDs', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  - id: openai:gpt-4.1
    config:
      auth:
        type: file
        path: ./unused/non-http-auth.ts
      tls:
        caPath: ./unused/non-http-ca.pem
      signatureAuth:
        privateKeyPath: ./unused/non-http-key.pem
  - https://example.com/grade:
      config:
        auth:
          type: file
          path: ./auth/http-map.ts
        tls:
          caPath: ./tls/http-map.pem
assert:
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/checks/safe.js',
      'evals/auth/http-map.ts',
      'evals/tls/http-map.pem',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track an HTTP provider config alias first visited by a non-HTTP provider', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  - id: openai:gpt-4.1
    config: &shared
      auth:
        type: file
        path: ./auth/http-token.ts
      tls:
        caPath: ./tls/http-ca.pem
  - https://example.com/grade:
      config: *shared
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/auth/http-token.ts',
      'evals/tls/http-ca.pem',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch computed provider-file templates', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  id: https://example.com/grade
  config:
    response_format:
      type: json_schema
      json_schema:
        schema: "{{ 'file://schemas/' + env.SCHEMA_FILE }}"
    settings: "{{ 'file://settings/' + env.SETTINGS_FILE }}"
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track a file-auth YAML alias first traversed outside auth', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  id: https://example.com/grade
  config:
    body:
      attachment: &auth
        type: file
        path: ./auth/get-token.ts
    auth: *auth
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/auth/get-token.ts',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should retain files when nested provider references are arrays', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  - id: https://example.com/grade
    config:
      tools: file://tools/grading.py:get_tools
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/tools/grading.py',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should safely handle templated and escaping nested HTTP file-auth paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    text:
      id: https://example.com/grade
      config:
        auth:
          type: file
          path: './auth/{{ env.TOKEN_SCRIPT }}.ts'
    embedding:
      id: https://example.com/embed
      config:
        auth:
          type: file
          path: ../../secrets/get-token.ts
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it('should not treat arbitrary provider payload or assertion objects as file auth', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider:
    text:
      id: https://example.com/grade
      config:
        body:
          upload:
            type: file
            path: ./payload/body.json
          config:
            auth:
              type: file
              path: ./payload/body-auth.json
        tools:
          - type: file
            path: ./payload/tool.json
          - config:
              auth:
                type: file
                path: ./payload/tool-auth.json
assert:
  - type: llm-rubric
    config:
      attachment:
        type: file
        path: ./payload/assert.json
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track assertion config references inside defaultTest assert sets', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: assert-set
    assert:
      - type: llm-rubric
        config:
          rubric: file://rubrics/security.md
          tools:
            - file://tools/assert-tools.py:get_tools
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/rubrics/security.md',
      'evals/tools/assert-tools.py',
    ]);
  });

  it('should track assertion config references in regular tests', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: llm-rubric
        config:
          rubric: file://rubrics/test.md
          transform: file://checks/test.js:score
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/rubrics/test.md', 'evals/checks/test.js']);
  });

  it('should bound cyclic provider-config references while retaining later files', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://providers/first.yaml';
      }
      if (String(filePath).endsWith('evals/providers/first.yaml')) {
        return 'id: openai:responses:gpt-5.4\nconfig: file://providers/second.yaml';
      }
      if (String(filePath).endsWith('evals/providers/second.yaml')) {
        return 'response_format: file://providers/first.yaml\ntools: file://tools/cyclic-tools.json';
      }
      if (String(filePath).endsWith('evals/tools/cyclic-tools.json')) {
        return '[]';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/first.yaml',
      'evals/providers/second.yaml',
      'evals/tools/cyclic-tools.json',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(7);
  });

  it('should not inspect a nested provider-config symlink outside the workspace', () => {
    const linkedProvider = '/test/working/evals/providers/external.yaml';
    const externalProvider = '/test/secrets/external.yaml';
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath) === linkedProvider ? externalProvider : String(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://providers/external.yaml';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/external.yaml',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      linkedProvider,
      'utf8',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      externalProvider,
      'utf8',
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path must stay within the repository'),
    );
  });

  it('should reject an escaping nested provider config before inspection', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://../../secrets/external.yaml';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should warn once for an escaping options provider config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'options: { provider: file://../../secrets/external.yaml }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it('should inspect nested provider-config glob matches without reading the pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://providers/{one,two}.yaml';
      }
      if (/evals\/providers\/(?:one|two)\.yaml$/.test(String(filePath))) {
        return 'id: openai:gpt-4.1-mini';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/providers/one.yaml',
      '/test/working/evals/providers/two.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/one.yaml',
      'evals/providers/two.yaml',
      'evals/providers/',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(4);
  });

  it('should keep other dependencies when a nested provider config cannot be parsed', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://providers/invalid.yaml';
      }
      if (String(filePath).endsWith('evals/providers/invalid.yaml')) {
        return 'config: [unterminated';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/providers/invalid.yaml',
      './',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to inspect nested config file'),
    );
  });

  it('should track object-form vars arrays in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  prompts:
    - file://native-a.txt
    - file://native-b.txt
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-a.txt',
      'evals/native-b.txt',
    ]);
  });

  it('should inspect nested file references inside an external vars map', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/native-vars.yaml';
      }
      if (String(filePath).endsWith('evals/data/native-vars.yaml')) {
        return 'context: file://fixtures/native-context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/native-vars.yaml',
      'evals/fixtures/native-context.txt',
    ]);
  });

  it('should inspect each external vars-glob match once and track nested references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  - data/native-*.yaml
  - data/native-*.yaml
`;
      }
      if (String(filePath).endsWith('evals/data/native-vars.yaml')) {
        return 'context: file://fixtures/native-context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/data/native-vars.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/native-vars.yaml',
      'evals/data/',
      'evals/fixtures/native-context.txt',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      '/test/working/evals/data/native-vars.yaml',
      'utf8',
    );
    expect(
      mockFs.readFileSync.mock.calls.filter(
        ([filePath]) =>
          String(filePath) === '/test/working/evals/data/native-vars.yaml',
      ),
    ).toHaveLength(1);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
  });

  it('should inspect only YAML and JSON maps in a mixed external vars glob', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/*';
      }
      if (String(filePath).endsWith('evals/data/context.yaml')) {
        return 'context: file://fixtures/native-context.txt';
      }
      throw new Error(`Unexpected file read: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/data/context.yaml',
      '/test/working/evals/data/context.pdf',
      '/test/working/evals/data/context.csv',
      '/test/working/evals/data/context.jsonl',
      '/test/working/evals/data/context.txt',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/context.yaml',
      'evals/data/context.pdf',
      'evals/data/context.csv',
      'evals/data/context.jsonl',
      'evals/data/context.txt',
      'evals/data/',
      'evals/fixtures/native-context.txt',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(3);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should inspect overlapping external vars-glob matches only once', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: [data/native-*.yaml, data/*-vars.yaml]';
      }
      if (String(filePath).endsWith('evals/data/native-vars.yaml')) {
        return 'context: file://fixtures/native-context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/data/native-vars.yaml',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/native-vars.yaml',
      'evals/data/',
      'evals/fixtures/native-context.txt',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
    expect(
      mockFs.readFileSync.mock.calls.filter(
        ([filePath]) =>
          String(filePath) === '/test/working/evals/data/native-vars.yaml',
      ),
    ).toHaveLength(1);
  });

  it('should reject a lexically escaping external vars path before inspection', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: ../../secrets/external-vars.yaml';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it('should reject an external vars-map symlink outside the workspace without reading or leaking it', () => {
    const canary = 'EXTERNAL_VARS_SECRET_CANARY';
    const linkedVars = '/test/working/evals/data/external-vars.yaml';
    const externalVars = '/test/secrets/external-vars.yaml';
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath) === linkedVars ? externalVars : String(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: data/external-vars.yaml';
      }
      if (String(filePath) === linkedVars) {
        return `secret: ${canary}`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/external-vars.yaml',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(linkedVars, 'utf8');
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(externalVars, 'utf8');
    expect(vi.mocked(core.warning).mock.calls.flat().join(' ')).not.toContain(
      canary,
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path must stay within the repository'),
    );
  });

  it('should bound recursive provider maps while retaining later grader dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
options:
  provider: &providers
    self: *providers
    text:
      id: file://native-text-grader.js
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-text-grader.js',
    ]);
  });

  it('should inspect a literal defaultTest wrapper below a glob-like ancestor directory', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/[v2]/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/[v2]/defaults/default.yaml')) {
        return 'vars: { context: file://native-context.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('[v2]'),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/[v2]/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/[v2]/defaults/default.yaml',
      'evals/[v2]/native-context.txt',
    ]);
  });

  it('should track Ruby assertion selectors in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: ruby
    value: file://native-score.rb:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/native-score.rb',
    ]);
  });

  it('should expand brace and Windows-style var globs in a file-backed defaultTest', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars:
  braces: file://fixtures/{one,two}.txt
  windows: 'file://fixtures\\*.txt'
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation(
      (
        value: string,
        options?: { magicalBraces?: boolean; windowsPathsNoEscape?: boolean },
      ) =>
        (value.includes('{') && options?.magicalBraces === true) ||
        (value.includes('*') &&
          (!value.includes('\\') || options?.windowsPathsNoEscape === true)),
    );
    mockGlob.sync.mockImplementation((patterns: string | string[]) => {
      const pattern = Array.isArray(patterns) ? patterns.join('|') : patterns;
      if (pattern.includes('fixtures/one.txt')) {
        return [
          '/test/working/evals/fixtures/one.txt',
          '/test/working/evals/fixtures/two.txt',
        ];
      }
      if (pattern.includes('fixtures/*.txt')) {
        return ['/test/working/evals/fixtures/windows.txt'];
      }
      return [];
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/fixtures/one.txt',
      'evals/fixtures/two.txt',
      'evals/fixtures/',
      'evals/fixtures/windows.txt',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringContaining('fixtures/one.txt'),
        expect.stringContaining('fixtures/two.txt'),
      ]),
      expect.objectContaining({
        magicalBraces: true,
        windowsPathsNoEscape: true,
      }),
    );
  });

  it('should reject an escaping Windows-style var-glob base and keep a safe watcher', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return "vars: { context: 'file://..\\..\\secrets\\*.txt' }";
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/secrets/external.txt']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', './']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'glob alternative must stay within the repository',
      ),
    );
  });

  it('should handle cyclic and malformed defaultTest assert sets without dropping later dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return `
providers:
  - file://providers/custom.py
defaultTest: file://defaults/default.yaml
`;
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert: &asserts
  - type: assert-set
    assert: *asserts
  - null
  - type: assert-set
    assert: not-an-array
  - type: javascript
    value: &values
      - *values
      - file://later-grader.js:named.with.dot
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/custom.py',
      'evals/defaults/default.yaml',
      'evals/later-grader.js',
    ]);
  });

  it('should preserve the missing glob directory for a deleted defaultTest dependency', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: file://fixturegone/*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/fixturegone/']);
  });

  it('should preserve the slash for an unmatched brace-glob base', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: ["data/{kept,removed}/*.yaml"]';
      }
      if (String(filePath).endsWith('evals/data/kept/a.yaml')) {
        return 'context: kept';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/data/kept/a.yaml']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/data/kept/*.yaml',
      '/test/working/evals/data/removed/*.yaml',
    ]);
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/kept/a.yaml',
      'evals/data/kept/',
      'evals/data/removed/',
    ]);
  });

  it('should watch the real parent for deleted concrete brace dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: ["data/{one,two}.yaml"]';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/data/one.yaml',
      '/test/working/evals/data/two.yaml',
    ]);
    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/data/']);
    expect(deps).not.toContain('evals/data/one.yaml/');
    expect(deps).not.toContain('evals/data/two.yaml/');
  });

  it('should watch the real parent for deleted concrete defaultTest brace files', () => {
    mockFs.readFileSync.mockReturnValue(
      'defaultTest: file://defaults/{one,two}.yaml',
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(mockGlob.sync.mock.calls[0]?.[0]).toEqual([
      '/test/working/evals/defaults/one.yaml',
      '/test/working/evals/defaults/two.yaml',
    ]);
    expect(deps).toEqual(['evals/defaults/']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('should preserve the missing absolute glob directory for a deleted defaultTest dependency', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: file:///test/working/evals/absfixturegone/*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/absfixturegone/',
    ]);
  });

  it('should preserve the config directory for a deleted root-level defaultTest glob', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: file://gone*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/']);
  });

  it('should watch the config directory for new matches in a populated root-level defaultTest glob', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: { context: file://*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/current.txt']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/current.txt',
      'evals/',
    ]);
  });

  it('should preserve a deleted workspace-root defaultTest glob as a pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('working/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('working/defaults/default.yaml')) {
        return 'vars: { context: file://gone*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['defaults/default.yaml', 'gone*.txt']);
  });

  it('should preserve a populated workspace-root defaultTest glob as a pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('working/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('working/defaults/default.yaml')) {
        return 'vars: { context: file://*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/current.txt']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['defaults/default.yaml', 'current.txt', '*.txt']);
  });

  it('should preserve an explicit dot workspace-root defaultTest glob as a pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('working/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('working/defaults/default.yaml')) {
        return 'vars: { context: file://./*.txt }';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['defaults/default.yaml', '*.txt']);
  });

  it('should reject a file-backed defaultTest outside the repository', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest: file://../secrets/default.yaml
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should ignore unsupported defaultTest strings', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest: default.yaml
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should ignore an invalid non-object defaultTest without dropping other dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
defaultTest: true
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py']);
    expect(core.warning).not.toHaveBeenCalled();
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

  it('should escape control characters from file read errors in warnings', () => {
    const reason =
      'ENOENT: no such file or directory, open "/test/config/evil\r\n::error::forged"';
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error(reason), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      `Failed to extract dependencies from config: ${JSON.stringify(reason)}`,
    );
  });

  it('should conservatively watch the workspace after a post-parse extraction failure', () => {
    mockFs.readFileSync.mockReturnValue('tests: true');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      `Failed to extract dependencies from config: ${JSON.stringify('config.tests is not iterable')}`,
    );
  });

  it('should escape control characters from unsafe dependency paths in warnings', () => {
    const filePath = '../../secrets/evil\r\n::error::forged.py';
    mockFs.readFileSync.mockReturnValue(
      `providers: [${JSON.stringify(`file://${filePath}`)}]`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      `Ignoring unsafe config dependency ${JSON.stringify(filePath)}: ${JSON.stringify('config file dependency must stay within the repository workspace')}`,
    );
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

  it('should ignore a null-byte glob without dropping later dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://providers/\\0*.py"
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((patterns: string | string[]) => {
      if (String(patterns).includes('\0')) {
        throw new TypeError('glob pattern cannot contain a null byte');
      }
      return [];
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte vars glob without dropping later dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `vars: ["data/\\0*.yaml", data/safe.yaml]`;
      }
      if (String(filePath).endsWith('evals/data/safe.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new TypeError('glob pattern cannot contain a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/safe.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte nested-config glob without dropping later dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider:
  id: "file://providers/bad\\0*.yaml"
assert:
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new TypeError('glob pattern cannot contain a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/checks/safe.js',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte defaultTest glob without dropping other dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
defaultTest: "file://defaults/bad\\0*.yaml"
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new TypeError('glob pattern cannot contain a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte templated defaultTest without watching the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
defaultTest: "file://defaults/bad\\0{{ env.NAME }}.yaml"
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new TypeError('glob pattern cannot contain a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte nested template without watching the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
provider: "file://providers/bad\\0{{ env.NAME }}.yaml"
assert:
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/checks/safe.js',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore a null-byte object-form template without watching the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: javascript
    value:
      file: "checks/bad\\0{{ env.NAME }}.js"
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/checks/safe.js',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('contains an invalid null byte'),
    );
  });

  it('should ignore an oversized provider glob without dropping later dependencies', () => {
    const oversizedGlob = `providers/${'x'.repeat(65_536)}*.py`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://${oversizedGlob}
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) throw new TypeError('pattern is too long');
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore an oversized prompt glob without dropping later dependencies', () => {
    const oversizedGlob = `prompts/${'x'.repeat(65_536)}*.txt`;
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://${oversizedGlob}
  - file://prompts/safe.txt
`);
    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );
    expect(deps).toEqual(['evals/prompts/safe.txt']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore oversized nested defaultTest globs without dropping later dependencies', () => {
    const oversizedGlob = `${'x'.repeat(65_536)}*.yaml`;
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars: ["data/${oversizedGlob}", data/safe.yaml]
provider:
  id: file://providers/${oversizedGlob}
assert:
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      if (String(filePath).endsWith('evals/data/safe.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) throw new TypeError('pattern is too long');
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/safe.yaml',
      'evals/fixtures/context.txt',
      'evals/checks/safe.js',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore an oversized defaultTest glob without dropping other dependencies', () => {
    const oversizedGlob = `defaults/${'x'.repeat(65_536)}*.yaml`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
defaultTest: file://${oversizedGlob}
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) throw new TypeError('pattern is too long');
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore an oversized templated provider without watching the workspace', () => {
    const oversizedTemplate = `providers/${'x'.repeat(65_536)}{{ env.NAME }}.py`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://${oversizedTemplate}
  - file://providers/safe.py
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore oversized nested templated references without watching the workspace', () => {
    const oversizedTemplate = `${'x'.repeat(65_536)}{{ env.NAME }}.yaml`;
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
vars: ["data/${oversizedTemplate}", data/safe.yaml]
provider: file://providers/${oversizedTemplate}
assert:
  - type: javascript
    value:
      file: checks/${oversizedTemplate}
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      if (String(filePath).endsWith('evals/data/safe.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/data/safe.yaml',
      'evals/fixtures/context.txt',
      'evals/checks/safe.js',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should ignore an oversized templated defaultTest without watching the workspace', () => {
    const oversizedTemplate = `defaults/${'x'.repeat(65_536)}{{ env.NAME }}.yaml`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
defaultTest: file://${oversizedTemplate}
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should validate oversized nested file references before checking template syntax', () => {
    const oversizedOpenTemplate = `file://${'{{'.repeat(32_770)}`;
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return `
assert:
  - type: contains
    value: "${oversizedOpenTemplate}"
  - type: javascript
    value: file://checks/safe.js:score
`;
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    const originalTest = RegExp.prototype.test;
    const templateTest = vi
      .spyOn(RegExp.prototype, 'test')
      .mockImplementation(function (this: RegExp, value: string) {
        if (this.source.includes('\\{\\{') && value.length > 65_536) {
          throw new Error('template syntax checked before length validation');
        }
        return originalTest.call(this, value);
      });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    templateTest.mockRestore();
    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      'evals/checks/safe.js',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the maximum glob pattern length'),
    );
  });

  it('should conservatively watch the dependency root when glob magic detection rejects a provider path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/invalid*.py
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('invalid')) throw new TypeError('invalid pattern');
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./', 'evals/providers/safe.py']);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
    );
  });

  it('should conservatively watch the dependency root when glob magic detection rejects a vars path', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'vars: [data/invalid*.yaml, data/safe.yaml]';
      }
      if (String(filePath).endsWith('evals/data/safe.yaml')) {
        return 'context: file://fixtures/context.txt';
      }
      throw new Error(`Unexpected file: ${String(filePath)}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('invalid')) throw new TypeError('invalid pattern');
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults/default.yaml',
      './',
      'evals/data/safe.yaml',
      'evals/fixtures/context.txt',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
    );
  });

  it('should ignore a glob rejected during brace expansion without dropping later dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{invalid,safe}*.py
  - file://providers/sibling.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    vi.mocked(minimatch.braceExpand).mockImplementationOnce(() => {
      throw new TypeError('invalid pattern');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/sibling.py']);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob pattern',
    );
  });

  it('should ignore a glob rejected during expansion without dropping later dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/invalid*.py
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementationOnce(() => {
      throw new TypeError('invalid pattern');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/safe.py']);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob pattern',
    );
  });

  it('should conservatively watch the dependency root when base-directory glob inspection fails', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://./providers/invalid*.py
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value === 'providers/invalid*.py') {
        throw new TypeError('invalid pattern');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./', 'evals/providers/safe.py']);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
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

    expect(deps).toEqual([
      '../config/',
      '../config/providers/custom.py',
      '../config/providers/',
    ]);
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

  it('should preserve a literal workspace-root directory dependency', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://.]');
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => String(filePath) === '/test/working',
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(deps).not.toContain('');
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
});
