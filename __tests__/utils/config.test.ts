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
    statSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
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
    vi.spyOn(process, 'cwd').mockReturnValue('/test/working');
    // Default mock implementations
    mockGlob.hasMagic.mockReturnValue(false);
    mockGlob.sync.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    mockFs.realpathSync.mockImplementation((value: string) => value);
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

  it('should extract HTTP validateStatus file dependencies and named exports', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/default.js
  - id: http://example.test
    config:
      validateStatus: file://validators/team:blue/status.mts:validateStatus
  - id: openai:gpt-4
    config:
      validateStatus: file://validators/ignored.js
  - id: https
    config:
      validateStatus: status >= 200 && status < 300
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/default.js',
      'validators/team:blue/status.mts',
    ]);
  });

  it('should extract HTTP transform and parser file dependencies from providers and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      transformRequest: file://transforms/request.js:request
      transformResponse: file://transforms/response.mjs:response
      responseParser: file://transforms/legacy.cts:parse
      sessionParser: file://transforms/session.mts:session
      session:
        responseParser: file://transforms/session-response.js:parse
  - 'https://map.example.test':
      config:
        transformRequest: file://transforms/map.js
targets:
  - id: http
    config:
      transformResponse: file://transforms/target.js:response
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'transforms/request.js',
      'transforms/response.mjs',
      'transforms/legacy.cts',
      'transforms/session.mts',
      'transforms/session-response.js',
      'transforms/map.js',
      'transforms/target.js',
    ]);
  });

  it('should track inline HTTP raw request file dependencies and ignore inline request text', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      request: file://requests/payload.txt
  - id: http
    config:
      request: POST /api HTTP/1.1
  - id: openai:gpt-4
    config:
      request: file://requests/ignored.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['requests/payload.txt']);
  });

  it('should contain inline HTTP raw request file dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      request: file://../outside/payload.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'must stay within the checkout or config directory',
      ),
    );
  });

  it('should extract templated HTTP, file-auth, multipart, and slash-selector dependencies and fail closed for a dynamic provider id', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: '{{ env.PROVIDER_ID | default("https") }}'
    config:
      url: '{{ env.TARGET_URL }}'
      transformRequest: file://transforms/request.js:team/request
      auth:
        type: '{{ env.AUTH_TYPE | default("file") }}'
        path: file://auth/get-token.py:get_auth
      multipart:
        parts:
          - kind: '{{ env.PART_KIND | default("file") }}'
            name: upload
            source:
              type: '{{ env.SOURCE_TYPE | default("path") }}'
              path: file://fixtures/document.pdf
  - id: http
    config:
      url: '{{ env.SECOND_URL }}'
      auth:
        type: file
        path: auth/plain.js:get_auth
      multipart:
        parts:
          - kind: file
            name: image
            source:
              type: path
              path: fixtures/image.png
      headers:
        Authorization: Bearer {{ env.TOKEN | default("unused") }}
  - id: openai:gpt-4
    config:
      apiKey: '{{ env.OPENAI_API_KEY | default("unused") }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'transforms/request.js',
      'auth/get-token.py',
      'fixtures/document.pdf',
      'auth/plain.js',
      'fixtures/image.png',
      './',
    ]);
  });

  it('should not widen the workspace for ordinary filtered env text', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      url: '{{ env.TARGET_URL }}'
      headers:
        Authorization: Bearer {{ env.TOKEN | default("unused") }}
  - id: openai:gpt-4
    config:
      apiKey: '{{ env.OPENAI_API_KEY | default("unused") }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract raw TLS, signature, and multipart paths from an external HTTP provider file', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'providers: file://providers/http.yaml',
      ],
      [
        '/test/working/providers/http.yaml',
        `- id: https\n  config:\n    url: https://example.test\n    auth:\n      type: file\n      path: auth/get-token.py:get_auth\n    tls:\n      caPath: certs/ca.bundle\n      certPath: certs/client.cert\n      keyPath: certs/client.private\n      pfxPath: certs/client.archive\n    signatureAuth:\n      privateKeyPath: signing/private.material\n      keystorePath: signing/store.bin\n      pfxPath: signing/signature.archive\n      certPath: signing/certificate.raw\n      keyPath: signing/key.raw\n    multipart:\n      parts:\n        - kind: file\n          name: upload\n          source:\n            type: path\n            path: fixtures/payload.blob`,
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/http.yaml',
      'auth/get-token.py',
      'certs/ca.bundle',
      'certs/client.cert',
      'certs/client.private',
      'certs/client.archive',
      'signing/private.material',
      'signing/store.bin',
      'signing/signature.archive',
      'signing/certificate.raw',
      'signing/key.raw',
      'fixtures/payload.blob',
    ]);
  });

  it('should decode in-root absolute file URLs before tracking multipart dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      multipart:
        parts:
          - kind: file
            name: upload
            source:
              type: path
              path: file:///test/working/fixtures/team%20document.pdf
          - kind: file
            name: localhost-upload
            source:
              type: path
              path: file://LOCALHOST/test/working/fixtures/localhost%20document.pdf
          - kind: file
            name: relative-upload
            source:
              type: path
              path: file://payload.blob
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'fixtures/team document.pdf',
      'fixtures/localhost document.pdf',
      'payload.blob',
    ]);
  });

  it('should preserve literal percent escapes in provider and extension file URLs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: file:///test/working/providers-percent/team%20provider.py:call_api
extensions:
  - file:///test/working/hooks/team%20policy.js:hook
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers-percent/team%20provider.py',
      'hooks/team%20policy.js',
    ]);
  });

  it('should decode multipart file URLs from an external provider file', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'providers: file://providers/http.yaml',
      ],
      [
        '/test/working/providers/http.yaml',
        `- id: https\n  config:\n    multipart:\n      note: file://assets/multipart-note.txt\n      parts:\n        - kind: file\n          metadata: file://assets/part-metadata.txt\n          source:\n            type: path\n            path: file:///test/working/fixtures/external%20document.pdf\n            description: file://assets/source-description.txt`,
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/http.yaml',
      'fixtures/external document.pdf',
      'assets/multipart-note.txt',
      'assets/part-metadata.txt',
      'assets/source-description.txt',
    ]);
  });

  it('should traverse unrelated multipart metadata for file dependencies', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'prompts: [prompts/main.txt]\ntests: file://tests/metadata.yaml',
      ],
      [
        '/test/working/tests/metadata.yaml',
        '- metadata:\n    multipart:\n      note: file://assets/metadata.txt',
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/main.txt',
      'tests/metadata.yaml',
      'assets/metadata.txt',
    ]);
  });

  it.each([
    ['escaped parent', 'file:///test/working/%2e%2e/outside/secret.txt'],
    [
      'uppercase localhost',
      'file://LOCALHOST/test/working/%2e%2e/outside/secret.txt',
    ],
    [
      'encoded localhost',
      'file://%6Cocalhost/test/working/%2e%2e/outside/secret.txt',
    ],
    [
      'backslash separator',
      'file://localhost\\test\\working\\%2e%2e\\outside\\secret.txt',
    ],
    ['encoded separator', 'file:///test/working/fixtures%2Fsecret.txt'],
  ])('should fail closed for an unsafe absolute file URL with an %s', (_kind, fileUrl) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      multipart:
        parts:
          - kind: file
            name: upload
            source:
              type: path
              path: ${fileUrl}
`);

    expect(() =>
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toThrow(
      'An existing config dependency resolves outside an allowed dependency root.',
    );
  });

  it('should preserve uppercase external auth selectors and fail closed for dynamic auth paths', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'providers: file://providers/auth.yaml',
      ],
      [
        '/test/working/providers/auth.yaml',
        `- id: https\n  config:\n    auth:\n      type: file\n      path: file://auth/UPPER.MTS:get_auth\n- id: https\n  config:\n    auth:\n      type: file\n      path: file://auth/plain.bin\n- id: https\n  config:\n    auth:\n      type: file\n      path: '{{ env.AUTH_PATH }}'\n- id: https\n  config:\n    auth:\n      type: file\n      path: '{% if env.USE_AUTH %}auth/optional.js{% endif %}'`,
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/auth.yaml',
      'auth/UPPER.MTS',
      'auth/UPPER.MTS:get_auth',
      'auth/plain.bin',
      './',
    ]);
  });

  it('should extract direct HTTP TLS and signature paths, ignore malformed parts, and fail closed for dynamic paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      transformRequest: file://{{ env.TRANSFORM_PATH }}
      tls:
        caPath: certs/ca.bundle
        certPath: certs/client.cert
        keyPath: certs/client.private
        pfxPath: certs/client.archive
      signatureAuth:
        privateKeyPath: signing/private.material
        keystorePath: signing/store.bin
        pfxPath: signing/signature.archive
        certPath: signing/certificate.raw
        keyPath: signing/key.raw
      multipart:
        parts:
          - null
          - 42
          - {}
          - source: null
          - source: 42
          - source: {}
          - source:
              path: fixtures/payload.blob
  - id: https
    config:
      tls: null
      signatureAuth: 42
  - id: https
    config:
      tls: 42
      signatureAuth: null
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'certs/ca.bundle',
      'certs/client.cert',
      'certs/client.private',
      'certs/client.archive',
      'signing/private.material',
      'signing/store.bin',
      'signing/signature.archive',
      'signing/certificate.raw',
      'signing/key.raw',
      'fixtures/payload.blob',
      './',
    ]);
  });

  it('should conservatively watch the workspace for block-templated extension paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      apiKey: '{{ env.OPENAI_API_KEY | default("unused") }}'
extensions:
  - '{% if env.USE_HOOK %}file://hooks/policy.js:beforeAll{% endif %}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should extract HTTP validateStatus dependencies from provider maps and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'https://provider.example.test':
      config:
        validateStatus: file://validators/provider-map.mjs:validateStatus
  - 'openai:gpt-4':
      config:
        validateStatus: file://validators/ignored.js
targets:
  - id: http
    config:
      validateStatus: file://validators/target.cts:check
  - 'https://target.example.test':
      id: friendly-target-label
      config:
        validateStatus: file://validators/target-map.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/provider-map.mjs',
      'validators/target.cts',
      'validators/target-map.js',
    ]);
  });

  it('should ignore malformed provider map entries', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - null
  - 42
  - {}
  - 'https://null.example.test': null
  - 'https://scalar.example.test': inline
  - 'https://first.example.test':
      config:
        validateStatus: file://validators/ignored-first.js
    'https://second.example.test':
      config:
        validateStatus: file://validators/ignored-second.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should extract scalar provider and target file dependencies', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers.yaml');
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['providers.yaml']);

    mockFs.readFileSync.mockReturnValue('targets: file://targets.yaml');
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['targets.yaml']);
  });

  it('should extract executable provider and target selector dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/python.py:call_api
  - id: file://providers/go.go:CallApi
  - 'file://providers/ruby.rb:call_api':
      config:
        temperature: 0
  - file://providers/uppercase.RB:call_api
targets:
  - id: file://targets/python.py:call_api
  - 'file://targets/go.go:CallApi':
      id: friendly-go-target
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/python.py',
      'providers/go.go',
      'providers/ruby.rb',
      'providers/uppercase.RB:call_api',
      'targets/python.py',
      'targets/go.go',
    ]);
  });

  it('should extract prefixed executable provider and target selector dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/python.py:call_api
  - id: golang:providers/go.go:CallApi
  - 'ruby:providers/ruby.rb:call_api':
      config:
        temperature: 0
  - python:providers/uppercase.PY:call_api
  - go:providers/not-supported.go:CallApi
targets:
  - id: python:targets/python.py:call_api
  - 'golang:targets/go.go:CallApi':
      id: friendly-go-target
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/python.py',
      'providers/go.go',
      'providers/ruby.rb',
      'providers/uppercase.PY:call_api',
      'targets/python.py',
      'targets/go.go',
    ]);
  });

  it('should preserve newlines in prefixed executable provider paths', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - "python:providers/team\\nblue.py:call_api"',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/team\nblue.py']);
  });

  it('should preserve uppercase HTTP validateStatus selector paths like the pinned runtime', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/status.MTS:validateStatus
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/status.MTS',
      'validators/status.MTS:validateStatus',
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

  it('should not watch the workspace for ordinary inline prompt templates', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - 'Translate {{text}}'
  - raw: 'Hello {{ name }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the workspace for templated prompt paths', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://prompts/{{ env.PROMPT }}.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it.each([
    ['huge numeric range', 'file://providers/{1..1000000000}/*.py'],
    ['malformed brace', 'file://providers/{safe,../outside/*.py'],
    ['in-class numeric range', 'file://providers/[{1..5000000}].py'],
    ['even-backslash numeric range', 'file://providers/\\\\{1..1000000000}.py'],
    ['unsafe numeric bound', `file://providers/{1..${'9'.repeat(200)}}/*.py`],
    ['unsafe integer bound', `file://providers/{1..${'9'.repeat(20)}}/*.py`],
    [
      'zero-padded numeric range',
      `file://providers/{${'0'.repeat(32_000)}1..1024}.py`,
    ],
    [
      'large estimated expansion',
      `file://providers/${'a'.repeat(4096)}-{1..1024}.py`,
    ],
    [
      'large comma expansion',
      `file://providers/${'a'.repeat(60_000)}-{${'x,'.repeat(1023)}x}.py`,
    ],
  ])('should fail closed before enumerating a %s config dependency glob', (_kind, provider) => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - ${provider}`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should fail closed before enumerating excessive config brace alternatives', () => {
    const provider = `file://providers/{${'a,'.repeat(1024)}a}/*.py`;
    mockFs.readFileSync.mockReturnValue(`providers:\n  - ${provider}`);
    mockGlob.hasMagic.mockReturnValue(true);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should extract plain prompt paths, globs, and executable prompt selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/simple.txt
  - prompts/*.j2
  - file://prompts/render.py:render
  - exec:file://prompts/build.py:fn
  - exec:prompts/render.rb:render
  - exec:prompts/render.sh
  - file://prompts/render.MTS:render
  - What is 2+2?
  - Return * when unknown
  - raw: prompts/object.txt
    id: object-prompt
  - id: object-inline
    raw: What is 2+2?
  - id: prompts/id-only.txt
  - file: 42
  - null
  - 42
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompts/template.j2']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/simple.txt',
      'prompts/template.j2',
      'prompts/',
      'prompts/render.py',
      'prompts/build.py',
      'prompts/render.rb',
      'prompts/render.sh',
      'prompts/render.MTS',
      'prompts/render.MTS:render',
      'prompts/object.txt',
      'prompts/id-only.txt',
    ]);
  });

  it('should extract scalar and map-form prompt paths without globbing inline questions', () => {
    mockFs.readFileSync.mockReturnValue('prompts: prompts/scalar.txt');
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/scalar.txt']);

    mockFs.readFileSync.mockReturnValue(`
prompts:
  prompts/map.txt: map-prompt
  What is 2+2?: inline-prompt
`);
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/map.txt']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should expand root-level prompt brace globs without treating inline wildcard prose as a path', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompt-*.{txt,md}
  - Return * when unknown
`);
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockGlob.sync.mockImplementation((value: string) =>
      value.endsWith('.txt')
        ? ['/test/working/prompt-one.txt']
        : value.endsWith('.md')
          ? ['/test/working/prompt-two.md']
          : [],
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompt-one.txt', 'prompt-two.md', './']);
  });

  it('should fail closed for templated top-level prompt and provider paths', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://{{ env.PROMPT_DIR }}/main.txt
providers:
  - file://{{ env.PROVIDER_DIR }}/provider.py:call_api
  - '{{ env.PROVIDER_URI }}'
tests:
  - provider: '{{ env.TEST_PROVIDER_URI }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should fail closed for templated filter, test, var, and assertion dependency paths', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/main.txt
nunjucksFilters:
  custom: '{{ env.FILTER_PATH }}'
defaultTest:
  vars: '{{ env.DEFAULT_VARS_PATH }}'
  assert:
    - type: ruby
      value: file://{{ env.ASSERT_PATH }}
tests:
  - '{{ env.TESTS_PATH }}'
  - vars:
      context: file://{{ env.CONTEXT_PATH }}
      expected:
        file: '{{ env.EXPECTED_PATH }}'
    assert:
      - type: contains
        value:
          file: '{% if env.USE_EXPECTED %}expected/result.txt{% endif %}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should extract nested file references from structured prompt files', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        `prompts:\n  - file: prompts/structured.yaml\n  - file://prompts/chat.json`,
      ],
      [
        '/test/working/prompts/structured.yaml',
        `messages:\n  - content: file://assets/context.txt\n  - content: file://data/extra.json`,
      ],
      [
        '/test/working/prompts/chat.json',
        JSON.stringify({ messages: [{ content: 'file://assets/chat.txt' }] }),
      ],
      [
        '/test/working/data/extra.json',
        JSON.stringify({ content: 'file://assets/deep.txt' }),
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/structured.yaml',
      'prompts/chat.json',
      'assets/context.txt',
      'data/extra.json',
      'assets/chat.txt',
      'assets/deep.txt',
    ]);
  });

  it('should not read an oversized structured prompt dependency', () => {
    mockFs.readFileSync.mockImplementation((value: string) => {
      if (value === '/test/working/promptfooconfig.yaml') {
        return 'prompts:\n  - file: prompts/huge.yaml';
      }
      throw new Error('oversized dependency was read');
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: value.endsWith('/huge.yaml') ? 10 * 1024 * 1024 + 1 : 0,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/huge.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should fail closed when a structured dependency cannot be statted', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts:\n  - file: prompts/unreadable.yaml',
    );
    mockFs.statSync.mockImplementation(() => {
      throw new Error('EACCES: denied\n::error::forged-structured-stat');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/unreadable.yaml', './']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-structured-stat');
  });

  it('should fail closed for dynamic and malformed nested dependency values while preserving safe siblings', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'providers: file://providers/external.yaml',
      ],
      [
        '/test/working/providers/external.yaml',
        `- id: https\n  config:\n    tls:\n      caPath: file://certs/ca.bundle\n      certPath: '{{ env.CERT_PATH }}'\n    signatureAuth:\n      privateKeyPath: signing/private.material\n    multipart:\n      parts:\n        - null\n        - {}\n        - source: null\n        - source: {}\n        - source:\n            path: '{{ env.MULTIPART_PATH }}'\n        - source:\n            path: fixtures/payload.blob\n  vars:\n    - file://vars/nested.yaml\n    - 42\n  refs:\n    - file://{{ env.EXTRA_PATH }}\n    - null\n    - 42\n    - &shared\n      value: file://assets/shared.txt\n    - *shared`,
      ],
      ['/test/working/providers/vars/nested.yaml', 'value: ready'],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/external.yaml',
      'providers/vars/nested.yaml',
      'certs/ca.bundle',
      'signing/private.material',
      'fixtures/payload.blob',
      'assets/shared.txt',
      './',
    ]);
  });

  it('should rebase nested test vars and custom provider files to the test file directory', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'tests: file://tests/nested/case.yaml',
      ],
      [
        '/test/working/tests/nested/case.yaml',
        `vars:\n  - file://fixtures/context.yaml\n  - fixtures/extra.yaml\nprovider: file://providers/per-test.py:call_api\nassert:\n  - type: llm-rubric\n    value: looks correct\n    provider:\n      id: file://graders/assertion.py:call_api\n      config:\n        transformResponse: file://graders/provider-transform.js:transform\n    contextTransform: '{{ env.CONTEXT_TRANSFORM }}'\n    transform: file://graders/transform.js:transform\n  - type: ruby\n    value: file://validators/check.rb:Validators::Format.check\n  - type: contains\n    value:\n      file: validators/expected.txt`,
      ],
      ['/test/working/tests/nested/fixtures/context.yaml', 'context: ready'],
      ['/test/working/tests/nested/fixtures/extra.yaml', 'extra: ready'],
      ['/test/working/fixtures/context.yaml', 'context: root-decoy'],
      ['/test/working/fixtures/extra.yaml', 'extra: root-decoy'],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'tests/nested/case.yaml',
      'tests/nested/fixtures/context.yaml',
      'tests/nested/fixtures/extra.yaml',
      'graders/assertion.py',
      'validators/check.rb',
      'validators/expected.txt',
      'tests/nested/providers/per-test.py',
      './',
    ]);
  });

  it('should extract inline per-test custom provider files', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider: file://providers/per-test.py:call_api
  - provider:
      id: python:providers/object.py:call_api
  - provider:
      'file://providers/map.py:call_api':
        config: {}
  - provider:
      'file://providers/invalid.py:call_api': null
  - vars:
      first: &shared-provider
        id: file://providers/shared.py:call_api
    provider: *shared-provider
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/per-test.py',
      'providers/object.py',
      'providers/map.py',
      'providers/shared.py',
      './',
    ]);
  });

  it('should track inline and default grading providers and fail closed for executable test transforms', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  provider: file://providers/default.py:call_api
  options:
    provider: file://graders/default.py:call_api
    transformVars: file://graders/default-vars.js:transform
    rubricPrompt: file://graders/default-rubric.txt
  assertScoringFunction: file://graders/default-score.js:score
  assert:
    - type: llm-rubric
      value: default rubric
      provider: file://graders/default-assert.py:call_api
      contextTransform: file://graders/default-context.js:transform
tests:
  - options:
      provider:
        id: file://graders/test.py:call_api
      transform: file://graders/test-transform.js:transform
      postprocess: file://graders/postprocess.js:transform
      transformVars: '{{ env.TEST_TRANSFORM }}'
      rubricPrompt: '{% if env.USE_RUBRIC %}file://graders/optional.txt{% endif %}'
    assertScoringFunction: file://graders/test-score.js:score
    assert:
      - type: assert-set
        assert:
          - type: llm-rubric
            value: test rubric
            provider:
              id: file://graders/test-assert.py:call_api
              config:
                transformResponse: file://graders/provider-transform.js:transform
            transform: file://graders/assert-transform.js:transform
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'graders/default-assert.py',
      'providers/default.py',
      'graders/default.py',
      'graders/test.py',
      'graders/test-assert.py',
      './',
    ]);
  });

  it('should fail closed for templated test transforms and configured custom providers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      id: file://providers/configured.py:call_api
      config: {}
    transform: inline transform
  - options:
      transformVars: '{{ env.TRANSFORM }}'
  - options:
      rubricPrompt: '{% if env.USE_RUBRIC %}grader/rubric.txt{% endif %}'
  - assert:
      - type: contains
        value: ready
        contextTransform: '{% if env.USE_CONTEXT %}context.txt{% endif %}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/configured.py', './']);
  });

  it('should track external default tests and commandLineOptions vars inputs', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest: file://defaults/test.yaml
commandLineOptions:
  vars:
    - tests/cases.csv
    - file://tests/more.jsonl
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'defaults/test.yaml',
      'tests/cases.csv',
      'tests/more.jsonl',
      './',
    ]);
  });

  it('should extract top-level Nunjucks filter file and glob dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
nunjucksFilters:
  allcaps: filters/allcaps.js
  dynamic: filters/*.mjs
  ignored: 42
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/filters/dynamic.mjs']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'filters/allcaps.js',
      'filters/dynamic.mjs',
      'filters/',
    ]);
  });

  it('should extract top-level and array test generator file dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/top-level.py:generate
`);
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tests/top-level.py']);

    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/cases.mjs:generate
  - path: file://tests/array.py:generate
  - file://tests/UPPER.MTS:generate
  - tests/plain.yaml
  - https://docs.google.com/spreadsheets/example
  - null
  - 42
`);
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'tests/cases.mjs',
      'tests/array.py',
      'tests/UPPER.MTS',
      'tests/UPPER.MTS:generate',
      'tests/plain.yaml',
    ]);
  });

  it('should extract file dependencies from test generator config values', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - path: file://tests/generator.py:generate
    config:
      fixture: file://data/cases.json
      nested:
        examples:
          - file://data/examples.yaml
          - inline value
          - null
          - 42
      dynamic: '{{ env.GENERATOR_FIXTURE }}'
      shared: &shared-generator
        fixture: file://data/shared.yaml
      alias: *shared-generator
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'tests/generator.py',
      'data/cases.json',
      'data/shared.yaml',
      'data/examples.yaml',
      './',
    ]);
  });

  it('should extract Excel test dependencies without their sheet specifiers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/current.xlsx#Regression Cases
  - path: tests/legacy.xls#Smoke
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['tests/current.xlsx', 'tests/legacy.xls']);
  });

  it('should safely reject oversized multiline Excel-like test references before parsing a sheet suffix', () => {
    const unsafePath = `${'.xls#'.repeat(14_000)}\n`;
    mockFs.readFileSync.mockReturnValue(`tests: ${JSON.stringify(unsafePath)}`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should extract nested file references from CSV and JSONL test files', () => {
    const files = new Map([
      [
        '/test/working/promptfooconfig.yaml',
        'tests:\n  - file://tests/cases.csv\n  - file://tests/cases.jsonl',
      ],
      [
        '/test/working/tests/cases.csv',
        'context,expected\nfile://assets/csv-context.txt,ok\n',
      ],
      [
        '/test/working/tests/cases.jsonl',
        `${JSON.stringify({ vars: { context: 'file://assets/jsonl.txt' } })}\n`,
      ],
    ]);
    mockFs.readFileSync.mockImplementation((value: string) => {
      const contents = files.get(value);
      if (contents === undefined) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return contents;
    });
    mockFs.statSync.mockImplementation(
      (value: string) =>
        ({
          isDirectory: () => false,
          size: Buffer.byteLength(files.get(value) ?? ''),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'tests/cases.csv',
      'tests/cases.jsonl',
      'assets/csv-context.txt',
      'assets/jsonl.txt',
    ]);
  });

  it.each([
    ['csv', 'context,expected\n"unterminated,ok'],
    ['jsonl', '{"vars":'],
  ])('should fail closed for a malformed transitive %s test file', (ext, contents) => {
    mockFs.readFileSync.mockImplementation((value: string) => {
      if (value === '/test/working/promptfooconfig.yaml') {
        return `tests: file://tests/cases.${ext}`;
      }
      return contents;
    });
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      size: Buffer.byteLength(contents),
    } as fs.Stats);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([`tests/cases.${ext}`, './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it.each([
    ['newline', 'file://assets/line\n::error::forged-structured.txt'],
    ['oversized', `file://${'a'.repeat(65_537)}`],
  ])('should fail closed for an unsafe transitive %s file reference', (_kind, ref) => {
    const jsonl = `${JSON.stringify({ metadata: { note: ref } })}\n`;
    mockFs.readFileSync.mockImplementation((value: string) =>
      value === '/test/working/promptfooconfig.yaml'
        ? 'tests: file://tests/unsafe.jsonl'
        : jsonl,
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      size: Buffer.byteLength(jsonl),
    } as fs.Stats);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['tests/unsafe.jsonl', './']);
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-structured');
  });

  it('should conservatively watch the workspace for scenario dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
scenarios:
  - tests: file://scenarios/tests.yaml
    config:
      - vars:
          context: file://scenarios/context.txt
        assert:
          - type: javascript
            value: file://scenarios/check.js:check
        provider: file://scenarios/provider.py:call_api
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
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

  it('should extract raw variable file paths and globs from string and array forms', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars: vars/default.yaml
tests:
  - vars: vars/one.yaml
  - vars:
      - vars/two.yaml
      - file://vars/prefixed.yaml
      - vars/*.yaml
      - 42
  - vars: 42
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/vars/matched.yaml']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/default.yaml',
      'vars/one.yaml',
      'vars/two.yaml',
      'vars/prefixed.yaml',
      'vars/matched.yaml',
      'vars/',
    ]);
  });

  it('should expand brace-only variable paths and reject unsafe brace alternatives', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      - vars/{one,two}.yaml
      - '{../outside,vars}/case.yaml'
`);
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockGlob.sync.mockImplementation((value: string) => {
      if (value.endsWith('/one.yaml')) return ['/test/working/vars/one.yaml'];
      if (value.endsWith('/two.yaml')) return ['/test/working/vars/two.yaml'];
      if (value.endsWith('/case.yaml')) {
        return ['/test/working/vars/case.yaml'];
      }
      return [];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/one.yaml',
      'vars/two.yaml',
      'vars/',
      'vars/case.yaml',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalledWith(
      expect.stringContaining('/outside/'),
      expect.anything(),
    );
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/working/vars/one.yaml',
      expect.objectContaining({ braceExpandMax: 1024 }),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unsafe config dependency glob pattern'),
    );
  });

  it('should preserve literal variable selectors and extract executable assertion selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars:
    defaultRuby: file://vars/default.rb:build
  assert:
    - type: javascript
      value: file://validators/default.cts:check
tests:
  - vars:
      ruby: file://vars/build.rb:build
      go: file://vars/build.go:Build
      javascript: file://vars/build.mts:build
      python: file://vars/build.py:build
      uppercase: file://vars/build.RB:build
      literal: file://vars/literal.txt:value
    assert:
      - type: javascript
        value: file://validators/check.go:Check
      - type: javascript
        value: file://validators/check.rb:Validators::Format.check
      - type: javascript
        value: file://validators/check.mjs:check
      - type: python
        value: file://validators/check.py:check
      - type: javascript
        value: file://validators/check.GO:Check
      - type: javascript
        value: file://validators/check.MTS:check
      - type: python
        value: file://validators/check.PY:check
      - type: ruby
        value: file://validators/check.RB:Validators::Format.check
      - type: contains
        value: file://validators/literal.txt:value
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/default.rb:build',
      'validators/default.cts',
      'vars/build.rb:build',
      'vars/build.go:Build',
      'vars/build.mts:build',
      'vars/build.py:build',
      'vars/build.RB:build',
      'vars/literal.txt:value',
      'validators/check.go:Check',
      'validators/check.rb',
      'validators/check.mjs',
      'validators/check.py',
      'validators/check.GO:Check',
      'validators/check.MTS',
      'validators/check.MTS:check',
      'validators/check.PY:check',
      'validators/check.RB:Validators::Format.check',
      'validators/literal.txt:value',
    ]);
  });

  it('should extract executable selectors from nested assertion sets', () => {
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

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/default.js',
      'validators/nested.rb',
      'validators/deep.py',
    ]);
  });

  it('should ignore malformed nested assertion entries', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - null
      - 42
      - type: assert-set
        assert: inline
      - type: assert-set
        assert:
          - type: javascript
            value: file://validators/safe.js:check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/safe.js']);
  });

  it('should visit shared nested assertion aliases only once', () => {
    mockFs.readFileSync.mockReturnValue(`
shared:
  leaf: &leaf
    - type: javascript
      value: file://validators/shared.js:check
  level1: &level1
    - type: assert-set
      assert: *leaf
    - type: assert-set
      assert: *leaf
  level2: &level2
    - type: assert-set
      assert: *level1
    - type: assert-set
      assert: *level1
  level3: &level3
    - type: assert-set
      assert: *level2
    - type: assert-set
      assert: *level2
tests:
  - assert: *level3
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/shared.js']);
    expect(mockFs.lstatSync).toHaveBeenCalledTimes(1);
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

  it('should extract extension hook files', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/setup.js:beforeAll
  - file://hooks/case.py:beforeEach
  - file://hooks/result.js:afterEach
  - file://hooks/report.py:afterAll
  - file://hooks/setup.js:beforeAll
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/hooks/setup.js',
      '../config/hooks/case.py',
      '../config/hooks/result.js',
      '../config/hooks/report.py',
    ]);
  });

  it('should preserve uppercase extension hook selector paths like the pinned runtime', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/setup.MTS:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/setup.MTS', 'hooks/setup.MTS:beforeAll']);
  });

  it('should extract extension hooks from commandLineOptions', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  extension:
    - file://hooks/policy.js:beforeAll
    - file://hooks/result.py:afterEach
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/policy.js', 'hooks/result.py']);
  });

  it('should preserve sibling dependencies when an extension glob is too long', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockFs.lstatSync.mockImplementation((value: string) => {
      throw Object.assign(new Error('stat failed'), {
        code: value.length > 65_536 ? 'ENAMETOOLONG' : 'ENOENT',
      });
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
extensions:
  - file://${'a'.repeat(65_536)}*
  - file://hooks/valid.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/custom.py');
    expect(deps).toContain('hooks/valid.js');
    expect(deps).toContain('./');
    expect(deps).toHaveLength(3);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve sibling dependencies when a resolved file glob is too long', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockGlob.sync.mockImplementation((pattern: string) =>
      realGlob.sync(pattern, { nodir: true }),
    );
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
  - file://${'a'.repeat(65_525)}*
extensions:
  - file://hooks/valid.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/custom.py');
    expect(deps).toContain('hooks/valid.js');
    expect(deps).toContain('./');
    expect(deps).toHaveLength(3);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should extract absolute extension hooks and preserve path colons', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/setup.js:beforeAll
  - file:///test/working/hooks/team:blue/result.py:afterEach
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/setup.js', 'hooks/team:blue/result.py']);
  });

  it('should extract default-export extensions without a hook suffix', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/default.js
  - file:///test/working/hooks/absolute-default.js
  - "file://hooks/trailing-default.js:"
commandLineOptions:
  extension:
    - file://hooks/cli-default.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'hooks/default.js',
      'hooks/absolute-default.js',
      'hooks/trailing-default.js',
      'hooks/cli-default.js',
    ]);
  });

  it('should preserve colons in default-export extension paths', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/team:blue/result.js
  - file://hooks/result:blue.js
  - file://hooks/team:green/result.py
  - file://hooks/result:green.py
commandLineOptions:
  extension:
    - file://hooks/cli:blue/result.mjs
    - file://hooks/cli-result:green.py
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'hooks/team:blue/result.js',
      'hooks/result:blue.js',
      'hooks/team:green/result.py',
      'hooks/result:green.py',
      'hooks/cli:blue/result.mjs',
      'hooks/cli-result:green.py',
    ]);
  });

  it('should conservatively watch the workspace for executable config files', () => {
    mockFs.readFileSync.mockReturnValue(
      "module.exports = { extensions: ['file://hooks/policy.js:beforeAll'] };",
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.cjs');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for referenced extension lists', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  $ref: '#/shared/extensions'
commandLineOptions:
  extension:
    $ref: '#/shared/cliExtensions'
shared:
  extensions:
    - file://hooks/shared.js:beforeAll
  cliExtensions:
    - file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for env-templated extensions', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - file://{{ env.HOOK_PATH }}:beforeAll
commandLineOptions:
  extension:
    - file://{{ env.CLI_HOOK_PATH }}:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for fully templated extension URLs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - '{{ env.HOOK_URI }}'
  - '{{ env.SCHEME }}://hooks/policy.js:beforeAll'
commandLineOptions:
  extension:
    - '{{ env.CLI_HOOK_URI }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should watch the repository workspace for unresolved extensions in an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://{{ env.HOOK_PATH }}:beforeAll
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve checkout extension hooks from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/policy.js:beforeAll
`);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/policy.js']);
  });

  it('should preserve checkout extension glob matches from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/hooks/policy.js']);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/policy.js');
    expect(deps).toContain('hooks/');
  });

  it('should preserve an extension glob base when the last hook is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/']);
  });

  it('should preserve a filesystem-root glob base as a directory', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/promptfooconfig.yaml');

    expect(deps).toEqual(['../../']);
  });

  it('should conservatively watch the workspace for referenced commandLineOptions', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
commandLineOptions:
  $ref: '#/shared/options'
shared:
  options:
    extension:
      - file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve dependencies when commandLineOptions is a scalar', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
commandLineOptions: inline-options
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore a scalar config without throwing during extension extraction', () => {
    mockFs.readFileSync.mockReturnValue('inline-config');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the workspace for a referenced root config', () => {
    mockFs.readFileSync.mockReturnValue(`
$ref: '#/shared/config'
shared:
  config:
    extensions:
      - file://hooks/shared.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for referenced extension entries', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - $ref: '#/shared/extension'
commandLineOptions:
  extension:
    - $ref: '#/shared/cliExtension'
shared:
  extension: file://hooks/shared.js:beforeAll
  cliExtension: file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should ignore remote and malformed extension entries', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - https://example.com/hook.js:beforeAll
  - inline-extension
  - 42
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should reject extension hook files outside the repository', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://../secrets/hook.js:beforeAll
  - file:///test/secrets/hook.js:beforeAll
  - file://C:/secrets/hook.js
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'must stay within the checkout or config directory',
      ),
    );
  });

  it('should preserve canonical Windows file URLs without a hook suffix during containment checks', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///C:/repo/hooks/default.js
commandLineOptions:
  extension:
    - file:///C:/repo/hooks/cli-default.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('C:/repo/hooks/default.js'),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('C:/repo/hooks/cli-default.js'),
    );
  });

  it('should cap warnings for many foreign Windows-absolute dependencies', () => {
    const extensions = Array.from(
      { length: 100 },
      (_, index) => `  - file:///C:/repo/hooks/policy-${index}.js`,
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`extensions:\n${extensions}`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledTimes(11);
    expect(core.warning).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Suppressing further unsafe config dependency warnings',
      ),
    );
  });

  it('should cap warnings for many unsafe brace alternatives', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    const alternatives = Array.from(
      { length: 100 },
      (_, index) => `../outside-${index}`,
    ).join(',');
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://{${alternatives}}/policy.py`,
    );
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledTimes(11);
    expect(core.warning).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Suppressing further unsafe config dependency warnings',
      ),
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

  it('should fail closed when dependency extraction throws after parsing a config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/policy.js:beforeAll
`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('glob failed\n::error::forged-extractor');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-extractor');
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
nunjucksFilters:
  empty: ''
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
    mockGlob.sync.mockReturnValue(['/test/config/providers/custom.py']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.py',
      '../config/providers/',
    ]);
  });

  it('should not enumerate unsafe alternatives hidden by mismatched brace glob closers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{provider),../providers}/*.py
extensions:
  - file://{hook),/absolute}/*.js
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('{') || value.includes('}'),
    );
    mockGlob.sync.mockImplementation((pattern: string) => {
      if (
        pattern.includes('/test/providers/') ||
        pattern.includes('/absolute/') ||
        pattern.includes('../providers') ||
        pattern.includes(',/absolute')
      ) {
        throw new Error('unsafe glob alternative was enumerated');
      }
      return pattern.endsWith('*.py')
        ? ['/test/working/provider)/safe.py']
        : ['/test/working/hook)/safe.js'];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'provider)/safe.py',
      'provider)/',
      'hook)/safe.js',
      'hook)/',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unsafe config dependency glob pattern'),
    );
  });

  it('should preserve valid brace, character-class, and literal-closing-parenthesis glob paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{foo,bar}/[!)]*.py
  - file://[!}]*.py
  - file://literal).py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('{') || value.includes('['),
    );
    mockGlob.sync.mockImplementation((pattern: string) => {
      if (pattern.includes('/foo/')) {
        return ['/test/working/foo/safe.py'];
      }
      if (pattern.includes('/bar/')) {
        return ['/test/working/bar/safe.py'];
      }
      return ['/test/working/class-safe.py'];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'foo/safe.py',
      'bar/safe.py',
      'foo/',
      'bar/',
      'class-safe.py',
      './',
      'literal).py',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should fail closed on checkout glob symlinks that resolve outside both dependency roots', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/hooks/safe.js',
      '/test/working/hooks/escaped.js',
    ]);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.endsWith('/escaped.js') ? '/test/outside/secret.js' : value,
    );

    expect(() =>
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toThrow(
      'An existing config dependency resolves outside an allowed dependency root.',
    );
  });

  it('should preserve safe glob siblings when realpath is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/hooks/safe.js',
      '/test/working/hooks/denied.js',
    ]);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw new Error('EACCES: denied\n::error::forged-annotation');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).toContain('hooks/');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve a config dependency glob match',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-annotation');
  });

  it('should ignore dependencies from an in-checkout config root that resolves outside the checkout', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/shared-link/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.startsWith('/test/working/shared-link')
        ? value.replace('/test/working/shared-link', '/test/shared-real')
        : value,
    );

    const deps = extractFileDependencies(
      '/test/working/shared-link/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring an in-checkout config directory that resolves outside the checkout.',
    );
  });

  it('should fail closed with a constant warning when an in-checkout config root cannot be resolved', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/shared-link/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value === '/test/working/shared-link') {
        throw new Error('EACCES: denied\n::error::forged-config-root');
      }
      return value;
    });

    const deps = extractFileDependencies(
      '/test/working/shared-link/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Unable to resolve an in-checkout config directory. Ignoring its dependencies.',
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-config-root');
  });

  it('should preserve checkout glob matches when an unused external root is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value === '/test/shared') {
        throw new Error('EACCES: denied\n::error::forged-root');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).toContain('hooks/');
    expect(mockFs.realpathSync).toHaveBeenCalledWith('/test/shared');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unable to resolve an allowed dependency root'),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-root');
  });

  it('should fail closed on direct checkout extension symlinks that resolve outside both dependency roots', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/escaped.js:beforeAll
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.endsWith('/escaped.js') ? '/test/outside/secret.js' : value,
    );

    expect(() =>
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toThrow(
      'An existing config dependency resolves outside an allowed dependency root.',
    );
  });

  it('should preserve safe direct extension siblings when realpath is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/denied.js:beforeAll
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw new Error('EACCES: denied\n::error::forged-direct');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve an existing config dependency',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-direct');
  });

  it('should not treat an inaccessible direct dependency as nonexistent', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/denied.js:beforeAll
`);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.lstatSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw Object.assign(
          new Error('EACCES: denied\n::error::forged-lstat'),
          { code: 'EACCES' },
        );
      }
      return {} as fs.Stats;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve an existing config dependency',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-lstat');
  });

  it('should preserve a direct dependency whose parent is not yet a directory', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/future.js:beforeAll
`);
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/future.js']);
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
