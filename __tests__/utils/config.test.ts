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

  it('should extract a scalar file prompt', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/main.txt']);
  });

  it('should expand a scalar file prompt glob', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/*.txt\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/prompts/main.txt']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/prompts/main.txt');
    expect(deps).toContain('../config/prompts');
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
  });

  it('should expand a bare scalar prompt glob inside a directory with spaces', () => {
    mockFs.readFileSync.mockReturnValue("prompts: 'prompt files/*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/prompt files/main.txt']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompt files/main.txt',
      '../config/prompt files',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
  });

  it.each([
    'release notes-*.{json,yaml}',
    'release notes-*.@(json|yaml)',
    'release notes-*',
    'release notes *.{json,yaml}',
    'release notes *.@(json|yaml)',
    'release notes *',
    'release notes **.{json,yaml}',
    'release notes **.@(json|yaml)',
    'release notes **',
  ])('should inspect a bare root prompt glob with spaces in its filename', (prompt) => {
    const match = prompt.startsWith('release notes-')
      ? 'release notes-v1.yaml'
      : 'release notes v1.yaml';
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith(match)) {
        return 'content: file://nested/system.txt\n';
      }
      return `prompts: '${prompt}'\n`;
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('*') || value.includes('@(') || value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([`/test/working/${match}`]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const expectedPatterns = prompt.includes('{json,yaml}')
      ? [
          prompt.replace('{json,yaml}', 'json'),
          prompt.replace('{json,yaml}', 'yaml'),
        ]
      : [prompt];

    expect(deps).toEqual([match, ...expectedPatterns, 'nested/system.txt']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
  });

  it('should watch the config directory for a root-level scalar prompt glob', () => {
    mockFs.readFileSync.mockReturnValue("prompts: '*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/existing.txt']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toContain('../config/existing.txt');
    expect(deps).toContain('../config');
  });

  it('should watch the correct directory for an absolute scalar prompt glob', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file:///test/working/prompts/*.txt\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompts/existing.txt']);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/existing.txt', 'prompts']);
  });

  it('should retain a watch sentinel when the last absolute prompt-glob match is deleted', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file:///test/working/prompts/*.txt\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/']);
  });

  it('should serialize the repository-root prompt-glob watch directory explicitly', () => {
    mockFs.readFileSync.mockReturnValue("prompts: '*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/existing.txt']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['existing.txt', '*.txt']);
  });

  it('should retain a repository-root watch sentinel when the last prompt is deleted', () => {
    mockFs.readFileSync.mockReturnValue("prompts: '*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['*.txt']);
  });

  it('should retain a scalar directory prompt after its last file is deleted', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts\n');

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/prompts']);
  });

  it.each([
    {
      prompt: 'file://prompts\\*.txt',
      normalized: '/test/working/evals/prompts/*.txt',
      matches: ['/test/working/evals/prompts/one.txt'],
      expected: ['evals/prompts/one.txt', 'evals/prompts'],
    },
    {
      prompt: 'file://prompts\\**\\*.txt',
      normalized: '/test/working/evals/prompts/**/*.txt',
      matches: ['/test/working/evals/prompts/nested/one.txt'],
      expected: ['evals/prompts/nested/one.txt', 'evals/prompts'],
    },
    {
      prompt: 'file://prompts\\*.txt',
      normalized: '/test/working/evals/prompts/*.txt',
      matches: [],
      expected: ['evals/prompts/'],
    },
  ])('should normalize backslash prompt globs before expansion', ({
    prompt,
    normalized,
    matches,
    expected,
  }) => {
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => !value.includes('\\') && value.includes('*'),
    );
    mockGlob.sync.mockImplementation((value: string) =>
      value === normalized ? matches : [],
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(expected);
    expect(mockGlob.sync).toHaveBeenCalledWith(normalized, {
      nodir: true,
      windowsPathsNoEscape: true,
    });
  });

  it.each([
    {
      prompt: 'file://{team-a,team-b}/*.txt',
      expected: ['evals/team-a/', 'evals/team-b/'],
    },
    {
      prompt: 'file://{blue,green}/**/*.yaml',
      expected: ['evals/blue/', 'evals/green/'],
    },
    {
      prompt: 'file://{1..3}/*.txt',
      expected: ['evals/1/', 'evals/2/', 'evals/3/'],
    },
  ])('should retain a watch sentinel for a deleted brace-directory prompt glob', ({
    prompt,
    expected,
  }) => {
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(expected);
  });

  it('should retain both safe watch roots for a brace prompt glob with a parent arm', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://{../shared,prompts}/*.txt'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['shared/', 'evals/prompts/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      ['/test/working/shared/*.txt', '/test/working/evals/prompts/*.txt'],
      expect.any(Object),
    );
  });

  it('should reject an escaped brace prompt-glob arm before scanning it', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://{../../outside,prompts}/*.txt'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/prompts/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/working/evals/prompts/*.txt',
      expect.any(Object),
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
    );
  });

  it('should reject an escaped structured brace prompt-glob arm before nested inspection', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://{../../outside,prompts}/*.yaml'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/prompts/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
    expect(mockGlob.sync).toHaveBeenNthCalledWith(
      1,
      '/test/working/evals/prompts/*.yaml',
      expect.any(Object),
    );
    expect(mockGlob.sync).toHaveBeenNthCalledWith(
      2,
      '/test/working/evals/prompts/*.yaml',
      expect.any(Object),
    );
  });

  it('should bound brace prompt-glob expansion and conservatively watch the workspace', () => {
    mockFs.readFileSync.mockReturnValue("prompts: 'file://{1..2000}/*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should not scan a structured brace prompt glob when every arm escapes', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://{../../outside,../../secret}/*.yaml'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
    );
  });

  it.each([
    "providers:\n  - 'file://{..\\..\\,providers}/LICE*'",
    "tests:\n  - vars:\n      context: 'file://{..\\..\\,providers}/LICE*'",
  ])('should reject a backslash-traversal brace glob arm before scanning it', (config) => {
    mockFs.readFileSync.mockReturnValue(`${config}\n`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/providers/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/working/evals/providers/LICE*',
      expect.any(Object),
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
    );
  });

  it('should ignore an inline scalar prompt', () => {
    mockFs.readFileSync.mockReturnValue('prompts: hello world\n');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it.each([
    'prompts: |\n  Return **bold** output for the user.\n',
    'prompts: |\n  Calculate price * discount_percent.\n',
    'prompts: "Return **bold** output for the user."\n',
    'prompts: "Calculate price * discount_percent."\n',
    'prompts: "Return **bold**."\n',
    'prompts: "Calculate price *. token."\n',
    'prompts: "Solve 2*2"\n',
    'prompts: "Solve 2*2."\n',
    'prompts: "Use *emphasis* sparingly."\n',
    'prompts: "Use **bold** text, not plain text."\n',
    'prompts: What is the capital of {{country}}?\n',
    'prompts: Return [safe] output for {{user}}.\n',
    'prompts: Which option (A or B)? Explain briefly.\n',
    'prompts: portkey://workspace/*\n',
    'prompts: langfuse://workspace/*\n',
    'prompts: helicone://workspace/*\n',
  ])('should not treat an inline prompt as a filesystem glob', (config) => {
    mockFs.readFileSync.mockReturnValue(config);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*?[\]]/.test(value),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should preserve provider dependencies for a very long inline prompt', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
prompts: ${'A'.repeat(70_000)}
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw new Error('pattern is too long');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.py']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('pattern is too long'),
    );
  });

  it('should extract scalar prompt functions without the function suffix', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file://prompts/build.py:create_prompt\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.py']);
  });

  it('should extract an in-workspace absolute scalar prompt function', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file:///test/working/prompts/build.py:create_prompt\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/build.py']);
  });

  it('should extract JavaScript prompt functions with supported selector characters', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - file://prompts/build.js:make$Prompt
  - file://prompts/other.js:make-prompt
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/build.js',
      '../config/prompts/other.js',
    ]);
  });

  it('should extract a scalar prompt path without a file prefix', () => {
    mockFs.readFileSync.mockReturnValue('prompts: prompts/main.txt\n');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/main.txt']);
  });

  it('should extract executable scalar prompts', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./prompts/generate.sh\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/generate.sh']);
  });

  it('should extract an executable prompt path without its arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh --tone formal\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/scripts/generate.sh']);
  });

  it('should extract a quoted executable prompt path without its arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      `prompts: "exec:'./prompt scripts/generate.sh' --tone formal"\n`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompt scripts/generate.sh']);
  });

  it('should extract existing file arguments passed to an executable prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates/input.txt --tone formal\n',
    );
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('templates/input.txt'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', 'templates/input.txt']);
  });

  it('should resolve executable file arguments from the action working directory', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates/input.txt\n',
    );
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('custom/templates/input.txt'),
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

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'custom/templates/input.txt',
    ]);
  });

  it.each([
    './custom',
    '/test/working/custom',
  ])('should resolve executable prompt-object arguments from config.basePath', (basePath) => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: Custom prompt
    raw: exec:./scripts/generate.sh ./templates/input.txt
    config:
      basePath: ${basePath}
`);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('custom/templates/input.txt'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'custom/templates/input.txt',
    ]);
  });

  it('should not probe an executable prompt basePath outside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: Custom prompt
    raw: exec:./scripts/generate.sh ./templates/input.txt
    config:
      basePath: /private/tmp/SENSITIVE-REVIEW-TOKEN
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh']);
    expect(mockFs.existsSync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should retain a deleted executable file argument from the action working directory', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates/input.txt --tone formal\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', 'templates/input.txt']);
  });

  it('should retain a deleted executable prompt-object argument from config.basePath', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: Custom prompt
    raw: exec:./scripts/generate.sh ./templates/input.txt --tone formal
    config:
      basePath: ./custom
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'custom/templates/input.txt',
    ]);
  });

  it('should extract an existing executable file argument in equals form', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh --template=./templates/input.txt --tone formal\n',
    );
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) =>
        String(filePath) === '/test/working/templates/input.txt',
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', 'templates/input.txt']);
  });

  it.each([
    { basePath: undefined, expected: 'templates/input.txt' },
    { basePath: './custom', expected: 'custom/templates/input.txt' },
  ])('should retain a deleted executable file argument in equals form', ({
    basePath,
    expected,
  }) => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: Custom prompt
    raw: exec:./scripts/generate.sh --template=./templates/input.txt --tone formal
    ${basePath ? `config:\n      basePath: ${basePath}` : ''}
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', expected]);
  });

  it('should ignore directory arguments passed to an executable prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates\n',
    );
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/templates'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
      mode: 0o755,
    } as fs.Stats);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh']);
  });

  it('should not disclose out-of-workspace executable arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh /private/tmp/SENSITIVE-REVIEW-TOKEN\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/scripts/generate.sh']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should extract a bare executable prompt with an uncommon extension', () => {
    mockFs.readFileSync.mockReturnValue('prompts: generate.zsh\n');
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('generate.zsh'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o755,
    } as fs.Stats);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/generate.zsh']);
  });

  it.each([
    'generate.zsh',
    'prompt.abc',
  ])('should retain a deleted prompt with an uncommon short extension', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts: ${prompt}\n`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([`evals/${prompt}`]);
  });

  it('should ignore an uncommon prompt file without executable permissions', () => {
    mockFs.readFileSync.mockReturnValue('prompts: generate.zsh\n');
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('generate.zsh'),
    );
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o644,
    } as fs.Stats);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should ignore an unreadable uncommon prompt candidate', () => {
    mockFs.readFileSync.mockReturnValue('prompts: generate.zsh\n');
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('generate.zsh'),
    );
    mockFs.statSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should not disclose inline prompt contents while probing an uncommon candidate', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "Inline SENSITIVE-REVIEW-TOKEN \\0 content"\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should ignore an empty executable prompt', () => {
    mockFs.readFileSync.mockReturnValue('prompts: "exec:"\n');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should extract supported root-level prompt file extensions', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - prompts.csv
  - generate.exe
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts.csv', '../config/generate.exe']);
  });

  it('should extract file-backed prompt object ids and raw values', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: file://prompts/from-id.txt
    label: From id
  - raw: exec:./prompts/from-raw.sh
    label: From raw
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/from-id.txt',
      '../config/prompts/from-raw.sh',
    ]);
  });

  it('should prefer the runtime raw prompt over a stale file field', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - label: Actual prompt
    file: ignored/stale.txt
    raw: file://prompts/actual.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/actual.txt']);
  });

  it('should use a file-backed prompt id when raw is empty', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: file://prompts/from-id.txt
    raw: ""
    label: From id
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/from-id.txt']);
  });

  it('should extract nested file references in a scalar prompt file', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('configs/prompts.yaml')) {
        return `
content:
  - file://prompts/system.txt
  - file://configs/prompts.yaml
ignored: 1
`;
      }
      return 'prompts: file://configs/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/configs/prompts.yaml',
      '../config/prompts/system.txt',
    ]);
  });

  it('should retain other dependencies when a prompt file cannot be inspected', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('configs/prompts.yaml')) {
        throw new Error('permission denied');
      }
      return `
providers:
  - file://providers/provider.py
prompts: file://configs/prompts.yaml
`;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.py',
      '../config/configs/prompts.yaml',
    ]);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to inspect prompt file dependency "configs/prompts.yaml": unable to read or parse file',
    );
  });

  it('should handle non-Error prompt file read failures', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('configs/prompts.json')) {
        throw 'permission denied';
      }
      return 'prompts: file://configs/prompts.json\n';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/configs/prompts.json']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to inspect prompt file dependency "configs/prompts.json": unable to read or parse file',
    );
  });

  it('should not inspect a prompt symlink that resolves outside the workspace', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('linked/secret.yaml')) {
        return 'token: SENSITIVE-REVIEW-TOKEN\ninvalid: yaml: content:\n';
      }
      return 'prompts: file://linked/secret.yaml\n';
    });
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('linked/secret.yaml'),
    );
    mockFs.realpathSync.mockReturnValue('/tmp/outside/secret.yaml');

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/linked/secret.yaml']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe prompt file dependency "linked/secret.yaml": resolved path must stay within the repository workspace',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should inspect each expanded scalar prompt-file glob match', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/one.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://defs/*.yaml\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/defs/one.yaml']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/defs/one.yaml',
      '../config/defs',
      '../config/shared/nested.txt',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
    expect(mockGlob.sync).toHaveBeenNthCalledWith(
      1,
      '/test/config/defs/*.yaml',
      { nodir: true, windowsPathsNoEscape: true },
    );
    expect(mockGlob.sync).toHaveBeenNthCalledWith(
      2,
      '/test/config/defs/*.yaml',
      { nodir: true, windowsPathsNoEscape: true },
    );
  });

  it('should inspect prompt-file glob matches when the pattern has no fixed extension', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/one.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://defs/*.{yaml,json}\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/defs/one.yaml']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/defs/one.yaml',
      '../config/defs',
      '../config/shared/nested.txt',
    ]);
  });

  it('should inspect prompt-file glob matches for an extensionless pattern', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/one.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://defs/*\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/config/defs/one.yaml']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/defs/one.yaml',
      '../config/defs',
      '../config/shared/nested.txt',
    ]);
  });

  it('should skip non-structured matches during extensionless prompt-glob inspection', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/one.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://defs/*\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/defs/one.yaml',
      '/test/config/defs/skip.txt',
    ]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/defs/one.yaml',
      '../config/defs/skip.txt',
      '../config/defs',
      '../config/shared/nested.txt',
    ]);
  });

  it('should inspect structured prompt matches selected by an extglob extension', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('prompts/chat.yaml')) {
        return 'content: file://nested/system.txt\n';
      }
      return 'prompts: file://prompts/*.@(json|yaml)\n';
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('@('),
    );
    mockGlob.sync.mockReturnValue(['/test/config/prompts/chat.yaml']);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/prompts/chat.yaml',
      '../config/prompts',
      '../config/nested/system.txt',
    ]);
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
  });

  it('should conservatively watch templated nested prompt paths', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('configs/prompts.yaml')) {
        return 'content: file://prompts/{{ env.PF977_TARGET }}.txt\n';
      }
      return 'prompts: file://configs/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/configs/prompts.yaml',
      '../config/prompts/{{ env.PF977_TARGET }}.txt',
      '../config/prompts/',
    ]);
  });

  it('should conservatively watch a nested prompt path with a Nunjucks comment', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/prompt.yaml')) {
        return 'content: "file://shared/{# select default #}system.txt"\n';
      }
      return 'prompts: file://defs/prompt.yaml\n';
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'defs/prompt.yaml',
      'shared/{# select default #}system.txt',
      'shared/',
    ]);
  });

  it('should conservatively watch the config directory for a root templated prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "file://{{ env.PF977_TARGET }}.txt"\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/{{ env.PF977_TARGET }}.txt',
      '../config/',
    ]);
  });

  it.each([
    '{{ env.PROMPT_FILE }}',
    "{{ env['PROMPT-FILE'] }}",
    '{{- env.PROMPT_FILE -}}',
    "{{- env['PROMPT-FILE'] -}}",
    '{{ env.TEST_PROMPT_PATH }}/prompt.txt',
    "{{ env.OPTIONAL_PATH | default('./shared/prompts') }}/prompt.txt",
  ])('should watch the repository for a root-templated prompt path', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts: "${prompt}"\n`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([`evals/${prompt}`, './']);
  });

  it('should not watch an unsafe templated prompt directory', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "file://../outside/{{ env.PF977_TARGET }}.txt"\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should ignore an unsafe file-backed scalar prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file://../outside/prompts.yaml\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should retain provider dependencies when prompts use mapping form', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py
prompts:
  file://prompts/main.txt: Main
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/providers/provider.py',
      '../config/prompts/main.txt',
    ]);
  });

  it('should ignore prompt entries without a usable file reference', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py
prompts:
  - true
  - null
  - label: Inline
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/providers/provider.py']);
  });

  it('should extract test variable files', () => {
    const configContent = `
tests:
  - null
  - invalid-test-entry
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

  it.each([
    '!!binary SGVsbG8=',
    '2024-01-02',
    '!!omap [{a: 1}, {b: 2}]',
    '!!pairs [{a: 1}, {b: 2}]',
    '!!set {a: null, b: null}',
  ])('should preserve dependencies when config uses a legacy YAML tag', (metadata) => {
    mockFs.readFileSync.mockReturnValue(`
prompts: file://prompts/main.txt
metadata: ${metadata}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject an invalid legacy YAML set without disclosing config contents', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts: file://prompts/main.txt
token: SENSITIVE-REVIEW-TOKEN
metadata: !!set {a: not-null}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it.each([
    '!!binary SGVsbG8=',
    '!!omap [{a: 1}, {b: 2}]',
    '!!pairs [{a: 1}, {b: 2}]',
    '!!set {a: null, b: null}',
  ])('should inspect nested prompt YAML that uses a legacy tag', (metadata) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('prompts/prompts.yaml')) {
        return `metadata: ${metadata}\ncontent: file://shared/system.txt\n`;
      }
      return 'prompts: file://prompts/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/prompts.yaml', 'shared/system.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not enumerate binary metadata while inspecting nested prompt YAML', () => {
    const binaryMetadata = Buffer.alloc(1536 * 1024, 65).toString('base64');
    const objectValues = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('prompts/prompts.yaml')) {
        return `metadata: !!binary ${binaryMetadata}\ncreatedAt: 2024-01-02\nmessages:\n  - content: file://shared/system.txt\n`;
      }
      return 'prompts: file://prompts/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const enumeratedBinary = objectValues.mock.calls.some(([value]) =>
      ArrayBuffer.isView(value),
    );
    const enumeratedDate = objectValues.mock.calls.some(
      ([value]) => value instanceof Date,
    );
    objectValues.mockRestore();

    expect(deps).toEqual(['prompts/prompts.yaml', 'shared/system.txt']);
    expect(enumeratedBinary).toBe(false);
    expect(enumeratedDate).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not enumerate a binary prompt map', () => {
    const binaryMetadata = Buffer.alloc(64 * 1024, 65).toString('base64');
    const objectKeys = vi.spyOn(Object, 'keys');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/provider.py
prompts: !!binary ${binaryMetadata}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const enumeratedBinary = objectKeys.mock.calls.some(([value]) =>
      ArrayBuffer.isView(value),
    );
    objectKeys.mockRestore();

    expect(deps).toEqual(['providers/provider.py']);
    expect(enumeratedBinary).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not enumerate binary test variables', () => {
    const binaryMetadata = Buffer.alloc(64 * 1024, 65).toString('base64');
    const objectValues = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockReturnValue(`
prompts: file://prompts/main.txt
defaultTest:
  vars: !!binary ${binaryMetadata}
  assert:
    - value: file://expected/default.txt
tests:
  - vars: !!binary ${binaryMetadata}
    assert:
      - value: file://expected/test.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const enumeratedBinary = objectValues.mock.calls.some(([value]) =>
      ArrayBuffer.isView(value),
    );
    objectValues.mockRestore();

    expect(deps).toEqual([
      'prompts/main.txt',
      'expected/default.txt',
      'expected/test.txt',
    ]);
    expect(enumeratedBinary).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'providers',
    'assert',
    'tests',
  ])('should not iterate a binary %s collection', (collection) => {
    const binaryMetadata = Buffer.alloc(64 * 1024, 65).toString('base64');
    const binaryCollection =
      collection === 'assert'
        ? `defaultTest:\n  assert: !!binary ${binaryMetadata}`
        : `${collection}: !!binary ${binaryMetadata}`;
    const iterator = vi.spyOn(Uint8Array.prototype, Symbol.iterator);
    mockFs.readFileSync.mockReturnValue(`
prompts: file://prompts/main.txt
${binaryCollection}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const iteratedBinary = iterator.mock.calls.length > 0;
    iterator.mockRestore();

    expect(deps).toEqual(['prompts/main.txt']);
    expect(iteratedBinary).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
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

  it('should not disclose config contents in YAML parse warnings', () => {
    mockFs.readFileSync.mockReturnValue(
      'token: SENSITIVE-REVIEW-TOKEN\ninvalid: [unterminated\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
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
