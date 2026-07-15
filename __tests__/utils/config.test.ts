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
    mockFs.realpathSync.mockImplementation((value: unknown) => String(value));
    mockFs.existsSync.mockReturnValue(false);
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

  it('should preserve a repository-root directory dependency without a trailing slash', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://.
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract a function-qualified Python provider file', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py:custom_call
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.py']);
  });

  it('should extract an object-form function-qualified Python provider', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: file://providers/provider.py:custom_call
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.py']);
  });

  it('should extract an environment-templated provider file', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_FILE', 'provider');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py']);
    vi.unstubAllEnvs();
  });

  it('should prefer config and provider environment values when extracting templated provider files', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_CONFIG_PROVIDER', 'process-provider');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROMPTFOO_CONFIG_PROVIDER: config-provider
  PROMPTFOO_IGNORED_VALUE:
    nested: ignored
providers:
  - file://providers/{{ env.PROMPTFOO_CONFIG_PROVIDER }}.py:café
  - id: file://providers/{{ env['PROMPTFOO_LOCAL_PROVIDER'] }}.py:café
    env:
      PROMPTFOO_LOCAL_PROVIDER: local-provider
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'providers/config-provider.py',
      'providers/local-provider.py',
    ]);
    vi.unstubAllEnvs();
  });

  it('should conservatively watch the workspace for an unresolved provider path template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_MISSING_PROVIDER }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should resolve a default-filtered provider path template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_MISSING_PROVIDER | default('provider') }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py']);
  });

  it('should conservatively watch the workspace when templating is disabled in the process environment', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_DISABLE_TEMPLATING', 'YePpErS');
    vi.stubEnv('PROMPTFOO_PROVIDER_FILE', 'provider');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    vi.unstubAllEnvs();
  });

  it('should conservatively watch the workspace when templating is disabled by config environment', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_DISABLE_TEMPLATING', 'false');
    vi.stubEnv('PROMPTFOO_PROVIDER_FILE', 'provider');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROMPTFOO_DISABLE_TEMPLATING: true
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    vi.unstubAllEnvs();
  });

  it.each([
    'PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS',
    'PROMPTFOO_SELF_HOSTED',
  ])('should conservatively watch the workspace when %s hides process environment templates', (flag) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv(flag, 'true');
    vi.stubEnv('PROMPTFOO_PROVIDER_FILE', 'provider');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    vi.unstubAllEnvs();
  });

  it('should extract environment templates that render to complete provider and tool file URLs', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_REF', 'file://providers/provider.py:café');
    vi.stubEnv('PROMPTFOO_TOOL_REF', 'file://tools/tools.cjs:getTools');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROMPTFOO_PROVIDER_REF }}"
  - id: openai:chat:gpt-4
    config:
      tools: "{{ env.PROMPTFOO_TOOL_REF }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py', 'tools/tools.cjs']);
    vi.unstubAllEnvs();
  });

  it('should extract an environment template that renders to a provider-map key', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_REF', 'file://providers/provider.py:café');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROMPTFOO_PROVIDER_REF }}":
      label: templated-map
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py']);
    vi.unstubAllEnvs();
  });

  it('should apply the mapped provider environment when rendering a provider-map key', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  IMPL: root
providers:
  - "file://providers/{{ env.IMPL }}.py:café":
      env:
        IMPL: primary
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/primary.py']);
  });

  it('should extract environment templates that render to prompt, variable, and assertion file URLs', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROMPT_REF', 'file://prompts/prompt.txt');
    vi.stubEnv('PROMPTFOO_VAR_REF', 'file://vars/context.txt');
    vi.stubEnv('PROMPTFOO_ASSERT_REF', 'file://assertions/check.js');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - openai:chat:gpt-4
prompts:
  - "{{ env.PROMPTFOO_PROMPT_REF }}"
tests:
  - vars:
      context: "{{ env.PROMPTFOO_VAR_REF }}"
    assert:
      - type: javascript
        value: "{{ env.PROMPTFOO_ASSERT_REF }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'prompts/prompt.txt',
      'vars/context.txt',
      'assertions/check.js',
    ]);
    vi.unstubAllEnvs();
  });

  it('should conservatively watch unresolved whole-file templates across config sections', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROMPTFOO_MISSING_PROVIDER_REF }}"
  - "{{ env.PROMPTFOO_MISSING_PROVIDER_MAP }}":
      label: unresolved-map
prompts:
  - "{{ env.PROMPTFOO_MISSING_PROMPT_REF }}"
  - file: "{{ env.PROMPTFOO_MISSING_PROMPT_FILE }}"
tests:
  - vars:
      context: "{{ env.PROMPTFOO_MISSING_VAR_REF }}"
      objectContext:
        file: "{{ env.PROMPTFOO_MISSING_VAR_FILE }}"
    assert:
      - type: javascript
        value: "{{ env.PROMPTFOO_MISSING_ASSERT_REF }}"
      - type: javascript
        value:
          file: "{{ env.PROMPTFOO_MISSING_ASSERT_FILE }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch Nunjucks comments in provider-map keys', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://providers/{# selected at runtime #}provider.py:call_api":
      label: commented-map
  - "{# provider prefix #}file://providers/other.py:call_api":
      label: commented-prefix
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch Nunjucks comments in nested provider and file paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      tools: "file://tools/{# selected at runtime #}tools.cjs:getTools"
prompts:
  - file: "prompts/{# prompt variant #}prompt.txt"
tests:
  - vars:
      context: "{# context prefix #}file://vars/context.txt"
      splitPrefix: "f{# split prefix #}ile://vars/context.txt"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
  });

  it('should not conservatively watch ordinary provider body templates', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      body: "{{ prompt }}"
      instruction: "{# ordinary comment #}respond to {{ vars.input }}"
      headers:
        Authorization: "Bearer {{ env.API_KEY }}"
        "{{ env.API_KEY }}": literal
      transformed: "{{ env.API_KEY | upper }}"
      bodyObject:
        type: file
        path: ./not-auth.ts
        config:
          auth:
            type: file
            path: ./also-not-auth.ts
          signatureAuth:
            privateKeyPath: ./also-not-a-key.pem
          tls:
            certPath: ./also-not-a-cert.pem
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
  });

  it('should extract HTTP file-auth dependencies and provider-env paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/typescript
    config:
      auth:
        type: file
        path: ./auth/get-token.ts
  - id: https://example.test/python
    config:
      auth:
        type: file
        path: ./auth/get-token.py
  - id: https://example.test/named
    config:
      auth:
        type: file
        path: file://auth/named-token.ts:getToken
  - id: https://example.test/environment
    env:
      AUTH_PATH: ./auth/current-token.ts
    config:
      auth:
        type: file
        path: "{{ env.AUTH_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'auth/get-token.ts',
      'auth/get-token.py',
      'auth/named-token.ts',
      'auth/current-token.ts',
    ]);
  });

  it('should extract HTTP status validators including named JavaScript exports', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/default
    config:
      validateStatus: file://validators/status.js
  - id: https://example.test/named
    config:
      validateStatus: file://validators/named-status.js:validateStatus
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['validators/status.js', 'validators/named-status.js']);
  });

  it('should extract HTTP auth and credential paths from provider-map entries', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - https://example.test:
      env:
        AUTH_PATH: ./auth/mapped-token.ts
      config:
        auth:
          type: file
          path: "{{ env.AUTH_PATH }}"
        signatureAuth:
          privateKeyPath: ./credentials/mapped-key.pem
        tls:
          caPath: ./credentials/mapped-ca.pem
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([
      'auth/mapped-token.ts',
      'credentials/mapped-key.pem',
      'credentials/mapped-ca.pem',
    ]);
  });

  it('should extract HTTP auth and credential paths from targets', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: https://example.test
    config:
      auth:
        type: file
        path: ./auth/target-token.ts
      signatureAuth:
        privateKeyPath: ./credentials/target-key.pem
      tls:
        caPath: ./credentials/target-ca.pem
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([
      'auth/target-token.ts',
      'credentials/target-key.pem',
      'credentials/target-ca.pem',
    ]);
  });

  it('should ignore bare HTTP-only auth and credential paths on non-HTTP providers', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      auth:
        type: file
        path: ./auth/not-an-http-token.ts
      signatureAuth:
        privateKeyPath: ./credentials/not-an-http-key.pem
      tls:
        caPath: ./credentials/not-an-http-ca.pem
  - openai:chat:gpt-4:
      config:
        auth:
          type: file
          path: ./auth/not-a-mapped-http-token.ts
        tls:
          caPath: ./credentials/not-a-mapped-http-ca.pem
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should extract an HTTP file-auth path when its auth type is templated', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    env:
      AUTH_TYPE: file
    config:
      auth:
        type: "{{ env.AUTH_TYPE }}"
        path: ./auth/templated-type.ts
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['auth/templated-type.ts']);
  });

  it('should resolve a default-filtered HTTP file-auth type', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      auth:
        type: "{{ env.MISSING_AUTH_TYPE | default('file') }}"
        path: ./auth/default-type.ts
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['auth/default-type.ts']);
  });

  it('should conservatively watch an unsupported filtered HTTP file-auth type', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    env:
      AUTH_TYPE: FILE
    config:
      auth:
        type: "{{ env.AUTH_TYPE | lower }}"
        path: ./auth/filtered-type.ts
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract plain and env-templated HTTP credential paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/signature
    env:
      PRIVATE_KEY_PATH: ./credentials/from-env.pem
    config:
      signatureAuth:
        privateKeyPath: "{{ env.PRIVATE_KEY_PATH }}"
        keystorePath: ./credentials/keystore.jks
        pfxPath: ./credentials/signature.pfx
        certPath: ./credentials/signature.crt
        keyPath: ./credentials/signature.key
  - id: https://example.test/tls
    config:
      tls:
        caPath: ./credentials/ca.pem
        certPath: ./credentials/client.crt
        keyPath: ./credentials/client.key
        pfxPath: file://credentials/client.pfx
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([
      'credentials/from-env.pem',
      'credentials/keystore.jks',
      'credentials/signature.pfx',
      'credentials/signature.crt',
      'credentials/signature.key',
      'credentials/ca.pem',
      'credentials/client.crt',
      'credentials/client.key',
      'credentials/client.pfx',
    ]);
  });

  it('should redact an escaping env-templated HTTP credential path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PRIVATE_KEY_PATH', '../PRIVATE_KEY_SECRET_CANARY_019F62C3.pem');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      signatureAuth:
        privateKeyPath: "{{ env.PRIVATE_KEY_PATH }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PRIVATE_KEY_PATH }}');
    expect(warnings).not.toContain('PRIVATE_KEY_SECRET_CANARY_019F62C3');
    vi.unstubAllEnvs();
  });

  it('should resolve a default-filtered HTTP credential template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      tls:
        caPath: "{{- env['MISSING_CA'] | default('./credentials/ca.pem', true) -}}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['credentials/ca.pem']);
  });

  it('should conservatively watch an unsupported filtered HTTP credential path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    env:
      CA_PATH: ' ./credentials/ca.pem '
    config:
      tls:
        caPath: "{{ env.CA_PATH | trim }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should redact an escaping literal HTTP credential path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      signatureAuth:
        privateKeyPath: ../PRIVATE_KEY_SECRET_CANARY_019F62C3.pem
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'PRIVATE_KEY_SECRET_CANARY_019F62C3',
    );
  });

  it('should reject and redact a null-byte HTTP credential path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      signatureAuth:
        privateKeyPath: "\\0PRIVATE_KEY_SECRET_CANARY_019F62C3.pem"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'PRIVATE_KEY_SECRET_CANARY_019F62C3',
    );
  });

  it('should revisit an aliased HTTP file-auth value in its auth context', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      body: &file_auth
        type: file
        path: ./auth/aliased-token.ts
      auth: *file_auth
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['auth/aliased-token.ts']);
  });

  it('should conservatively watch and redact an escaping templated file-auth path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('AUTH_PATH', '../AUTH_PATH_SECRET_CANARY_019F62C3.ts');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      auth:
        type: file
        path: "{{ env.AUTH_PATH }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.AUTH_PATH }}');
    expect(warnings).not.toContain('AUTH_PATH_SECRET_CANARY_019F62C3');
    vi.unstubAllEnvs();
  });

  it('should resolve a default-filtered HTTP file-auth template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      auth:
        type: file
        path: "{{- env['MISSING_AUTH'] | default('./auth/default.ts', true) -}}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['auth/default.ts']);
  });

  it('should conservatively watch an unsupported filtered HTTP file-auth path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    env:
      AUTH_PATH: ' ./auth/filtered.ts '
    config:
      auth:
        type: file
        path: "{{ env.AUTH_PATH | trim }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should redact an escaping literal HTTP file-auth path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test
    config:
      auth:
        type: file
        path: ../AUTH_PATH_SECRET_CANARY_019F62C3.ts
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'AUTH_PATH_SECRET_CANARY_019F62C3',
    );
  });

  it('should resolve bracket and default-filter env templates in nested provider dependencies', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROVIDER_TOOLS_PATH', 'file://tools/current.ts:getTools');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      tools: "{{ env['PROVIDER_TOOLS_PATH'] }}"
  - id: openai:chat:gpt-4
    config:
      tools: "{{ env.MISSING_PROVIDER | default('file://tools/default.ts:getTools') }}"
  - id: openai:chat:gpt-4
    config:
      tools: "{{- env['MISSING_BRACKET'] | default('file://tools/default-bracket.ts:getTools') -}}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'tools/current.ts',
      'tools/default.ts',
      'tools/default-bracket.ts',
    ]);
    vi.unstubAllEnvs();
  });

  it('should resolve falsy env values with a Nunjucks default filter', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    env:
      ENABLED: false
      VERSION: 0
    config:
      tools: "{{ env.ENABLED | default('file://tools/enabled.ts:getTools', true) }}"
      functions: "{{- env['VERSION'] | default('file://tools/version.ts:getTools', true) -}}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['tools/enabled.ts', 'tools/version.ts']);
  });

  it('should conservatively watch computed nested response-schema templates', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROVIDER_FILE', 'current.json');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      response_format:
        type: json_schema
        schema: "{{ 'file://schemas/' + env.PROVIDER_FILE }}"
  - id: openai:chat:gpt-4
    config:
      response_format:
        type: json_schema
        json_schema:
          schema: "{{ 'file://schemas/' + env.PROVIDER_FILE }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
    vi.unstubAllEnvs();
  });

  it('should resolve provider-env templates in nested response schemas', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/schemas/current.json')) {
        return '{}';
      }
      return `
providers:
  - id: openai:chat:gpt-4
    env:
      SCHEMA_PATH: file://schemas/current.json
    config:
      response_format:
        type: json_schema
        schema: "{{ env.SCHEMA_PATH }}"
  - id: openai:chat:gpt-4
    env:
      SCHEMA_PATH: file://schemas/current.json
    config:
      response_format:
        type: json_schema
        json_schema:
          schema: "{{ env['SCHEMA_PATH'] }}"
`;
    });

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['schemas/current.json']);
  });

  it('should extract env-templated nested provider config file URLs', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    env:
      SYSTEM_PROMPT: file://prompts/system.txt
    config:
      systemPrompt: "{{ env.SYSTEM_PROMPT }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['prompts/system.txt']);
  });

  it('should resolve a default-filtered nested provider config file URL', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      systemPrompt: "{{ env.MISSING_SYSTEM_PROMPT | default('file://prompts/system.txt') }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['prompts/system.txt']);
  });

  it('should conservatively watch an unsupported filtered nested provider config file URL', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    env:
      SYSTEM_PROMPT: ' file://prompts/system.txt '
    config:
      systemPrompt: "{{ env.SYSTEM_PROMPT | trim }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should extract comment-prefixed env file templates', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    env:
      PROVIDER_REF: file://providers/current.py
    config:
      tools: "{# choose #}{{ env.PROVIDER_REF }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['providers/current.py']);
  });

  it('should handle long and malformed Nunjucks comment prefixes without backtracking', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const validPrefix = '{# choose #} '.repeat(2_000);
    const malformedPrefix = `{{#${'#}}{{#'.repeat(2_000)}`;
    const unclosedComment = `{#${'{{#'.repeat(65_537)}`;
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_REF: file://providers/current.py
providers:
  - ${JSON.stringify(`${validPrefix}{{ env.PROVIDER_REF }}`)}
prompts:
  - ${JSON.stringify(malformedPrefix)}
  - ${JSON.stringify(unclosedComment)}
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['providers/current.py']);
  });

  it('should extract string and array test-vars file references', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  VARS_PATH: file://vars/from-env.json
tests:
  - vars: file://vars/direct.json
  - vars:
      - file://vars/array.json
      - "{{ env.VARS_PATH }}"
      - null
defaultTest:
  vars: file://vars/default.json
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([
      'vars/default.json',
      'vars/direct.json',
      'vars/array.json',
      'vars/from-env.json',
    ]);
  });

  it('should not conservatively watch inline env prose in prompts or vars', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - "Mention file:// only as text beside {{ env.API_KEY }}."
tests:
  - vars:
      message: "Mention file:// only as text beside {{ env.API_KEY }}."
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should not conservatively watch resolved non-file env templates or blocks', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROMPT_TEXT: Say hi
  PROVIDER_ID: openai:chat:gpt-4
  SHORT: yes
providers:
  - "{{ env.PROVIDER_ID | default('openai:chat:gpt-4', true) }}"
prompts:
  - "{{ env.PROMPT_TEXT }}"
  - "{% if env.SHORT %}Say hi{% endif %}"
tests:
  - vars:
      message: "{{ env.PROMPT_TEXT }}"
      block: "{% if env.SHORT %}Say hi{% endif %}"
    assert:
      - type: contains
        value: "{{ env.PROMPT_TEXT }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should not conservatively watch a resolved non-file provider template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_ID: openai:chat:gpt-4
providers:
  - "{{ env.PROVIDER_ID }}"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should not conservatively watch a resolved non-file provider-map key', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_ID: openai:chat:gpt-4
providers:
  - "{{ env.PROVIDER_ID }}": {}
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should not conservatively watch a default-filtered non-file provider-map key', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.MISSING_PROVIDER_ID | default('openai:chat:gpt-4') }}": {}
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should resolve whitespace-trimmed env templates in provider paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  PROVIDER_FILE: current
providers:
  - "file://providers/{{- env.PROVIDER_FILE -}}.py"
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['providers/current.py']);
  });

  it('should ignore non-file objects and primitives across config sections', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: not-a-file
tests:
  - vars:
      number: 1
      empty: null
      object:
        value: not-a-file
      invalidFile:
        file: 1
    assert:
      - type: javascript
        value: 1
      - type: javascript
        value: null
      - type: javascript
        value:
          expression: not-a-file
      - type: javascript
        value:
          file: 1
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
  });

  it('should redact a whole provider URL template that escapes the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv(
      'PROMPTFOO_PROVIDER_REF',
      'file://../../OUTSIDE_PATH_SECRET_CANARY_019F62C3.py:café',
    );
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ env.PROMPTFOO_PROVIDER_REF }}"
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROVIDER_REF }}');
    expect(warnings).not.toContain('OUTSIDE_PATH_SECRET_CANARY_019F62C3');
    vi.unstubAllEnvs();
  });

  it('should preserve a rendered non-provider template in unsafe-path warnings', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv(
      'PROMPTFOO_PROMPT_REF',
      'file://../OUTSIDE_PROMPT_SECRET_CANARY_019F62C3.txt',
    );
    const forgedAnnotation = 'PROMPT_WARNING_CANARY_019F62C3';
    const templatedPrompt = `{{ env.PROMPTFOO_PROMPT_REF }}\n::error::${forgedAnnotation}`;
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - ${JSON.stringify(templatedPrompt)}
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROMPT_REF }}');
    expect(warnings).not.toContain('OUTSIDE_PROMPT_SECRET_CANARY_019F62C3');
    expect(warnings).not.toContain(`\n::error::${forgedAnnotation}`);
    expect(warnings).toContain(`\\n::error::${forgedAnnotation}`);
    vi.unstubAllEnvs();
  });

  it('should redact a rendered provider path that escapes the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv(
      'PROMPTFOO_PROVIDER_FILE',
      '../../OUTSIDE_PATH_SECRET_CANARY_019F62C3',
    );
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROVIDER_FILE }}');
    expect(warnings).not.toContain('OUTSIDE_PATH_SECRET_CANARY_019F62C3');
    vi.unstubAllEnvs();
  });

  it('should redact rendered provider glob matches that escape the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_DIR', 'PATH_SECRET_CANARY_019F62C3');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_DIR }}/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leaked.py']);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/PATH_SECRET_CANARY_019F62C3/']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROVIDER_DIR }}');
    expect(warnings).not.toContain('PATH_SECRET_CANARY_019F62C3');
    expect(warnings).not.toContain('/test/outside/leaked.py');
    vi.unstubAllEnvs();
  });

  it('should escape rendered provider glob warnings that could forge annotations', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_DIR', 'current');
    const forgedAnnotation = 'TEMPLATED_GLOB_CANARY_019F62C3';
    const templatedGlob = `file://providers/{{ env.PROMPTFOO_PROVIDER_DIR }}/*.py\n::error::${forgedAnnotation}`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - ${JSON.stringify(templatedGlob)}
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leaked.py']);

    extractFileDependencies('/test/repository/promptfooconfig.yaml');

    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROVIDER_DIR }}');
    expect(warnings).not.toContain(`\n::error::${forgedAnnotation}`);
    expect(warnings).toContain(`\\n::error::${forgedAnnotation}`);
    vi.unstubAllEnvs();
  });

  it('should extract a callable Unicode Python selector and preserve an unsupported Go selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py:café
  - file://providers/provider.go:调用
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.py',
      '../config/providers/provider.go:调用',
    ]);
  });

  it('should extract function-qualified Ruby and Go providers including Ruby bang methods', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.rb:generate_response!
  - file://providers/check.rb:valid_response?
  - file://providers/provider.go:CallApi
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.rb',
      '../config/providers/check.rb',
      '../config/providers/provider.go',
    ]);
  });

  it('should extract supported provider files with empty function selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://providers/provider.py:"
  - "file://providers/provider.rb:"
  - "file://providers/provider.go:"
  - id: openai:chat:gpt-4
    config:
      tools: "file://tools/tools.cjs:"
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.py',
      '../config/providers/provider.rb',
      '../config/providers/provider.go',
      '../config/tools/tools.cjs',
    ]);
  });

  it('should not reinterpret unsupported JavaScript or TypeScript provider selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.js:handlers.callApi
  - file://providers/provider.ts:callApi
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.js:handlers.callApi',
      '../config/providers/provider.ts:callApi',
    ]);
  });

  it('should preserve an absolute provider inside the repository', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/repository/providers/provider.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py']);
  });

  it('should preserve the watch root for an absolute provider glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/repository/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/repository/config/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/']);
  });

  it('should preserve the watch root for a brace-only provider glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{one,two}.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        Boolean(options?.magicalBraces && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/']);
    expect(mockGlob.hasMagic).toHaveBeenCalledWith('providers/{one,two}.py', {
      magicalBraces: true,
    });
    expect(mockGlob.sync).toHaveBeenCalledWith(
      [
        '/test/repository/providers/one.py',
        '/test/repository/providers/two.py',
      ],
      { nodir: true, braceExpandMax: 1_024 },
    );
  });

  it.each([
    'file://{..,fixtures}/*.py',
    'file://{nested/../../../outside,fixtures}/*.py',
  ])('should reject a traversal branch in %s before scanning the host', (provider) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - ${provider}
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        Boolean(options?.magicalBraces && value.includes('{')),
    );

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should bound brace expansion before scanning provider glob alternatives', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{1..2000}.yaml
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        Boolean(options?.magicalBraces && value.includes('{')),
    );

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should preserve concrete root-level brace alternatives for deleted files', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{one,two}.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        Boolean(options?.magicalBraces && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['one.py', 'two.py']);
  });

  it('should retain safe parent-directory brace alternatives inside the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{../shared,tests}/*.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        Boolean(options?.magicalBraces && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/repository/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['shared/', 'evals/tests/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
  });

  it('should preserve the pattern for an absolute root-level provider glob', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/repository/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['*.py']);
  });

  it('should preserve empty YAML provider globs without watching the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://*.yaml
  - file://providers/*.json
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['*.yaml', 'providers/']);
  });

  it('should preserve sibling dependencies when a provider glob pattern is oversized', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const oversizedPattern = `providers/${'a'.repeat(65_537)}*.py`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://${oversizedPattern}
  - file://providers/invalid[.py
  - file://providers/resolved*.py
  - file://providers/safe.py
prompts:
  - file://prompts/safe.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (
        value.length > 65_536 ||
        value.includes('invalid[') ||
        (value.startsWith('/test/repository/') && value.includes('resolved*'))
      ) {
        throw new TypeError('invalid glob pattern');
      }
      return value.includes('*');
    });

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['./', 'providers/safe.py', 'prompts/safe.txt']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should extract nested file references from a provider YAML file', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  systemPrompt: file://prompts/system.txt
  tools:
    - file://tools/search.yaml
`;
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/prompts/system.txt',
      '../config/tools/search.yaml',
    ]);
  });

  it('should extract a function-qualified provider from a provider YAML file', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: file://providers/nested.py:call_api
`;
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/providers/nested.py',
    ]);
  });

  it('should recursively extract second-level YAML and JSON provider references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const value = String(filePath);
      if (value.endsWith('provider.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  tools: file://configs/tools.json
`;
      }
      if (value.endsWith('tools.json')) {
        return '{"schema":"file://configs/schema.yaml"}';
      }
      if (value.endsWith('schema.yaml')) {
        return 'systemPrompt: file://prompts/system.txt';
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/configs/tools.json',
      '../config/configs/schema.yaml',
      '../config/prompts/system.txt',
    ]);
  });

  it('should prefer an outer provider environment over the referenced provider YAML environment', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-precedence.yaml')) {
        return `
env:
  IMPL: fallback
id: file://providers/{{ env.IMPL }}.py:café
`;
      }
      return `
env:
  IMPL: root
providers:
  - id: file://provider-precedence.yaml
    env:
      IMPL: primary
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['provider-precedence.yaml', 'providers/primary.py']);
  });

  it('should prefer bare provider-file environment values over root config defaults', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-root-precedence.yaml')) {
        return `
env:
  IMPL: fallback
id: file://providers/{{ env.IMPL }}.py:café
`;
      }
      return `
env:
  IMPL: root
providers:
  - file://provider-root-precedence.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-root-precedence.yaml',
      'providers/fallback.py',
    ]);
  });

  it('should prefer the root config environment when an object provider references a provider file', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-object-precedence.yaml')) {
        return `
env:
  IMPL: fallback
id: file://providers/{{ env.IMPL }}.py:café
`;
      }
      return `
env:
  IMPL: root
providers:
  - id: file://provider-object-precedence.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-object-precedence.yaml',
      'providers/root.py',
    ]);
  });

  it('should inspect a shared provider file separately for bare and object caller contexts', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-context.yaml')) {
        return `
env:
  IMPL: fallback
id: file://providers/{{ env.IMPL }}.py
`;
      }
      return `
env:
  IMPL: root
providers:
  - file://provider-context.yaml
  - id: file://provider-context.yaml
`;
    });

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual([
      'provider-context.yaml',
      'providers/fallback.py',
      'providers/root.py',
    ]);
  });

  it('should prefer a provider-map environment over root and provider-file defaults', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-map-precedence.yaml')) {
        return `
env:
  IMPL: fallback
id: file://providers/{{ env.IMPL }}.py:café
`;
      }
      return `
env:
  IMPL: root
providers:
  - file://provider-map-precedence.yaml:
      env:
        IMPL: mapped
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-map-precedence.yaml',
      'providers/mapped.py',
    ]);
  });

  it('should not treat file URLs stored in provider environment values as dependencies', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    env:
      API_BASE_URL: file://ENV_VALUE_SECRET_CANARY_019F62C3
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'ENV_VALUE_SECRET_CANARY_019F62C3',
    );
  });

  it('should inspect a shared provider YAML for every rendering environment', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-shared.yaml')) {
        return 'id: file://providers/{{ env.IMPL }}.py:café';
      }
      return `
providers:
  - id: file://provider-shared.yaml
    env:
      IMPL: a
  - id: file://provider-shared.yaml
    env:
      IMPL: b
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-shared.yaml',
      'providers/a.py',
      'providers/b.py',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(3);
  });

  it('should inspect an aliased provider config for every rendering environment', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
shared: &shared
  tools: file://{{ env.TOOL_FILE }}
providers:
  - id: openai:chat:gpt-4
    env:
      TOOL_FILE: tools/first.ts:getTools
    config: *shared
  - id: openai:chat:gpt-4
    env:
      TOOL_FILE: tools/second.ts:getTools
    config: *shared
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['tools/first.ts', 'tools/second.ts']);
  });

  it('should render supported numeric and boolean config environment values in provider paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
env:
  VERSION: 2
  ENABLED: true
providers:
  - file://providers/v{{ env.VERSION }}.py:café
  - file://providers/enabled-{{ env.ENABLED }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/v2.py', 'providers/enabled-true.py']);
  });

  it('should render numeric and boolean provider overrides in provider-file paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('VERSION', '1');
    vi.stubEnv('ENABLED', 'false');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-scalar-precedence.yaml')) {
        return `
env:
  VERSION: fallback
  ENABLED: fallback
id: file://providers/v{{ env.VERSION }}-{{ env.ENABLED }}.py:café
`;
      }
      return `
env:
  VERSION: root
  ENABLED: root
providers:
  - id: file://provider-scalar-precedence.yaml
    env:
      VERSION: 2
      ENABLED: true
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-scalar-precedence.yaml',
      'providers/v2-true.py',
    ]);
    vi.unstubAllEnvs();
  });

  it('should render wrapped provider-file defaults with bare, object, and map caller environments', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/provider-wrapped.yaml')) {
        return `
env:
  TOOL_FILE: "tools/{{ env.VARIANT }}.cjs:getTools"
config:
  tools: "file://{{ env.TOOL_FILE }}"
`;
      }
      return `
env:
  VARIANT: suite
providers:
  - file://provider-wrapped.yaml
  - id: file://provider-wrapped.yaml
    env:
      VARIANT: object
  - file://provider-wrapped.yaml:
      env:
        VARIANT: mapped
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'provider-wrapped.yaml',
      'tools/suite.cjs',
      'tools/object.cjs',
      'tools/mapped.cjs',
    ]);
  });

  it('should extract supported JavaScript and TypeScript function references nested in provider config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  tools: file://tools/tools.js:getTools
  transform: file://tools/transform.ts:handlers.transform
`;
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/tools/tools.js',
      '../config/tools/transform.ts',
    ]);
  });

  it('should preserve nested Ruby-colon filenames and extract callable CJS hyphen exports', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  template: file://templates/context.rb:prod
  tools: file://tools/tools.cjs:get-tools
`;
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/templates/context.rb:prod',
      '../config/tools/tools.cjs',
    ]);
  });

  it('should preserve absolute file references nested in provider YAML', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  schema: file:///test/repository/providers/schema.json
`;
      }
      if (String(filePath).endsWith('schema.json')) {
        return '{}';
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.yaml', 'providers/schema.json']);
  });

  it('should retain dependencies when provider YAML contains cyclic aliases', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return `
id: file://providers/provider.py:call_api
config: &config
  schema: file://providers/schema.json
  recursive: *config
`;
      }
      if (String(filePath).endsWith('schema.json')) {
        return '{}';
      }
      return `
providers:
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/providers/provider.py',
      '../config/providers/schema.json',
    ]);
  });

  it('should not enumerate binary or other atomic provider config values', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const encoded = Buffer.alloc(128 * 1024, 1).toString('base64');
    const entriesSpy = vi.spyOn(Object, 'entries');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
      binary: !!binary ${encoded}
      timestamp: 2024-01-02
      ordered: !!omap [{a: 1}, {b: 2}]
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(
      entriesSpy.mock.calls.some(([value]) => ArrayBuffer.isView(value)),
    ).toBe(false);
  });

  it('should extract providers from the targets alias', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - file://providers/target.py:call_api
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/target.py']);
  });

  it('should extract a scalar provider and file-keyed provider map', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/scalar.py:call_api
  - file://providers/mapped.py:call_api:
      config:
        temperature: 0
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/scalar.py',
      '../config/providers/mapped.py',
    ]);
  });

  it('should inspect duplicate provider YAML references only once', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        return 'id: file://providers/nested.py:call_api';
      }
      return `
providers:
  - file://providers/provider.yaml
  - file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.yaml',
      '../config/providers/nested.py',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('should bound provider-config inspection and conservatively watch the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const providerRefs = Array.from(
      { length: 150 },
      (_, index) => `  - file://providers/provider-${index}.yaml`,
    ).join('\n');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes('/providers/provider-')) {
        return 'id: openai:chat:gpt-4';
      }
      return `providers:\n${providerRefs}`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toContain('./');
    expect(mockFs.readFileSync.mock.calls.length).toBeLessThanOrEqual(129);
  });

  it('should bound provider-value traversal and conservatively watch the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const providerRefs = Array.from(
      { length: 1_200 },
      (_, index) =>
        `      tool-${index}: file://providers/provider-${index}.py`,
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:chat:gpt-4
    config:
${providerRefs}
targets:
  - file://providers/target.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toContain('./');
    expect(deps.length).toBeLessThan(1_200);
  });

  it('should bound expanded glob matches and conservatively watch the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(
      Array.from(
        { length: 5_000 },
        (_, index) => `/test/repository/providers/provider-${index}.py`,
      ),
    );

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.realpathSync.mock.calls.length).toBeLessThan(10);
  });

  it('should apply the glob cap before reading matched provider YAML files', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `providers:\n  - file://providers/*.yaml\n`;
      }
      throw new Error('PROVIDER_GLOB_READ_SECRET_CANARY_019F62C3');
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(
      Array.from(
        { length: 4_097 },
        (_, index) => `/test/repository/providers/provider-${index}.yaml`,
      ),
    );

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('should cap provider YAML inspection before reading every glob match', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return `providers:\n  - file://providers/*.yaml\n`;
      }
      return 'id: openai:chat:gpt-4';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(
      Array.from(
        { length: 1_300 },
        (_, index) => `/test/repository/providers/provider-${index}.yaml`,
      ),
    );

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toContain('./');
    expect(mockFs.readFileSync.mock.calls.length).toBeLessThanOrEqual(129);
  });

  it('should conservatively watch and redact unexpected dependency-extraction errors', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('GLOB_PATH_SECRET_CANARY_019F62C3');
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'GLOB_PATH_SECRET_CANARY_019F62C3',
    );
  });

  it('should preserve an external config-directory watch root after an extraction error', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/working');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('GLOB_PATH_SECRET_CANARY_019F62C3');
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/']);
  });

  it('should conservatively watch the workspace for an unreadable provider YAML file', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('provider.yaml')) {
        throw new Error('provider config is unavailable');
      }
      return `
providers: file://providers/provider.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.yaml', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Watching the repository workspace conservatively',
      ),
    );
  });

  it('should conservatively watch an executable provider symlink outside the workspace without reading it', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath.endsWith('/providers/external.py')) {
        return '/test/outside/external.py';
      }
      return filePath;
    });
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/providers/external.py')) {
        throw new Error('SCRIPT_SYMLINK_SECRET_CANARY');
      }
      return `
providers:
  - file://providers/external.py
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'SCRIPT_SYMLINK_SECRET_CANARY',
    );
  });

  it('should reject a provider YAML symlink outside the workspace without leaking its contents', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath.endsWith('/providers/external.yaml')) {
        return '/test/outside/external.yaml';
      }
      return filePath;
    });
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/providers/external.yaml')) {
        return 'secret: SYMLINK_SECRET_CANARY_019F62C3: invalid';
      }
      return `
providers:
  - file://providers/external.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'SYMLINK_SECRET_CANARY_019F62C3',
    );
  });

  it('should conservatively watch symlinked prompt, variable, and assertion paths without external reads', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (
        filePath.includes('/prompts/link.txt') ||
        filePath.includes('/vars/link.txt') ||
        filePath.includes('/assertions/link.js')
      ) {
        return '/test/outside/SECRET_SYMLINK_TARGET_019F62C3';
      }
      return filePath;
    });
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file: prompts/link.txt
tests:
  - vars:
      context: file://vars/link.txt
    assert:
      - type: javascript
        value: file://assertions/link.js
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ENOENT',
    'ENOTDIR',
  ])('should reject a missing provider YAML below an escaping symlink on %s without reading it', (code) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath.endsWith('/providers/external/new.yaml')) {
        throw Object.assign(new Error('REALPATH_SECRET_CANARY'), { code });
      }
      if (filePath.endsWith('/providers/external')) {
        return '/test/outside';
      }
      return filePath;
    });
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/providers/external/new.yaml')) {
        return `
id: openai:chat:gpt-4
config:
  template: file://templates/from-external.txt
secret: OUTSIDE_SECRET_CANARY_019F62C3
`;
      }
      return `
providers:
  - file://providers/external/new.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'OUTSIDE_SECRET_CANARY_019F62C3',
    );
  });

  it('should sanitize malformed provider YAML errors before warning', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/providers/invalid.yaml')) {
        return 'secret: PARSER_SECRET_CANARY_019F62C3: invalid';
      }
      return `
providers:
  - file://providers/invalid.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/invalid.yaml', './']);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'PARSER_SECRET_CANARY_019F62C3',
    );
  });

  it('should redact a rendered provider YAML path when inspection fails', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    vi.stubEnv('PROMPTFOO_PROVIDER_FILE', 'PATH_SECRET_CANARY_019F62C3');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/PATH_SECRET_CANARY_019F62C3.yaml')) {
        return 'secret: PARSER_SECRET_CANARY_019F62C3: invalid';
      }
      return `
providers:
  - file://providers/{{ env.PROMPTFOO_PROVIDER_FILE }}.yaml
`;
    });

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/PATH_SECRET_CANARY_019F62C3.yaml', './']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('{{ env.PROMPTFOO_PROVIDER_FILE }}');
    expect(warnings).not.toContain('PATH_SECRET_CANARY_019F62C3');
    expect(warnings).not.toContain('PARSER_SECRET_CANARY_019F62C3');
    vi.unstubAllEnvs();
  });

  it.each([
    ['ENOENT', ['providers/missing.py']],
    ['ENOTDIR', ['providers/missing.py']],
    ['EACCES', ['./']],
  ])('should handle %s while checking a provider dependency real path', (code, expected) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath.endsWith('/providers/missing.py')) {
        throw Object.assign(new Error('REALPATH_SECRET_CANARY'), { code });
      }
      return filePath;
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/missing.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(expected);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'REALPATH_SECRET_CANARY',
    );
  });

  it('should preserve a provider dependency when all of its contained ancestors are missing', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath !== '/test/repository') {
        throw Object.assign(new Error('REALPATH_SECRET_CANARY'), {
          code: 'ENOENT',
        });
      }
      return filePath;
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/missing/deep/provider.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/missing/deep/provider.py']);
  });

  it('should conservatively watch the workspace when its real path cannot be checked', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      if (String(value) === '/test/repository') {
        throw Object.assign(new Error('ROOT_REALPATH_SECRET_CANARY'), {
          code: 'EACCES',
        });
      }
      return String(value);
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py
  - file://providers/provider-two.py
  - file://providers/provider-three.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'ROOT_REALPATH_SECRET_CANARY',
    );
    expect(
      mockFs.realpathSync.mock.calls.filter(
        ([value]) => String(value) === '/test/repository',
      ),
    ).toHaveLength(1);
  });

  it('should conservatively watch non-provider dependencies when the workspace real path cannot be checked', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      if (String(value) === '/test/repository') {
        throw Object.assign(new Error('ROOT_REALPATH_SECRET_CANARY'), {
          code: 'EACCES',
        });
      }
      return String(value);
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
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).not.toContain(
      'ROOT_REALPATH_SECRET_CANARY',
    );
  });

  it('should reject an absolute provider outside the repository', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/secrets/provider.py
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it('should not reinterpret an invalid provider function selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.js:not-valid
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.js:not-valid']);
  });

  it('should preserve a Windows drive colon in a Python provider', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///C:/repository/providers/provider.py:custom_call
`);

      const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

      expect(deps).toEqual(['../config/C:/repository/providers/provider.py']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
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

  it('should ignore a malformed non-string prompt file value', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file: 17
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
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

  it('should extract provider dependencies from configs using supported legacy YAML tags', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
metadata:
  binary: !!binary SGVsbG8=
  timestamp: 2024-01-02
  ordered: !!omap [{a: 1}, {b: 2}]
  pairs: !!pairs [{a: 1}, {b: 2}]
  set: !!set {a: null, b: null}
providers:
  - file://providers/provider.py:call_api
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/provider.py']);
  });

  it('should reject invalid legacy YAML sets', () => {
    mockFs.readFileSync.mockReturnValue(`
metadata: !!set {a: invalid}
providers:
  - file://providers/provider.py:call_api
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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

  it('should handle an explicit null config', () => {
    mockFs.readFileSync.mockReturnValue('null');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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

  it('should ignore an external provider config without watching the workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://../outside/provider.yaml
  - file://providers/safe.py
`);

    expect(
      extractFileDependencies('/test/repository/promptfooconfig.yaml'),
    ).toEqual(['providers/safe.py']);
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

  it('should ignore null-byte provider globs without expanding them', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://\\0*.py"
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual(['../config/providers/safe.py']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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

  it('should keep absolute checkout provider dependencies for an external config', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath === '/private/configs') {
        throw Object.assign(new Error('UNUSED_ROOT_SECRET_CANARY'), {
          code: 'EACCES',
        });
      }
      return filePath;
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/repository/providers/direct.py
  - file:///test/repository/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/repository/providers/matched.py']);

    expect(
      extractFileDependencies('/private/configs/promptfooconfig.yaml'),
    ).toEqual(['providers/direct.py', 'providers/matched.py', 'providers/']);
    expect(
      mockFs.realpathSync.mock.calls.filter(
        ([value]) => String(value) === '/private/configs',
      ),
    ).toHaveLength(0);
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

    expect(deps).toEqual(['../config/']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should ignore an unsafe expanded match from a contained provider glob', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/secrets/leaked.py',
      '/test/config/providers/custom.py',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/custom.py',
      '../config/providers/',
    ]);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('<redacted unsafe config dependency match>');
    expect(warnings).not.toContain('/test/secrets/leaked.py');
  });

  it('should reject escaping and inaccessible checkout glob matches for an external config without leaking paths', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    const forgedMatch =
      '/test/repository/providers/link\n::error::GLOB_MATCH_CANARY_019F62C3.py';
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/repository/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      forgedMatch,
      '/test/repository/providers/denied.py',
      '/test/repository/providers/safe.py',
    ]);
    mockFs.realpathSync.mockImplementation((value: unknown) => {
      const filePath = String(value);
      if (filePath === forgedMatch) {
        return '/private/secrets/provider.py';
      }
      if (filePath.endsWith('/providers/denied.py')) {
        throw Object.assign(new Error('REALPATH_SECRET_CANARY'), {
          code: 'EACCES',
        });
      }
      return filePath;
    });

    expect(
      extractFileDependencies('/private/configs/promptfooconfig.yaml'),
    ).toEqual(['providers/safe.py', 'providers/']);
    const warnings = vi.mocked(core.warning).mock.calls.flat().join('\n');
    expect(warnings).toContain('Ignoring unsafe config dependency match');
    expect(warnings).not.toContain('GLOB_MATCH_CANARY_019F62C3');
    expect(warnings).not.toContain('REALPATH_SECRET_CANARY');
    expect(warnings).not.toContain('/providers/denied.py');
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
    expect(
      mockFs.realpathSync.mock.calls.filter(
        ([value]) => String(value) === '/test/config',
      ),
    ).toHaveLength(1);
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
