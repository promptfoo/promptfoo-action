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
  PROMPTFOO_IGNORED_VALUE: 42
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

  it('should conservatively watch the workspace for a filtered provider path template', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/repository');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{{ env.PROMPTFOO_MISSING_PROVIDER | default('provider') }}.py:café
`);

    const deps = extractFileDependencies(
      '/test/repository/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
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

  it('should preserve the workspace watch root for an absolute root-level provider glob', () => {
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

    expect(deps).toEqual(['./']);
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

    expect(deps).toEqual(['../config/providers/custom.py', '../config/']);
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
