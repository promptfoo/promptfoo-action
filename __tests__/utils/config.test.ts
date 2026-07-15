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

  it('should strip a function selector from an object file provider', () => {
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

  it('should preserve an absolute in-workspace file provider path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: file:///test/working/providers/custom.py:call_api
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['providers/custom.py']);
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

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
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

  it('should retain missing provider files when realpath reports ENOENT', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers: file://providers/deleted.py:call_api',
    );
    mockFs.realpathSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/deleted.py']);
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

    expect(deps).toEqual([]);
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some((call) => String(call[0]).includes('SECRET_MARKER')),
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
  - file://invalid.yaml
  - file://unreadable.json
`;
      }
      if (filePath.endsWith('invalid.yaml')) {
        throw new Error('invalid provider config');
      }
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/invalid.yaml',
      '../config/unreadable.json',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested provider dependencies from "invalid.yaml"; tracking the provider config file only',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract nested provider dependencies from "unreadable.json"; tracking the provider config file only',
    );
    expect(
      vi
        .mocked(core.warning)
        .mock.calls.some(
          (call) =>
            String(call[0]).includes('invalid provider config') ||
            String(call[0]).includes('permission denied'),
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
