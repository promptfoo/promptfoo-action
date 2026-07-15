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
    mockFs.realpathSync.mockImplementation((filePath: string) => filePath);
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    delete process.env.PROVIDER_PATH;
    delete process.env.PROVIDER_FILE;
    delete process.env.PROVIDER_TOOLS_PATH;
    delete process.env.MISSING_PROVIDER;
    delete process.env.PROVIDER_REV;
    delete process.env.PROVIDER_FLAG;
    delete process.env.API_KEY;
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

  it('should extract a scalar file provider', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://provider.js
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/provider.js']);
  });

  it('should strip a function selector from a scalar file provider', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://providers/custom.py:call_api
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py']);
  });

  it('should strip a top-level TypeScript provider selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: file://providers/custom.ts:callApi
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.ts']);
  });

  it('should strip function selectors from Go and Ruby file providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/main.go:CallApi
  - id: file://providers/provider.rb:generate_response
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/main.go',
      '../config/providers/provider.rb',
    ]);
  });

  it('should preserve an unsupported Go provider selector', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/main.go:generate',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/main.go:generate']);
  });

  it('should preserve an absolute in-workspace file provider path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file:///test/working/providers/custom.py:call_api
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/custom.py']);
  });

  it('should preserve a Windows drive colon in a file provider path', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mockFs.readFileSync.mockReturnValue(
        'providers: file:///C:/repository/providers/provider.py:custom_call',
      );

      const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

      expect(deps).toEqual(['../config/C:/repository/providers/provider.py']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('should strip class-method selectors from Python and Ruby providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py:MyProvider.call_api
  - file://providers/custom.rb:MyProvider.generate_response
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.py',
      '../config/providers/custom.rb',
    ]);
  });

  it('should strip Ruby bang and predicate method selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://providers/custom.rb:call_api!"
  - "file://providers/other.rb:MyProvider.available?"
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.rb',
      '../config/providers/other.rb',
    ]);
  });

  it('should strip a Unicode Python provider method selector', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: "file://providers/custom.py:café"',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py']);
  });

  it('should preserve an invalid provider function selector as part of the path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://providers/custom.py:not-a-function
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py:not-a-function']);
  });

  it('should preserve a selector on a non-executable provider path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://providers/custom.yaml:call_api
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.yaml:call_api']);
  });

  it('should extract scalar file targets', () => {
    mockFs.readFileSync.mockReturnValue(`
targets: file://targets/custom.py:call_api
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/targets/custom.py']);
  });

  it('should extract nested references from a provider config file', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers.yaml';
      }
      if (filePath.endsWith('providers.yaml')) {
        return `
- id: file://providers/custom.py:call_api
  config:
    tools: file://fixtures/tools.yaml
`;
      }
      if (filePath.endsWith('tools.yaml')) {
        return 'schema: file://fixtures/schema.json';
      }
      return '{}';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers.yaml',
      '../config/providers/custom.py',
      '../config/fixtures/tools.yaml',
      '../config/fixtures/schema.json',
    ]);
  });

  it('should resolve an env-templated provider path inside the workspace', () => {
    process.env.PROVIDER_PATH = '../providers/custom.py:call_api';
    mockFs.readFileSync.mockReturnValue(
      'providers: "file://{{ env.PROVIDER_PATH }}"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/custom.py']);
  });

  it('should resolve whole-value env templates to file providers', () => {
    process.env.PROVIDER_PATH = 'file://providers/scalar.py:call_api';
    process.env.PROVIDER_FILE = 'file://providers/wrapped.py:call_api';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROVIDER_PATH }}"
  - id: "{{ env.PROVIDER_FILE }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/scalar.py',
      'evals/providers/wrapped.py',
    ]);
  });

  it('should resolve bracket and default-filter whole-value provider templates', () => {
    process.env.PROVIDER_PATH = 'file://providers/hidden.py:call_api';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env['PROVIDER_PATH'] }}"
  - id: "{{ env.PROVIDER_PATH | default('file://providers/default.py') }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/hidden.py']);
  });

  it('should conservatively watch provider paths and map keys with control tags', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://{% if env.PROVIDER_PATH %}providers/custom.py{% endif %}"
  - "{% if env.PROVIDER_PATH %}file://providers/mapped.py{% endif %}":
      config:
        temperature: 0
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch nested provider paths and map keys with comment tags', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      tools: file://tools/{# comment #}custom.js:getTools
  - "{# comment #}file://providers/mapped.py:call_api":
      config:
        temperature: 0
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should not watch the workspace for arbitrary nested provider templates', () => {
    process.env.API_KEY = 'secret-token';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    label: "{{ 'file://display/' + env.API_KEY }}"
    config:
      header: "{% if vars.FLAG %}enabled{% endif %}"
      headers:
        "{{ env.API_KEY }}": literal
        Authorization: "Bearer {{ env.API_KEY }}"
        X-Message: "{{ 'file://display/' + env.API_KEY }}"
      body:
        prompt: "hello {{ prompt }} {{ env.API_KEY | upper }}"
        message: "{{ 'file://display/' + env.API_KEY }}"
        metadata:
          type: file
          path: "{{ env.API_KEY | upper }}"
  - id: https://example.test
    env:
      BASE_URL: https://api.example.test
    config:
      method: GET
      url: "{{ env.BASE_URL + '/v1/chat' }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract HTTP file-auth dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/typescript
    config:
      method: GET
      auth:
        type: file
        path: ./auth/get-token.ts
  - id: https://example.test/python
    config:
      method: GET
      auth:
        type: file
        path: ./auth/get-token.py
  - id: https://example.test/named
    config:
      method: GET
      auth:
        type: file
        path: file://auth/named-token.ts:getToken
  - https://example.test/mapped:
      config:
        method: GET
        auth:
          type: file
          path: ./auth/mapped-token.ts
  - id: "{{ env.HTTP_PROVIDER_ID }}"
    env:
      HTTP_PROVIDER_ID: https://example.test/templated
    config:
      method: GET
      auth:
        type: file
        path: ./auth/templated-token.ts
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/auth/get-token.ts',
      'evals/auth/get-token.py',
      'evals/auth/named-token.ts',
      'evals/auth/mapped-token.ts',
      'evals/auth/templated-token.ts',
    ]);
  });

  it('should ignore HTTP-shaped plain file fields on non-HTTP providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      auth:
        type: file
        path: ./auth/not-http.ts
      tls:
        caPath: ./credentials/not-http.pem
      signatureAuth:
        privateKeyPath: ./credentials/not-http.key
      multipart:
        parts:
          - kind: file
            name: not-http
            source:
              type: path
              path: ./fixtures/not-http.pdf
  - custom:provider:
      config:
        auth:
          type: file
          path: ./auth/not-http-map.ts
        multipart:
          parts:
            - kind: file
              name: not-http-map
              source:
                type: path
                path: ./fixtures/not-http-map.pdf
  - id: https://example.test/body
    config:
      method: POST
      body:
        nested_provider:
          id: openai:gpt-4
          config:
            auth:
              type: file
              path: ./auth/body-false.ts
            tls:
              caPath: ./credentials/body-false.pem
            multipart:
              parts:
                - kind: file
                  name: body-false
                  source:
                    type: path
                    path: ./fixtures/body-false.pdf
        payload:
          config:
            auth:
              type: file
              path: ./auth/payload-false.ts
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
  });

  it('should honor provider env for an HTTP file-auth path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    env:
      AUTH_PATH: ./auth/current-token.ts
    config:
      method: GET
      auth:
        type: file
        path: "{{ env.AUTH_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/auth/current-token.ts']);
  });

  it('should resolve a whitespace-controlled default env template in an HTTP file-auth path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      method: GET
      auth:
        type: file
        path: "{{- env['MISSING_PROVIDER'] | d('./auth/default-token.ts', true) -}}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/auth/default-token.ts']);
  });

  it('should conservatively watch a computed HTTP file-auth path', () => {
    process.env.PROVIDER_FILE = 'token.ts:getToken';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      method: GET
      auth:
        type: file
        path: "{{ 'file://auth/' + env.PROVIDER_FILE }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should reject an HTTP file-auth path outside the workspace without leaking it', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      method: GET
      auth:
        type: file
        path: ../../outside/secret-token.ts
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping unsafe config dependency content; its path may still be tracked for change detection',
      ),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('secret-token'),
    );
  });

  it('should extract plain and env-templated HTTP credential paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/signature
    env:
      PRIVATE_KEY_PATH: ./credentials/from-env.pem
    config:
      method: GET
      signatureAuth:
        id: customer-signing-key
        privateKeyPath: "{{ env.PRIVATE_KEY_PATH }}"
        keystorePath: ./credentials/keystore.jks
        pfxPath: ./credentials/signature.pfx
        certPath: ./credentials/signature.crt
        keyPath: ./credentials/signature.key
  - id: https://example.test/tls
    config:
      method: GET
      tls:
        caPath: ./credentials/ca.pem
        certPath: ./credentials/client.crt
        keyPath: ./credentials/client.key
        pfxPath: ./credentials/client.pfx
        jksPath: ./credentials/client.jks
  - id: https://example.test/tls-env
    env:
      TLS_JKS_PATH: ./credentials/from-env.jks
    config:
      method: GET
      tls:
        jksPath: "{{ env.TLS_JKS_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/credentials/from-env.pem',
      'evals/credentials/keystore.jks',
      'evals/credentials/signature.pfx',
      'evals/credentials/signature.crt',
      'evals/credentials/signature.key',
      'evals/credentials/ca.pem',
      'evals/credentials/client.crt',
      'evals/credentials/client.key',
      'evals/credentials/client.pfx',
      'evals/credentials/client.jks',
      'evals/credentials/from-env.jks',
    ]);
  });

  it('should extract plain and env-templated HTTP multipart upload paths', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/example.txt
providers:
  - id: https://example.test/upload
    env:
      UPLOAD_PATH: ./fixtures/from-env.pdf
    config:
      method: POST
      multipart:
        parts:
          - kind: file
            name: report
            source:
              type: path
              path: ./fixtures/report.pdf
          - kind: file
            name: env-report
            source:
              type: path
              path: "{{ env.UPLOAD_PATH }}"
          - kind: file
            name: file-url-report
            source:
              type: path
              path: file://fixtures/from-file-url.pdf
          - kind: file
            name: generated
            source:
              type: generated
              path: ./fixtures/ignored.pdf
      body:
        parts:
          - source:
              type: path
              path: ./fixtures/body-data.pdf
        multipart:
          parts:
            - kind: file
              name: body-metadata
              source:
                type: path
                path: ./fixtures/body-metadata.pdf
      metadata:
        multipart:
          parts:
            - kind: file
              name: metadata
              source:
                type: path
                path: ./fixtures/metadata.pdf
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/fixtures/report.pdf',
      'evals/fixtures/from-env.pdf',
      'evals/fixtures/from-file-url.pdf',
    ]);
  });

  it('should revisit an aliased HTTP file-auth value in its auth context', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      method: GET
      other: &file_auth
        type: file
        path: ./auth/aliased-token.ts
      auth: *file_auth
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/auth/aliased-token.ts']);
  });

  it('should avoid retraversing a repeated provider alias in the same context', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - &provider
    id: file://providers/custom.py:call_api
  - *provider
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/custom.py']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize a Windows drive after provider-path templating', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      process.env.PROVIDER_PATH =
        '/C:/repository/providers/provider.py:custom_call';
      mockFs.readFileSync.mockReturnValue(
        'providers: "file://{{ env.PROVIDER_PATH }}"',
      );

      const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

      expect(deps).toEqual(['../config/C:/repository/providers/provider.py']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('should prefer top-level config env for templated provider paths', () => {
    process.env.PROVIDER_PATH = '../providers/old.py:call_api';
    process.env.PROVIDER_FILE = 'current.py:call_api';
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_PATH: ../providers/{{ env.PROVIDER_FILE }}
  IGNORED_NUMBER: 7
  IGNORED_OBJECT:
    nested: true
providers: "file://{{ env.PROVIDER_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/current.py']);
  });

  it('should conservatively watch unresolved templates in config env', () => {
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_PATH: ../providers/{{ env.MISSING_PROVIDER }}
providers: "file://{{ env.PROVIDER_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should honor numeric and boolean config env overrides', () => {
    process.env.PROVIDER_REV = '1';
    process.env.PROVIDER_FLAG = 'false';
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_REV: 2
  PROVIDER_FLAG: true
providers:
  - "file://providers/v{{ env.PROVIDER_REV }}.py:call_api"
  - "file://providers/{{ env.PROVIDER_FLAG }}.py:call_api"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/v2.py', 'evals/providers/true.py']);
  });

  it('should resolve env-templated nested provider dependencies', () => {
    process.env.PROVIDER_TOOLS_PATH = '../shared/tools.js:getTools';
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : 'config:\n  tools: "file://{{ env.PROVIDER_TOOLS_PATH }}"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml', 'shared/tools.js']);
  });

  it('should prefer provider env for templated nested dependencies', () => {
    process.env.PROVIDER_TOOLS_PATH = '../tools/old.ts:getTools';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    env:
      PROVIDER_TOOLS_PATH: ../tools/current.ts:getTools
    config:
      tools: "file://{{ env.PROVIDER_TOOLS_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['tools/current.ts']);
  });

  it('should ignore ordinary nested env objects when resolving provider dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    env:
      PROVIDER_TOOLS_PATH: current.ts
    config:
      env:
        PROVIDER_TOOLS_PATH: default.ts
      tools: "file://tools/{{ env.PROVIDER_TOOLS_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/tools/current.ts']);
  });

  it('should resolve bracket and default-filter env templates in nested provider dependencies', () => {
    process.env.PROVIDER_TOOLS_PATH = 'file://tools/current.ts:getTools';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      tools: "{{ env['PROVIDER_TOOLS_PATH'] }}"
  - id: openai:gpt-4
    config:
      tools: "{{ env.MISSING_PROVIDER | default('file://tools/default.ts:getTools') }}"
  - id: openai:gpt-4
    config:
      tools: "{{ env['MISSING_PROVIDER'] | default('file://tools/bracket-default.ts:getTools') }}"
  - id: openai:gpt-4
    config:
      tools: "{{- env['MISSING_PROVIDER'] | d('file://tools/whitespace-default.ts:getTools', true) -}}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tools/current.ts',
      'evals/tools/default.ts',
      'evals/tools/bracket-default.ts',
      'evals/tools/whitespace-default.ts',
    ]);
  });

  it('should honor a falsy default-filter env template in nested provider dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    env:
      PROVIDER_TOOLS_PATH: ''
    config:
      tools: "{{ env.PROVIDER_TOOLS_PATH | default('file://tools/default.ts:getTools', true) }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/tools/default.ts']);
  });

  it('should honor boolean and numeric falsy config env values in default-filter provider dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
env:
  BOOLEAN_TOOLS_PATH: false
  NUMERIC_TOOLS_PATH: 0
providers:
  - id: openai:gpt-4
    config:
      tools: "{{ env.BOOLEAN_TOOLS_PATH | default('file://tools/boolean-default.ts:getTools', true) }}"
  - id: openai:gpt-4
    config:
      tools: "{{ env.NUMERIC_TOOLS_PATH | default('file://tools/numeric-default.ts:getTools', true) }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/tools/boolean-default.ts',
      'evals/tools/numeric-default.ts',
    ]);
  });

  it('should conservatively watch unsupported leading env templates in file-bearing provider fields', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      tools: "{{ env.PROVIDER_TOOLS_PATH | custom_filter }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch file-bearing provider expressions with a leading literal', () => {
    process.env.PROVIDER_TOOLS_PATH = 'current.ts:getTools';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      tools: "{{ 'file://tools/' + env.PROVIDER_TOOLS_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch a computed file template in a provider-specific config field', () => {
    process.env.PROVIDER_FILE = 'settings.json';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: custom:provider
    config:
      settings: "{{ 'file://config/' + env.PROVIDER_FILE }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch an env-built file template in a provider-specific config field', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: custom:provider
    env:
      CONFIG_DIR: file://config
      SETTINGS_FILE: settings.json
    config:
      settings: "{{ env.CONFIG_DIR + '/' + env.SETTINGS_FILE }}"
  - id: custom:provider
    env:
      CONFIG_DIR: file://config
      SETTINGS_FILE: bracket-settings.json
    config:
      settings: "{{ env['CONFIG_DIR'] + '/' + env['SETTINGS_FILE'] }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch computed nested response-schema templates', () => {
    process.env.PROVIDER_FILE = 'current.json';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      response_format:
        type: json_schema
        schema: "{{ 'file://schemas/' + env.PROVIDER_FILE }}"
  - id: openai:gpt-4
    config:
      response_format:
        type: json_schema
        json_schema:
          schema: "{{ 'file://schemas/' + env.PROVIDER_FILE }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should resolve the dependency root real path only once per extraction', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/one.py
  - file://providers/two.py
  - file://providers/three.py
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/one.py',
      'evals/providers/two.py',
      'evals/providers/three.py',
    ]);
    expect(
      mockFs.realpathSync.mock.calls.filter(
        (call) => call[0] === '/test/working',
      ),
    ).toHaveLength(1);
  });

  it('should prefer caller env over external provider-file defaults', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
providers:
  - id: file://providers.yaml
    env:
      PROVIDER_FILE: prod
`
        : `
env:
  PROVIDER_FILE: dev
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml', 'evals/providers/prod.py']);
  });

  it('should prefer bare provider-file env over top-level config env', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
env:
  PROVIDER_FILE: suite
providers: file://providers.yaml
`
        : `
env:
  PROVIDER_FILE: provider
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers.yaml',
      'evals/providers/provider.py',
    ]);
  });

  it('should prefer bare provider-file env in an array over top-level config env', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
env:
  PROVIDER_FILE: suite
providers:
  - file://providers.yaml
`
        : `
env:
  PROVIDER_FILE: provider
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers.yaml',
      'evals/providers/provider.py',
    ]);
  });

  it('should prefer suite env for a wrapped provider-file without local env', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
env:
  PROVIDER_FILE: suite
providers:
  - id: file://providers.yaml
`
        : `
env:
  PROVIDER_FILE: provider
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml', 'evals/providers/suite.py']);
  });

  it('should revisit a provider file when bare and wrapped references share an env context', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
env:
  PROVIDER_FILE: suite
providers:
  - file://providers.yaml
  - id: file://providers.yaml
`
        : `
env:
  PROVIDER_FILE: provider
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers.yaml',
      'evals/providers/provider.py',
      'evals/providers/suite.py',
    ]);
  });

  it('should prefer an outer provider-file env over nested provider-file defaults', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
env:
  PROVIDER_FILE: suite
providers: file://outer.yaml
`;
      }
      if (filePath.endsWith('outer.yaml')) {
        return `
env:
  PROVIDER_FILE: outer
id: file://inner.yaml
`;
      }
      return `
env:
  PROVIDER_FILE: inner
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/outer.yaml',
      'evals/inner.yaml',
      'evals/providers/outer.py',
    ]);
  });

  it('should revisit provider files under distinct env contexts', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
providers:
  - id: file://providers.yaml
    env:
      PROVIDER_FILE: first
  - id: file://providers.yaml
    env:
      PROVIDER_FILE: second
`
        : 'id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers.yaml',
      'evals/providers/first.py',
      'evals/providers/second.py',
    ]);
  });

  it('should revisit aliased provider values under distinct env contexts', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    env:
      PROVIDER_FILE: first
    config: &shared
      tools: "file://tools/{{ env.PROVIDER_FILE }}.ts:getTools"
  - id: openai:gpt-4
    env:
      PROVIDER_FILE: second
    config: *shared
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/tools/first.ts', 'evals/tools/second.ts']);
  });

  it('should distinguish callable nested JavaScript from literal Ruby paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : `
config:
  tools: file://shared/tools.cjs:get-tools
  template: file://templates/context.rb:prod
`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers.yaml',
      '../config/shared/tools.cjs',
      '../config/templates/context.rb:prod',
    ]);
  });

  it('should reject unsafe env-templated provider paths without leaking values', () => {
    process.env.PROVIDER_PATH = '../../outside/SECRET_MARKER.py';
    mockFs.readFileSync.mockReturnValue(
      'providers: "file://{{ env.PROVIDER_PATH }}"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should not leak an unsafe literal provider path in warnings', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://../../outside/SECRET_MARKER.yaml',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should emit one sanitized warning for repeated unsafe dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://../../outside/FIRST_SECRET_MARKER.py
  - file://../../outside/SECOND_SECRET_MARKER.py
prompts:
  - file://../../outside/PROMPT_SECRET_MARKER.txt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping unsafe config dependency content; its path may still be tracked for change detection',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should not treat provider env values as file dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    env:
      TOKEN_FILE: file://../../outside/SECRET_MARKER.txt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the workspace for unresolved provider templates', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: "file://{{ env.PROVIDER_PATH }}"',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should extract nested references from matched provider config globs', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/provider_*.yaml';
      }
      return 'config:\n  tools: file://shared/tools.py:get_tools';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/provider_one.yaml',
      '/test/config/providers/provider_two.yaml',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider_one.yaml',
      '../config/providers/provider_two.yaml',
      '../config/providers/',
      '../config/shared/tools.py',
    ]);
  });

  it('should extract nested references from matched JSON target config globs', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'targets: file://targets/target_*.json'
        : '{"config":{"tools":"file://shared/tools.py:get_tools"}}',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/targets/target_one.json']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/targets/target_one.json',
      '../config/targets/',
      '../config/shared/tools.py',
    ]);
  });

  it('should expand brace-only provider globs', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/provider_{one,two}.py',
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/provider_one.py',
      '/test/config/providers/provider_two.py',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider_one.py',
      '../config/providers/provider_two.py',
      '../config/providers/',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(
      mockGlob.hasMagic.mock.calls.some(
        (call) =>
          String(call[0]).includes('{one,two}') &&
          call[1]?.magicalBraces === true,
      ),
    ).toBe(true);
  });

  it('should reject escaping brace alternatives before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://{..,fixtures}/provider_*.py',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/fixtures/provider_one.py']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./', 'fixtures/provider_one.py', 'fixtures/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    const enumeratedPatterns = mockGlob.sync.mock.calls[0]?.[0];
    expect(enumeratedPatterns).toEqual([
      '/test/working/fixtures/provider_*.py',
    ]);
  });

  it('should bound brace expansion before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/provider_{1..1025}.py',
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should preserve sibling dependencies when a provider glob is oversized or invalid', () => {
    const oversizedPattern = `providers/${'x'.repeat(65537)}*.py`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/first.py
  - file://${oversizedPattern}
  - file://providers/INVALID_GLOB_SECRET_MARKER[.py
  - file://providers/second.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65536) {
        throw new TypeError('pattern is too long');
      }
      if (value.includes('INVALID_GLOB_SECRET_MARKER')) {
        throw new TypeError('INVALID_GLOB_SECRET_MARKER: invalid pattern');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/first.py',
      './',
      'evals/providers/second.py',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('INVALID_GLOB_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should preserve the watch root for an empty absolute provider glob', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file:///test/working/providers/deleted_*.yaml',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/']);
  });

  it('should preserve the pattern for an empty root provider glob', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file:///test/working/deleted_provider_*.yaml',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['deleted_provider_*.yaml']);
  });

  it('should stop safely if a provider glob has no non-glob ancestor', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers/*.yaml');
    mockGlob.hasMagic.mockReturnValue(true);
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should extract provider-map keys and nested references', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py:call_api:
      config:
        tools: file://fixtures/tools.txt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.py',
      '../config/fixtures/tools.txt',
    ]);
  });

  it('should use provider-map env for templated provider keys', () => {
    process.env.PROVIDER_PATH = '../providers/old.py:call_api';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://{{ env.PROVIDER_PATH }}":
      env:
        PROVIDER_PATH: ../providers/current.py:call_api
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/current.py']);
  });

  it('should prefer suite env for a provider-map file reference', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
env:
  PROVIDER_FILE: suite
providers:
  - file://providers.yaml:
      config:
        temperature: 0
`
        : `
env:
  PROVIDER_FILE: provider
id: "file://providers/{{ env.PROVIDER_FILE }}.py:call_api"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml', 'evals/providers/suite.py']);
  });

  it('should resolve a whole-value env template in a provider-map key', () => {
    process.env.PROVIDER_PATH = 'file://providers/custom.py:call_api';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROVIDER_PATH }}":
      config:
        temperature: 0
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/custom.py']);
  });

  it('should ignore unsafe nested references in a provider config file', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : 'config:\n  secret: file://../outside/secret.txt',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers.yaml']);
  });

  it('should ignore provider config symlinks that escape the dependency root', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers.yaml';
      }
      throw new Error('SECRET_MARKER: malformed outside config');
    });
    mockFs.realpathSync.mockImplementation((filePath: string) =>
      filePath.endsWith('providers.yaml')
        ? '/private/outside/providers.yaml'
        : filePath,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(
      mockFs.readFileSync.mock.calls.some((call) =>
        String(call[0]).includes('providers.yaml'),
      ),
    ).toBe(false);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should not expand a provider glob through an escaping symlink ancestor', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://linked-root/**/*.yaml',
    );
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.includes('*')) {
        throw Object.assign(new Error('missing glob path'), { code: 'ENOENT' });
      }
      if (filePath.endsWith('linked-root')) {
        return '/private/outside-root';
      }
      return filePath;
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/private/outside-root/secret.yaml']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should retain missing provider files when realpath reports ENOENT', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/deleted.py:call_api',
    );
    mockFs.realpathSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/', '../config/providers/deleted.py']);
  });

  it('should validate the parent when realpath reports ENOTDIR', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/deleted.py:call_api',
    );
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('deleted.py')) {
        throw Object.assign(new Error('missing'), { code: 'ENOTDIR' });
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/deleted.py']);
  });

  it('should stop safely when no provider-path ancestor can be resolved', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/deleted.py:call_api',
    );
    let rootValidated = false;
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath === '/test/config' && !rootValidated) {
        rootValidated = true;
        return filePath;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/deleted.py']);
  });

  it('should stop safely when a provider-path ancestor is inaccessible', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/private.py',
    );
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('private.py')) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/private.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping unsafe config dependency content; its path may still be tracked for change detection',
      ),
    );
  });

  it('should ignore provider files when realpath cannot validate containment', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/private.py',
    );
    mockFs.realpathSync.mockImplementation(() => {
      throw Object.assign(new Error('SECRET_MARKER: access denied'), {
        code: 'EACCES',
      });
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/', '../config/providers/private.py']);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should conservatively watch dependencies when the root real path is inaccessible', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath === '/test/repository') {
        throw Object.assign(new Error('ROOT_REALPATH_SECRET_MARKER'), {
          code: 'EACCES',
        });
      }
      return filePath;
    });
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://prompts/prompt.txt
tests:
  - vars:
      context: file://vars/context.txt
    assert:
      - type: javascript
        value: file://assertions/check.js
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('ROOT_REALPATH_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should handle recursive YAML aliases in provider config files', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - &provider
    id: file://providers/custom.py:call_api
    config:
      tools: file://shared/tools.py:get_tools
      nested: *provider
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.py',
      '../config/shared/tools.py',
    ]);
  });

  it('should conservatively stop an env-mutating recursive YAML alias', () => {
    process.env.PROVIDER_FILE = 'seed';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - &provider
    id: file://providers/custom.py:call_api
    env:
      PROVIDER_FILE: "{{ env.PROVIDER_FILE }}x"
    config:
      nested: *provider
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/custom.py', '../config/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should conservatively stop an env-mutating provider-file cycle', () => {
    process.env.PROVIDER_FILE = 'seed';
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : `
config:
  env:
    PROVIDER_FILE: "{{ env.PROVIDER_FILE }}x"
  nested: file://providers.yaml
`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers.yaml', '../config/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should conservatively bound provider dependency traversal', () => {
    const providers = Array.from(
      { length: 1100 },
      (_, index) => `  - file://providers/provider-${index}.py`,
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`providers:\n${providers}`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/');
    expect(deps.length).toBeLessThan(1101);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should stop reading provider config glob matches when traversal is bounded', () => {
    const providerConfigs = Array.from(
      { length: 1300 },
      (_, index) => `/test/config/providers/provider_${index}.yaml`,
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers/provider_*.yaml'
        : 'null',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(providerConfigs);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/');
    expect(mockFs.readFileSync.mock.calls.length).toBeLessThanOrEqual(1025);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should handle repeated and empty nested provider config files', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
targets:
  - file://providers.yaml
  - file://providers.yaml
`;
      }
      return 'null';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('should keep a provider config dependency when nested extraction fails', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
providers:
  - file://invalid-SECRET_MARKER.yaml
  - file://unreadable-SECRET_MARKER.json
`;
      }
      if (filePath.endsWith('invalid-SECRET_MARKER.yaml')) {
        throw new Error('invalid provider config');
      }
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/invalid-SECRET_MARKER.yaml',
      '../config/',
      '../config/unreadable-SECRET_MARKER.json',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested provider dependencies; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some(
          (call) =>
            String(call[0]).includes('invalid provider config') ||
            String(call[0]).includes('permission denied') ||
            String(call[0]).includes('SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should conservatively watch when a nested provider config uses an unsupported YAML tag', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : `
id: openai:gpt-4
config:
  created: !!timestamp 2025-01-01T00:00:00Z
  tools: file://tools/TIMESTAMP_SECRET_MARKER.js
`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers.yaml', '../config/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested provider dependencies; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('TIMESTAMP_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should expand a scalar file provider glob', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file://providers/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/providers/first.js',
      '/test/config/providers/second.js',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/providers/first.js');
    expect(deps).toContain('../config/providers/second.js');
    expect(deps).toContain('../config/providers/');
  });

  it('should ignore a scalar non-file provider', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: openai:gpt-4
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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
    mockFs.readFileSync.mockReturnValue(
      'invalid: yaml: ROOT_YAML_SECRET_MARKER:',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('ROOT_YAML_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should conservatively watch the workspace for an invalid root config', () => {
    mockFs.readFileSync.mockReturnValue('invalid: yaml: content:');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should handle file read errors gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/']);
  });

  it('should handle non-Error file read failures gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/']);
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

  it('should retain contained lexical prompt, variable, and assertion symlinks that escape', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://prompts/linked.txt
  - file: prompts/linked-object.txt
tests:
  - vars:
      linked: file://vars/linked.txt
      linkedObject:
        file: vars/linked-object.txt
    assert:
      - type: javascript
        value: file://assertions/linked.js
      - type: javascript
        value:
          file: assertions/linked-object.js
`);
    mockFs.realpathSync.mockImplementation((filePath: string) =>
      filePath.includes('linked') ? '/private/outside/secret' : filePath,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/linked.txt',
      '../config/prompts/linked-object.txt',
      '../config/vars/linked.txt',
      '../config/vars/linked-object.txt',
      '../config/assertions/linked.js',
      '../config/assertions/linked-object.js',
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
