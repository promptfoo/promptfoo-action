import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;
const MAX_BRACE_EXPANSIONS = 1024;
const HTTP_FILE_CONFIG_KEYS = [
  'validateStatus',
  'transformRequest',
  'transformResponse',
  'responseParser',
  'sessionParser',
] as const;
const HTTP_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts)$/;
const PROVIDER_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts|py|go|rb)$/;
const ASSERT_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts|py|rb)$/;
const TEST_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts|py)$/;
const CASE_INSENSITIVE_JS_SELECTOR = /\.(?:[cm]?js|[cm]?ts)$/i;

interface ConfigAssertion {
  type?: string;
  value?: string | { file?: string };
  assert?: ConfigAssertion[];
}

type ConfigProvider = string | { id?: string; [key: string]: unknown };
type ConfigPrompt = string | { file?: string; [key: string]: unknown };

interface ConfigTestCase {
  vars?: { [key: string]: string | { file?: string } };
  assert?: ConfigAssertion[];
  provider?: ConfigProvider;
  path?: string;
  [key: string]: unknown;
}

interface ConfigScenario {
  config?: ConfigTestCase[];
  tests?: string | ConfigTestCase | Array<string | ConfigTestCase>;
}

export interface PromptfooConfig {
  providers?: ConfigProvider | ConfigProvider[];
  targets?: ConfigProvider | ConfigProvider[];
  prompts?: ConfigPrompt | ConfigPrompt[] | Record<string, string>;
  tests?: string | ConfigTestCase | Array<string | ConfigTestCase>;
  defaultTest?: string | ConfigTestCase;
  scenarios?: Array<string | ConfigScenario>;
  nunjucksFilters?: Record<string, string>;
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function sanitizeLogText(value: string): string {
  return value
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function hasMismatchedGlobDelimiters(pattern: string): boolean {
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let inCharacterClass = false;
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === '{') {
      braceDepth++;
      continue;
    }
    if (character === '}' && braceDepth > 0) {
      if (parenthesisDepth > 0) return true;
      braceDepth--;
      continue;
    }
    if (braceDepth === 0) continue;
    if (character === '(') {
      parenthesisDepth++;
    } else if (character === ')') {
      if (parenthesisDepth === 0) return true;
      parenthesisDepth--;
    } else if (character === ']') {
      return true;
    }
  }
  return braceDepth > 0 || parenthesisDepth > 0 || inCharacterClass;
}

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(configPath: string): string[] {
  const dependencies = new Set<string>();
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  const isSafeDependency = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);

  if (isPathInside(cwd, configDir)) {
    try {
      const realWorkspace = fs.realpathSync(cwd);
      const realConfigDir = fs.realpathSync(configDir);
      if (!isPathInside(realWorkspace, realConfigDir)) {
        core.warning(
          'Ignoring unsafe config path: resolved config directory must stay within the repository workspace',
        );
        return ['./'];
      }
    } catch {
      core.warning(
        'Ignoring unsafe config path: resolved config directory cannot be verified',
      );
      return ['./'];
    }
  }

  const getRealDependencyRoots = (): string[] => {
    const roots: string[] = [];
    for (const root of new Set([dependencyRoot, cwd])) {
      try {
        roots.push(fs.realpathSync(root));
      } catch {}
    }
    return roots;
  };
  const watchWorkspace = (): void => {
    dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
  };
  let configParsed = false;

  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    if (!configContent.trim()) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const config = loadYaml(configContent, {
      schema: CORE_SCHEMA.withTags(mergeTag),
    }) as PromptfooConfig;

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }
    configParsed = true;

    const resolveConfigDependency = (
      filePath: string,
      source: string,
    ): string | undefined => {
      try {
        if (!filePath) {
          throw new Error(`${source} is empty`);
        }
        if (filePath.includes('\0')) {
          throw new Error(`${source} contains an invalid null byte`);
        }
        if (/[\r\n]/.test(filePath)) {
          throw new Error(`${source} contains an invalid line break`);
        }

        if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependency(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        if (absolutePath.length > MAX_GLOB_PATTERN_LENGTH) {
          return absolutePath;
        }

        try {
          fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return absolutePath;
          }
          throw new Error(`${source} resolved path cannot be verified`);
        }

        try {
          const realPath = fs.realpathSync(absolutePath);
          const realRoots = getRealDependencyRoots();
          if (!realRoots.some((root) => isPathInside(root, realPath))) {
            throw new Error(
              `${source} resolved path must stay within the repository workspace`,
            );
          }
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message.includes('must stay within')
              ? error.message
              : `${source} resolved path cannot be verified`,
          );
        }

        return absolutePath;
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency "${sanitizeLogText(filePath)}": ${sanitizeLogText(
            String(error).replace(/^(?:[A-Za-z]+)?Error: /, ''),
          )}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrl.replace('file://', '');
      if (filePath.length > MAX_GLOB_PATTERN_LENGTH) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      if (filePath.includes('{') && hasMismatchedGlobDelimiters(filePath)) {
        watchWorkspace();
        core.warning(
          'Skipping a malformed config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      if (absolutePath.length > MAX_GLOB_PATTERN_LENGTH) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      const globOptions = {
        magicalBraces: true,
        braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
      };
      let isGlob: boolean;
      let expandedPaths: string[];
      try {
        isGlob = glob.hasMagic(filePath, globOptions);
        expandedPaths = isGlob
          ? braceExpand(filePath, globOptions)
          : [filePath];
      } catch (error) {
        watchWorkspace();
        core.warning(
          `Failed to parse config dependency glob: ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
          )}; conservatively watching the repository workspace`,
        );
        return;
      }

      if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
        watchWorkspace();
        core.warning(
          'Skipping config dependency glob with too many brace alternatives; conservatively watching the repository workspace',
        );
        return;
      }

      // Check if the path contains glob patterns
      if (isGlob) {
        // It's a glob pattern, expand it
        const safePatterns = expandedPaths
          .map((expandedPath) => path.resolve(configDir, expandedPath))
          .filter(isSafeDependency);
        if (safePatterns.length < expandedPaths.length) {
          core.warning(
            'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
          );
        }
        if (safePatterns.length === 0) {
          return;
        }

        let matches: string[];
        try {
          matches = glob.sync(safePatterns, {
            nodir: true,
            ...globOptions,
            braceExpandMax: MAX_BRACE_EXPANSIONS,
          });
        } catch (error) {
          watchWorkspace();
          core.warning(
            `Failed to expand config dependency glob: ${sanitizeLogText(
              error instanceof Error ? error.message : String(error),
            )}; conservatively watching the repository workspace`,
          );
          return;
        }
        const realDependencyRoots = getRealDependencyRoots();

        for (const match of matches) {
          if (/[\r\n]/.test(match)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path contains an invalid line break',
            );
            continue;
          }

          const absoluteMatch = path.resolve(match);
          if (!isSafeDependency(absoluteMatch)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
            continue;
          }

          try {
            const realMatch = fs.realpathSync(absoluteMatch);
            if (
              !realDependencyRoots.some((root) => isPathInside(root, realMatch))
            ) {
              core.warning(
                'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
              );
              continue;
            }

            dependencies.add(absoluteMatch);
          } catch {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const filePathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(filePathRoot.length).split(/[\\/]/);
        let basePath = filePathRoot;
        for (const part of pathParts) {
          let partHasMagic: boolean;
          try {
            partHasMagic = glob.hasMagic(part, globOptions);
          } catch (error) {
            watchWorkspace();
            core.warning(
              `Failed to parse config dependency glob base: ${sanitizeLogText(
                error instanceof Error ? error.message : String(error),
              )}; conservatively watching the repository workspace`,
            );
            return;
          }
          if (partHasMagic) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        dependencies.add(path.resolve(configDir, basePath || '.'));
      } else if (isDirectory(absolutePath)) {
        // It's a directory, preserve trailing slash if it was there
        const directoryPath = fileUrl.endsWith('/')
          ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
          : absolutePath;
        dependencies.add(directoryPath);
      } else {
        // It's a regular file path
        dependencies.add(absolutePath);
      }
    };

    const processFileSelector = (
      fileUrl: string,
      extension: RegExp,
      options: { firstColon?: boolean; requireExport?: boolean } = {},
    ): void => {
      const rawFilename = fileUrl.slice('file://'.length);
      const colon = options.firstColon
        ? rawFilename.indexOf(':')
        : rawFilename.lastIndexOf(':');
      const candidateFilename = rawFilename.slice(0, colon);
      const candidateExport = rawFilename.slice(colon + 1);
      if (colon === -1 || (options.requireExport && !candidateExport)) {
        processFileUrl(fileUrl);
        return;
      }
      const normalized = `file://${candidateFilename}`;
      if (extension.test(candidateFilename)) {
        processFileUrl(normalized);
        return;
      }
      if (CASE_INSENSITIVE_JS_SELECTOR.test(candidateFilename)) {
        processFileUrl(fileUrl);
        processFileUrl(normalized);
        return;
      }
      processFileUrl(fileUrl);
    };

    // Extract provider files
    const providers = [config.providers, config.targets].flatMap((value) =>
      Array.isArray(value) ? value : value ? [value] : [],
    );
    const processProviderId = (providerId: string): boolean => {
      if (providerId.startsWith('file://')) {
        processFileSelector(providerId, PROVIDER_FILE_SELECTOR);
        return true;
      }
      const scriptProvider = /^(?:python|golang|ruby):(.+)$/.exec(providerId);
      if (!scriptProvider) return false;
      processFileSelector(
        `file://${scriptProvider[1]}`,
        PROVIDER_FILE_SELECTOR,
      );
      return true;
    };
    const processProvider = (provider: ConfigProvider): void => {
      if (typeof provider === 'string') {
        processProviderId(provider);
      } else if (typeof provider === 'object' && provider !== null) {
        if (typeof provider.id === 'string' && processProviderId(provider.id)) {
          return;
        }
        const httpProviders: Array<[string, unknown]> =
          typeof provider.id === 'string'
            ? [[provider.id, provider]]
            : Object.entries(provider);
        for (const [providerId, options] of httpProviders) {
          if (processProviderId(providerId)) continue;
          if (
            !/^(?:https?:|https?$)/i.test(providerId) ||
            typeof options !== 'object' ||
            options === null ||
            !('config' in options) ||
            typeof options.config !== 'object' ||
            options.config === null
          ) {
            continue;
          }
          const providerConfig = options.config as Record<string, unknown>;
          for (const key of HTTP_FILE_CONFIG_KEYS) {
            const value = providerConfig[key];
            if (typeof value === 'string' && value.startsWith('file://')) {
              processFileSelector(value, HTTP_FILE_SELECTOR, {
                requireExport: true,
              });
            }
          }
        }
      }
    };
    for (const provider of providers) {
      processProvider(provider);
    }

    // Extract prompt files
    if (config.prompts) {
      const prompts = Array.isArray(config.prompts)
        ? config.prompts
        : typeof config.prompts === 'string' || 'file' in config.prompts
          ? [config.prompts]
          : Object.keys(config.prompts);
      for (const prompt of prompts) {
        const promptPath =
          typeof prompt === 'string' && prompt.startsWith('exec:')
            ? prompt.slice('exec:'.length)
            : prompt;
        if (
          typeof promptPath === 'string' &&
          !/[\r\n]|(?:portkey|langfuse|helicone):\/\//.test(promptPath) &&
          (promptPath.startsWith('file://') ||
            /[\\/*]/.test(promptPath) ||
            /\.[A-Za-z0-9]{1,8}(?::[^/]*)?$/.test(promptPath))
        ) {
          processFileSelector(
            promptPath.startsWith('file://')
              ? promptPath
              : `file://${promptPath}`,
            PROVIDER_FILE_SELECTOR,
          );
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars?: { [key: string]: unknown }): void => {
      if (!vars) return;
      for (const value of Object.values(vars)) {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value);
        } else if (
          typeof value === 'object' &&
          value !== null &&
          'file' in value &&
          typeof value.file === 'string'
        ) {
          const absolutePath = resolveConfigDependency(
            value.file,
            'test variable file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
      }
    };

    // Extract assert files
    const visitedAssertSets = new WeakSet<object>();
    const extractAssertFiles = (asserts?: ConfigAssertion[]): void => {
      if (!Array.isArray(asserts) || visitedAssertSets.has(asserts)) return;
      visitedAssertSets.add(asserts);
      for (const assert of asserts) {
        if (
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processFileSelector(assert.value, ASSERT_FILE_SELECTOR, {
            firstColon: true,
          });
        } else if (
          typeof assert.value === 'object' &&
          assert.value !== null &&
          'file' in assert.value &&
          typeof assert.value.file === 'string'
        ) {
          const absolutePath = resolveConfigDependency(
            assert.value.file,
            'assertion file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
        if (assert.type === 'assert-set' && Array.isArray(assert.assert)) {
          extractAssertFiles(assert.assert);
        }
      }
    };

    const extractTestFiles = (
      tests: string | ConfigTestCase | Array<string | ConfigTestCase>,
    ): void => {
      if (typeof tests === 'string') {
        processFileSelector(
          tests.startsWith('file://') ? tests : `file://${tests}`,
          TEST_FILE_SELECTOR,
        );
        return;
      }
      if (Array.isArray(tests)) {
        for (const test of tests) extractTestFiles(test);
        return;
      }
      if (typeof tests.path === 'string') {
        extractTestFiles(tests.path);
        return;
      }
      extractVarFiles(tests.vars);
      extractAssertFiles(tests.assert);
      if (tests.provider) processProvider(tests.provider);
    };

    // Process defaultTest
    if (config.defaultTest) extractTestFiles(config.defaultTest);

    // Process tests
    if (config.tests) {
      extractTestFiles(config.tests);
    }

    if (config.scenarios) {
      for (const scenario of config.scenarios) {
        if (typeof scenario === 'string') {
          processFileUrl(scenario);
          continue;
        }
        if (scenario.config) extractTestFiles(scenario.config);
        if (scenario.tests) extractTestFiles(scenario.tests);
      }
    }

    if (config.nunjucksFilters) {
      for (const filter of Object.values(config.nunjucksFilters)) {
        processFileUrl(
          filter.startsWith('file://') ? filter : `file://${filter}`,
        );
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      if (relativePath === '') {
        return './';
      }
      const repositoryPath = relativePath.split(path.sep).join('/');
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch (error) {
    core.warning(
      `Failed to extract dependencies from config: ${sanitizeLogText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return configParsed ? ['./'] : [];
  }
}
