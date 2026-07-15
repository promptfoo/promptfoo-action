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
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(),
    fstatSync: vi.fn(),
    readSync: vi.fn(),
    closeSync: vi.fn(),
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
    lstatSync: Mock;
    realpathSync: Mock;
    statSync: Mock;
    openSync: Mock;
    fstatSync: Mock;
    readSync: Mock;
    closeSync: Mock;
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
    mockFs.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => filePath);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
    } as fs.Stats);
    mockFs.openSync.mockImplementation((filePath: unknown) => filePath);
    mockFs.fstatSync.mockImplementation((descriptor: unknown) =>
      mockFs.statSync(descriptor),
    );
    const descriptorContents = new Map<unknown, Buffer>();
    const descriptorOffsets = new Map<unknown, number>();
    mockFs.readSync.mockImplementation(
      (
        descriptor: unknown,
        buffer: Uint8Array,
        offset: number,
        length: number,
      ) => {
        let content = descriptorContents.get(descriptor);
        if (!content) {
          content = Buffer.from(mockFs.readFileSync(descriptor, 'utf8'));
          descriptorContents.set(descriptor, content);
        }
        const start = descriptorOffsets.get(descriptor) ?? 0;
        const end = Math.min(start + length, content.length);
        buffer.set(content.subarray(start, end), offset);
        descriptorOffsets.set(descriptor, end);
        return end - start;
      },
    );
    mockFs.closeSync.mockImplementation(() => undefined);
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

    expect(deps).toHaveLength(3);
    expect(deps).toContain('../config/custom_provider.py');
    expect(deps).toContain('../config/another_provider.js');
  });

  it.each([
    'promptfooconfig.js',
    'promptfooconfig.ts',
  ])('should conservatively watch side inputs for an executable primary config (%s)', (configName) => {
    mockFs.readFileSync.mockReturnValue('module.exports = { prompts: [] };\n');

    const deps = extractFileDependencies(`/test/working/${configName}`);

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch the workspace after an unexpected post-parse extraction failure', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: file://prompts/main.txt
    config:
      basePath: prompts
`);

    const deps = extractFileDependencies(
      '/test/working/promptfooconfig.yaml',
      42 as unknown as string,
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('42'),
    );
  });

  it.each([
    ['FIFO', false, 0],
    ['oversized file', true, 2 ** 40],
  ])('should not read a primary config backed by a %s', (_kind, isFile, size) => {
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => isFile,
      mode: isFile ? 0o100644 : 0o10644,
      size,
    } as fs.Stats);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('primary config should not be read');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
  });

  it('should not read a primary config swapped to a FIFO after path validation', () => {
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 0,
    } as fs.Stats);
    mockFs.fstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
      mode: 0o10644,
      size: 0,
    } as fs.Stats);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('swapped primary config should not be read');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(mockFs.openSync).toHaveBeenCalledWith(
      '/test/working/promptfooconfig.yaml',
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    expect(mockFs.closeSync).toHaveBeenCalledWith(
      '/test/working/promptfooconfig.yaml',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
  });

  it.each([
    'primary',
    'structured',
  ])('should fail closed when a %s config parent is swapped after path inspection', (kind) => {
    const swappedPath =
      kind === 'primary'
        ? '/test/working/promptfooconfig.yaml'
        : '/test/working/prompts/swapped.yaml';
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      return {
        dev: candidate === swappedPath ? 1 : 2,
        ino: candidate === swappedPath ? 11 : 22,
        isDirectory: () => false,
        isFile: () => true,
        mode: 0o100644,
        size: 0,
      } as fs.Stats;
    });
    mockFs.fstatSync.mockImplementation((descriptor: unknown) => {
      const candidate = String(descriptor);
      return {
        dev: candidate === swappedPath ? 9 : 2,
        ino: candidate === swappedPath ? 99 : 22,
        isDirectory: () => false,
        isFile: () => true,
        mode: 0o100644,
        size: 0,
      } as fs.Stats;
    });
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (
        kind === 'structured' &&
        String(filePath).endsWith('/promptfooconfig.yaml')
      ) {
        return 'prompts: file://prompts/swapped.yaml\n';
      }
      throw new Error('SENSITIVE-EXTERNAL-TARGET was read');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(
      kind === 'primary' ? 0 : 1,
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-EXTERNAL-TARGET'),
    );
  });

  it('should safely read an in-workspace config symlink after resolving its physical target', () => {
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      return candidate === '/test/working/promptfooconfig.yaml'
        ? '/test/working/configs/actual.yaml'
        : candidate;
    });
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
    expect(mockFs.openSync).toHaveBeenCalledWith(
      '/test/working/configs/actual.yaml',
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'primary',
    'structured',
  ])('should bound a %s config that grows after descriptor inspection', (kind) => {
    const oversizedContent = `${' '.repeat(10_485_761)}prompts: []\n`;
    mockFs.fstatSync.mockReturnValue({
      dev: undefined,
      ino: undefined,
      isDirectory: () => false,
      isFile: () => true,
      mode: undefined,
      size: undefined,
    } as fs.Stats);
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/promptfooconfig.yaml')) {
        return kind === 'primary'
          ? oversizedContent
          : 'prompts: file://prompts/growing.yaml\n';
      }
      if (String(filePath).endsWith('/prompts/growing.yaml')) {
        return oversizedContent;
      }
      throw new Error('unexpected file read');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).toHaveBeenCalledWith(
      kind === 'primary'
        ? 'Failed to extract dependencies from config: unable to read or parse config'
        : 'Skipping oversized structured prompt dependency; nested references will not be inspected',
    );
  });

  it('should not read a primary config that grows before descriptor validation', () => {
    mockFs.statSync.mockReturnValue({
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 0,
    } as fs.Stats);
    mockFs.fstatSync.mockReturnValue({
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 2 ** 40,
    } as fs.Stats);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
  });

  it.each([
    ['size', 2],
    ['mtimeMs', 2],
    ['ctimeMs', 2],
  ])('should not read a primary config whose %s changes before descriptor validation', (field, value) => {
    const inspected = {
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 1,
      mtimeMs: 1,
      ctimeMs: 1,
    };
    mockFs.statSync.mockReturnValue(inspected as fs.Stats);
    mockFs.fstatSync.mockReturnValue({
      ...inspected,
      [field]: value,
    } as fs.Stats);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should fail closed when a primary config changes while its descriptor is being read', () => {
    const inspected = {
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 35,
      mtimeMs: 1,
      ctimeMs: 1,
    };
    mockFs.statSync.mockReturnValue(inspected as fs.Stats);
    mockFs.fstatSync
      .mockReturnValueOnce(inspected as fs.Stats)
      .mockReturnValueOnce({ ...inspected, mtimeMs: 2 } as fs.Stats);
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.fstatSync).toHaveBeenCalledTimes(2);
  });

  it('should fail closed when a primary config path is retargeted while its descriptor is being read', () => {
    const inspected = {
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 35,
      mtimeMs: 1,
      ctimeMs: 1,
    };
    let configResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath) !== '/test/working/promptfooconfig.yaml') {
        return filePath;
      }
      configResolutions++;
      return configResolutions === 1
        ? '/test/working/configs/first.yaml'
        : '/test/working/configs/second.yaml';
    });
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/configs/second.yaml')) {
        return { ...inspected, ino: 22 } as fs.Stats;
      }
      return inspected as fs.Stats;
    });
    mockFs.fstatSync.mockReturnValue(inspected as fs.Stats);
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should fail closed when a primary config resolves outside the workspace after its descriptor is read', () => {
    const inspected = {
      dev: 1,
      ino: 11,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 35,
      mtimeMs: 1,
      ctimeMs: 1,
    };
    let configResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath) !== '/test/working/promptfooconfig.yaml') {
        return filePath;
      }
      configResolutions++;
      return configResolutions === 1
        ? '/test/working/promptfooconfig.yaml'
        : '/private/tmp/SENSITIVE-REVIEW-TOKEN/config.yaml';
    });
    mockFs.statSync.mockReturnValue(inspected as fs.Stats);
    mockFs.fstatSync.mockReturnValue(inspected as fs.Stats);
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it.each([
    'stat',
    'realpath',
    'open',
    'read',
    'close',
  ])('should fail closed when primary config %s inspection throws', (stage) => {
    const error = new Error('EACCES: SENSITIVE-REVIEW-TOKEN');
    if (stage === 'stat')
      mockFs.statSync.mockImplementation(() => {
        throw error;
      });
    if (stage === 'realpath')
      mockFs.realpathSync.mockImplementation(() => {
        throw error;
      });
    if (stage === 'open')
      mockFs.openSync.mockImplementation(() => {
        throw error;
      });
    if (stage === 'read')
      mockFs.readSync.mockImplementation(() => {
        throw error;
      });
    if (stage === 'close')
      mockFs.closeSync.mockImplementation(() => {
        throw error;
      });
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/main.txt\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should extract absolute checkout dependencies from an external config', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/prompts/structured.yaml')) {
        return 'content: file:///test/working/shared/system.txt\n';
      }
      return `
providers:
  - file:///test/working/providers/custom.py
prompts:
  - file:///test/working/prompts/main.txt
  - file:///test/working/prompts/structured.yaml
  - file:///test/working/prompts/*.md
`;
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompts/reference.md']);
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/prompts/structured.yaml'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) => filePath);

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual([
      'providers/custom.py',
      'prompts/main.txt',
      'prompts/structured.yaml',
      'shared/system.txt',
      'prompts/reference.md',
      'prompts',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve a checkout-contained glob match when an unused external root is unreadable', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file:///test/working/providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/safe.py']);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const resolvedPath = String(filePath);
      if (resolvedPath === '/test/external') {
        throw new Error('EACCES: SENSITIVE-REVIEW-TOKEN');
      }
      if (resolvedPath.startsWith('/test/working')) {
        return resolvedPath.replace('/test/working', '/private/worktree');
      }
      return resolvedPath;
    });

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should watch the checkout for an env-templated HTTP path from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      auth:
        type: file
        path: '{{ env.PROJECT_ROOT }}/auth/token.json'
`);

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['../external/', './']);
  });

  it('should watch the checkout for an env-templated prompt path from an external config', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "file://{{ env.PROJECT_ROOT }}/prompts/system.txt"\n',
    );

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual([
      '../external/',
      './',
      '../external/{{ env.PROJECT_ROOT }}/prompts/system.txt',
    ]);
  });

  it('should watch the checkout for an env-templated executable argument rooted at an external base path', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: exec:./scripts/generate.sh {{ env.PROJECT_ROOT }}/templates/input.txt
    config:
      basePath: ../external
`);

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual([
      '../external/scripts/generate.sh',
      '../external/',
      './',
    ]);
  });

  it('should watch the checkout and external static root for generic env-templated file references', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://{{ env.PROJECT_ROOT }}/providers/custom.py'
  - id: openai:gpt-4
    config:
      request: 'file://{{ env.PROJECT_ROOT }}/fixtures/request.json'
tests:
  - vars:
      context: 'file://{{ env.PROJECT_ROOT }}/data/context.txt'
    assert:
      - type: equals
        value: 'file://{{ env.PROJECT_ROOT }}/expected.txt'
`);

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual([
      '../external/',
      './',
      '../external/{{ env.PROJECT_ROOT }}/providers/custom.py',
      '../external/{{ env.PROJECT_ROOT }}/fixtures/request.json',
      '../external/{{ env.PROJECT_ROOT }}/data/context.txt',
      '../external/{{ env.PROJECT_ROOT }}/expected.txt',
    ]);
  });

  it('should watch the in-checkout static directory of a generic templated file reference', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4
    config:
      request: 'file://scripts/{{ env.PF977_SCRIPT }}.py'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('scripts/');
  });

  it.each([
    {
      label: 'generic provider request',
      config: `providers:\n  - id: openai:gpt-4\n    config:\n      request: 'file:///{{ env.PROJECT_ROOT }}/fixtures/request.json'\n`,
    },
    {
      label: 'prompt',
      config: `prompts: 'file:///{{ env.PROJECT_ROOT }}/prompts/system.txt'\n`,
    },
    {
      label: 'executable argument',
      config: `prompts:\n  - raw: exec:./scripts/generate.sh /{{ env.PROJECT_ROOT }}/templates/input.txt\n    config:\n      basePath: ../external\n`,
    },
  ])('should watch the checkout for a leading-slash env template from an external config: $label', ({
    config,
  }) => {
    mockFs.readFileSync.mockReturnValue(config);

    const deps = extractFileDependencies(
      '/test/external/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toContain('../external/');
    expect(deps).toContain('./');
  });

  it('should preserve a glob match under a symlinked external config root', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/linked/providers/safe.py']);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const resolvedPath = String(filePath);
      return resolvedPath.startsWith('/test/linked')
        ? resolvedPath.replace('/test/linked', '/private/external')
        : resolvedPath;
    });

    const deps = extractFileDependencies(
      '/test/linked/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual([
      '../linked/providers/safe.py',
      '../linked/providers',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject a glob match under an escaping in-checkout config-root symlink', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/evals/providers/safe.py']);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const resolvedPath = String(filePath);
      return resolvedPath.startsWith('/test/working/evals')
        ? resolvedPath.replace(
            '/test/working/evals',
            '/private/SENSITIVE-REVIEW-TOKEN/evals',
          )
        : resolvedPath;
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
      '/test/working',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should reject an escaping dependency-glob symlink and preserve safe matches', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/escape.py',
      '/test/working/providers/safe.py',
    ]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/escape.py')
        ? '/test/outside/SENSITIVE-REVIEW-TOKEN.py'
        : filePath,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', 'providers', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path must stay within the repository workspace',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should fail closed for a direct dependency under an escaping symlinked directory', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://linked/prompt.txt\n');
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked/prompt.txt'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked/prompt.txt')
        ? '/private/tmp/SENSITIVE-REVIEW-TOKEN/prompt.txt'
        : filePath,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should fail closed for a contained direct dependency behind a retargetable symlink', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://linked/prompt.txt\n');
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked/prompt.txt'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked/prompt.txt')
        ? '/test/working/actual/prompt.txt'
        : filePath,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('linked/prompt.txt');
    expect(deps).toContain('./');
  });

  it('should fail closed for a missing direct dependency under an escaping symlinked directory', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://linked/missing.txt\n');
    mockFs.existsSync.mockReturnValue(false);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate.endsWith('/linked/missing.txt')) {
        throw new Error('ENOENT');
      }
      return candidate.endsWith('/linked')
        ? '/private/tmp/SENSITIVE-REVIEW-TOKEN'
        : filePath;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should reject an escaping static glob prefix before enumeration', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://linked/*.txt\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('escaped prefix should not be enumerated');
    });
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked')
        ? '/private/tmp/SENSITIVE-REVIEW-TOKEN'
        : filePath,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively watch a contained, retargetable dependency-glob prefix', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://linked/*.py\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/linked') ? '/test/working/actual' : filePath,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('linked/');
    expect(deps).toContain('./');
  });

  it('should reject a lexical dependency-glob match outside the workspace', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers/*.py\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/outside/leaked.py']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers');
    expect(deps).not.toContain('../outside/leaked.py');
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path must stay within the repository workspace',
    );
  });

  it('should fail closed when no direct-dependency ancestor can be resolved', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://linked/missing.txt\n');
    let rootResolutions = 0;
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      if (candidate === '/test/working/promptfooconfig.yaml') return candidate;
      if (candidate === '/test/working' && rootResolutions++ === 0) {
        return candidate;
      }
      throw new Error('ENOENT: SENSITIVE-REVIEW-TOKEN');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it.each([
    'evals/**/../../outside/*.yaml',
    'evals/**/[.][.]/[.][.]/outside/*.yaml',
    'evals/{safe,../../outside}/*.yaml',
    'evals/**/{.,.}{.,.}/outside/*.yaml',
    'evals/**/{..,src}/outside/*.yaml',
    'evals/**/{.,x}{.,y}/outside/*.yaml',
    'evals/**/[.]{.,x}/outside/*.yaml',
    'evals/**/{.,x}[.]/outside/*.yaml',
    'evals/**/\\.\\./\\.\\./outside/*.yaml',
    'evals/**/[.]\\./[.]\\./outside/*.yaml',
    'evals/**/.\\./.\\./outside/*.yaml',
  ])('should reject config-glob traversal before enumeration (%s)', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`prompts: 'file://${pattern}'\n`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      /[*{[]/.test(value),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('traversing config glob should not be enumerated');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should reject a config dependency with excessive sequential extglob tokens before parsing', () => {
    const hostile = `providers/${'@(x)'.repeat(15_000)}.py`;
    mockFs.readFileSync.mockReturnValue(`providers: 'file://${hostile}'\n`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('SENSITIVE-REVIEW-TOKEN reached glob parsing');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should preserve safe dependency-glob matches when a sibling realpath lookup fails', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/unreadable.py',
      '/test/working/providers/safe.py',
    ]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/unreadable.py')) {
        throw new Error('EACCES: SENSITIVE-REVIEW-TOKEN');
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', 'providers', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unreadable config dependency glob match: unable to resolve path',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should reject a dangling dependency-glob symlink and preserve safe matches', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/*.py\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/dangling.py',
      '/test/working/providers/safe.py',
    ]);
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => !String(filePath).endsWith('/dangling.py'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/dangling.py')) {
        throw new Error('ENOENT: SENSITIVE-REVIEW-TOKEN');
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', 'providers', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unreadable config dependency glob match: unable to resolve path',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should extract file-backed targets and nested target dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - file://providers/custom.py
  - id: file://providers/another.js
    config:
      request: file://fixtures/request.json
  - id: openai:gpt-4
    config:
      tools:
        - schema: file://schemas/tool.yaml
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/custom.py',
      'providers/another.js',
      'fixtures/request.json',
      'schemas/tool.yaml',
      './',
    ]);
  });

  it.each([
    'providers',
    'targets',
  ])('should extract a scalar file-backed %s reference', (field) => {
    mockFs.readFileSync.mockReturnValue(
      `${field}: file://providers/scalar.yaml\n`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/scalar.yaml', './']);
  });

  it('should extract nested and bare HTTP dependencies from a target map entry', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - https:
      config:
        request: file://fixtures/map-request.json
        auth:
          type: file
          path: ./auth/map-token.ts
        tls:
          caPath: ./certs/map-ca.pem
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'fixtures/map-request.json',
      'auth/map-token.ts',
      'certs/map-ca.pem',
      './',
    ]);
  });

  it.each([
    'providers',
    'targets',
  ])('should extract nested and HTTP dependencies from a singleton %s object', (field) => {
    mockFs.readFileSync.mockReturnValue(`
${field}:
  id: http
  config:
    request: file://fixtures/singleton-request.json
    auth:
      type: file
      path: ./auth/singleton-token.ts
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'fixtures/singleton-request.json',
      'auth/singleton-token.ts',
      './',
    ]);
  });

  it('should extract a file-backed target map key', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - file://providers/mapped.py:call_api:
      label: mapped-provider
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/mapped.py', './']);
  });

  it('should follow the runtime-selected first key from a multi-entry provider and target map', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/one.py:call_api: {}
    file://providers/two.js:callApi:
      config:
        request: file://fixtures/ignored-provider.json
        $ref: file://schemas/ignored-provider.yaml
targets:
  - python:targets/one.py:call_api: {}
    ruby:targets/two.rb:Call::api:
      config:
        request: file://fixtures/ignored-target.json
        $ref: file://schemas/ignored-target.yaml
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/one.py');
    expect(deps).toContain('targets/one.py');
    expect(deps).not.toContain('providers/two.js');
    expect(deps).not.toContain('targets/two.rb');
    expect(deps).not.toContain('fixtures/ignored-provider.json');
    expect(deps).not.toContain('schemas/ignored-provider.yaml');
    expect(deps).not.toContain('fixtures/ignored-target.json');
    expect(deps).not.toContain('schemas/ignored-target.yaml');
    expect(deps).toContain('./');
  });

  it('should extract Python, Golang, and Ruby provider-prefix paths from providers, targets, ids, and maps', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/plain.py:call_api
  - python:file://providers/prefixed.py:call_api
  - id: golang:providers/by-id.go:CallAPI
  - 'ruby:providers/mapped.rb:Clients::call_api':
      label: mapped-ruby
  - go:providers/not-supported.go:CallAPI
targets:
  - ruby:providers/target.rb:Clients::call_api
  - id: python:providers/target-by-id.py:call_api
  - 'golang:providers/target-map.go:CallAPI':
      label: mapped-golang
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/plain.py',
      'providers/prefixed.py',
      'providers/by-id.go',
      'providers/mapped.rb',
      'providers/mapped.rb:Clients::call_api',
      'providers/target.rb',
      'providers/target.rb:Clients::call_api',
      'providers/target-by-id.py',
      'providers/target-map.go',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch static prefixes for templated HTTP target paths', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      auth:
        type: file
        path: certs/{{ env.AUTH_FILE }}
      tls:
        certPath: '{{ env.CLIENT_CERT_PATH }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['certs/', './']);
  });

  it('should preserve dependencies when a target contains a cyclic YAML alias', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - &target
    id: http
    config:
      request: file://fixtures/cyclic-request.json
      auth:
        type: file
        path: ./auth/cyclic-token.ts
    self: *target
prompts: file://prompts/main.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'fixtures/cyclic-request.json',
      'auth/cyclic-token.ts',
      'prompts/main.txt',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve dependencies when a nested target array contains a cyclic YAML alias', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: openai:gpt-4
    config:
      request: &request
        - file://fixtures/cyclic-array-request.json
        - *request
prompts: file://prompts/main.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'fixtures/cyclic-array-request.json',
      'prompts/main.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore unsupported target-map shapes without dropping valid dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - http: not-provider-options
  - http: {}
    https: {}
prompts: file://prompts/main.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract bare HTTP target auth, TLS, and signature file paths', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      auth:
        type: file
        path: ./auth/get-token.js
      tls:
        caPath: ./certs/ca.pem
        certPath: ./certs/client.pem
        keyPath: ./certs/client.key
        pfxPath: ./certs/client.pfx
        jksPath: ./certs/client.jks
      signatureAuth:
        privateKeyPath: ./signing/private.key
        keystorePath: ./signing/keystore.jks
        pfxPath: ./signing/signature.pfx
        certPath: ./signing/signature.pem
        keyPath: ./signing/signature.key
  - id: https://example.test/chat
    config:
      auth:
        type: file
        path: /test/working/auth/https-token.ts
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'auth/get-token.js',
      'certs/ca.pem',
      'certs/client.pem',
      'certs/client.key',
      'certs/client.pfx',
      'certs/client.jks',
      'signing/private.key',
      'signing/keystore.jks',
      'signing/signature.pfx',
      'signing/signature.pem',
      'signing/signature.key',
      'auth/https-token.ts',
      './',
    ]);
  });

  it('should preserve literal backslashes in direct POSIX HTTP file paths', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
        path: 'file://auth\\token\\{literal}.TS:get_auth'
      validateStatus: 'file://transforms\\handler\\{literal}.JS:validate'
      transformRequest: 'file://transforms\\handler\\*.TS:request'
      transformResponse: 'file://transforms\\handler\\{literal}.js:response'
      responseParser: 'file://transforms\\handler\\[literal].TS:parse'
      sessionParser: 'file://transforms\\handler\\{literal}.js:session'
      session:
        responseParser: 'file://transforms\\handler\\{literal}.js:sessionResponse'
      tls:
        caPath: 'certs\\ca.py:backup'
      signatureAuth:
        privateKeyPath: 'signing\\private.js:backup'
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: 'fixtures\\document.ts:copy'
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) =>
        value.includes('{') || value.includes('*') || value.includes('['),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'auth\\token\\{literal}.TS',
      'transforms\\handler\\{literal}.JS',
      'transforms\\handler\\*.TS',
      'transforms\\handler\\{literal}.js',
      'transforms\\handler\\[literal].TS',
      'certs\\ca.py:backup',
      'signing\\private.js:backup',
      'fixtures\\document.ts:copy',
      './',
    ]);
  });

  it('should not route literal HTTP function paths through config-glob expansion', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
        path: 'file://auth\\{1..1000000000}.JS:get_auth'
      validateStatus: 'file://validators\\{1..1000000000}.JS:validate'
      transformRequest: 'file://transforms\\{one,two}.TS:request'
tests:
  - provider:
      'https://example.test/chat':
        config:
          responseParser: 'file://parsers\\{1..1000000000}.JS:parse'
scenarios:
  - provider:
      'https://example.test/scenario':
        config:
          auth:
            type: file
            path: 'file://auth\\{one,two}.TS:get_auth'
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('{') && !value.includes('\\'),
    );

    const startedAt = performance.now();
    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('auth\\{1..1000000000}.JS');
    expect(deps).toContain('validators\\{1..1000000000}.JS');
    expect(deps).toContain('transforms\\{one,two}.TS');
    expect(deps).toContain('./');
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('should reject an escaping literal POSIX HTTP file path without leaking it', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
        path: 'file://../SENSITIVE-REVIEW-TOKEN\\token.JS:get_auth'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: literal file reference must stay within the repository workspace',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should preserve a nested HTTP body file path while excluding direct HTTP paths from glob expansion', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      body:
        document:
          path: 'file://fixtures\\payload\\{literal}.json'
          transformResponse: 'file://fixtures\\payload\\{literal}.json'
          validateStatus: 'file://fixtures\\payload\\{literal}.json'
          auth:
            path: 'file://fixtures\\payload\\{literal}.json'
          tls:
            caPath: 'file://fixtures\\payload\\{literal}.json'
      auth:
        type: file
        path: 'file://auth\\{1..1000000000}.JS:get_auth'
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('{') && !value.includes('\\'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/fixtures/payload/{literal}.json',
    ]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('fixtures/payload/{literal}.json');
    expect(deps).toContain('fixtures\\payload\\{literal}.json');
    expect(deps).toContain('auth\\{1..1000000000}.JS');
    expect(mockGlob.sync).toHaveBeenCalledTimes(5);
  });

  it('should decode a multipart file URL before tracking its direct read', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: file:///test/working/fixtures/report%20copy.pdf
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('fixtures/report copy.pdf');
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should route a nested POSIX-backslash body glob through bounded config-glob handling', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      body:
        path: 'file://fixtures\\*.json'
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('fixtures/');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['file://fixtures/document.pdf', 'fixtures/document.pdf'],
    ['file://./fixtures/document.pdf', 'fixtures/document.pdf'],
    ['file:///test/working/fixtures/report%ZZ.pdf', 'fixtures/report%ZZ.pdf'],
  ])('should preserve a supported multipart file-URL shorthand', (input, expected) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      multipart:
        parts:
          - kind: file
            source:
              type: path
              path: ${input}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([expected]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize file-backed target function references', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: file://providers/custom.py:call_api
  - id: http
    config:
      validateStatus: file://./validators/status.js:validateResponse
      auth:
        type: file
        path: file://./auth/get-token.ts:buildAuth
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/custom.py',
      'validators/status.js',
      'auth/get-token.ts',
      './',
    ]);
  });

  it('should extract a file-backed HTTP provider status validator', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      validateStatus: file://./validators/status.js:validateResponse
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/status.js']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract HTTP dependencies behind env-computed provider, auth, and multipart discriminators', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: "{{ env.PF977_HTTP_ID }}"
    config:
      url: https://example.test/chat
      auth:
        type: "{{ env.PF977_AUTH_TYPE }}"
        path: ./auth/get-token.js
      multipart:
        parts:
          - kind: "{{ env.PF977_PART_KIND }}"
            name: document
            source:
              type: "{{ env.PF977_SOURCE_TYPE }}"
              path: ./fixtures/document.pdf
targets:
  - id: http
    config:
      url: https://example.test/target
      multipart:
        parts:
          - kind: file
            name: upload
            source:
              type: path
              path: ./fixtures/target.txt
          - null
          - kind: field
            name: ignored
            value: inline
          - kind: file
            name: invalid-source
            source: null
          - kind: file
            name: generated
            source:
              type: generated
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'auth/get-token.js',
      'fixtures/document.pdf',
      'fixtures/target.txt',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract HTTP validator, auth, and TLS paths from provider and target maps', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - http:
      config:
        validateStatus: file://./validators/provider.js:validateResponse
        auth:
          type: file
          path: ./auth/provider.ts:buildAuth
        tls:
          certPath: ./certs/provider.pem
targets:
  - https://example.test/chat:
      config:
        validateStatus: file://./validators/target.js:validateResponse
        auth:
          type: file
          path: ./auth/target.ts:buildAuth
        tls:
          keyPath: ./certs/target.key
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/provider.js',
      'auth/provider.ts',
      'certs/provider.pem',
      'validators/target.js',
      'auth/target.ts',
      'certs/target.key',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should watch both status-validator paths for an uppercase JavaScript selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      validateStatus: file://./validators/status.JS:validateResponse
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/status.JS:validateResponse',
      'validators/status.JS',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve an unsupported status-validator extension and literal colon filename', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      validateStatus: file://./validators/status.py:validateResponse
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/status.py:validateResponse']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'status >= 200 && status < 300',
    '(status) => status < 500',
    'function(status) { return status < 500; }',
  ])('should not treat an inline HTTP status validator as a file dependency', (validator) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      validateStatus: '${validator}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve Ruby and Go function-like suffixes in vars and Go assertions', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars:
    ruby: file://vars/default.rb:build_vars
  assert:
    - type: javascript
      value: file://validators/default.go:Check
tests:
  - vars:
      ruby: file://vars/build.rb:build_vars
      go: file://vars/build.go:BuildVars
    assert:
      - type: javascript
        value: file://validators/check.go:Check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/default.rb:build_vars',
      'validators/default.go:Check',
      'vars/build.rb:build_vars',
      'vars/build.go:BuildVars',
      'validators/check.go:Check',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve unsupported uppercase function-selector extensions in vars and assertions', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      ruby: file://vars/build.RB:build_vars
    assert:
      - type: javascript
        value: file://validators/check.GO:Check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/build.RB:build_vars',
      'validators/check.GO:Check',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should watch both paths for uppercase JavaScript selectors in providers and assertions while preserving vars', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.TS:callApi
tests:
  - vars:
      script: file://vars/build.JS:buildVars
    assert:
      - type: javascript
        value: file://validators/check.MJS:Check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/custom.TS:callApi',
      'providers/custom.TS',
      'vars/build.JS:buildVars',
      'validators/check.MJS:Check',
      'validators/check.MJS',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should watch both paths for uppercase JavaScript prompt and HTTP auth selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
        path: ./auth/build.TS:buildAuth
prompts: file://prompts/build.JS:buildPrompt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'auth/build.TS:buildAuth',
      'auth/build.TS',
      'prompts/build.JS:buildPrompt',
      'prompts/build.JS',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize provider and prompt selectors when the basename contains a colon', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/build:v2.js:run
  - python:providers/build:v2.py:run
prompts:
  - file://prompts/build:v2.py:render
  - file://prompts/build:v2.JS:render
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/build:v2.js',
      'providers/build:v2.py',
      'prompts/build:v2.py',
      'prompts/build:v2.JS:render',
      'prompts/build:v2.JS',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should strip the rightmost supported provider and prompt function selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/build.js:v2.py:run
prompts: file://prompts/build.js:v2.py:render
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/build.js:v2.py',
      'prompts/build.js:v2.py',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize a JavaScript provider selector containing a slash and preserve a namespaced Ruby provider selector', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js:handlers/run
  - ruby:providers/custom.rb:Namespace::method
tests:
  - assert:
      - type: ruby
        value: file://validators/check.rb:Namespace::valid?
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/custom.js',
      'providers/custom.js:handlers/run',
      'providers/custom.rb',
      'providers/custom.rb:Namespace::method',
      'validators/check.rb',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract runtime-supported executable provider and target scripts', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - exec:providers/run.sh
targets:
  - id: exec:targets/run.py
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/run.sh', 'targets/run.py', './']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract interpreter-backed executable provider and target scripts', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'exec: python providers/chain.py --mode eval'
  - 'exec: /usr/bin/python3 providers/absolute-interpreter.py'
  - 'exec: "./.venv/bin/python" "provider scripts/quoted.py" --verbose'
  - 'exec:node --loader ts-node/esm providers/loader-target.ts --verbose'
  - 'exec:'
  - 'exec: --verbose'
targets:
  - id: 'exec:node targets/run.js --verbose'
  - id: 'exec:"/opt/node/bin/node" targets/absolute-node.js --verbose'
  - id: 'exec:node --require ./setup/register.js targets/node-target.js'
  - id: 'exec:python file://targets/prefixed.py'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/chain.py',
      'providers/absolute-interpreter.py',
      'provider scripts/quoted.py',
      'ts-node/esm',
      'providers/loader-target.ts',
      'targets/run.js',
      'targets/absolute-node.js',
      'setup/register.js',
      'targets/node-target.js',
      'targets/prefixed.py',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore an oversized executable provider command without affecting siblings', () => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'exec:${'a'.repeat(65_537)}.py'\n  - 'exec:python providers/safe.py'\n`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
  });

  it.each([
    'providers: file://providers/external.yaml',
    'targets: file://providers/external.yml',
    "providers:\n  - 'file://providers/external.json':\n      label: mapped",
    'targets:\n  - id: file://providers/external.yaml',
  ])('should conservatively watch dependencies nested in an external provider config', (providerConfig) => {
    mockFs.readFileSync.mockReturnValue(`${providerConfig}\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch nested assets from every provider-YAML glob match', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers/*.yaml\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/one.yaml',
      '/test/working/providers/two.yaml',
    ]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/one.yaml',
      'providers/two.yaml',
      'providers',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should expand an optimized literal-brace character class in config file URLs', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/prompts/{.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return `
providers: file://providers/[{].yaml
prompts: file://prompts/[{].yaml
`;
    });
    mockGlob.hasMagic.mockReturnValue(false);
    mockGlob.sync.mockImplementation((pattern: string | string[]) =>
      String(pattern).includes('/providers/')
        ? ['/test/working/providers/{.yaml']
        : ['/test/working/prompts/{.yaml'],
    );
    mockFs.existsSync.mockReturnValue(true);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/{.yaml');
    expect(deps).toContain('prompts/{.yaml');
    expect(deps).toContain('shared/nested.txt');
  });

  it('should process repeated selector markers in linear time and preserve sibling dependencies', () => {
    const adversarialPath = `${'.js:'.repeat(8192)}/`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
  - file://${adversarialPath}
  - file://${adversarialPath}
  - file://${adversarialPath}
  - file://${adversarialPath}
prompts: file://prompts/safe.txt
`);
    const startedAt = performance.now();

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/safe.py');
    expect(deps).toContain('prompts/safe.txt');
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it('should normalize supported JavaScript, Python, and Ruby assertion selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: javascript
        value: file://validators/check.js:Check
      - type: python
        value: file://validators/check.py:check
      - type: ruby
        value: file://validators/check.rb:Checks::valid?
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/check.js',
      'validators/check.py',
      'validators/check.rb',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not extract bare auth or TLS paths from a non-HTTP target', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: openai:gpt-4
    config:
      validateStatus: ./private/not-a-provider-validator.js
      auth:
        type: file
        path: ./private/not-a-provider-auth-file.js
      tls:
        caPath: ./private/not-a-provider-ca.pem
      signatureAuth:
        privateKeyPath: ./private/not-a-provider-key.pem
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore empty and non-string HTTP target paths', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: https
    config:
      auth:
        type: file
        path: ''
      tls:
        caPath: 42
      signatureAuth:
        privateKeyPath: null
  - id: http://example.test/chat
    config:
      auth:
        type: bearer
        path: ./private/not-file-auth.js
prompts: file://prompts/main.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject escaped HTTP target paths without disclosing their values', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      auth:
        type: file
        path: ../../SENSITIVE-REVIEW-TOKEN/auth.ts
      tls:
        caPath: ../../SENSITIVE-REVIEW-TOKEN/ca.pem
      signatureAuth:
        privateKeyPath: ../../SENSITIVE-REVIEW-TOKEN/private.key
prompts: file://prompts/main.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe HTTP provider file dependency: path must stay within the repository workspace',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
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
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
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
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
  });

  it('should preserve a relative prompt glob inside a directory with spaces', () => {
    mockFs.readFileSync.mockReturnValue("prompts: './prompt files/*.txt'\n");
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/prompt files/main.txt']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompt files/main.txt', 'prompt files']);
  });

  it('should preserve a relative prompt file inside a directory with spaces', () => {
    mockFs.readFileSync.mockReturnValue("prompts: './prompt files/main.txt'\n");

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompt files/main.txt']);
  });

  it.each([
    { prompt: 'prompt?', expected: ['prompt?'] },
    { prompt: '[ab]', expected: ['[ab]'] },
    { prompt: '{one,two}', expected: ['one', 'two'] },
    { prompt: '@(one|two)', expected: ['@(one|two)'] },
    { prompt: '*(one|two)', expected: ['*(one|two)'] },
    { prompt: '!(one|two)', expected: ['./'] },
  ])('should retain an extensionless non-star prompt glob after deletion', ({
    prompt,
    expected,
  }) => {
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation(
      (
        value: string,
        options?: { magicalBraces?: boolean; nonegate?: boolean },
      ) =>
        value.includes('*') ||
        value.includes('?') ||
        value.includes('[') ||
        value.includes('@(') ||
        (options?.magicalBraces === true && value.includes('{')) ||
        (options?.nonegate === true && value.startsWith('!(')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(expected);
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
      windowsPathsNoEscape: false,
      nobrace: true,
      braceExpandMax: 1024,
      fs: expect.objectContaining({ readdirSync: expect.any(Function) }),
      ignore: expect.objectContaining({
        childrenIgnored: expect.any(Function),
      }),
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

  it('should retain concrete brace-expanded prompt files after deletion', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://prompts/{one,two}.txt'\n",
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/one.txt', 'prompts/two.txt']);
  });

  it('should inspect nested dependencies in brace-only structured prompt files', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/one.yaml')) {
        return 'content: file://shared/one.txt\n';
      }
      if (String(filePath).endsWith('defs/two.yaml')) {
        return 'content: file://shared/two.txt\n';
      }
      return "prompts: 'file://defs/{one,two}.yaml'\n";
    });
    mockGlob.hasMagic.mockImplementation(
      (value: string, options?: { magicalBraces?: boolean }) =>
        value.includes('*') ||
        (options?.magicalBraces === true && value.includes('{')),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/defs/one.yaml',
      '/test/working/defs/two.yaml',
    ]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'defs/one.yaml',
      'defs/two.yaml',
      'shared/one.txt',
      'shared/two.txt',
    ]);
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
    expect(mockGlob.sync).toHaveBeenCalledTimes(2);
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

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
    );
  });

  it.each([
    '{foo),../providers}/*.py',
    '{foo),/absolute}/*.py',
    '{foo),../../outside}/*.py',
  ])('should reject a mismatched glob delimiter before expanding unsafe alternatives', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
  - file://${pattern}
prompts: file://prompts/safe.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './', 'prompts/safe.txt']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it('should preserve sibling dependencies when glob classification throws', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/broken.py
  - file://providers/safe.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('broken.py')) throw new Error('invalid pattern');
      return false;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it.each([
    '[}]*.js',
    '[)]*.js',
    '[[]*.js',
    '{foo,bar}/[!)]*.py',
    '[!}]*.py',
    'literal).py',
  ])('should preserve valid scoped glob delimiters and literal parentheses', (pattern) => {
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://validators/${pattern}\n`,
    );
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('['),
    );
    mockGlob.sync.mockReturnValue(['/test/working/validators/match.js']);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(
      pattern === '{foo,bar}/[!)]*.py'
        ? ['validators/match.js', 'validators/foo', 'validators/bar', './']
        : pattern === 'literal).py'
          ? ['validators/literal).py', './']
          : ['validators/match.js', 'validators', './'],
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should reject foreign Windows-style absolute dependencies while preserving POSIX root-colon filenames', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
  - file://C:/SENSITIVE-REVIEW-TOKEN/provider.py
  - file:////SENSITIVE-REVIEW-TOKEN/share/provider.py
  - file://C:relative-provider.py
  - file://a:provider.py
  - id: http
    config:
      auth:
        type: file
        path: C:/SENSITIVE-REVIEW-TOKEN/auth.ts
tests:
  - vars:
      context:
        file: C:/SENSITIVE-REVIEW-TOKEN/context.txt
prompts:
  - file://prompts/safe.txt
  - file://C:/SENSITIVE-REVIEW-TOKEN/prompt.txt
  - file:////SENSITIVE-REVIEW-TOKEN/share/prompt.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/safe.py',
      'C:relative-provider.py',
      'a:provider.py',
      'prompts/safe.txt',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should reject a Windows file-URL drive path on a POSIX runner before scanning it', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file:///C:/repo/providers/*.py\nprompts: file://prompts/safe.txt\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/safe.txt', './']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: foreign absolute paths are not supported',
    );
  });

  it('should reject a Windows file-URL drive path in an HTTP provider on a POSIX runner', () => {
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      auth:
        type: file
        path: file:///C:/repo/auth/token.json
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: foreign absolute paths are not supported',
    );
  });

  it('should emit one sanitized warning for many foreign absolute dependencies', () => {
    const vars = Array.from(
      { length: 200 },
      (_, index) =>
        `      value${index}:\n        file: C:/SENSITIVE-REVIEW-TOKEN/${index}.txt`,
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
  - file://C:/SENSITIVE-REVIEW-TOKEN/provider.py
  - id: http
    config:
      auth:
        type: file
        path: C:/SENSITIVE-REVIEW-TOKEN/auth.ts
tests:
  - vars:
${vars}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
    const foreignWarnings = vi
      .mocked(core.warning)
      .mock.calls.filter(([message]) =>
        String(message).includes('foreign absolute paths are not supported'),
      );
    expect(foreignWarnings).toHaveLength(1);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
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

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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

  it('should fail closed when a config dependency glob exhausts its traversal budget', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - file://providers/**/*.yaml\n',
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((_pattern, options) => {
      const childrenIgnored = options.ignore?.childrenIgnored;
      for (let index = 0; index < 4097; index++) {
        childrenIgnored?.({
          fullpath: () => `SENSITIVE-REVIEW-TOKEN/${index}`,
          isSymbolicLink: () => false,
        });
      }
      return [];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob that exceeded the traversal budget; conservatively watching the dependency root',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should reject a truncated combinatorial alphabetic brace dependency before enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://prompts/{a..z}{a..z}{a..z}.txt'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('{'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
    );
  });

  it('should fail closed when structured-prompt glob inspection exhausts its traversal budget', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://defs/*.yaml\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    let calls = 0;
    mockGlob.sync.mockImplementation((_pattern, options) => {
      if (calls++ === 0) return ['/test/working/defs/one.yaml'];
      const childrenIgnored = options.ignore?.childrenIgnored;
      for (let index = 0; index < 4097; index++) {
        childrenIgnored?.({
          fullpath: () => `SENSITIVE-REVIEW-TOKEN/${index}`,
          isSymbolicLink: () => false,
        });
      }
      return [];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping prompt file dependency glob that exceeded the traversal budget; conservatively watching the dependency root',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should bound a backslash-activated runtime brace range before config glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'file://prompts\\{1..2000}/*.txt'\n",
    );
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

  it('should reject a backslash-activated runtime brace traversal arm before config glob enumeration', () => {
    mockFs.readFileSync.mockReturnValue(
      "providers:\n  - 'file://providers\\{safe,..\\..\\..\\outside}/*.py'\n",
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
    );
  });

  it('should bound comma-alternative expansion before config glob enumeration', () => {
    const alternatives = Array.from({ length: 1025 }, (_, index) => index).join(
      ',',
    );
    mockFs.readFileSync.mockReturnValue(
      `prompts: 'file://prompts/{${alternatives}}/*.txt'\n`,
    );
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

  it('should avoid expanding a deeply nested templated-looking config glob and preserve safe siblings', () => {
    const deepGlob = `${'{'.repeat(129)}one,two${'}'.repeat(129)}/*.py`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - file://providers/safe.py\n  - 'file://${deepGlob}'\nprompts: file://prompts/safe.txt\n`,
    );
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/safe.py',
      './',
      deepGlob,
      'prompts/safe.txt',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it('should normalize a backslash-delimited config brace path with runtime glob semantics', () => {
    const prompt = 'file://prompts\\{literal}/*.txt';
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/evals/prompts/{literal}/safe.txt',
    ]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toContain('evals/prompts/{literal}/safe.txt');
    expect(mockGlob.sync).toHaveBeenCalledWith(
      '/test/working/evals/prompts/{literal}/*.txt',
      expect.objectContaining({
        nobrace: true,
        windowsPathsNoEscape: false,
        braceExpandMax: 1024,
        fs: expect.objectContaining({ readdirSync: expect.any(Function) }),
        ignore: expect.objectContaining({
          childrenIgnored: expect.any(Function),
        }),
      }),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it('should preserve a brace-backed assertion-file dependency for bounded downstream matching', () => {
    const dependency = `data/${'{a,b}'.repeat(11)}.txt`;
    mockFs.readFileSync.mockReturnValue(
      `tests:\n  - assert:\n      - type: equals\n        value:\n          file: '${dependency}'\n`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([dependency]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should traverse file references nested in a test generator config', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  path: file://generators/build.py
  config:
    examples: file://data/examples.json
    nested:
      rubric: file://rubrics/quality.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'generators/build.py',
      'data/examples.json',
      'rubrics/quality.txt',
      './',
    ]);
  });

  it.each([
    'az://myaccount/evals/tests.json',
    's3://bucket/evals/tests.yaml',
    'https://example.test/evals/tests.csv',
  ])('should not create local watches for a remote structured test URL: %s', (tests) => {
    mockFs.readFileSync.mockReturnValue(`tests: '${tests}'\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should not classify a Windows drive-absolute structured test path as a remote URL', () => {
    mockFs.readFileSync.mockReturnValue("tests: 'C://repo/evals/tests.yaml'\n");

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: foreign absolute paths are not supported',
    );
  });

  it.each([
    { label: 'forward range', prompt: 'file://prompts/{1..1000000000}.txt' },
    { label: 'reverse range', prompt: 'file://prompts/{1000000000..1}.txt' },
    {
      label: 'negative stepped range',
      prompt: 'file://prompts/{-1000000000..1000000000..2}.yaml',
    },
    {
      label: 'class-hidden range',
      prompt: 'file://prompts/[{1..5000000}].txt',
    },
    {
      label: 'even-backslash range',
      prompt: 'file://prompts/\\\\{1..5000000}.txt',
    },
    {
      label: 'padded range',
      prompt: `file://prompts/{${'0'.repeat(32_000)}1..1024}.txt`,
    },
  ])('should reject a hostile numeric config range before glob classification or enumeration: $label', ({
    prompt,
  }) => {
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('hostile range reached glob classification');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(mockGlob.hasMagic).not.toHaveBeenCalled();
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

    expect(deps).toEqual(['./']);
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

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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
    "prompts: 'Answer in {{ env.TONE }} tone'\n",
    'prompts: \'Use {{- env["TONE"] -}} tone for this response\'\n',
    "prompts: '{{ env.TONE }} tone for {{question}}'\n",
    'prompts: \'{{- env["TONE"] -}}: {{user}}\'\n',
    "prompts: 'Summarize /tmp/SENSITIVE-REVIEW-TOKEN.txt for the user'\n",
    "prompts: 'Summarize /tmp/SENSITIVE-REVIEW-TOKEN.txt'\n",
    "prompts: 'Inspect ../private/SENSITIVE-REVIEW-TOKEN.txt before replying'\n",
    "prompts: 'Choose A/B before continuing'\n",
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
    expect(core.warning).not.toHaveBeenCalled();
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

    expect(deps).toEqual(['providers/custom.py', './']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('pattern is too long'),
    );
  });

  it('should skip an oversized file glob and preserve sibling dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
  - file://prompts/${'A'.repeat(70_000)}*.txt
prompts: file://prompts/main.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw new Error('pattern is too long');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.py', 'prompts/main.txt', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it('should skip an oversized prompt glob and preserve sibling dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
prompts:
  - file://prompts/main.txt
  - file://prompts/${'A'.repeat(70_000)}*.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65_536) {
        throw new Error('pattern is too long');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.py', 'prompts/main.txt', './']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
  });

  it('should extract scalar prompt functions without the function suffix', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file://prompts/build.py:create_prompt\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompts/build.py', './']);
  });

  it('should extract an in-workspace absolute scalar prompt function', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: file:///test/working/prompts/build.py:create_prompt\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/build.py', './']);
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
      './',
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

    expect(deps).toEqual(['../config/prompts/generate.sh', './']);
  });

  it.each([
    ['exec:./prompts/generate.sh', 'prompts/generate.sh'],
    ['file://prompts/build.js:makePrompt', 'prompts/build.js'],
    ['file://prompts/build.py:create_prompt', 'prompts/build.py'],
    ['prompts/build.sh', 'prompts/build.sh'],
    ['prompts/build.bash', 'prompts/build.bash'],
    ['prompts/build.rb', 'prompts/build.rb'],
  ])('should conservatively watch side inputs for a dynamic prompt (%s)', (prompt, script) => {
    mockFs.readFileSync.mockReturnValue(`prompts: ${prompt}\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain(script);
    expect(deps).toContain('./');
  });

  it('should extract a root-level extensionless executable prompt', () => {
    mockFs.readFileSync.mockReturnValue('prompts: exec:prompt-generator\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompt-generator', './']);
  });

  it.each([
    'exec:prompts/foo.py:build|foo.sh',
    'exec:file://prompts/foo.py:build|foo.sh',
    'exec:prompts/foo.sh',
  ])('should extract an executable prompt script with runtime selector syntax', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts: ${prompt}\n`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      `../config/${prompt.includes('.py:') ? 'prompts/foo.py' : 'prompts/foo.sh'}`,
      './',
    ]);
  });

  it('should extract an executable prompt path without its arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh --tone formal\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/scripts/generate.sh', './']);
  });

  it('should extract a quoted executable prompt path without its arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      `prompts: "exec:'./prompt scripts/generate.sh' --tone formal"\n`,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/prompt scripts/generate.sh', './']);
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

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'templates/input.txt',
      './',
    ]);
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
      './',
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
      './',
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

    expect(deps).toEqual(['evals/scripts/generate.sh', './']);
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

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'templates/input.txt',
      './',
    ]);
  });

  it('should watch the static directory of a templated executable argument', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates/{{ env.NAME }}.txt\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', 'templates/', './']);
  });

  it('should watch the workspace for a root-templated executable argument', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh {{ env.NAME }}.txt\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', './']);
  });

  it('should process a long malformed executable template in linear time', () => {
    const malformedTemplate = '{{'.repeat(32768);
    mockFs.readFileSync.mockReturnValue(
      `prompts: exec:./scripts/generate.sh ${malformedTemplate}\n`,
    );
    const startedAt = performance.now();

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', './']);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it('should preserve legacy tokenization for a malformed template with a single closing brace', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh {{ ./fixtures/legacy.txt } b }} ./fixtures/keep.txt\n',
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      './',
      'fixtures/legacy.txt',
      'fixtures/keep.txt',
    ]);
  });

  it('should not watch an out-of-workspace templated executable argument', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - raw: exec:./scripts/generate.sh ./templates/{{ env.NAME }}.txt
    config:
      basePath: /private/tmp/SENSITIVE-REVIEW-TOKEN
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', './']);
    expect(core.warning).not.toHaveBeenCalled();
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
      './',
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

    expect(deps).toEqual([
      'evals/scripts/generate.sh',
      'templates/input.txt',
      './',
    ]);
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

    expect(deps).toEqual(['evals/scripts/generate.sh', expected, './']);
  });

  it('should ignore directory arguments passed to an executable prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh ./templates\n',
    );
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/templates'),
    );
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () =>
            !String(filePath).endsWith('/promptfooconfig.yaml'),
          isFile: () => String(filePath).endsWith('/promptfooconfig.yaml'),
          mode: 0o755,
          size: 0,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/scripts/generate.sh', './']);
  });

  it('should not disclose out-of-workspace executable arguments', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: exec:./scripts/generate.sh /private/tmp/SENSITIVE-REVIEW-TOKEN\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/scripts/generate.sh', './']);
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
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/promptfooconfig.yaml')) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o100644,
          size: 0,
        } as fs.Stats;
      }
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

  it('should not treat an inline question-mark prompt as a dependency glob', () => {
    mockFs.readFileSync.mockReturnValue('prompts: "What is 2+2?"\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('?'),
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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

    expect(deps).toEqual([
      '../config/prompts.csv',
      '../config/generate.exe',
      './',
    ]);
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
      './',
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

  it('should fall back to a prompt file when the prompt id is only a label', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: customer-label
    file: prompts/customer.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/customer.txt']);
  });

  it('should fall back to a prompt file when the prompt id label contains a slash', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: customer/v2
    file: prompts/customer.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/customer.txt']);
  });

  it('should prefer an explicit prompt file over a file-like prompt id label', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts:
  - id: customer.md
    file: prompts/customer.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/customer.txt']);
  });

  it('should reject a null-byte dependency glob before scanning and preserve valid dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/valid.py
  - "file://prompts/*\\0.txt"
prompts: file://prompts/main.txt
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new Error('glob received a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/valid.py', 'prompts/main.txt', './']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: config file dependency contains an invalid null byte',
    );
  });

  it('should reject a null-byte prompt glob before nested inspection and preserve valid dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/valid.py
prompts:
  - file://prompts/main.txt
  - "file://prompts/*\\0.yaml"
`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.includes('\0')) {
        throw new Error('glob received a null byte');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/valid.py', 'prompts/main.txt', './']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency: config file dependency contains an invalid null byte',
    );
  });

  it('should reject a null byte in an object-backed dependency and preserve valid dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
prompts: file://prompts/main.txt
tests:
  - vars:
      context:
        file: "data/invalid\\0.json"
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'test variable file dependency contains an invalid null byte',
      ),
    );
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

  it('should inspect nested references in an object-form structured prompt file', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('configs/prompts.yaml')) {
        return 'content: file://prompts/system.txt\n';
      }
      return 'prompts:\n  - file: file://configs/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/configs/prompts.yaml',
      '../config/prompts/system.txt',
    ]);
  });

  it('should conservatively watch a generic Nunjucks expression in a structured prompt file', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('defs/prompt.yaml')
        ? 'content: "{{ env.PROMPT_TEXT | default(\'hello\') }}"\n'
        : 'prompts: file://defs/prompt.yaml\n',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('defs/prompt.yaml');
    expect(deps).toContain('./');
  });

  it.each([
    'providers: file://providers/external.yaml',
    'scenarios: file://scenarios/cases.yaml',
    'tests: file://data/cases.csv',
    'tests: file://data/cases.xlsx#Sheet1',
  ])('should conservatively watch structured runtime inputs that can render Nunjucks (%s)', (config) => {
    mockFs.readFileSync.mockReturnValue(`${config}\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
  });

  it('should not read an oversized structured prompt while preserving safe sibling dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      if (String(filePath).endsWith('/huge.yaml')) {
        throw new Error('oversized prompt should not be read');
      }
      return `
prompts:
  - file://prompts/huge.yaml
  - file://prompts/safe.yaml
`;
    });
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('.yaml'),
    );
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644,
          size: String(filePath).endsWith('/huge.yaml') ? 2 ** 40 : 128,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/huge.yaml',
      './',
      'prompts/safe.yaml',
      'shared/nested.txt',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/huge.yaml',
      'utf8',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping oversized structured prompt dependency; nested references will not be inspected',
    );
  });

  it('should not read a contained FIFO structured prompt while preserving safe sibling dependencies', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      if (String(filePath).endsWith('/blocked.yaml')) {
        throw new Error('FIFO prompt should not be read');
      }
      return `
prompts:
  - file://prompts/blocked.yaml
  - file://prompts/safe.yaml
`;
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => false,
          isFile: () => !String(filePath).endsWith('/blocked.yaml'),
          mode: String(filePath).endsWith('/blocked.yaml') ? 0o10644 : 0o100644,
          size: 0,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/blocked.yaml',
      './',
      'prompts/safe.yaml',
      'shared/nested.txt',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/blocked.yaml',
      'utf8',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping non-file structured prompt dependency; nested references will not be inspected',
    );
  });

  it('should not read a structured prompt swapped to a FIFO after path validation', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/blocked.yaml')) {
        throw new Error('swapped FIFO prompt should not be read');
      }
      return 'prompts: file://prompts/blocked.yaml\n';
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
      size: 0,
    } as fs.Stats);
    mockFs.fstatSync.mockImplementation(
      (descriptor: unknown) =>
        ({
          isDirectory: () => false,
          isFile: () => !String(descriptor).endsWith('/blocked.yaml'),
          mode: String(descriptor).endsWith('/blocked.yaml')
            ? 0o10644
            : 0o100644,
          size: 0,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/blocked.yaml', './']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/blocked.yaml',
      'utf8',
    );
    expect(mockFs.openSync).toHaveBeenCalledWith(
      '/test/working/prompts/blocked.yaml',
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    expect(mockFs.closeSync).toHaveBeenCalledWith(
      '/test/working/prompts/blocked.yaml',
    );
    expect(core.warning).toHaveBeenCalledWith(
      'Skipping non-file structured prompt dependency; nested references will not be inspected',
    );
  });

  it.each([
    'oversized',
    'unreadable',
  ])('should fail closed to the checkout when an external-config structured prompt is %s', (failure) => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/structured.yaml')) {
        throw new Error('EACCES: SENSITIVE-REVIEW-TOKEN');
      }
      return 'prompts: file:///test/working/prompts/structured.yaml\n';
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation(
      (filePath: unknown) =>
        ({
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644,
          size:
            failure === 'oversized' &&
            String(filePath).endsWith('/structured.yaml')
              ? 2 ** 40
              : 128,
        }) as fs.Stats,
    );

    const deps = extractFileDependencies(
      '/external/config/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['prompts/structured.yaml', './']);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
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
      './',
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

    expect(deps).toEqual(['../config/configs/prompts.json', './']);
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
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('linked/secret.yaml')
        ? '/tmp/outside/secret.yaml'
        : filePath,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe prompt file dependency "linked/secret.yaml": resolved path must stay within the repository workspace',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should not read a dangling direct structured-prompt symlink', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/dangling.yaml')) {
        return 'content: file:///test/outside/SENSITIVE-REVIEW-TOKEN.txt\n';
      }
      return 'prompts: file://prompts/dangling.yaml\n';
    });
    mockFs.existsSync.mockReturnValue(false);
    mockFs.lstatSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/dangling.yaml')) {
        return { isSymbolicLink: () => true } as fs.Stats;
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/dangling.yaml')) {
        throw new Error('ENOENT: SENSITIVE-REVIEW-TOKEN');
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/dangling.yaml', './']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/dangling.yaml',
      'utf8',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should not read a missing direct structured prompt after an ENOENT lstat', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/missing.yaml')) {
        return 'content: file:///test/outside/SENSITIVE-REVIEW-TOKEN.txt\n';
      }
      return 'prompts: file://prompts/missing.yaml\n';
    });
    mockFs.existsSync.mockReturnValue(false);
    mockFs.lstatSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/missing.yaml')) {
        const error = new Error(
          'ENOENT: SENSITIVE-REVIEW-TOKEN',
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { isSymbolicLink: () => false } as fs.Stats;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/missing.yaml']);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/missing.yaml',
      'utf8',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should preserve a safe structured prompt when a sibling lstat lookup is denied', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return `
prompts:
  - file://prompts/unreadable.yaml
  - file://prompts/safe.yaml
`;
    });
    mockFs.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/safe.yaml'),
    );
    mockFs.lstatSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/unreadable.yaml')) {
        const error = new Error(
          'EACCES: SENSITIVE-REVIEW-TOKEN',
        ) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return { isSymbolicLink: () => false } as fs.Stats;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'prompts/unreadable.yaml',
      './',
      'prompts/safe.yaml',
      'shared/nested.txt',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/working/prompts/unreadable.yaml',
      'utf8',
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
      {
        nodir: true,
        windowsPathsNoEscape: false,
        nobrace: true,
        braceExpandMax: 1024,
        fs: expect.objectContaining({ readdirSync: expect.any(Function) }),
        ignore: expect.objectContaining({
          childrenIgnored: expect.any(Function),
        }),
      },
    );
    expect(mockGlob.sync).toHaveBeenNthCalledWith(
      2,
      '/test/config/defs/*.yaml',
      {
        nodir: true,
        windowsPathsNoEscape: false,
        nobrace: true,
        braceExpandMax: 1024,
        fs: expect.objectContaining({ readdirSync: expect.any(Function) }),
        ignore: expect.objectContaining({
          childrenIgnored: expect.any(Function),
        }),
      },
    );
  });

  it('should preserve extracted dependencies when structured prompt-glob reclassification throws', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://defs/*.yaml\n');
    let rawClassifications = 0;
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value === 'defs/*.yaml') {
        rawClassifications++;
        if (rawClassifications === 2) throw new Error('invalid pattern');
      }
      return value.includes('*');
    });
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['../config/defs/']);
    expect(mockGlob.sync).toHaveBeenCalledTimes(1);
  });

  it('should not read a dangling structured-prompt glob symlink and preserve safe matches', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('defs/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      if (String(filePath).endsWith('defs/dangling.yaml')) {
        return 'content: file:///test/outside/SENSITIVE-REVIEW-TOKEN.txt\n';
      }
      return 'prompts: file://defs/*.yaml\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/defs/dangling.yaml',
      '/test/config/defs/safe.yaml',
    ]);
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => !String(filePath).endsWith('/dangling.yaml'),
    );
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/dangling.yaml')) {
        throw new Error('ENOENT: SENSITIVE-REVIEW-TOKEN');
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/defs/safe.yaml',
      '../config/defs',
      './',
      '../config/shared/nested.txt',
    ]);
    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(
      '/test/config/defs/dangling.yaml',
      'utf8',
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should redact an unreadable structured-prompt glob pattern and preserve safe matches', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://SENSITIVE-REVIEW-TOKEN/*.yaml\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/SENSITIVE-REVIEW-TOKEN/unreadable.yaml',
      '/test/config/SENSITIVE-REVIEW-TOKEN/safe.yaml',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/unreadable.yaml')) {
        throw new Error('EACCES: SENSITIVE-REVIEW-TOKEN');
      }
      return filePath;
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/SENSITIVE-REVIEW-TOKEN/safe.yaml',
      '../config/SENSITIVE-REVIEW-TOKEN',
      './',
      '../config/shared/nested.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should redact an escaping structured-prompt glob pattern and preserve safe matches', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('/safe.yaml')) {
        return 'content: file://shared/nested.txt\n';
      }
      return 'prompts: file://SENSITIVE-REVIEW-TOKEN/*.yaml\n';
    });
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/config/SENSITIVE-REVIEW-TOKEN/escape.yaml',
      '/test/config/SENSITIVE-REVIEW-TOKEN/safe.yaml',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith('/escape.yaml')
        ? '/test/outside/SENSITIVE-REVIEW-TOKEN.yaml'
        : filePath,
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/SENSITIVE-REVIEW-TOKEN/safe.yaml',
      '../config/SENSITIVE-REVIEW-TOKEN',
      '../config/shared/nested.txt',
    ]);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
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
      '../config/prompts/',
      './',
      '../config/prompts/{{ env.PF977_TARGET }}.txt',
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
      'shared/',
      'shared/{# select default #}system.txt',
    ]);
  });

  it('should conservatively watch the config directory for a root templated prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      'prompts: "file://{{ env.PF977_TARGET }}.txt"\n',
    );

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/',
      './',
      '../config/{{ env.PF977_TARGET }}.txt',
    ]);
  });

  it.each([
    '{{ env.PROMPT_FILE }}',
    "{{ env['PROMPT-FILE'] }}",
    "{{ env ['PROMPT-FILE'] }}",
    "{{ (env)['PROMPT-FILE'] }}",
    "{{\u00a0(env)['PROMPT-FILE']\u00a0}}",
    '{{- env.PROMPT_FILE -}}',
    "{{- env['PROMPT-FILE'] -}}",
    '{{ env.TEST_PROMPT_PATH }}/prompt.txt',
    "{{ env.OPTIONAL_PATH | default('./shared/prompts') }}/prompt.txt",
  ])('should watch the repository for a root-templated prompt path', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts: "${prompt}"\n`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/', `evals/${prompt}`, './']);
  });

  it('should conservatively watch a Nunjucks block that can emit an env-backed file prompt', () => {
    mockFs.readFileSync.mockReturnValue(
      `prompts: "{% if env.PF977_USE_FILE %}file://{{ env.PF977_PROMPT }}{% endif %}"\n`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not widen an ordinary prompt containing filtered env text', () => {
    mockFs.readFileSync.mockReturnValue(
      `prompts: "Summarize {{ env.PF977_TOPIC | default('the document') }} clearly."\n`,
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
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
      './',
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

    expect(deps).toEqual(['../config/providers/provider.py', './']);
  });

  it('should extract test variable files', () => {
    const configContent = `
tests:
  - null
  - false
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

  it('should track bare ElevenLabs provider and test-variable audio files', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: elevenlabs:stt
    config:
      audioFile: media/provider.wav
defaultTest:
  options:
    provider:
      id: elevenlabs:stt
      config:
        audioFile: media/grader.wav
tests:
  - vars:
      audioFile: media/input.wav
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'media/provider.wav',
      'media/grader.wav',
      'media/input.wav',
    ]);
  });

  it('should track a bare audio test variable for a scalar ElevenLabs provider', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: elevenlabs:alignment
tests:
  - vars:
      audioFile: media/input.wav
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['media/input.wav']);
  });

  it('should preserve a file URL in an ElevenLabs provider audio-file config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: elevenlabs:stt
    config:
      audioFile: file://media/provider.wav
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['media/provider.wav']);
  });

  it.each([
    'txt',
    'md',
    'j2',
    'csv',
  ])('should conservatively watch Nunjucks includes in an unstructured %s prompt', (extension) => {
    const promptPath = `/test/working/prompts/main.${extension}`;
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => String(filePath) === promptPath,
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath) === promptPath
        ? '{% include "partials/shared.njk" %}\n'
        : `prompts: file://prompts/main.${extension}\n`,
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([`prompts/main.${extension}`, './']);
  });

  it('should detect an unstructured Nunjucks include after a long whitespace prefix', () => {
    const promptPath = '/test/working/prompts/main.txt';
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => String(filePath) === promptPath,
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath) === promptPath
        ? `${' '.repeat(2048)}{% include "partials/shared.njk" %}\n`
        : 'prompts: file://prompts/main.txt\n',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt', './']);
  });

  it.each([
    'include',
    'extends',
    'import',
    'from',
  ])('should detect an unstructured Nunjucks %s directive after a non-breaking space', (directive) => {
    const promptPath = '/test/working/prompts/main.txt';
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => String(filePath) === promptPath,
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath) === promptPath
        ? `${' '.repeat(2048)}{%\u00a0${directive} "partials/shared.njk" %}\n`
        : 'prompts: file://prompts/main.txt\n',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt', './']);
  });

  it('should not watch unrelated files for a static unstructured prompt', () => {
    const promptPath = '/test/working/prompts/main.txt';
    mockFs.existsSync.mockImplementation(
      (filePath: unknown) => String(filePath) === promptPath,
    );
    mockFs.readFileSync.mockImplementation((filePath: unknown) =>
      String(filePath) === promptPath
        ? 'A static prompt.\n'
        : 'prompts: file://prompts/main.txt\n',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/main.txt']);
  });

  it('should skip unsupported or out-of-root unstructured prompt-glob matches', () => {
    mockFs.readFileSync.mockReturnValue('prompts: file://prompts/*\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/prompts/ignored.bin',
      '/private/SENSITIVE-REVIEW-TOKEN/outside.txt',
    ]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).not.toContain('../private/SENSITIVE-REVIEW-TOKEN/outside.txt');
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should extract file-backed test variables declared as strings or arrays', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars: file://data/default-cases.yaml
tests:
  - vars: file://data/scalar-cases.yaml
  - vars:
      - file://data/array-cases.yaml
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/data/default-cases.yaml',
      '../config/data/scalar-cases.yaml',
      '../config/data/array-cases.yaml',
    ]);
  });

  it('should extract bare scalar and array test-vars paths', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars: data/default-cases.yaml
tests:
  - vars: data/scalar-cases.csv
  - vars:
      - data/array-cases.yaml
      - data/extra-cases.json
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'data/default-cases.yaml',
      'data/scalar-cases.csv',
      'data/array-cases.yaml',
      'data/extra-cases.json',
    ]);
  });

  it('should expand direct scalar and array test-vars globs', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars: data/default/*.yaml
tests:
  - vars:
      - data/cases/*.json
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation((pattern: string | string[]) => {
      const value = Array.isArray(pattern) ? pattern[0] : pattern;
      return value.includes('/default/')
        ? ['/test/working/data/default/one.yaml']
        : ['/test/working/data/cases/one.json'];
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'data/default/one.yaml',
      'data/default',
      'data/cases/one.json',
      'data/cases',
    ]);
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

  it('should extract every file reference in an assertion-value array', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: equals
        value:
          - file://expected/one.txt
          - file://expected/two.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['expected/one.txt', 'expected/two.txt']);
  });

  it.each([
    'file://defaults/defaults.yaml',
    'defaults/defaults.yaml',
  ])('should conservatively watch an external default-test file (%s)', (value) => {
    mockFs.readFileSync.mockReturnValue(`defaultTest: ${value}\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['defaults/defaults.yaml', './']);
  });

  it('should conservatively watch nested dependencies in test and scenario directories', () => {
    mockFs.readFileSync.mockReturnValue(`
tests: file://tests
scenarios: file://scenarios
`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation((filePath: unknown) => {
      const candidate = String(filePath);
      const isDirectory =
        candidate.endsWith('/tests') || candidate.endsWith('/scenarios');
      return {
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        mode: isDirectory ? 0o40755 : 0o100644,
        size: 0,
      } as fs.Stats;
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('tests');
    expect(deps).toContain('scenarios');
    expect(deps).toContain('./');
  });

  it('should extract file-backed grading providers from inline assertions and test options', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  options:
    provider: file://graders/default-options.py:grade
  assert:
    - type: llm-rubric
      provider: file://graders/default.js:grade
tests:
  - options:
      provider: python:graders/test-options.py:grade
    assert:
      - type: llm-rubric
        provider: exec:graders/run.sh
      - type: llm-rubric
        provider:
          id: file://graders/object.py:grade
          config:
            request: file://fixtures/request.json
      - type: llm-rubric
        provider:
          'ruby:graders/mapped.rb:Clients::grade':
            label: mapped
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'graders/default-options.py',
      'graders/default.js',
      'graders/test-options.py',
      'graders/run.sh',
      'graders/object.py',
      'fixtures/request.json',
      'graders/mapped.rb',
      'graders/mapped.rb:Clients::grade',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract direct file-backed test and default-test provider overrides', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  provider: file://graders/default-provider.py:grade
tests:
  - provider: file://graders/test-provider.py:grade
  - provider:
      id: python:graders/object-provider.py:grade
      config:
        request: file://fixtures/request.json
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'graders/default-provider.py',
      'graders/test-provider.py',
      'fixtures/request.json',
      'graders/object-provider.py',
      './',
    ]);
  });

  it('should follow the runtime-selected first key from inline provider and target maps', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      file://graders/one.py:grade: {}
      file://graders/two.js:grade:
        config:
          request: file://fixtures/ignored-inline.json
          $ref: file://schemas/ignored-inline.yaml
scenarios:
  - provider:
      python:graders/scenario-one.py:grade: {}
      ruby:graders/scenario-two.rb:Grade::call:
        config:
          request: file://fixtures/ignored-scenario.json
          $ref: file://schemas/ignored-scenario.yaml
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('graders/one.py');
    expect(deps).toContain('graders/scenario-one.py');
    expect(deps).toContain('./');
    expect(deps).not.toContain('graders/two.js');
    expect(deps).not.toContain('graders/scenario-two.rb');
    expect(deps).not.toContain('fixtures/ignored-inline.json');
    expect(deps).not.toContain('schemas/ignored-inline.yaml');
    expect(deps).not.toContain('fixtures/ignored-scenario.json');
    expect(deps).not.toContain('schemas/ignored-scenario.yaml');
  });

  it('should safely ignore an empty inline provider map', () => {
    mockFs.readFileSync.mockReturnValue('tests:\n  - provider: {}\n');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch side inputs for inline executable test and scenario providers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider: exec:providers/test.sh
scenarios:
  - provider: exec:providers/scenario.py
  - provider:
      'exec:providers/mapped.sh': {}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/test.sh');
    expect(deps).toContain('providers/scenario.py');
    expect(deps).toContain('providers/mapped.sh');
    expect(deps).toContain('./');
  });

  it('should conservatively watch side inputs for top-level and inline script providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - exec:providers/top.sh
  - 'python:providers/top.py:call_api'
  - file://providers/build:v2.py:call_api
tests:
  - provider: file://providers/test.js:callApi
  - provider: file://providers/build:v2.js:callApi
scenarios:
  - provider:
      'python:providers/scenario.py:call_api': {}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/top.sh');
    expect(deps).toContain('providers/top.py');
    expect(deps).toContain('providers/test.js');
    expect(deps).toContain('providers/build:v2.py');
    expect(deps).toContain('providers/build:v2.js');
    expect(deps).toContain('providers/scenario.py');
    expect(deps).toContain('./');
  });

  it('should conservatively watch templated provider and transform concatenations', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "{{ 'python:providers/' + env.PROVIDER_FILE }}"
tests:
  - options:
      transform: "{{ 'file://hooks/' + env.HOOK_FILE }}"
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should recursively inspect provider IDs nested inside provider config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: custom:outer
    config:
      grader:
        id: python:graders/nested.py:grade
      target:
        'exec:providers/nested.sh': {}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('graders/nested.py');
    expect(deps).toContain('providers/nested.sh');
    expect(deps).toContain('./');
  });

  it('should recursively inspect a file-backed provider-map key nested inside provider config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: custom:outer
    config:
      nested:
        'file://providers/inner.py:call_api': {}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/inner.py');
    expect(deps).toContain('./');
  });

  it('should track a bare JavaScript provider and conservatively watch its side inputs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - providers/bare.js:callApi
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/bare.js');
    expect(deps).toContain('./');
  });

  it('should track config-level refs at the root and inside inline prompts', () => {
    mockFs.readFileSync.mockReturnValue(`
$ref: file://schemas/root.yaml
prompts:
  - label: Referenced prompt
    $ref: schemas/prompt.yaml
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('schemas/root.yaml');
    expect(deps).toContain('schemas/prompt.yaml');
    expect(deps).toContain('./');
  });

  it('should track refs nested inside assertion sets', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - type: assert-set
        assert:
          - $ref: file://schemas/assertion.yaml#/assertions/check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('schemas/assertion.yaml');
    expect(deps).not.toContain('schemas/assertion.yaml#/assertions/check');
    expect(deps).toContain('./');
  });

  it('should not watch unrelated files for static inline and grading providers', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: openai:gpt-4.1-mini
    config:
      temperature: 0
defaultTest:
  options:
    provider:
      id: openai:gpt-4.1-mini
      config:
        temperature: 0
tests:
  - assert:
      - type: llm-rubric
        provider:
          id: openai:gpt-4.1-mini
          config:
            temperature: 0
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should preserve a sibling local dependency when a config ref is remote', () => {
    mockFs.readFileSync.mockReturnValue(`
$ref: https://example.test/schema.yaml
prompts: file://prompts/local.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('prompts/local.txt');
    expect(deps).toContain('./');
  });

  it('should track provider-field config refs and strip JSON-pointer fragments', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  $ref: file://schemas/providers.yaml#/providers
targets:
  $ref: file://schemas/targets.yaml#/targets
defaultTest:
  options:
    provider:
      $ref: file://schemas/grader.yaml#/grader
tests:
  - provider:
      $ref: file://schemas/inline.yaml#/provider
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('schemas/providers.yaml');
    expect(deps).toContain('schemas/targets.yaml');
    expect(deps).toContain('schemas/grader.yaml');
    expect(deps).toContain('schemas/inline.yaml');
    expect(deps).not.toContain('schemas/providers.yaml#/providers');
    expect(deps).not.toContain('schemas/inline.yaml#/provider');
    expect(deps).toContain('./');
  });

  it('should track config envPath files and executable test-module side inputs', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  envPath:
    - ' , '
    - .env.eval
    - 'config/runtime.env, config/local.env'
    - file://config/explicit.env
  grader: file://graders/config.py:grade
tests: file://tests/generate.js:generateTests
scenarios: file://scenarios/generate.py:generate_scenarios
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('.env.eval');
    expect(deps).toContain('config/runtime.env');
    expect(deps).toContain('config/local.env');
    expect(deps).toContain('config/explicit.env');
    expect(deps).toContain('graders/config.py');
    expect(deps).toContain('tests/generate.js');
    expect(deps).toContain('scenarios/generate.py');
    expect(deps).toContain('./');
  });

  it('should conservatively watch comma-separated env paths resolved from different runtime roots', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  envPath: 'env/one.env, env/two.env'
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toContain('evals/env/one.env');
    expect(deps).toContain('evals/env/two.env');
    expect(deps).toContain('./');
  });

  it('should preserve the static root of a zero-match provider glob in a config subdirectory', () => {
    mockFs.readFileSync.mockReturnValue('providers:\n  - file://*.yaml\n');
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['evals/', './']);
  });

  it('should conservatively watch map-style HTTP test and scenario providers', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - provider:
      'https://example.test/chat':
        config:
          tls:
            caPath: ./certs/test-ca.pem
scenarios:
  - provider:
      'https://example.test/scenario':
        config:
          tls:
            caPath: ./certs/scenario-ca.pem
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract runtime test and assertion transform, rubric, and scoring files without widening inline expressions', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  assertScoringFunction: file://scoring/default.py:score
  options:
    postprocess: file://transforms/default-post.py:post
    transformVars: file://transforms/default-vars.py:vars
    rubricPrompt: file://rubrics/default.txt
tests:
  - assertScoringFunction: file://scoring/test.js:score
    options:
      transform: file://transforms/test.py:transform
      transformVars: 'vars.input.toUpperCase()'
      rubricPrompt:
        - file://rubrics/one.txt
        - content: file://rubrics/two.txt
    assert:
      - type: context-faithfulness
        contextTransform: file://transforms/context.py:context
        transform: file://transforms/assert.py:transform
        rubricPrompt: file://rubrics/assert.txt
      - type: context-relevance
        contextTransform: 'output.context.join(" ")'
        transform: 'output.answer'
        rubricPrompt: 'Judge the answer clearly.'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'scoring/default.py',
      'transforms/default-post.py',
      'transforms/default-vars.py',
      'rubrics/default.txt',
      'scoring/test.js',
      'transforms/test.py',
      'rubrics/one.txt',
      'rubrics/two.txt',
      'transforms/context.py',
      'transforms/assert.py',
      'rubrics/assert.txt',
      './',
    ]);
    expect(deps).toContain('./');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract an inline test response-format schema file', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - options:
      response_format: file://schemas/math-response.json
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['schemas/math-response.json']);
  });

  it('should fail closed for HTTP graders and safely ignore malformed or cyclic grading metadata', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  options:
    rubricPrompt: &rubric
      - *rubric
      - file://rubrics/cyclic.txt
tests:
  - assert:
      - type: llm-rubric
        provider:
          first: openai:gpt-4
          second: anthropic:claude
      - type: llm-rubric
        provider:
          id: http
          config:
            auth:
              type: file
              path: ./auth/grader.ts
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['rubrics/cyclic.txt', './']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not watch unrelated files for an ordinary inline HTTP grading body', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: openai:gpt-4.1-mini
tests:
  - assert:
      - type: llm-rubric
        provider:
          id: https
          config:
            url: https://example.test/grade
            body:
              prompt: '{{ prompt }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should conservatively watch an inline HTTP grading body with a nested Nunjucks include', () => {
    mockFs.readFileSync.mockReturnValue(`
providers: openai:gpt-4.1-mini
tests:
  - assert:
      - type: llm-rubric
        provider:
          id: https
          config:
            url: https://example.test/grade
            headers:
              empty: null
              cyclic: &header
                self: *header
              x-template:
                - '{% include "partials/header.njk" %}'
            body:
              prompt: '{{ prompt }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should not enumerate binary grading metadata while preserving sibling dependencies', () => {
    const binary = Buffer.alloc(1024 * 1024, 7).toString('base64');
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
defaultTest:
  options:
    rubricPrompt: !!binary ${binary}
`);
    const startedAt = performance.now();

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract JavaScript and Python extension-hook files and ignore invalid entries', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/before.js:beforeAll
  - hooks/after.py:afterEach
  - null
  - ''
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/before.js', 'hooks/after.py', './']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract a scalar extension-hook file', () => {
    mockFs.readFileSync.mockReturnValue(
      'extensions: file://hooks/single.js:afterAll\n',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/single.js', './']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve glob-like extension-hook filenames as literal direct reads', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - 'file://hooks/{before,after}.js:run'
  - 'hooks/[literal].py:run'
`);
    mockGlob.hasMagic.mockImplementation((value: string) => /[[{]/.test(value));

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'hooks/{before,after}.js',
      'hooks/[literal].py',
      './',
    ]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should conservatively watch side inputs for extension, assertion, and filter hooks', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/before.js:run
tests:
  - assert:
      - type: javascript
        value: file://validators/check.js:validate
nunjucksFilters:
  custom: filters/custom.py
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('hooks/before.js');
    expect(deps).toContain('validators/check.js');
    expect(deps).toContain('filters/custom.py');
    expect(deps).toContain('./');
  });

  it.each([
    'auth/get-token.js:buildAuth',
    'auth/get-token.py:build_auth',
    'auth/get-token.rb:Build::auth',
  ])('should conservatively watch side inputs for an HTTP file-auth hook (%s)', (authPath) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
        path: ${authPath}
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
  });

  it('should safely ignore an HTTP file-auth hook without a path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      auth:
        type: file
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should keep inline prose with an embedded hostile file URL literal and bounded', () => {
    mockFs.readFileSync.mockReturnValue(
      "prompts: 'The example is file://assets/{1..1000000000}.txt'\n",
    );
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('glob parser should not inspect inline prose');
    });
    const startedAt = performance.now();

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('should reject an unclosed character class before glob parsing', () => {
    const invalid = `providers/[${'a'.repeat(32_000)}.py`;
    mockFs.readFileSync.mockReturnValue(
      `providers:\n  - 'file://${invalid}'\n`,
    );
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('glob parser should not inspect an unclosed class');
    });
    const startedAt = performance.now();

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring invalid config dependency glob; preserving other dependencies',
    );
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it.each([
    'file://prompts/[draft.txt',
    'file://prompts/{draft.txt',
  ])('should fail closed for a literal prompt filename with an unmatched delimiter (%s)', (prompt) => {
    mockFs.readFileSync.mockReturnValue(`prompts: '${prompt}'\n`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('glob parser should not inspect an unmatched delimiter');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
  });

  it('should sanitize an escaping CRLF dependency warning', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      secret:
        file: "../../outside\\r\\n::set-output name=owned::yes"
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('::set-output'),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('\r'),
    );
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('\n'),
    );
  });

  it('should extract nested assert-set validators and preserve siblings after a cyclic alias', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert: &root
      - type: assert-set
        assert:
          - type: javascript
            value: file://validators/nested.js:check
          - type: ruby
            value: file://validators/nested.rb:Checks::valid?
          - type: python
            value: file://validators/nested.py:check
          - type: assert-set
            assert: *root
      - type: contains
        value: file://expected/sibling.txt
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/nested.js',
      'validators/nested.rb',
      'validators/nested.py',
      'expected/sibling.txt',
      './',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should extract generated tests, scenarios, Nunjucks filters, and HTTP transform dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: http
    config:
      transformRequest: file://transforms/request.js:transform
      transformResponse: file://transforms/response.js:transform
      responseParser: file://transforms/parser.js:parse
      sessionParser: file://transforms/session.js:parse
      session:
        responseParser: file://transforms/session-response.js:parse
tests:
  path: file://tests/generate.py:generate
scenarios:
  - tests: file://scenarios/cases.yaml
    config:
      - vars:
          context: file://scenario-data/context.json
        assert:
          - type: javascript
            value: file://validators/scenario.js:check
  - tests:
      - path: file://scenarios/generate.py:generate
      - vars:
          extra: file://scenario-data/extra.json
        assert:
          - type: ruby
            value: file://validators/scenario.rb:Checks::valid?
nunjucksFilters:
  upper: filters/upper.js
  lower: file://filters/lower.js
  ignored: false
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'transforms/request.js',
      'transforms/response.js',
      'transforms/parser.js',
      'transforms/session.js',
      'transforms/session-response.js',
      'tests/generate.py',
      'scenarios/cases.yaml',
      './',
      'scenario-data/context.json',
      'validators/scenario.js',
      'scenarios/generate.py',
      'scenario-data/extra.json',
      'validators/scenario.rb',
      'filters/upper.js',
      'filters/lower.js',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'tests/cases.yaml',
    'data#cases.csv',
    'file://tests/cases.yaml',
    'file://tests/cases.yml',
    'file://tests/cases.json',
    'file://tests/cases.jsonl',
    'file://tests/*.{yaml,jsonl}',
    'file://tests/*.@(yaml|json)',
    'file://tests/cases.xlsx#Sheet1',
    'file://tests/cases.xls#2',
    'file://tests/cases.csv',
    'file://tests/*.@(csv|xlsx)#Sheet1',
  ])('should conservatively watch nested dependencies in an external structured test suite', (testsPath) => {
    mockFs.readFileSync.mockReturnValue(`tests: ${testsPath}\n`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('./');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should bound an adversarial spreadsheet-selector suffix before matching dependencies', () => {
    const selectorStorm = `${'.xls#'.repeat(16384)}\\nSENSITIVE-REVIEW-TOKEN`;
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
tests: "file://${selectorStorm}"
`);
    const startedAt = performance.now();

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('SENSITIVE-REVIEW-TOKEN'),
    );
  });

  it('should safely ignore a cyclic test-array alias while preserving sibling dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/safe.py
tests: &tests
  - *tests
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/safe.py', './']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize XLS and XLSX sheet selectors only in test and scenario paths', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - file://tests/cases.xlsx#Sheet2
  - path: file://tests/more.xls#2
  - vars:
      literal: file://data/literal.xlsx#Sheet2
scenarios:
  - tests: file://scenarios/cases.xlsx#Sheet1
  - tests:
      - path: file://scenarios/more.xls#3
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'tests/cases.xlsx',
      './',
      'tests/more.xls',
      'data/literal.xlsx#Sheet2',
      'scenarios/cases.xlsx',
      'scenarios/more.xls',
    ]);
    expect(core.warning).not.toHaveBeenCalled();
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

    expect(deps).toEqual([
      'providers/inherited.py',
      'prompts/inherited.txt',
      './',
    ]);
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

  it('should preserve nested dependencies after a cyclic structured-prompt alias', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('prompts/prompts.yaml')) {
        return `metadata: &metadata\n  self: *metadata\ncontent: file://shared/system.txt\n`;
      }
      return 'prompts: file://prompts/prompts.yaml\n';
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['prompts/prompts.yaml', 'shared/system.txt']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve nested dependencies after a cyclic structured-prompt array alias', () => {
    mockFs.readFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('prompts/prompts.yaml')) {
        return `metadata: &metadata\n  - *metadata\ncontent: file://shared/system.txt\n`;
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

    expect(deps).toEqual(['providers/provider.py', './']);
    expect(enumeratedBinary).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should not enumerate binary target metadata while extracting nested dependencies', () => {
    const binaryMetadata = Buffer.alloc(64 * 1024, 65).toString('base64');
    const objectValues = vi.spyOn(Object, 'values');
    mockFs.readFileSync.mockReturnValue(`
targets:
  - id: http
    config:
      metadata: !!binary ${binaryMetadata}
      auth:
        type: file
        path: ./auth/get-token.js
      request: file://fixtures/request.json
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');
    const enumeratedBinary = objectValues.mock.calls.some(([value]) =>
      ArrayBuffer.isView(value),
    );
    objectValues.mockRestore();

    expect(deps).toEqual(['fixtures/request.json', 'auth/get-token.js', './']);
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

    expect(deps).toEqual(['./']);
  });

  it('should handle non-Error file read failures gracefully', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw 'permission denied';
    });

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
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

    expect(deps).toEqual(['../config/providers/custom.py', './']);
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

    expect(deps).toEqual(['providers/custom.py', 'prompts/prompt.txt', './']);
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

    expect(deps).toEqual(['evals/..fixtures/custom.py', './']);
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

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
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

    expect(deps).toHaveLength(9);
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

    expect(deps).toEqual(['../config/provider.py', '../config', './']);
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
      (filePath: unknown) =>
        ({
          isDirectory: () =>
            !String(filePath).endsWith('/promptfooconfig.yaml'),
          isFile: () => String(filePath).endsWith('/promptfooconfig.yaml'),
          size: 0,
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
