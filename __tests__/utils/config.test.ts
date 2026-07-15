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
    lstatSync: vi.fn(),
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
    lstatSync: Mock;
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
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath),
    );
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
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

  it('should extract HTTP validateStatus files and strip JavaScript export suffixes', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/default.js
      transformRequest: file://transforms/request.js:request
      transformResponse: file://transforms/response.cjs:response
  - id: http://example.test/api
    config:
      validateStatus: file://validators/named.ts:validateStatus
  - id: https://example.test/literal
    config:
      validateStatus: file://validators/literal.JS:acceptStatus
      transformResponse: 'file://transforms/empty.js:'
  - id: openai:gpt-4
    config:
      validateStatus: file://validators/not-http.js
targets:
  - id: http
    config:
      validateStatus: file://validators/target.mjs:acceptStatus
      responseParser: file://transforms/parser.mts:parse
      sessionParser: file://transforms/session.cts:session
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/validators/default.js',
      '../config/transforms/request.js',
      '../config/transforms/response.cjs',
      '../config/validators/named.ts',
      '../config/validators/literal.JS:acceptStatus',
      '../config/validators/literal.JS',
      '../config/transforms/empty.js:',
      '../config/validators/target.mjs',
      '../config/transforms/parser.mts',
      '../config/transforms/session.cts',
    ]);
  });

  it('should track provider script selectors and both uppercase JavaScript interpretations', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/python.py:call_api
  - id: file://providers/golang.go:CallApi
  - file://providers/ruby.rb:Namespace::call_api
  - file://providers/upper.JS:callApi
targets:
  - id: file://providers/target.mts:callApi
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/providers/python.py',
      '../config/providers/golang.go',
      '../config/providers/ruby.rb:Namespace::call_api',
      '../config/providers/upper.JS:callApi',
      '../config/providers/upper.JS',
      '../config/providers/target.mts',
    ]);
  });

  it('should extract HTTP file dependencies from provider and target map forms', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'https://example.test/api':
      config:
        validateStatus: file://validators/mapped.js:acceptStatus
        transformRequest: file://transforms/mapped.ts:request
targets:
  - http:
      config:
        transformResponse: file://transforms/target.cjs:response
        sessionParser: file://transforms/session.mjs:parse
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/validators/mapped.js',
      '../config/transforms/mapped.ts',
      '../config/transforms/target.cjs',
      '../config/transforms/session.mjs',
    ]);
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

  it('should preserve literal var globs and normalize only supported assertion selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - vars:
      ruby: file://vars/build.rb:func
      go: file://vars/build.go:Func
      literal: file://vars/literal.RB:Build
    assert:
      - type: javascript
        value: file://validators/check.go:Check
      - type: ruby
        value: file://validators/check.rb:Namespace::Check
      - type: javascript
        value: file://validators/upper.JS:Check
      - type: javascript
        value: 'file://validators/empty.py:'
defaultTest:
  vars:
    typescript: file://vars/default.mts:build
  assert:
    - type: javascript
      value: file://validators/default.cts:check
`);

    expect(
      extractFileDependencies('/test/config/promptfooconfig.yaml'),
    ).toEqual([
      '../config/vars/default.mts:build',
      '../config/validators/default.cts',
      '../config/vars/build.rb:func',
      '../config/vars/build.go:Func',
      '../config/vars/literal.RB:Build',
      '../config/validators/check.go:Check',
      '../config/validators/check.rb',
      '../config/validators/upper.JS:Check',
      '../config/validators/upper.JS',
      '../config/validators/empty.py',
    ]);
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

  it('should sanitize CRLF in an unsafe dependency warning', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://../../secrets/policy\\n::error::forged.py"
`);

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('policy\\n::error::forged.py'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should sanitize CRLF from a rendered dependency-glob error', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - "file://providers/{{env.NAME}}/*.py"
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw new Error('permission denied\n::error::forged');
    });

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('permission denied\\n::error::forged'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
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

  it('should preserve absolute checkout dependencies from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/shared.py
prompts:
  - file: /test/working/prompts/shared.txt
tests:
  - vars:
      context:
        file: /test/working/data/context.json
    assert:
      - type: javascript
        value:
          file: /test/working/hooks/validator.js
`);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/shared.py',
      'prompts/shared.txt',
      'data/context.json',
      'hooks/validator.js',
    ]);
  });

  it('should preserve absolute checkout dependency glob matches from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/shared.py']);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
  });

  it('should conservatively watch the checkout for an oversized dependency glob', () => {
    const pattern = `providers/${'x'.repeat(65536)}*.py`;
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://${pattern}`);
    mockGlob.hasMagic.mockImplementation((value: string) => {
      if (value.length > 65536) {
        throw new TypeError('pattern is too long');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('oversized config dependency glob'),
    );
  });

  it('should conservatively watch the checkout when the config-directory prefix makes a dependency glob oversized', () => {
    const pattern = `${'x'.repeat(65520)}*.py`;
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://${pattern}`);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('oversized config dependency glob'),
    );
  });

  it('should conservatively watch the checkout for excessive dependency brace expansion', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/{1..2000}/*.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('too many brace alternatives'),
    );
  });

  it.each([
    '*.json',
    '**/*.json',
    '{one,two}/*.json',
  ])('should watch the config root when the last %s dependency is deleted', (pattern) => {
    mockFs.readFileSync.mockReturnValue(`providers:\n  - file://${pattern}`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );
    mockGlob.sync.mockReturnValue([]);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
  });

  it('should conservatively watch the checkout when dependency glob parsing throws', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/[broken/*.py
`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new TypeError('pattern is too long\n::error::forged');
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should not expand a dependency glob whose brace alternatives all escape the allowed roots', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://{../../secrets,../../outside}/*.py
`);
    mockGlob.hasMagic.mockImplementation(
      (value: string) => value.includes('*') || value.includes('{'),
    );

    const deps = extractFileDependencies(
      '/test/working/evals/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('unsafe config dependency glob alternative'),
    );
  });

  it('should conservatively watch the checkout when dependency-glob base parsing throws', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    let calls = 0;
    mockGlob.hasMagic.mockImplementation((value: string) => {
      calls++;
      if (calls > 1) {
        throw new TypeError('invalid base\n::error::forged');
      }
      return value.includes('*');
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('invalid base\\n::error::forged'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should conservatively watch the checkout when dependency glob expansion throws', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockImplementation(() => {
      throw Object.assign(new Error('permission denied\n::error::forged'), {
        code: 'EACCES',
      });
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should reject an existing direct dependency symlink outside both allowed roots', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/leak.py
  - file:///test/working/providers/shared.py
`);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('/providers/leak.py')
        ? '/test/secrets/leak.py'
        : String(filePath),
    );

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path must stay within'),
    );
  });

  it('should reject an existing dangling direct dependency symlink', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/dangling.py
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/dangling.py')) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return String(filePath);
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('cannot be verified'),
    );
  });

  it('should fail closed when an in-checkout config root resolves outside the workspace', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/direct.py
  - file://providers/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/shared-link/providers/glob.js',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).startsWith('/test/working/shared-link')
        ? String(filePath).replace('/test/working/shared-link', '/test/shared')
        : String(filePath),
    );

    expect(
      extractFileDependencies('/test/working/shared-link/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config path: resolved config directory must stay within the repository workspace',
    );
  });

  it('should fail closed when an in-checkout config root cannot be verified', () => {
    mockFs.realpathSync.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config path: resolved config directory cannot be verified',
    );
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject an inaccessible direct dependency before realpath resolution', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/denied.py
`);
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(
      extractFileDependencies('/test/shared/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('resolved path cannot be verified'),
    );
  });

  it('should reject a foreign Windows-absolute dependency path', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'file://C:/outside/provider.py'
`);

    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within the repository workspace'),
    );
  });

  it.each([
    'ENOENT',
    'ENOTDIR',
  ])('should preserve a missing direct dependency when realpath reports %s', (code) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/missing.py
`);
    mockFs.lstatSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/missing.py')) {
        throw Object.assign(new Error('not found'), { code });
      }
      return {} as fs.Stats;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/missing.py']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    'parse',
    'expand',
    'base',
  ])('should sanitize a non-Error dependency-glob %s failure', (stage) => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/*.py
`);
    let hasMagicCalls = 0;
    mockGlob.hasMagic.mockImplementation((value: string) => {
      hasMagicCalls++;
      if (stage === 'parse' || (stage === 'base' && hasMagicCalls > 1)) {
        throw 'permission denied\n::error::forged';
      }
      return value.includes('*');
    });
    if (stage === 'expand') {
      mockGlob.sync.mockImplementation(() => {
        throw 'permission denied\n::error::forged';
      });
    }

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('permission denied\\n::error::forged'),
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should reject an external-config glob match that resolves outside both allowed roots', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/leak.py',
      '/test/working/providers/shared.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('/providers/leak.py')
        ? '/test/secrets/leak.py'
        : String(filePath),
    );

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
    );
  });

  it('should ignore an unverifiable dependency glob match and preserve safe siblings', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/denied.py',
      '/test/working/providers/shared.py',
    ]);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith('/providers/denied.py')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
    );
  });

  it('should reject a CRLF dependency glob match and preserve safe siblings', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/providers/policy\n::error::forged.py',
      '/test/working/providers/shared.py',
    ]);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring unsafe config dependency glob match: resolved path contains an invalid line break',
    );
    expect(
      (core.warning as Mock).mock.calls.every(
        ([message]) => !/[\r\n]/.test(String(message)),
      ),
    ).toBe(true);
  });

  it('should preserve a checkout glob match when the unused external-config root is unverifiable', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/shared.py']);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === '/test/shared') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return String(filePath);
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should preserve a checkout glob match when allowed roots are symlinked', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file:///test/working/providers/*.py
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/providers/shared.py']);
    mockFs.realpathSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value.startsWith('/test/working')) {
        return value.replace('/test/working', '/real/workspace');
      }
      if (value === '/test/shared') {
        return '/real/shared';
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/shared.py', 'providers']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should normalize a direct repository-root directory dependency to the workspace sentinel', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://.
`);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
  });

  it('should conservatively watch the workspace after an unexpected post-parse extraction failure', () => {
    mockFs.readFileSync.mockReturnValue('providers: {}');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extract dependencies from config'),
    );
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

    expect(deps).toEqual(['../config/providers/custom.py', '../config']);
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
