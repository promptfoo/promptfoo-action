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
    mockFs.realpathSync.mockImplementation((filePath: unknown) => filePath);
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

  it('should normalize canonical Windows file URL paths without changing POSIX paths', () => {
    expect(normalizeConfigFilePath('/C:/repo/prompts/build.py', 'win32')).toBe(
      'C:/repo/prompts/build.py',
    );
    expect(normalizeConfigFilePath('/C:/repo/prompts/*.txt', 'win32')).toBe(
      'C:/repo/prompts/*.txt',
    );
    expect(normalizeConfigFilePath('prompts\\*.txt', 'win32')).toBe(
      'prompts/*.txt',
    );
    expect(
      normalizeConfigFilePath('/test/working/prompts/build.py', 'linux'),
    ).toBe('/test/working/prompts/build.py');
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

  it('should preserve dependencies when prompts use the supported map form', () => {
    const configContent = `
providers:
  - file://providers/provider.py
prompts:
  mapped-prompt: mapping input
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.py']);
  });

  it('should extract file prompt keys from the supported map form', () => {
    const configContent = `
prompts:
  file://prompts/mapped.txt: mapped prompt
`;
    mockFs.readFileSync.mockReturnValue(configContent);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/mapped.txt']);
  });

  it('should extract function-backed prompt keys from the supported map form', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/build.py:create_prompt: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.py']);
  });

  it('should extract Ruby prompt-map keys with namespaced selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/build.rb:MyModule::Nested.method: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.rb']);
  });

  it('should extract bare file and function prompt-map keys', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  prompts/main.txt: main prompt
  prompts/build.py:create_prompt: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/main.txt',
      '../config/prompts/build.py',
    ]);
  });

  it('should ignore multiline inline prompt-map keys containing glob syntax', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ? |-
    What does [a-z] match?
    Explain with an example.
  : inline prompt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('[a-z]'),
    );

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should ignore long inline prompt-map keys without passing them to glob', () => {
    const longPrompt = `Explain this passage: ${'a'.repeat(70_000)}`;
    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  "${longPrompt}": inline\n`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw new Error('pattern is too long');
      }
      return false;
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it.each([
    'Explain *carefully* how this works',
    'Summarize https://example.com/docs for the user',
    'Compare this / that for clarity',
    'Choose [pass/fail]',
    'Use * for yes/no',
    'Explain *carefully* for pass/fail',
    'Return **bold** for yes/no',
    'Choose [safe] for yes/no',
    'Classify as [positive,negative] for pass/fail',
    'What? Answer yes/no',
    'Is it safe? choose pass/fail',
    'Use regex (foo|bar)? for yes/no',
    'Summarize [a-z] for input/output',
    'Explain [a-z], e.g.',
  ])('should ignore single-line inline prompt-map keys containing path markers: %s', (prompt) => {
    mockFs.readFileSync.mockReturnValue(
      `prompts:\n  "${prompt}": inline prompt\n`,
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('[') || value.includes('?'),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
  });

  it('should extract bare executable prompt paths and globs containing spaces', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ./tools/my generator: generated prompt
  tools/my other generator: another generated prompt
  prompts with spaces/*.tmpl: globbed prompt
  prompt assets/my generator: spaced executable prompt
  prompt assets/my generator*: spaced globbed prompt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((pattern: string) =>
      pattern.includes('prompt assets')
        ? ['/test/working/prompt assets/my generator-v2']
        : ['/test/working/prompts with spaces/generate.tmpl'],
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'tools/my generator',
      'tools/my other generator',
      'prompts with spaces/generate.tmpl',
      'prompts with spaces',
      'prompt assets/my generator',
      'prompt assets/my generator-v2',
      'prompt assets',
    ]);
  });

  it('should retain deleted prompt paths with whitespace-only segments', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  prompts/ /deleted-generator.longunknown: unknown executable
  prompts/ /deleted-generator.xy: short executable
  prompts/ /deleted generator: extensionless executable
  prompt assets/ /my generator: multiword executable
  prompt assets/ /my generator*: multiword executable glob
  prompt assets/file?: question-mark executable glob
  prompt assets/ /file?: spaced question-mark executable glob
  prompt assets/file [a-z]: bracket executable glob
  prompts/ /file [0-9]: spaced bracket executable glob
  prompt assets/my *file*: asterisk executable glob
  prompt assets/ /my **file**: spaced asterisk executable glob
  prompt assets/my *file* draft: asterisk executable glob with suffix
  prompt assets/file? draft: question-mark executable glob with suffix
  prompt assets/file [a-z] draft: bracket executable glob with suffix
`);
    mockFs.existsSync.mockReturnValue(false);
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('?') || value.includes('['),
    );
    mockGlob.sync.mockImplementation((pattern: string) => {
      if (pattern.endsWith('/ /file?')) {
        return ['/test/working/prompt assets/ /file1'];
      }
      if (pattern.endsWith('/file?')) {
        return ['/test/working/prompt assets/file1'];
      }
      if (pattern.endsWith('/file [a-z]')) {
        return ['/test/working/prompt assets/file a'];
      }
      if (pattern.endsWith('/file [0-9]')) {
        return ['/test/working/prompts/ /file 1'];
      }
      if (pattern.endsWith('/my *file*')) {
        return ['/test/working/prompt assets/my matched-file-v2'];
      }
      if (pattern.endsWith('/my **file**')) {
        return ['/test/working/prompt assets/ /my matched-file-v3'];
      }
      if (pattern.endsWith('/my *file* draft')) {
        return ['/test/working/prompt assets/my matched-file-v4 draft'];
      }
      if (pattern.endsWith('/file? draft')) {
        return ['/test/working/prompt assets/file1 draft'];
      }
      if (pattern.endsWith('/file [a-z] draft')) {
        return ['/test/working/prompt assets/file a draft'];
      }
      return ['/test/working/prompt assets/ /my generator-v2'];
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/ /deleted-generator.longunknown',
      'prompts/ /deleted-generator.xy',
      'prompts/ /deleted generator',
      'prompt assets/ /my generator',
      'prompt assets/ /my generator-v2',
      'prompt assets/ ',
      'prompt assets/file1',
      'prompt assets',
      'prompt assets/ /file1',
      'prompt assets/file a',
      'prompts/ /file 1',
      'prompts/ ',
      'prompt assets/my matched-file-v2',
      'prompt assets/ /my matched-file-v3',
      'prompt assets/my matched-file-v4 draft',
      'prompt assets/file1 draft',
      'prompt assets/file a draft',
    ]);
  });

  it('should extract nested file references from mapped YAML and JSON prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://prompts/chat.yaml: yaml prompt
  file://prompts/chat.json: json prompt
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return 'system: file://partials/system.txt\n';
      }
      if (candidate.endsWith('/prompts/chat.json')) {
        return '{"messages":[{"content":"file://partials/user.txt"}]}';
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/prompts/chat.yaml',
      '../config/partials/system.txt',
      '../config/prompts/chat.json',
      '../config/partials/user.txt',
    ]);
  });

  it('should resolve environment templates in nested mapped prompt references', () => {
    vi.stubEnv('PARTIAL_DIR', 'resolved');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://partials/{{ env.PARTIAL_DIR }}/system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/resolved/system.txt']);
  });

  it('should prefer config environment values in nested mapped prompt references', () => {
    vi.stubEnv('PARTIAL_DIR', 'process-value');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'env:\n  PARTIAL_DIR: config-value\nprompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://partials/{{ env["PARTIAL_DIR"] }}/system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/config-value/system.txt']);
  });

  it('should resolve built-in environment filters and defaults in nested mapped prompt references', () => {
    vi.stubEnv('PARTIAL_DIR', 'process-value');
    vi.stubEnv('MISSING_PARTIAL', undefined);
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'env:\n  PARTIAL_DIR: "  Config-Value  "\n  NON_STRING_PARTIAL: 1\nprompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return `messages:
  - content: file://partials/{{ env.PARTIAL_DIR | trim | lower }}/system.txt
  - content: file://partials/{{ env.MISSING_PARTIAL | default('fallback') | upper }}/user.txt
`;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/chat.yaml',
      'partials/config-value/system.txt',
      'partials/FALLBACK/user.txt',
    ]);
  });

  it('should resolve nested config environment templates before mapped prompt references', () => {
    vi.stubEnv('ROOT_PARTIAL_DIR', 'Config-Value');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'env:\n  PARTIAL_DIR: "{{ env.ROOT_PARTIAL_DIR | lower }}"\nprompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://partials/{{ env.PARTIAL_DIR }}/system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/config-value/system.txt']);
  });

  it('should resolve scalar environment filters and empty-value defaults in nested mapped prompt references', () => {
    vi.stubEnv('EXISTING_PARTIAL', 'existing');
    vi.stubEnv('EMPTY_PARTIAL', '');
    vi.stubEnv('INTEGER_PARTIAL', '12-items');
    vi.stubEnv('INVALID_INTEGER_PARTIAL', 'items');
    vi.stubEnv('FLOAT_PARTIAL', '1.5-items');
    vi.stubEnv('INVALID_FLOAT_PARTIAL', 'items');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return `messages:
  - content: file://partials/{{ env.EXISTING_PARTIAL | default('fallback') }}/existing.txt
  - content: file://partials/{{ env.EMPTY_PARTIAL | d('fallback', true) }}/empty.txt
  - content: file://partials/{{ env.INTEGER_PARTIAL | int | string }}/integer.txt
  - content: file://partials/{{ env.INVALID_INTEGER_PARTIAL | int }}/invalid-integer.txt
  - content: file://partials/{{ env.FLOAT_PARTIAL | float }}/float.txt
  - content: file://partials/{{ env.INVALID_FLOAT_PARTIAL | float }}/invalid-float.txt
`;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/chat.yaml',
      'partials/existing/existing.txt',
      'partials/fallback/empty.txt',
      'partials/12/integer.txt',
      'partials/0/invalid-integer.txt',
      'partials/1.5/float.txt',
      'partials/0/invalid-float.txt',
    ]);
  });

  it('should strip Nunjucks comments from nested mapped prompt references', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://partials/{#path-note#}system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
  });

  it.each([
    'cjs',
    'cts',
    'js',
    'mjs',
    'mts',
    'ts',
    'py',
    'go',
    'rb',
  ])('should strip executable selectors from nested mapped prompt references: %s', (extension) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return `messages:\n  - content: file://partials/build.${extension}:generate\n`;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', `partials/build.${extension}`]);
  });

  it.each([
    '{{ env.MISSING_PARTIAL }}',
    '{{ env.MISSING_PARTIAL | upper }}',
    '{{ env.PARTIAL_DIR | custom_filter }}',
    '{{ vars.partial_dir }}',
    '{% if env.PARTIAL_DIR %}resolved{% endif %}',
  ])('should conservatively watch nested prompt references with an unresolved template: %s', (template) => {
    vi.stubEnv('MISSING_PARTIAL', undefined);
    vi.stubEnv('PARTIAL_DIR', 'resolved');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return `messages:\n  - content: file://partials/${template}/system.txt\n`;
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Templated prompt file dependencies'),
    );
  });

  it('should not expose expanded environment values in unsafe nested prompt warnings', () => {
    vi.stubEnv('CUSTOM_RUNTIME_SECRET', 'SENSITIVE-REVIEW-TOKEN');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://../outside/{{ env.CUSTOM_RUNTIME_SECRET }}/system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('{{ env.CUSTOM_RUNTIME_SECRET }}'),
    );
    expect(vi.mocked(core.warning).mock.calls.join('\n')).not.toContain(
      'SENSITIVE-REVIEW-TOKEN',
    );
  });

  it('should not expose expanded environment values in unsafe nested prompt glob warnings', () => {
    vi.stubEnv('CUSTOM_RUNTIME_SECRET', 'SENSITIVE-REVIEW-TOKEN');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'messages:\n  - content: file://partials/{{ env.CUSTOM_RUNTIME_SECRET }}/*.txt\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/tmp/outside/secret.txt']);

    extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('{{ env.CUSTOM_RUNTIME_SECRET }}'),
    );
    expect(vi.mocked(core.warning).mock.calls.join('\n')).not.toContain(
      'SENSITIVE-REVIEW-TOKEN',
    );
  });

  it('should support Promptfoo legacy YAML tags in mapped configs and prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
metadata:
  binary: !!binary SGVsbG8=
  timestamp: 2024-01-02
  ordered: !!omap [{a: 1}, {b: 2}]
  pairs: !!pairs [{a: 1}, {b: 2}]
  set: !!set {a: null, b: null}
prompts:
  file://prompts/chat.yaml: yaml prompt
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `
metadata:
  binary: !!binary SGVsbG8=
  set: !!set {a: null}
system: file://partials/system.txt
`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
  });

  it('should treat binary YAML scalars as traversal leaves', () => {
    const keys = vi.spyOn(Object, 'keys');
    const entries = vi.spyOn(Object, 'entries');
    const values = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'metadata:\n  binary: !!binary SGVsbG8=\nprompts:\n  file://prompts/chat.yaml: yaml prompt\n';
      }
      return 'metadata:\n  binary: !!binary SGVsbG8=\nsystem: file://partials/system.txt\n';
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
    expect(
      [...keys.mock.calls, ...entries.mock.calls, ...values.mock.calls].some(
        ([value]) => ArrayBuffer.isView(value),
      ),
    ).toBe(false);
  });

  it('should tolerate self-referential arrays in mapped structured prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `prompts:\n  file://prompts/chat.yaml: yaml prompt\n`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `items: &items [*items, file://partials/system.txt]\n`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'partials/system.txt']);
  });

  it('should reject invalid Promptfoo legacy YAML sets', () => {
    mockFs.readFileSync.mockReturnValue(`
metadata: !!set {a: not-null}
prompts:
  file://prompts/main.txt: prompt
`);

    expect(() =>
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toThrow(/cannot resolve a set item/);
  });

  it('should extract safe globbed YAML prompts while tolerating cycles and unsafe matches', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://prompts/*.yaml: mapped prompts
`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return `
node: &node
  system: file://partials/system.txt
  self: *node
  optional: null
  count: 2
`;
      }
      throw new Error(`unexpected read: ${candidate}`);
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts/chat.yaml',
      '/outside/prompts/unsafe.yaml',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/chat.yaml', 'prompts', 'partials/system.txt']);
  });

  it.each([
    'prompts/*.{yaml,json}',
    'prompts/*',
  ])('should extract nested references from mapped structured prompt glob %s', (promptGlob) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `prompts:\n  file://${promptGlob}: mapped prompts\n`;
      }
      if (candidate.endsWith('/prompts/chat.yaml')) {
        return 'system: file://partials/system.txt\n';
      }
      if (candidate.endsWith('/prompts/chat.json')) {
        return '{"user":"file://partials/user.txt"}';
      }
      throw new Error(`unexpected read: ${candidate}`);
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts/chat.yaml',
      '/test/working/prompts/chat.json',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([
      'prompts/chat.yaml',
      'prompts/chat.json',
      'prompts',
      'partials/system.txt',
      'partials/user.txt',
    ]);
  });

  it('should ignore unsafe and malformed mapped structured prompts', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('promptfooconfig.yaml')) {
        return `
prompts:
  file://../outside.yaml: unsafe prompt
  file://prompts/broken.json: malformed prompt
`;
      }
      if (candidate.endsWith('/prompts/broken.json')) return '{not json';
      throw new Error(`unexpected read: ${candidate}`);
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/broken.json']);
  });

  it('should not read mapped structured prompts that resolve outside the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('promptfooconfig.yaml')) {
        return 'prompts:\n  file://prompts/linked.yaml: linked prompt\n';
      }
      return 'secret: SENSITIVE-REVIEW-TOKEN\n';
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockReturnValue('/tmp/outside/secret.yaml');

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/linked.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe prompt file dependency "prompts/linked.yaml": resolved path must stay within the repository workspace',
    );
  });

  it('should extract executable prompt-map keys from the action working directory', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:./prompts/generate.sh --tone formal: generated prompt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['prompts/generate.sh']);
  });

  it('should retain a deleted file argument for mapped executable prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:node templates/generate.js --tone formal: generated prompt
`);
    mockFs.existsSync.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['node', 'templates/generate.js']);
  });

  it('should retain escaped-space file arguments for mapped executable prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:node templates/my\\ generator.py --tone formal: generated prompt
`);
    mockFs.existsSync.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['node', 'templates/my generator.py']);
  });

  it('should track existing file arguments for mapped executable prompts from the action working directory', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:../bin/python ../prompts/generate.py: generated prompt
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/prompts/generate.py'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working/custom',
    );

    expect(deps).toEqual(['bin/python', 'prompts/generate.py']);
  });

  it('should track contained absolute executable arguments and ignore directory arguments', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  exec:../bin/python /test/working/prompts/generate.py ./templates /tmp/outside/generate.py: generated prompt
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      return (
        candidate.endsWith('/prompts/generate.py') ||
        candidate.endsWith('/templates')
      );
    });
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => String(filePath).endsWith('/templates'),
          isFile: () => String(filePath).endsWith('/prompts/generate.py'),
          mode: 0o644,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working/custom',
    );

    expect(deps).toEqual(['bin/python', 'prompts/generate.py']);
  });

  it('should resolve mapped executable prompt arguments from prompt config basePath', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: exec:../bin/python templates/generate.py
    config:
      basePath: custom
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/custom/templates/generate.py'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['bin/python', 'custom/templates/generate.py']);
  });

  it('should resolve direct executable prompt paths from prompt config basePath', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: exec:./scripts/build.sh
    config:
      basePath: custom
`);

    expect(
      extractFileDependencies(
        '/test/working/evals/promptfooconfig.yaml',
        '/test/working',
      ),
    ).toEqual(['custom/scripts/build.sh']);
  });

  it('should extract uncommon root-level executable prompt-map keys', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  generate.zsh: generated prompt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['generate.zsh']);
  });

  it.each([
    'generate.run',
    'generate.xy',
  ])('should extract root-level prompt-map executables with a short suffix: %s', (promptPath) => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  ${promptPath}: generated prompt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([promptPath]);
  });

  it('should extract file-backed prompt ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: file://prompts/main.txt
    label: main prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/main.txt']);
  });

  it('should extract bare file and function prompt ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: prompts/main.txt
    label: main prompt
  - id: prompts/build.py:create_prompt
    label: generated prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/main.txt',
      '../config/prompts/build.py',
    ]);
  });

  it('should prefer file-backed and executable prompt raw values over ids', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: file://prompts/from-raw.txt
    id: prompts/ignored.txt
    label: raw prompt
  - raw: exec:./prompts/generate.sh --tone formal
    label: generated prompt
  - raw: inline prompt
    label: inline
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['evals/prompts/from-raw.txt', 'prompts/generate.sh']);
  });

  it('should ignore empty executable prompts and unsupported prompt objects', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - "exec:"
  - label: unsupported prompt object
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore null prompt and test entries from YAML', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - null
  - inline prompt
tests:
  - null
  - vars:
      context: file://data/context.txt
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['data/context.txt']);
  });

  it('should extract dependencies from a singleton test generator', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/generate.py:create_tests
  config:
    dataset: file://data/cases.json
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/generate.py',
      '../config/data/cases.json',
    ]);
  });

  it('should extract nested config files from a bare-path test generator', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: tests/generate.py:create_tests
  config:
    dataset: file://data/cases.json
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/generate.py',
      '../config/data/cases.json',
    ]);
  });

  it('should extract nested generator config files and string test references', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/cases.yaml
  - inline test reference
  - path: file://tests/build.ts:create_tests
    config:
      datasets:
        - file://data/first.json
        - nested:
            source: file://data/second.json
            enabled: true
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/tests/cases.yaml',
      '../config/tests/build.ts',
      '../config/data/first.json',
      '../config/data/second.json',
    ]);
  });

  it.each([
    ['xlsx string', 'tests: file://tests/test_cases.xlsx#Sheet2'],
    ['xls string', 'tests: file://tests/test_cases.xls#My Data Sheet'],
    ['xlsx path', 'tests:\n  path: file://tests/test_cases.xlsx#Sheet2'],
    ['xls bare path', 'tests:\n  path: tests/test_cases.xls#2'],
  ])('should strip spreadsheet sheet selectors from %s test dependencies', (_name, section) => {
    mockFs.readFileSync.mockReturnValue(`${section}\n`);

    const extension = section.includes('.xlsx') ? 'xlsx' : 'xls';
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([`tests/test_cases.${extension}`]);
  });

  it('should strip spreadsheet sheet selectors before expanding test globs', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file://tests/*.{xlsx,xls}#Sheet2\n',
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/tests/first.xlsx',
      '/test/working/tests/second.xls',
    ]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tests/first.xlsx', 'tests/second.xls', 'tests']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/working/tests/*.xlsx', '/test/working/tests/*.xls'],
      expect.objectContaining({ windowsPathsNoEscape: true }),
    );
  });

  it('should preserve fragments on non-spreadsheet test dependencies', () => {
    mockFs.readFileSync.mockReturnValue(
      'tests: file://tests/test_cases.yaml#literal-fragment\n',
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tests/test_cases.yaml#literal-fragment']);
  });

  it('should tolerate self-referential generator config objects and arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://tests/generate.py:create_tests
  config:
    binary: !!binary SGVsbG8=
    object: &object
      self: *object
      source: file://data/object.json
    array: &array [*array, file://data/array.json]
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['tests/generate.py', 'data/object.json', 'data/array.json']);
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

  it('should preserve literal function-like suffixes in variable and assertion filenames', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      context: file://data/context.rb:v2
    assert:
      - type: contains
        value: file://expected/output.py:v3
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/data/context.rb:v2',
      '../config/expected/output.py:v3',
      '../config/expected/output.py',
    ]);
  });

  it('should track executable variable and assertion files with function selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      javascript: file://vars/build.cjs:generateValue
      python: file://vars/build.py:generate_value
    assert:
      - type: contains
        value: file://validators/check.cjs:knownValue
      - type: contains
        value: file://validators/check.py:known_value
      - type: contains
        value: file://validators/check.rb:MyModule::Nested.method
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(
      expect.arrayContaining([
        '../config/vars/build.cjs',
        '../config/vars/build.py',
        '../config/validators/check.cjs',
        '../config/validators/check.py',
        '../config/validators/check.rb',
      ]),
    );
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

  it('should extract nested HTTP file-auth and assertion config dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/api
    env:
      AUTH_PATH: ./auth/current-token.ts
      IGNORED_NUMBER: 7
    config: &provider_config
      auth:
        type: file
        path: "{{ env.AUTH_PATH }}"
      self: *provider_config
      binary: !!binary SGVsbG8=
  - id: https://example.test/named
    config:
      auth:
        type: file
        path: file://auth/named-token.py:get_token
defaultTest:
  assert:
    - type: assert-set
      assert:
        - type: llm-rubric
          config:
            rubric: file://rubrics/default.md
            tools:
              - file://tools/default-tools.py:get_tools
tests:
  - assert:
      - type: llm-rubric
        config:
          rubric: file://rubrics/test.md
          transform: file://checks/test.js:score
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/auth/current-token.ts',
      'evals/auth/named-token.py',
      'evals/rubrics/default.md',
      'evals/tools/default-tools.py',
      'evals/rubrics/test.md',
      'evals/checks/test.js',
    ]);
  });

  it('should conservatively watch unresolved nested auth and assertion dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/api
    config:
      auth:
        type: file
        path: "{{ env.MISSING_AUTH }}"
      tls:
        keyPath: "{{ env.MISSING_KEY }}"
      tls:
        keyPath: "{{ env.MISSING_KEY }}"
tests:
  - assert:
      - type: llm-rubric
        config:
          rubric: file://rubrics/{{ env.MISSING_RUBRIC }}.md
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Templated prompt file dependencies cannot be extracted statically',
      ),
    );
  });

  it('should extract plain and env-templated HTTP credential paths through YAML aliases', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https://example.test/signature
    env:
      PRIVATE_KEY_PATH: ./credentials/from-env.pem
    config:
      other: &signature_auth
        privateKeyPath: "{{ env.PRIVATE_KEY_PATH }}"
        keystorePath: ./credentials/keystore.jks
        pfxPath: ./credentials/signature.pfx
        certPath: ./credentials/signature.crt
        keyPath: ./credentials/signature.key
      signatureAuth: *signature_auth
  - id: https://example.test/tls
    config:
      tls:
        caPath: ./credentials/ca.pem
        certPath: ./credentials/client.crt
        keyPath: ./credentials/client.key
        pfxPath: ./credentials/client.pfx
`);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'evals/credentials/from-env.pem',
      'evals/credentials/keystore.jks',
      'evals/credentials/signature.pfx',
      'evals/credentials/signature.crt',
      'evals/credentials/signature.key',
      'evals/credentials/client.pfx',
      'evals/credentials/client.crt',
      'evals/credentials/client.key',
      'evals/credentials/ca.pem',
    ]);
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

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['./']);
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

  it('should fail closed for invalid YAML', () => {
    mockFs.readFileSync.mockReturnValue('invalid: yaml: content:');

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config');
  });

  it.each([
    ['providers', 'providers:\n  $ref: providers.yaml#/providers'],
    ['inline providers', 'providers: { $ref: providers.yaml#/providers }'],
    [
      'explicit-key providers',
      'providers:\n  ? $ref\n  : providers.yaml#/providers',
    ],
    [
      'assertions',
      'tests:\n  - assert:\n      $ref: assertions.yaml#/assertions',
    ],
  ])('should conservatively watch the repository for valid YAML $ref %s', (_name, section) => {
    mockFs.readFileSync.mockReturnValue(`prompts: []\n${section}\n`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('YAML $ref dependencies'),
    );
  });

  it.each([
    ['quoted prompt', `prompts:\n  - 'Show {"$ref":"not-a-file"} to the user'`],
    [
      'block prompt',
      'prompts:\n  - |-\n    Show {"$ref":"not-a-file"} to the user',
    ],
    [
      'metadata value',
      'metadata:\n  note: |-\n    $ref: not-a-file.yaml#/definitions/example\nprompts:\n  - inline prompt',
    ],
  ])('should ignore $ref text inside an inline %s', (_name, configContent) => {
    mockFs.readFileSync.mockReturnValue(configContent);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    [
      'tool parameters',
      `providers:
  - id: openai:gpt-4o
    config:
      tools:
        - type: function
          function:
            name: example
            parameters:
              type: object
              properties:
                item:
                  $ref: '#/$defs/item'
              $defs:
                item:
                  type: string`,
    ],
    [
      'function parameters',
      `providers:
  - id: openai:gpt-4o
    config:
      functions:
        - name: example
          parameters:
            type: object
            properties:
              item:
                $ref: '#/$defs/item'
            $defs:
              item:
                type: string`,
    ],
  ])('should ignore parsed $ref keys inside provider %s schemas', (_name, section) => {
    mockFs.readFileSync.mockReturnValue(`prompts: []\n${section}\n`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should tolerate provider tools and functions without parameter schemas while scanning parsed $ref keys', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - openai:gpt-4o-mini:
      label: no config
  - openai:gpt-4o:
      config:
        functions:
          - name: without_parameters
          - name: null_parameters
            parameters: null
        tools:
          - type: web_search
          - type: function
            function:
              name: without_parameters
          - type: function
            function:
              name: null_parameters
              parameters: null
prompts: []
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should detect parsed $ref aliases that are also used by provider parameter schemas', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      schema: &shared
        $ref: external.yaml#/schema
providers:
  - id: openai:gpt-4o
    config:
      tools:
        - type: function
          function:
            name: example
            parameters: *shared
prompts: []
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('YAML $ref dependencies'),
    );
  });

  it('should match Promptfoo backslash-separated prompt globs on POSIX', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts\\*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompts/example.txt']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/example.txt', 'prompts']);
    expect(mockGlob.hasMagic).toHaveBeenCalledWith(
      'prompts/*.txt',
      expect.objectContaining({
        windowsPathsNoEscape: true,
        magicalBraces: true,
      }),
    );
  });

  it('should recognize Windows backslash-separated prompt globs', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts\\*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((filePath: string) =>
      filePath.includes('*'),
    );

    try {
      const deps = extractFileDependencies(
        '/test/working/promptfooconfig.yaml',
      );

      expect(deps).toEqual(['prompts/']);
      expect(mockGlob.hasMagic).toHaveBeenCalledWith(
        'prompts/*.txt',
        expect.objectContaining({
          windowsPathsNoEscape: true,
          magicalBraces: true,
        }),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('should conservatively watch all changes for JavaScript and TypeScript configs', () => {
    mockFs.readFileSync.mockReturnValue('export default { prompts: [] };');

    expect(extractFileDependencies('/test/working/promptfooconfig.ts')).toEqual(
      ['.'],
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('JavaScript/TypeScript config dependencies'),
    );
  });

  it('should fail closed for file read errors', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config: File not found');
  });

  it('should fail closed for non-Error file read failures', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    expect(() =>
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toThrow('Failed to extract dependencies from config: permission denied');
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

  it('should preserve absolute file URLs that stay inside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/prompts/absolute.txt: absolute prompt
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/absolute.txt']);
  });

  it('should preserve the watch root for an unmatched absolute prompt glob', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/prompts/*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/']);
  });

  it('should preserve the config directory for an unmatched root-level prompt glob', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/']);
  });

  it.each([
    false,
    true,
  ])('should preserve a workspace-root prompt glob without watching unrelated files (matched: %s)', (matched) => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://*.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(
      matched ? ['/test/working/existing.txt'] : [],
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(matched ? ['existing.txt', '*.txt'] : ['*.txt']);
  });

  it('should preserve brace-only prompt globs for deleted dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/{first,second}.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/working/prompts/first.txt', '/test/working/prompts/second.txt'],
      expect.objectContaining({ magicalBraces: true }),
    );
  });

  it('should expand contained parent-directory brace alternatives before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://{../shared,tests}/*.yaml: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/shared/common.yaml',
      '/test/working/evals/tests/cases.yaml',
    ]);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual([
      'shared/common.yaml',
      'evals/tests/cases.yaml',
      'shared',
      'evals/tests',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/working/shared/*.yaml', '/test/working/evals/tests/*.yaml'],
      expect.objectContaining({ magicalBraces: true }),
    );
  });

  it('should discard an escaping brace alternative before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://{../../outside,tests}/*.yaml: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/tests/cases.yaml']);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['evals/tests/cases.yaml', 'evals/tests']);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/working/evals/tests/*.yaml'],
      expect.objectContaining({ magicalBraces: true }),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('unsafe config dependency glob alternative'),
    );
  });

  it('should preserve an unmatched brace-arm watch directory when another arm has matches', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://{../shared,tests}/*.yaml: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/shared/common.yaml']);

    expect(
      extractFileDependencies('/test/working/evals/promptfooconfig.yaml'),
    ).toEqual(['shared/common.yaml', 'shared', 'evals/tests/']);
  });

  it('should bound brace expansion before glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/prompt_{1..1025}.txt: mapped prompts
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
  });

  it('should preserve an explicitly mapped prompt directory after its last file is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file://prompts/: mapped prompts
`);
    mockFs.existsSync.mockReturnValue(false);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['prompts/']);
  });

  it('should preserve a repository-root directory sentinel', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  file:///test/working/: repository prompts
`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['/']);
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
      '../config/providers/custom.py',
      '../config/providers',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/config/providers/*.py'],
      expect.objectContaining({ magicalBraces: true }),
    );
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

    expect(deps).toEqual(['../config/provider.py', '../config']);
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
