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
    statSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
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
    statSync: Mock;
    lstatSync: Mock;
    realpathSync: Mock;
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
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    mockFs.realpathSync.mockImplementation((value: string) => value);
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

  it('should extract HTTP validateStatus file dependencies and named exports', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/default.js
  - id: http://example.test
    config:
      validateStatus: file://validators/team:blue/status.mts:validateStatus
  - id: openai:gpt-4
    config:
      validateStatus: file://validators/ignored.js
  - id: https
    config:
      validateStatus: status >= 200 && status < 300
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/default.js',
      'validators/team:blue/status.mts',
    ]);
  });

  it('should extract HTTP validateStatus dependencies from provider maps and targets', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - 'https://provider.example.test':
      config:
        validateStatus: file://validators/provider-map.mjs:validateStatus
  - 'openai:gpt-4':
      config:
        validateStatus: file://validators/ignored.js
targets:
  - id: http
    config:
      validateStatus: file://validators/target.cts:check
  - 'https://target.example.test':
      id: friendly-target-label
      config:
        validateStatus: file://validators/target-map.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/provider-map.mjs',
      'validators/target.cts',
      'validators/target-map.js',
    ]);
  });

  it('should ignore malformed provider map entries', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - null
  - 42
  - {}
  - 'https://null.example.test': null
  - 'https://scalar.example.test': inline
  - 'https://first.example.test':
      config:
        validateStatus: file://validators/ignored-first.js
    'https://second.example.test':
      config:
        validateStatus: file://validators/ignored-second.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should extract scalar provider and target file dependencies', () => {
    mockFs.readFileSync.mockReturnValue('providers: file://providers.yaml');
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['providers.yaml']);

    mockFs.readFileSync.mockReturnValue('targets: file://targets.yaml');
    expect(
      extractFileDependencies('/test/working/promptfooconfig.yaml'),
    ).toEqual(['targets.yaml']);
  });

  it('should extract executable provider and target selector dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/python.py:call_api
  - id: file://providers/go.go:CallApi
  - 'file://providers/ruby.rb:call_api':
      config:
        temperature: 0
  - file://providers/uppercase.RB:call_api
targets:
  - id: file://targets/python.py:call_api
  - 'file://targets/go.go:CallApi':
      id: friendly-go-target
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/python.py',
      'providers/go.go',
      'providers/ruby.rb',
      'providers/uppercase.RB:call_api',
      'targets/python.py',
      'targets/go.go',
    ]);
  });

  it('should extract prefixed executable provider and target selector dependencies', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - python:providers/python.py:call_api
  - id: golang:providers/go.go:CallApi
  - 'ruby:providers/ruby.rb:call_api':
      config:
        temperature: 0
  - python:providers/uppercase.PY:call_api
  - go:providers/not-supported.go:CallApi
targets:
  - id: python:targets/python.py:call_api
  - 'golang:targets/go.go:CallApi':
      id: friendly-go-target
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'providers/python.py',
      'providers/go.go',
      'providers/ruby.rb',
      'providers/uppercase.PY:call_api',
      'targets/python.py',
      'targets/go.go',
    ]);
  });

  it('should preserve newlines in prefixed executable provider paths', () => {
    mockFs.readFileSync.mockReturnValue(
      'providers:\n  - "python:providers/team\\nblue.py:call_api"',
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/team\nblue.py']);
  });

  it('should preserve uppercase HTTP validateStatus selector paths like the pinned runtime', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - id: https
    config:
      validateStatus: file://validators/status.MTS:validateStatus
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/status.MTS',
      'validators/status.MTS:validateStatus',
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

  it('should preserve literal variable selectors and extract executable assertion selectors', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  vars:
    defaultRuby: file://vars/default.rb:build
  assert:
    - type: javascript
      value: file://validators/default.cts:check
tests:
  - vars:
      ruby: file://vars/build.rb:build
      go: file://vars/build.go:Build
      javascript: file://vars/build.mts:build
      python: file://vars/build.py:build
      uppercase: file://vars/build.RB:build
      literal: file://vars/literal.txt:value
    assert:
      - type: javascript
        value: file://validators/check.go:Check
      - type: javascript
        value: file://validators/check.rb:Validators::Format.check
      - type: javascript
        value: file://validators/check.mjs:check
      - type: python
        value: file://validators/check.py:check
      - type: javascript
        value: file://validators/check.GO:Check
      - type: javascript
        value: file://validators/check.MTS:check
      - type: python
        value: file://validators/check.PY:check
      - type: ruby
        value: file://validators/check.RB:Validators::Format.check
      - type: contains
        value: file://validators/literal.txt:value
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'vars/default.rb:build',
      'validators/default.cts',
      'vars/build.rb:build',
      'vars/build.go:Build',
      'vars/build.mts:build',
      'vars/build.py:build',
      'vars/build.RB:build',
      'vars/literal.txt:value',
      'validators/check.go:Check',
      'validators/check.rb',
      'validators/check.mjs',
      'validators/check.py',
      'validators/check.GO:Check',
      'validators/check.MTS',
      'validators/check.MTS:check',
      'validators/check.PY:check',
      'validators/check.RB:Validators::Format.check',
      'validators/literal.txt:value',
    ]);
  });

  it('should extract executable selectors from nested assertion sets', () => {
    mockFs.readFileSync.mockReturnValue(`
defaultTest:
  assert:
    - type: assert-set
      assert:
        - type: javascript
          value: file://validators/default.js:check
tests:
  - assert:
      - type: assert-set
        assert:
          - type: ruby
            value: file://validators/nested.rb:Validators::Format.check
          - type: assert-set
            assert:
              - type: python
                value: file://validators/deep.py:check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'validators/default.js',
      'validators/nested.rb',
      'validators/deep.py',
    ]);
  });

  it('should ignore malformed nested assertion entries', () => {
    mockFs.readFileSync.mockReturnValue(`
tests:
  - assert:
      - null
      - 42
      - type: assert-set
        assert: inline
      - type: assert-set
        assert:
          - type: javascript
            value: file://validators/safe.js:check
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['validators/safe.js']);
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

  it('should extract extension hook files', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/setup.js:beforeAll
  - file://hooks/case.py:beforeEach
  - file://hooks/result.js:afterEach
  - file://hooks/report.py:afterAll
  - file://hooks/setup.js:beforeAll
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([
      '../config/hooks/setup.js',
      '../config/hooks/case.py',
      '../config/hooks/result.js',
      '../config/hooks/report.py',
    ]);
  });

  it('should preserve uppercase extension hook selector paths like the pinned runtime', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/setup.MTS:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/setup.MTS', 'hooks/setup.MTS:beforeAll']);
  });

  it('should extract extension hooks from commandLineOptions', () => {
    mockFs.readFileSync.mockReturnValue(`
commandLineOptions:
  extension:
    - file://hooks/policy.js:beforeAll
    - file://hooks/result.py:afterEach
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/policy.js', 'hooks/result.py']);
  });

  it('should preserve sibling dependencies when an extension glob is too long', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockFs.lstatSync.mockImplementation((value: string) => {
      throw Object.assign(new Error('stat failed'), {
        code: value.length > 65_536 ? 'ENAMETOOLONG' : 'ENOENT',
      });
    });
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
extensions:
  - file://${'a'.repeat(65_536)}*
  - file://hooks/valid.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/custom.py');
    expect(deps).toContain('hooks/valid.js');
    expect(deps).toContain('./');
    expect(deps).toHaveLength(3);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve sibling dependencies when a resolved file glob is too long', async () => {
    const realGlob = await vi.importActual<typeof import('glob')>('glob');
    mockGlob.hasMagic.mockImplementation(realGlob.hasMagic);
    mockGlob.sync.mockImplementation((pattern: string) =>
      realGlob.sync(pattern, { nodir: true }),
    );
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.py
  - file://${'a'.repeat(65_525)}*
extensions:
  - file://hooks/valid.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toContain('providers/custom.py');
    expect(deps).toContain('hooks/valid.js');
    expect(deps).toContain('./');
    expect(deps).toHaveLength(3);
    expect(mockGlob.sync).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should extract absolute extension hooks and preserve path colons', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/setup.js:beforeAll
  - file:///test/working/hooks/team:blue/result.py:afterEach
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/setup.js', 'hooks/team:blue/result.py']);
  });

  it('should extract default-export extensions without a hook suffix', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/default.js
  - file:///test/working/hooks/absolute-default.js
  - "file://hooks/trailing-default.js:"
commandLineOptions:
  extension:
    - file://hooks/cli-default.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'hooks/default.js',
      'hooks/absolute-default.js',
      'hooks/trailing-default.js',
      'hooks/cli-default.js',
    ]);
  });

  it('should preserve colons in default-export extension paths', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/team:blue/result.js
  - file://hooks/result:blue.js
  - file://hooks/team:green/result.py
  - file://hooks/result:green.py
commandLineOptions:
  extension:
    - file://hooks/cli:blue/result.mjs
    - file://hooks/cli-result:green.py
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([
      'hooks/team:blue/result.js',
      'hooks/result:blue.js',
      'hooks/team:green/result.py',
      'hooks/result:green.py',
      'hooks/cli:blue/result.mjs',
      'hooks/cli-result:green.py',
    ]);
  });

  it('should conservatively watch the workspace for executable config files', () => {
    mockFs.readFileSync.mockReturnValue(
      "module.exports = { extensions: ['file://hooks/policy.js:beforeAll'] };",
    );

    const deps = extractFileDependencies('/test/working/promptfooconfig.cjs');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for referenced extension lists', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  $ref: '#/shared/extensions'
commandLineOptions:
  extension:
    $ref: '#/shared/cliExtensions'
shared:
  extensions:
    - file://hooks/shared.js:beforeAll
  cliExtensions:
    - file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for env-templated extensions', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - file://{{ env.HOOK_PATH }}:beforeAll
commandLineOptions:
  extension:
    - file://{{ env.CLI_HOOK_PATH }}:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for fully templated extension URLs', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - '{{ env.HOOK_URI }}'
  - '{{ env.SCHEME }}://hooks/policy.js:beforeAll'
commandLineOptions:
  extension:
    - '{{ env.CLI_HOOK_URI }}'
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should watch the repository workspace for unresolved extensions in an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://{{ env.HOOK_PATH }}:beforeAll
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve checkout extension hooks from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/policy.js:beforeAll
`);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/policy.js']);
  });

  it('should preserve checkout extension glob matches from an external config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/hooks/policy.js']);

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/policy.js');
    expect(deps).toContain('hooks/');
  });

  it('should preserve an extension glob base when the last hook is deleted', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/']);
  });

  it('should preserve a filesystem-root glob base as a directory', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([]);

    const deps = extractFileDependencies('/promptfooconfig.yaml');

    expect(deps).toEqual(['../../']);
  });

  it('should conservatively watch the workspace for referenced commandLineOptions', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
commandLineOptions:
  $ref: '#/shared/options'
shared:
  options:
    extension:
      - file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should preserve dependencies when commandLineOptions is a scalar', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
commandLineOptions: inline-options
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js']);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should ignore a scalar config without throwing during extension extraction', () => {
    mockFs.readFileSync.mockReturnValue('inline-config');

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('should conservatively watch the workspace for a referenced root config', () => {
    mockFs.readFileSync.mockReturnValue(`
$ref: '#/shared/config'
shared:
  config:
    extensions:
      - file://hooks/shared.js:beforeAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should conservatively watch the workspace for referenced extension entries', () => {
    mockFs.readFileSync.mockReturnValue(`
providers:
  - file://providers/custom.js
extensions:
  - $ref: '#/shared/extension'
commandLineOptions:
  extension:
    - $ref: '#/shared/cliExtension'
shared:
  extension: file://hooks/shared.js:beforeAll
  cliExtension: file://hooks/cli-shared.js:afterAll
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['providers/custom.js', './']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
  });

  it('should ignore remote and malformed extension entries', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - https://example.com/hook.js:beforeAll
  - inline-extension
  - 42
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
  });

  it('should reject extension hook files outside the repository', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://../secrets/hook.js:beforeAll
  - file:///test/secrets/hook.js:beforeAll
  - file://C:/secrets/hook.js
`);

    const deps = extractFileDependencies('/test/config/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'must stay within the checkout or config directory',
      ),
    );
  });

  it('should preserve canonical Windows file URLs without a hook suffix during containment checks', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///C:/repo/hooks/default.js
commandLineOptions:
  extension:
    - file:///C:/repo/hooks/cli-default.js
`);

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('C:/repo/hooks/default.js'),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('C:/repo/hooks/cli-default.js'),
    );
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

  it('should fail closed when dependency extraction throws after parsing a config', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/policy.js:beforeAll
`);
    mockGlob.hasMagic.mockImplementation(() => {
      throw new Error('glob failed\n::error::forged-extractor');
    });

    const deps = extractFileDependencies('/test/working/promptfooconfig.yaml');

    expect(deps).toEqual(['./']);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Watching the repository workspace'),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-extractor');
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

    expect(deps).toEqual(['../config/providers/custom.py']);
  });

  it('should ignore checkout glob symlinks that resolve outside both dependency roots', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/hooks/safe.js',
      '/test/working/hooks/escaped.js',
    ]);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.endsWith('/escaped.js') ? '/test/outside/secret.js' : value,
    );

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).toContain('hooks/');
    expect(deps).not.toContain('hooks/escaped.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within an allowed dependency root'),
    );
  });

  it('should preserve safe glob siblings when realpath is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue([
      '/test/working/hooks/safe.js',
      '/test/working/hooks/denied.js',
    ]);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw new Error('EACCES: denied\n::error::forged-annotation');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).toContain('hooks/');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve a config dependency glob match',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-annotation');
  });

  it('should ignore dependencies from an in-checkout config root that resolves outside the checkout', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/shared-link/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.startsWith('/test/working/shared-link')
        ? value.replace('/test/working/shared-link', '/test/shared-real')
        : value,
    );

    const deps = extractFileDependencies(
      '/test/working/shared-link/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Ignoring an in-checkout config directory that resolves outside the checkout.',
    );
  });

  it('should fail closed with a constant warning when an in-checkout config root cannot be resolved', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file://hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/shared-link/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value === '/test/working/shared-link') {
        throw new Error('EACCES: denied\n::error::forged-config-root');
      }
      return value;
    });

    const deps = extractFileDependencies(
      '/test/working/shared-link/promptfooconfig.yaml',
    );

    expect(deps).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      'Unable to resolve an in-checkout config directory. Ignoring its dependencies.',
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-config-root');
  });

  it('should preserve checkout glob matches when an unused external root is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/*.js
`);
    mockGlob.hasMagic.mockImplementation((value: string) =>
      value.includes('*'),
    );
    mockGlob.sync.mockReturnValue(['/test/working/hooks/safe.js']);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value === '/test/shared') {
        throw new Error('EACCES: denied\n::error::forged-root');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).toContain('hooks/');
    expect(mockFs.realpathSync).toHaveBeenCalledWith('/test/shared');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unable to resolve an allowed dependency root'),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-root');
  });

  it('should ignore direct checkout extension symlinks that resolve outside both dependency roots', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/escaped.js:beforeAll
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((value: string) =>
      value.endsWith('/escaped.js') ? '/test/outside/secret.js' : value,
    );

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).not.toContain('hooks/escaped.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('must stay within an allowed dependency root'),
    );
  });

  it('should preserve safe direct extension siblings when realpath is denied', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/denied.js:beforeAll
`);
    mockFs.lstatSync.mockReturnValue({} as fs.Stats);
    mockFs.realpathSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw new Error('EACCES: denied\n::error::forged-direct');
      }
      return value;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve an existing config dependency',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-direct');
  });

  it('should not treat an inaccessible direct dependency as nonexistent', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/safe.js:beforeAll
  - file:///test/working/hooks/denied.js:beforeAll
`);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.lstatSync.mockImplementation((value: string) => {
      if (value.endsWith('/denied.js')) {
        throw Object.assign(
          new Error('EACCES: denied\n::error::forged-lstat'),
          { code: 'EACCES' },
        );
      }
      return {} as fs.Stats;
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toContain('hooks/safe.js');
    expect(deps).not.toContain('hooks/denied.js');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unable to resolve an existing config dependency',
      ),
    );
    expect(
      (core.warning as unknown as Mock).mock.calls
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('::error::forged-lstat');
  });

  it('should preserve a direct dependency whose parent is not yet a directory', () => {
    mockFs.readFileSync.mockReturnValue(`
extensions:
  - file:///test/working/hooks/future.js:beforeAll
`);
    mockFs.lstatSync.mockImplementation(() => {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    });

    const deps = extractFileDependencies('/test/shared/promptfooconfig.yaml');

    expect(deps).toEqual(['hooks/future.js']);
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

    expect(deps).toEqual(['../config/provider.py']);
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
