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

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('glob match must stay within the repository'),
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
    expect(mockFs.realpathSync).not.toHaveBeenCalled();
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();
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
  response_format: file://native-schema.json
  tools: file://native-tools.json
  provider:
    text:
      id: file://native-text-grader.js
    embedding:
      id: file://native-embedding-grader.js
    classification:
      id: file://native-classification-grader.js
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
      'evals/native-schema.json',
      'evals/native-tools.json',
      'evals/native-text-grader.js',
      'evals/native-embedding-grader.js',
      'evals/native-classification-grader.js',
      'evals/native-moderation-grader.js',
    ]);
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
    mockGlob.sync.mockImplementation((pattern: string) => {
      if (pattern.includes('{one,two}')) {
        return [
          '/test/working/evals/fixtures/one.txt',
          '/test/working/evals/fixtures/two.txt',
        ];
      }
      if (pattern.includes('fixtures\\*.txt')) {
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
      expect.stringContaining('{one,two}'),
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

    expect(deps).toEqual(['evals/defaults/default.yaml', 'evals/']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('glob base must stay within the repository'),
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
