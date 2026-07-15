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
    mockFs.existsSync.mockReturnValue(false);
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath),
    );
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

    expect(deps).toEqual(['evals/defaults/default.yaml']);
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

    expect(deps).toEqual(['evals/defaults/default.yaml']);
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
      'evals/defaults',
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
      'evals/defaults',
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

  it('should skip glob enumeration when the workspace root cannot be resolved', () => {
    mockFs.readFileSync.mockReturnValue('providers: [file://providers/*.py]');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockFs.realpathSync.mockImplementation(() => {
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
      if (String(filePath) === '/test/working' && rootReads++ === 0) {
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
    ]);
  });

  it('should track a scalar Python vars generator without inspecting it as YAML', () => {
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
      'evals/generators/vars.py',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should track array-form JS and Python vars generators with selectors without inspecting them', () => {
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
      'evals/generators/vars.cjs',
      'evals/generators/more-vars.py',
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

  it('should track a nested provider-config glob without inspecting the pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('evals/promptfooconfig.yaml')) {
        return 'defaultTest: file://defaults/default.yaml';
      }
      if (String(filePath).endsWith('evals/defaults/default.yaml')) {
        return 'provider: file://providers/{one,two}.yaml';
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
      'evals/providers',
    ]);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2);
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
      'evals/data',
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
      'evals/data',
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
      'evals/data',
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
      'evals/fixtures',
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

    expect(deps).toEqual([
      '../config/',
      '../config/providers/custom.py',
      '../config/providers',
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
