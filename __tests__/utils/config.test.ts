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
    lstatSync: vi.fn(),
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
    lstatSync: Mock;
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
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    delete process.env.PROVIDER_PATH;
    delete process.env.PROVIDER_FILE;
    delete process.env.PROVIDER_TOOLS_PATH;
    delete process.env.MISSING_PROVIDER;
    delete process.env.PROVIDER_REV;
    delete process.env.PROVIDER_FLAG;
    delete process.env.PROVIDER_TEXT;
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

  it('should extract Python, Golang, and Ruby prefixed providers and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/scalar.py:build_provider
  - id: golang:providers/id.go:CustomCall
  - 'ruby:providers/map.rb:build_provider':
      config:
        temperature: 0
  - id: go:providers/not-a-provider.go:CustomCall
targets:
  - ruby:targets/scalar.rb:build_target
  - id: python:file://targets/id.py:build_target
  - 'golang:targets/map.go:BuildTarget':
      config:
        temperature: 0
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers/scalar.py',
      'evals/providers/id.go',
      'evals/providers/map.rb',
      'evals/targets/scalar.rb',
      'evals/targets/id.py',
      'evals/targets/map.go',
    ]);
  });

  it('should extract exec-prefixed providers and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - exec:scripts/provider.sh
targets:
  - id: exec:scripts/target.py
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/scripts/provider.sh',
      'evals/scripts/target.py',
    ]);
  });

  it('should conservatively watch the workspace for multi-file exec provider commands', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: exec:python scripts/provider.py config/input.json',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should strip slash and backslash selectors from JavaScript and TypeScript providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://providers/custom.cjs:checks/pass'
  - 'file://providers/custom.ts:checks\\pass'
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/providers/custom.cjs', 'evals/providers/custom.ts']);
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

  it('should map a direct workspace-root directory dependency to the root sentinel', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://.');
    mockFs.statSync.mockImplementation(
      (filePath: string) =>
        ({
          isDirectory: () => filePath === '/test/working',
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should extract checkout dependencies from a config outside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/direct.py:call_api
  - file:///test/working/providers/glob_*.py
  - id: https://example.test/upload
    config:
      method: POST
      multipart:
        parts:
          - kind: file
            name: report
            source:
              type: path
              path: /test/working/fixtures/report.pdf
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/glob_current.py']);

    const deps = extractFileDependencies(
      '/private/config/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'providers/direct.py',
      'providers/glob_current.py',
      'providers/',
      'fixtures/report.pdf',
    ]);
  });

  it('should conservatively watch the checkout for unresolved external-config dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_ROOT: /test/working/providers
providers:
  - file:///test/working/providers/BROKEN_SECRET_MARKER[.py
  - "{{ 'file://' + env.PROVIDER_ROOT + '/computed.py:call_api' }}"
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('BROKEN_SECRET_MARKER')) {
        throw new TypeError('BROKEN_SECRET_MARKER: invalid pattern');
      }
      return false;
    });

    const deps = extractFileDependencies(
      '/private/config/promptfooconfig.yaml',
    );

    expect(deps).toContain('./');
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('BROKEN_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should track checkout targets reached through an external-config symlink', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///private/config/link-to-repo/providers/direct.py:call_api
  - file:///private/config/link-to-repo/providers/glob_*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/private/config/link-to-repo/providers/glob_current.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.includes('*')) {
        throw Object.assign(new Error('missing glob path'), { code: 'ENOENT' });
      }
      if (filePath.includes('/private/config/link-to-repo')) {
        return filePath.replace(
          '/private/config/link-to-repo',
          '/test/working',
        );
      }
      return filePath;
    });

    const deps = extractFileDependencies(
      '/private/config/promptfooconfig.yaml',
    );

    expect(deps).toContain('providers/direct.py');
    expect(deps).toContain('providers/glob_current.py');
    expect(deps).toContain('providers/');
  });

  it('should not read nested dependencies when an in-workspace config directory resolves outside the checkout', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers.yaml';
      }
      if (filePath.endsWith('providers.yaml')) {
        return 'config:\n  tools: file://tools/helper.js:loadTools';
      }
      throw new Error(`UNEXPECTED_READ_SECRET_MARKER: ${filePath}`);
    });
    mockFs.realpathSync.mockImplementation((filePath: string) =>
      filePath.startsWith('/test/working/evals')
        ? filePath.replace('/test/working/evals', '/private/config')
        : filePath,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping unsafe config dependency content; its path may still be tracked for change detection',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('UNEXPECTED_READ_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should not read a dangling provider-config symlink as a missing file', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/dangling.yaml';
      }
      throw new Error('DANGLING_READ_SECRET_MARKER');
    });
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('dangling.yaml')) {
        throw Object.assign(new Error('missing target'), { code: 'ENOENT' });
      }
      return filePath;
    });
    mockFs.lstatSync.mockImplementation(
      (filePath: string) =>
        ({
          isSymbolicLink: () => filePath.endsWith('dangling.yaml'),
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/dangling.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) =>
          String(call[0]).includes('DANGLING_READ_SECRET_MARKER'),
        ),
    ).toBe(false);
  });

  it('should not read a missing provider path when lstat cannot validate it', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://providers/private.yaml';
      }
      throw new Error('LSTAT_READ_SECRET_MARKER');
    });
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('private.yaml')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return filePath;
    });
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('LSTAT_SECRET_MARKER'), {
        code: 'EACCES',
      });
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/private.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
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

  it('should normalize Windows file URL drives for prompt, variable, and assertion dependencies', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mockFs.readFileSync.mockReturnValue(`
prompts:
  - file:///C:/repository/prompts/prompt.txt
tests:
  - vars:
      context: file:///C:/repository/vars/context.txt
    assert:
      - type: javascript
        value: file:///C:/repository/assertions/check.js
`);

      const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

      expect(deps).toEqual([
        '../config/C:/repository/prompts/prompt.txt',
        '../config/C:/repository/vars/context.txt',
        '../config/C:/repository/assertions/check.js',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('should preserve a safe numeric dependency brace range on Windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mockFs.readFileSync.mockReturnValue(
        'providers: file://providers/provider_{1..8}.py',
      );
      mockGlob.hasMagic.mockImplementation(
        (value: string, options?: { magicalBraces?: boolean }) =>
          options?.magicalBraces === true && value.includes('{'),
      );

      const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

      expect(deps).toEqual(['../config/providers/']);
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

  it('should conservatively watch a Nunjucks block that can emit a file reference without widening ordinary filtered env text', () => {
    mockFs.readFileSync.mockReturnValueOnce(`
providers:
  - id: openai:gpt-4
    config:
      tools: "{% if env.ENABLED %}file://tools/current.ts:getTools{% endif %}"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);

    process.env.PROVIDER_TEXT = 'not a file';
    mockFs.readFileSync.mockReturnValueOnce(`
providers:
  - id: openai:gpt-4
    config:
      tools: "{{ env.PROVIDER_TEXT | upper }}"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
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

  it('should extract HTTP validateStatus file dependencies with an optional function selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/default-validator
    config:
      validateStatus: file://validators/default-status.js
  - id: https://example.test/named-validator
    config:
      validateStatus: file://validators/named-status.js:validate
  - id: https://example.test/slash-validator
    config:
      validateStatus: 'file://validators/slash-status.js:checks/pass'
  - id: https://example.test/backslash-validator
    config:
      validateStatus: 'file://validators/backslash-status.ts:checks\\pass'
  - id: https://example.test/templated-validator
    env:
      STATUS_PATH: file://validators/templated-status.js:validate
    config:
      validateStatus: "{{ env.STATUS_PATH }}"
  - id: https://example.test/literal-validator
    config:
      validateStatus: file://validators/status.JS:validate
  - id: https://example.test/python-literal-validator
    config:
      validateStatus: file://validators/status.py:validate
  - id: https://example.test/empty-literal-validator
    config:
      validateStatus: 'file://validators/status-empty.js:'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/default-status.js',
      'evals/validators/named-status.js',
      'evals/validators/slash-status.js',
      'evals/validators/backslash-status.ts',
      'evals/validators/templated-status.js',
      'evals/validators/status.JS:validate',
      'evals/validators/status.py:validate',
      'evals/validators/status-empty.js:',
    ]);
  });

  it('should extract HTTP provider-map and target-map validator, auth, and TLS dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - https://example.test/provider-map:
      env:
        STATUS_PATH: file://validators/provider-map.js:validate
      config:
        auth:
          type: file
          path: ./auth/provider-map.ts
        tls:
          caPath: ./credentials/provider-map.pem
        validateStatus: "{{ env.STATUS_PATH }}"
targets:
  - https://example.test/target-map:
      config:
        auth:
          type: file
          path: ./auth/target-map.ts
        tls:
          certPath: ./credentials/target-map.pem
        validateStatus: file://validators/target-map.mjs:checks/pass
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/auth/provider-map.ts',
      'evals/credentials/provider-map.pem',
      'evals/validators/provider-map.js',
      'evals/auth/target-map.ts',
      'evals/credentials/target-map.pem',
      'evals/validators/target-map.mjs',
    ]);
  });

  it('should extract HTTP dependencies gated by env-rendered provider, auth, and multipart discriminators', () => {
    mockFs.readFileSync.mockReturnValue(`
env:
  HOST: example.test
  AUTH_TYPE: file
  PART_KIND: file
  SOURCE_TYPE: path
providers:
  - id: "{{ 'https://' + env.HOST }}"
    config:
      auth:
        type: "{{ env.AUTH_TYPE }}"
        path: ./auth/computed-token.ts
      multipart:
        parts:
          - kind: "{{ env.PART_KIND }}"
            name: report
            source:
              type: "{{ env.SOURCE_TYPE }}"
              path: ./fixtures/computed-report.pdf
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/auth/computed-token.ts',
      'evals/fixtures/computed-report.pdf',
    ]);
  });

  it('should extract HTTP dependencies from short HTTP provider ids with config URLs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      url: https://example.test/http
      auth:
        type: file
        path: ./auth/http-token.ts
  - id: https
    config:
      url: https://example.test/https
      auth:
        type: file
        path: ./auth/https-token.ts
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/auth/http-token.ts', 'evals/auth/https-token.ts']);
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
      validateStatus: file://validators/not-http.js:validate
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
        validateStatus: file://validators/not-http-map.js
  - id: https://example.test/body
    config:
      method: POST
      queryParams:
        validateStatus: file://validators/query-false.js
      session:
        validateStatus: file://validators/session-false.js
      tools:
        - validateStatus: file://validators/tool-false.js
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
            validateStatus: file://validators/body-false.js
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

  it('should honor provider-map env for an HTTP file-auth path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - https://example.test/mapped-env:
      env:
        AUTH_PATH: ./auth/mapped-env-token.ts
      config:
        method: GET
        auth:
          type: file
          path: "{{ env.AUTH_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/auth/mapped-env-token.ts']);
  });

  it('should apply provider-map env templates once for HTTP file dependencies', () => {
    process.env.PROVIDER_PATH = 'a';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - https://example.test/mapped-env:
      env:
        AUTH_REV: "{{ env.PROVIDER_PATH }}x"
      config:
        method: GET
        auth:
          type: file
          path: "./auth/{{ env.AUTH_REV }}.ts"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/auth/ax.ts']);
  });

  it('should extract HTTP file-auth paths from an external provider map', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : `
https://example.test/external-map:
  env:
    AUTH_PATH: ./auth/external-map-token.ts
  config:
    method: GET
    auth:
      type: file
      path: "{{ env.AUTH_PATH }}"
`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/providers.yaml',
      'evals/auth/external-map-token.ts',
    ]);
  });

  it('should extract arbitrary-extension HTTP dependencies from an external provider config', () => {
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'providers: file://providers.yaml'
        : `
id: https://example.test/upload
config:
  tls:
    caPath: ./credentials/custom.bundle
  signatureAuth:
    privateKeyPath: ./credentials/signing.material
  multipart:
    parts:
      - kind: file
        name: report
        source:
          type: path
          path: ./fixtures/report.payload
`,
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/providers.yaml',
      'evals/credentials/custom.bundle',
      'evals/credentials/signing.material',
      'evals/fixtures/report.payload',
    ]);
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
      'evals/prompts/example.txt',
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

  it('should reject mismatched glob delimiters before enumerating unsafe brace alternatives', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://{foo),../outside}/*.py'
  - 'file://{bar),/private/outside}/*.py'
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid config dependency glob; conservatively watching the dependency root',
    );
  });

  it('should preserve valid brace and character-class glob delimiters', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://{foo,bar}/[!)]*.py'
  - 'file://[!}]*.py'
  - 'file://literal).py'
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValueOnce([
      '/test/working/foo/provider.py',
      '/test/working/bar/provider.py',
    ]);
    mockGlob.sync.mockReturnValueOnce(['/test/working/visible.py']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'foo/provider.py',
      'bar/provider.py',
      'foo/',
      'bar/',
      'visible.py',
      '[!}]*.py',
      'literal).py',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
  });

  it('should reject foreign Windows absolute dependency paths on POSIX without leaking them', () => {
    if (process.platform === 'win32') return;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://C:\\private\\DRIVE_SECRET_MARKER.py'
  - 'file:///C:/private/URL_DRIVE_SECRET_MARKER.py'
  - 'file://\\\\server\\share\\UNC_SECRET_MARKER.py'
  - 'file:////server/share/URL_UNC_SECRET_MARKER.py'
  - 'file://\\private\\ROOT_SECRET_MARKER.py'
prompts:
  - file: 'C:\\private\\OBJECT_SECRET_MARKER.txt'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
    expect(core.warning).toHaveBeenCalledTimes(1);
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

  it('should reject a huge numeric dependency brace range before glob parsing', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/{1..1000000000}.py',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should reject a huge numeric dependency brace range inside a character class before glob parsing', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/[{1..1000000000}].py',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should reject an amplified zero-padded numeric dependency brace range before glob parsing', () => {
    const paddedStart = `${'0'.repeat(1024)}1`;
    mockFs.readFileSync.mockReturnValue(
      `providers: file://providers/{${paddedStart}..1024}.py`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should reject an active numeric dependency brace range after an even number of POSIX escapes', () => {
    if (process.platform === 'win32') return;
    mockFs.readFileSync.mockReturnValue(
      "providers: 'file://providers/\\\\{1..1000000000}.py'",
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should reject a multiplicative dependency brace glob before enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers: file://providers/${'{one,two}'.repeat(11)}.py`,
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        options?.magicalBraces === true && value.includes('{'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should reject an overlong dependency glob before glob parsing', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers: file://providers/${'a'.repeat(4097)}.py`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping unsafe config dependency glob; conservatively watching the dependency root',
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

    expect(deps).toEqual([
      '../config/',
      './',
      '../config/providers/deleted.py',
    ]);
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

    expect(deps).toEqual([
      '../config/',
      './',
      '../config/providers/deleted.py',
    ]);
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

    expect(deps).toEqual([
      '../config/',
      './',
      '../config/providers/private.py',
    ]);
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

    expect(deps).toEqual(['../config/providers/custom.py', '../config/', './']);
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

    expect(deps).toEqual(['../config/providers.yaml', '../config/', './']);
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
      './',
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

    expect(deps).toEqual(['../config/providers.yaml', '../config/', './']);
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

    expect(deps).toEqual(['../config/', './']);
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

    expect(deps).toEqual(['../config/', './']);
  });

  it('should handle non-Error file read failures gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/', './']);
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

  it('should reject an initial null-byte provider and an object-form null-byte prompt safely', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://\\0provider.py"
prompts:
  - file: "\\0prompt.txt"
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping unsafe config dependency content; its path may still be tracked for change detection',
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
      './',
      '../config/providers/custom.py',
      '../config/providers/',
    ]);
  });

  it('should ignore unsafe external-config glob matches and preserve safe siblings', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'providers: file://../repository/providers/*.yaml';
      }
      if (filePath.endsWith('safe.yaml')) {
        return 'config:\n  tools: file://tools/safe.py';
      }
      throw new Error(`UNSAFE_READ_SECRET_MARKER: ${filePath}`);
    });
    mockFs.realpathSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('escaped-SECRET_MARKER.yaml')) {
        return '/private/outside/ESCAPED_SECRET_MARKER.yaml';
      }
      if (filePath.endsWith('blocked-SECRET_MARKER.yaml')) {
        throw Object.assign(new Error('EACCES_SECRET_MARKER'), {
          code: 'EACCES',
        });
      }
      return filePath;
    });
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/repository/providers/escaped-SECRET_MARKER.yaml',
      '/test/repository/providers/blocked-SECRET_MARKER.yaml',
      '/test/repository/providers/safe.yaml',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/safe.yaml',
      'providers/',
      '../config/tools/safe.py',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/repository/providers/escaped-SECRET_MARKER.yaml',
      'utf-8',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/repository/providers/blocked-SECRET_MARKER.yaml',
      'utf-8',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should retain a directory sentinel when the last extension-style glob match is deleted', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers.v1/*.py');
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);
    mockFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers.v1/']);
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

  it('should extract plain prompt paths and globs', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/plain.txt
  - prompts/prompt_*.txt
  - label: inline
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/prompts/prompt_one.txt',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/plain.txt',
      'evals/prompts/prompt_one.txt',
      'evals/prompts/',
    ]);
  });

  it('should normalize scalar prompts without treating inline question marks as globs', () => {
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('?'),
    );
    mockFs.readFileSync.mockReturnValueOnce('prompts: prompts/scalar.txt');

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/scalar.txt']);

    mockFs.readFileSync.mockReturnValueOnce('prompts: What is 2+2?');

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);

    mockFs.readFileSync.mockReturnValueOnce(
      'prompts: "inline with\\nnewline and prompts/example.txt"',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should extract prompt script selectors and exec prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts/generate.cjs:buildPrompt
  - exec:scripts/generate.py:buildPrompt
  - exec:file://scripts/from-url.py:buildPrompt
  - exec:scripts/generate.sh
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/prompts/generate.cjs',
      'evals/scripts/generate.py',
      'evals/scripts/from-url.py',
      'evals/scripts/generate.sh',
    ]);
  });

  it('should extract an env-templated top-level prompt path', () => {
    mockFs.readFileSync.mockReturnValue(`
env:
  PROMPT_DIR: prompts/current
prompts: "file://{{ env.PROMPT_DIR }}/main.txt"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/current/main.txt']);

    mockFs.readFileSync.mockReturnValueOnce(`
env:
  PROMPT_FILE: prompts/current/entire.txt
prompts: "{{ env.PROMPT_FILE }}"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/current/entire.txt']);

    mockFs.readFileSync.mockReturnValueOnce(
      'prompts: "file://{{ env.MISSING_PROMPT_DIR }}/main.txt"',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract prompt-object raw/id paths and prompt-map keys', () => {
    mockFs.readFileSync.mockReturnValueOnce(`
prompts:
  - id: prompts/object-id.txt
    label: object-id
  - raw: prompts/object-raw.txt
    label: object-raw
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/object-id.txt', 'evals/prompts/object-raw.txt']);

    mockFs.readFileSync.mockReturnValueOnce(`
prompts:
  prompts/map.txt: map label
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/map.txt']);
  });

  it('should extract top-level string and generator-config test paths', () => {
    mockFs.readFileSync.mockReturnValueOnce('tests: tests/cases.yaml');

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.yaml']);

    mockFs.readFileSync.mockReturnValueOnce(`
tests:
  path: file://tests/generate.py:build_cases
  config:
    count: 1
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/generate.py']);
  });

  it('should extract spreadsheet test paths without sheet selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/cases.xlsx#Sheet One
  - tests/legacy.xls#Sheet2
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.xlsx', 'evals/tests/legacy.xls']);
  });

  it('should reject oversized and newline-bearing spreadsheet selectors before dependency parsing', () => {
    const oversizedSelector = `${'.xls#'.repeat(900)}\nSECRET_MARKER`;
    mockFs.readFileSync.mockReturnValue(`
tests:
  - "${oversizedSelector.replaceAll('\n', '\\n')}"
  - "file://tests/cases.xlsx#Sheet\\r\\nSECRET_MARKER"
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping invalid test dependency path; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should reject foreign absolute test paths without rebasing or leaking them', () => {
    if (process.platform === 'win32') return;
    mockFs.readFileSync.mockReturnValue(
      "tests: 'file://C:\\private\\TEST_PATH_SECRET_MARKER.yaml'",
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should extract nested default-test, external-test, and generator-config dependencies', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      /(?:defaults|cases)\.ya?ml$/.test(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
defaultTest: file://defaults.yaml
tests:
  - file://tests/cases.yaml
  - path: file://tests/generate.py:build_cases
    config:
      dataset: file://datasets/current.yaml
`;
      }
      if (filePath.endsWith('defaults.yaml')) {
        return `
vars:
  context: file://defaults/context.txt
assert:
  - type: javascript
    value: file://validators/default.cjs:validate
`;
      }
      return `
- vars:
    context: file://tests/context.txt
  assert:
    - type: javascript
      value: file://validators/case.py:validate
`;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/defaults.yaml',
      'evals/defaults/context.txt',
      'evals/validators/default.cjs',
      'evals/tests/cases.yaml',
      'evals/tests/context.txt',
      'evals/validators/case.py',
      'evals/tests/generate.py',
      'evals/datasets/current.yaml',
    ]);
  });

  it('should extract default and per-test assertion scoring functions', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  assertScoringFunction: file://validators/default-score.cjs:score
tests:
  - vars:
      input: example
    assertScoringFunction: file://validators/case-score.py:score
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/validators/default-score.cjs',
      'evals/validators/case-score.py',
    ]);
  });

  it('should extract extension hooks and scenario assertion scoring functions', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/before-all.cjs:beforeAll
scenarios:
  - tests:
      - vars:
          input: example
    config:
      - assertScoringFunction: file://validators/scenario-score.cjs:score
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/hooks/before-all.cjs',
      'evals/validators/scenario-score.cjs',
    ]);
  });

  it('should extract assertion files referenced from external JSONL and CSV tests', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      /cases\.(?:jsonl|csv)$/.test(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
tests:
  - file://tests/cases.jsonl
  - file://tests/cases.csv
`;
      }
      if (filePath.endsWith('cases.jsonl')) {
        return '{"assert":[{"type":"javascript","value":"file://validators/from-jsonl.cjs:validate"}]}\n';
      }
      return 'input,__expected\nexample,file://validators/from-csv.cjs:validate\n';
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/tests/cases.jsonl',
      'evals/validators/from-jsonl.cjs',
      'evals/tests/cases.csv',
      'evals/validators/from-csv.cjs',
    ]);
  });

  it('should extract vars-file paths relative to an external test file', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'tests: file://tests/cases.yaml'
        : '- vars: vars.yaml',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.yaml', 'evals/tests/vars.yaml']);
  });

  it('should extract nested string and generator test paths relative to an external test file', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      /tests\/(?:cases|nested\/child)\.yaml$/.test(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'tests: file://tests/cases.yaml';
      }
      if (filePath.endsWith('cases.yaml')) {
        return `
- nested/child.yaml
- path: nested/generate.py:build_cases
  config:
    dataset: file://datasets/current.yaml
`;
      }
      return `
vars:
  input: example
assert:
  - type: javascript
    value: file://validators/nested.cjs:validate
`;
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/tests/cases.yaml',
      'evals/tests/nested/child.yaml',
      'evals/validators/nested.cjs',
      'evals/tests/nested/generate.py',
      'evals/datasets/current.yaml',
    ]);
  });

  it('should resolve vars and providers in scenario-loaded tests from the main config base', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('scenarios/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'scenarios:\n  - tests: file://scenarios/cases.yaml'
        : '- vars: vars/context.yaml\n  provider: python:providers/scenario.py:call_api',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/scenarios/cases.yaml',
      'evals/providers/scenario.py',
      'evals/vars/context.yaml',
    ]);
  });

  it('should revisit an aliased external test file in its root and scenario base contexts', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('shared/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? `
tests: &cases file://shared/cases.yaml
scenarios:
  - tests: *cases
`
        : '- vars: vars/context.yaml\n  provider: python:providers/aliased.py:call_api',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/shared/cases.yaml',
      'evals/shared/providers/aliased.py',
      'evals/shared/vars/context.yaml',
      'evals/providers/aliased.py',
      'evals/vars/context.yaml',
    ]);

    mockFs.readFileSync.mockReturnValueOnce(`
shared: &tests
  - vars:
      input: example
    provider: python:providers/inline-alias.py:call_api
tests: *tests
scenarios:
  - tests: *tests
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/providers/inline-alias.py']);
  });

  it('should extract dependencies reachable through an external test ref', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      /tests\/(?:cases\.yaml|case(?:-relative)?\.json)$/.test(filePath),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'tests: file://tests/cases.yaml';
      }
      if (filePath.endsWith('cases.yaml')) {
        return `
- $ref: /test/working/evals/tests/case.json#/test
- $ref: evals/tests/case-relative.json#/test
- $ref: '#local-only'
`;
      }
      return `
vars:
  input: example
assert:
  - type: javascript
    value: file://validators/from-ref.cjs:validate
`;
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/tests/cases.yaml',
      'evals/tests/case.json',
      'evals/validators/from-ref.cjs',
      'evals/tests/case-relative.json',
    ]);
  });

  it('should extract per-test, default-test, and scenario provider dependencies', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
defaultTest:
  provider: file://providers/default.cjs:callApi
tests: file://tests/cases.yaml
scenarios:
  - config:
      - provider: ruby:providers/scenario.rb:call_api
`;
      }
      return `
- provider: python:../providers/test-provider.py:call_api
  vars:
    input: example
`;
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/providers/default.cjs',
      'evals/tests/cases.yaml',
      'evals/providers/test-provider.py',
      'evals/providers/scenario.rb',
    ]);
  });

  it('should extract inline, external-test, default-test, and scenario assertion grader providers', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
defaultTest:
  assert:
    - type: llm-rubric
      value: default
      provider: file://graders/default.cjs:callApi
tests:
  - assert:
      - type: llm-rubric
        value: inline
        provider:
          id: python:graders/inline.py:call_api
  - file://tests/cases.yaml
scenarios:
  - config:
      - assert:
          - type: assert-set
            assert:
              - type: llm-rubric
                value: scenario
                provider: ruby:graders/scenario.rb:call_api
`;
      }
      return `
- vars:
    input: example
  assert:
    - type: llm-rubric
      value: external
      provider: golang:graders/external.go:CallApi
`;
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/graders/default.cjs',
      'evals/graders/inline.py',
      'evals/tests/cases.yaml',
      'evals/graders/external.go',
      'evals/graders/scenario.rb',
    ]);
  });

  it('should normalize object and absolute per-test provider references while ignoring non-file providers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      id: python:/test/working/shared/absolute-provider.py:call_api
  - provider:
      config:
        temperature: 0
  - provider: echo
  - provider: 1
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['shared/absolute-provider.py']);
  });

  it('should extract an aliased scripted test provider after the alias appears under vars', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return 'tests: file://tests/cases.yaml';
      }
      return `
- vars:
    copied: &provider
      id: python:../providers/aliased.py:call_api
      config:
        temperature: 0
  provider: *provider
`;
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.yaml', 'evals/providers/aliased.py']);
  });

  it('should extract direct string and array vars-file paths', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars: vars/string.yaml
  - vars:
      - file://vars/array.yaml
      - /test/working/shared/absolute.yaml
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/vars/string.yaml',
      'evals/vars/array.yaml',
      'shared/absolute.yaml',
    ]);
  });

  it('should extract nested references from a structured prompt file', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('prompts/structured.yaml'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'prompts:\n  - file: prompts/structured.yaml'
        : 'messages:\n  - file://shared/context.txt',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/structured.yaml', 'evals/shared/context.txt']);

    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValueOnce(
      'prompts:\n  - file: prompts/missing.yaml',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/prompts/missing.yaml']);
  });

  it('should not read oversized structured provider, prompt, or test dependencies', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      /(?:prompt|cases)\.ya?ml$/.test(filePath),
    );
    mockFs.statSync.mockImplementation(
      (filePath: string) =>
        ({
          isDirectory: () => false,
          size: /(?:providers|prompt|cases)\.ya?ml$/.test(filePath)
            ? 3 * 1024 * 1024 * 1024
            : 0,
        }) as fs.Stats,
    );
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('promptfooconfig.yaml')) {
        return `
providers: file://providers.yaml
prompts:
  - file: prompts/prompt.yaml
tests: file://tests/cases.yaml
`;
      }
      throw new Error('OVERSIZED_READ_SECRET_MARKER');
    });

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/providers.yaml',
      './',
      'evals/prompts/prompt.yaml',
      'evals/tests/cases.yaml',
    ]);

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested provider dependencies; conservatively watching the dependency root',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested prompt dependencies; conservatively watching the dependency root',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested test dependencies; conservatively watching the dependency root',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should extract test and assertion transform dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  options:
    transformVars: file://transforms/default-vars.cjs:transform
tests:
  - options:
      transform: file://transforms/test.mjs:transform
      postprocess: file://transforms/postprocess.py:postprocess
    assert:
      - type: javascript
        value: file://validators/check.cjs:validate
        transform: file://transforms/assertion.ts:transform
        contextTransform: file://transforms/context.py:transform
scenarios:
  - config:
      - options:
          transformVars: file://transforms/scenario.cjs:transform
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/transforms/default-vars.cjs',
      'evals/validators/check.cjs',
      'evals/transforms/assertion.ts',
      'evals/transforms/context.py',
      'evals/transforms/test.mjs',
      'evals/transforms/postprocess.py',
      'evals/transforms/scenario.cjs',
    ]);
  });

  it('should avoid expanding a shared test-alias DAG exponentially', () => {
    const aliases = Array.from({ length: 18 }, (_, index) => {
      if (index === 0) {
        return 'a0: &a0 [{ vars: { input: example } }]';
      }
      return `a${index}: &a${index} [*a${index - 1}, *a${index - 1}]`;
    }).join('\n');
    mockFs.readFileSync.mockReturnValue(`${aliases}\ntests: *a17`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively stop cyclic and oversized test dependency graphs', () => {
    mockFs.readFileSync.mockReturnValueOnce('tests: &tests [*tests]');

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);

    const configs = Array.from(
      { length: 1025 },
      (_, index) => `      - value: ${index}`,
    ).join('\n');
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.yaml'),
    );
    mockFs.readFileSync.mockReturnValueOnce(`
tests:
  - path: file://tests/generate.py:build
    config:
${configs}
  - file://tests/cases.yaml
  - []
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/generate.py', './', 'evals/tests/cases.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should avoid retraversing aliased generator config objects and unsafe external test paths', () => {
    mockFs.readFileSync.mockReturnValue(`
shared: &shared
  dataset: file://datasets/current.yaml
tests:
  - path: file://tests/generate.py:build
    config:
      first: *shared
      second: *shared
  - file://../../outside/UNSAFE_TEST_SECRET_MARKER.yaml
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/generate.py', 'evals/datasets/current.yaml']);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
    ).toBe(false);
  });

  it('should preserve spaces in quoted CSV assertion file paths', () => {
    mockFs.existsSync.mockImplementation((filePath: string) =>
      filePath.endsWith('tests/cases.csv'),
    );
    mockFs.readFileSync.mockImplementation((filePath: string) =>
      filePath.endsWith('promptfooconfig.yaml')
        ? 'tests: file://tests/cases.csv'
        : 'input,__expected\nhello,"file://validators/check case.cjs:validate"\n',
    );

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.csv', 'evals/validators/check case.cjs']);
  });

  it('should ignore non-file scalar extension hooks', () => {
    mockFs.readFileSync.mockReturnValue('extensions: inline-hook');

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should extract scenario tests/config dependencies and Nunjucks filter globs', () => {
    mockFs.readFileSync.mockReturnValue(`
scenarios:
  - file://scenarios/direct.yaml
  - tests: file://scenarios/no-config.yaml
  - tests: file://scenarios/cases.yaml
    config:
      - vars:
          context: file://scenarios/context.txt
        assert:
          - type: javascript
            value: file://validators/scenario.rb:validate
  - tests:
      - vars:
          nested: file://scenarios/nested.txt
        assert:
          - type: javascript
            value: file://validators/nested.cjs:checks/pass
    config:
      - vars:
          extra: file://scenarios/extra.txt
nunjucksFilters:
  pretty: filters/filter_*.js
  direct: file://filters/direct.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/filters/filter_pretty.js',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/scenarios/direct.yaml',
      'evals/scenarios/no-config.yaml',
      'evals/scenarios/cases.yaml',
      'evals/scenarios/context.txt',
      'evals/validators/scenario.rb',
      'evals/scenarios/nested.txt',
      'evals/validators/nested.cjs',
      'evals/scenarios/extra.txt',
      'evals/filters/filter_pretty.js',
      'evals/filters/',
    ]);
  });

  it('should preserve literal variable and Go assertion selectors while stripping Ruby assertion selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars:
    defaultRuby: file://vars/default.rb:build
tests:
  - vars:
      ruby: file://vars/build.rb:build
      go: file://vars/build.go:Build
      literal: file://vars/build.RB:build
    assert:
      - type: javascript
        value: file://validators/check.go:Check
      - type: javascript
        value: file://validators/check.rb:validate
      - type: javascript
        value: 'file://validators/check.cjs:checks/pass'
      - type: javascript
        value: 'file://validators/other.mjs:checks\\pass'
      - type: javascript
        value: 'file://validators/check-empty.cjs:'
      - type: javascript
        value: "file://validators/check-newline.cjs:checks\\npass"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/vars/default.rb:build',
      'evals/vars/build.rb:build',
      'evals/vars/build.go:Build',
      'evals/vars/build.RB:build',
      'evals/validators/check.go:Check',
      'evals/validators/check.rb',
      'evals/validators/check.cjs',
      'evals/validators/other.mjs',
      'evals/validators/check-empty.cjs',
      'evals/validators/check-newline.cjs',
    ]);
  });

  it('should extract nested assert-set validators from default and test assertions', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  assert:
    - type: assert-set
      assert:
        - type: javascript
          value: 'file://validators/default.cjs:checks/pass'
tests:
  - assert:
      - type: assert-set
        assert:
          - type: javascript
            value: file://validators/nested.rb:validate
          - type: assert-set
            assert:
              - type: javascript
                value: 'file://validators/deep.mjs:checks\\pass'
      - type: contains
        value: safe
        assert:
          - type: javascript
            value: file://validators/not-a-set.cjs:validate
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/validators/default.cjs',
      'evals/validators/nested.rb',
    ]);
  });

  it('should conservatively stop a recursive assert-set alias', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - &recursive
        type: assert-set
        assert:
          - *recursive
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should conservatively bound assert-set traversal', () => {
    const assertions = Array.from(
      { length: 1025 },
      () => '      - type: contains\n        value: safe',
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
${assertions}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Provider dependency traversal stopped; conservatively watching the dependency root',
    );
  });

  it('should not count repeated assert-set aliases as unique traversal nodes', () => {
    const tests = Array.from(
      { length: 1025 },
      () => '  - assert:\n      - *shared',
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
shared: &shared
  type: javascript
  value: file://validators/shared.cjs:validate
tests:
${tests}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/shared.cjs']);
    expect(core.warning).not.toHaveBeenCalled();
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
