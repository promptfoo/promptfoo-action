import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand, unescape as unescapeGlob } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;
const MAX_BRACE_EXPANSIONS = 1024;
const MAX_NUMERIC_BRACE_RANGE = 100_000;
const MAX_BRACE_DEPTH = 128;
const MAX_EXTGLOB_DEPTH = 16;
const MAX_STRUCTURED_FILE_SIZE = 10 * 1024 * 1024;
const MAX_STRUCTURED_FILES = 128;
const MAX_STRUCTURED_NODES = 50_000;
const MAX_STRUCTURED_ENTRIES = 1024;
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
const ENV_TEMPLATE = /(?:\{\{|\{%)(?:[^}]|\}(?!\}|%))*\benv(?:\.|\[)/;
const ENV_EXPRESSION = /\{\{(?:[^}]|\}(?!\}))*\}\}/g;
const ENV_VARIABLE = /env\.(\w+)|env\[['"]([^'"]+)['"]\]/;
const FILE_URL_IN_TEMPLATE = /file:\/\/[^\s'"{}]+/g;

interface ConfigAssertion {
  type?: string;
  value?: string | { file?: string };
  provider?: ConfigProvider;
  contextTransform?: unknown;
  transform?: unknown;
  rubricPrompt?: unknown;
  assert?: ConfigAssertion[];
}

type ConfigProvider = string | { id?: string; [key: string]: unknown };
type ConfigPrompt = string | { file?: string; [key: string]: unknown };

interface ConfigTestCase {
  vars?: string | string[] | { [key: string]: string | { file?: string } };
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
  env?: Record<string, string>;
  providers?: ConfigProvider | ConfigProvider[];
  targets?: ConfigProvider | ConfigProvider[];
  prompts?: ConfigPrompt | ConfigPrompt[] | Record<string, string>;
  tests?: string | ConfigTestCase | Array<string | ConfigTestCase>;
  defaultTest?: string | ConfigTestCase;
  scenarios?: Array<string | ConfigScenario>;
  nunjucksFilters?: Record<string, string>;
  extensions?: unknown;
  commandLineOptions?: { extension?: unknown };
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

function fileUrlPath(value: string): string {
  const filePath = value.startsWith('file://')
    ? value.slice('file://'.length)
    : value;
  return process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(filePath)
    ? filePath.slice(1)
    : filePath;
}

function hasMismatchedGlobDelimiters(pattern: string): boolean {
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let inCharacterClass = false;
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      if (character === '}' && braceDepth > 0) braceDepth--;
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

function hasExcessiveGlobDepth(pattern: string): boolean {
  let braceDepth = 0;
  let extglobDepth = 0;
  let extglobOperator = false;
  let escaped = false;
  let inCharacterClass = false;
  const braceOperators: Array<{
    hasAlternatives: boolean;
    hasOperatorAlternative: boolean;
    endsWithOperator: boolean;
  }> = [];
  const updateBraceOperator = (character: string, isEscaped = false): void => {
    const state = braceOperators[braceOperators.length - 1];
    if (!state) return;
    if (character === ',' && !isEscaped) {
      state.hasAlternatives = true;
      state.hasOperatorAlternative ||= state.endsWithOperator;
      state.endsWithOperator = false;
      return;
    }
    state.endsWithOperator = !isEscaped && '*+?@!'.includes(character);
  };
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      updateBraceOperator(character, true);
      extglobOperator = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      extglobOperator = false;
      continue;
    }
    if (character === '{') {
      braceDepth++;
      if (braceDepth > MAX_BRACE_DEPTH) return true;
      braceOperators.push({
        hasAlternatives: false,
        hasOperatorAlternative: false,
        endsWithOperator: false,
      });
      extglobOperator = false;
    } else if (character === '}' && braceDepth > 0) {
      braceDepth--;
      const state = braceOperators.pop();
      const braceCanEndWithOperator =
        !!state &&
        state.hasAlternatives &&
        (state.hasOperatorAlternative || state.endsWithOperator);
      const parentState = braceOperators[braceOperators.length - 1];
      if (parentState) {
        parentState.endsWithOperator = braceCanEndWithOperator;
      }
      extglobOperator = braceCanEndWithOperator;
    } else if (character === '[') {
      inCharacterClass = true;
      updateBraceOperator(character, true);
      extglobOperator = false;
    } else if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      updateBraceOperator(character, true);
      extglobOperator = false;
    } else if (!inCharacterClass && character === '(' && extglobOperator) {
      extglobDepth++;
      if (extglobDepth > MAX_EXTGLOB_DEPTH) return true;
      extglobOperator = false;
    } else if (!inCharacterClass && character === ')' && extglobDepth > 0) {
      extglobDepth--;
      extglobOperator = false;
    } else {
      updateBraceOperator(character, inCharacterClass);
      extglobOperator = !inCharacterClass && '*+?@!'.includes(character);
    }
  }
  return false;
}

function hasOversizedNumericBraceRange(pattern: string): boolean {
  for (const range of pattern.matchAll(
    /(?<!\\)(?:\\\\)*\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g,
  )) {
    if (range.slice(1).some((value) => value && value.length > 16)) return true;
    const start = Number(range[1]);
    const end = Number(range[2]);
    const step = Math.abs(Number(range[3] ?? '1')) || 1;
    if (
      Math.floor(Math.abs(end - start) / step) + 1 >
      MAX_NUMERIC_BRACE_RANGE
    ) {
      return true;
    }
  }
  return false;
}

function hasExcessiveExpandedExtglobDepth(pattern: string): boolean {
  let extglobDepth = 0;
  let extglobOperator = false;
  let escaped = false;
  let inCharacterClass = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      extglobOperator = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      extglobOperator = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      extglobOperator = false;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      extglobOperator = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(' && extglobOperator) {
      extglobDepth++;
      if (extglobDepth > MAX_EXTGLOB_DEPTH) return true;
      extglobOperator = false;
      continue;
    }
    if (character === ')' && extglobDepth > 0) {
      extglobDepth--;
      extglobOperator = false;
      continue;
    }
    extglobOperator = '*+?@!'.includes(character);
  }
  return false;
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
    dependencies.add(cwd);
  };
  let configParsed = false;
  let warnedForeignWindowsPath = false;

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
          if (warnedForeignWindowsPath) return undefined;
          warnedForeignWindowsPath = true;
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

    const getEmbeddedFileReferences = (value: string): Set<string> => {
      const withoutBlocks = value.replace(/\{%[\s\S]*?%\}/g, '').trim();
      const matches = withoutBlocks.match(FILE_URL_IN_TEMPLATE) ?? [];
      if (withoutBlocks.startsWith('file://') && matches.length <= 1) {
        return new Set([withoutBlocks]);
      }
      return new Set(matches);
    };
    const processRuntimeFileReference = (
      value: unknown,
      envOverrides?: Record<string, string>,
    ): void => {
      if (typeof value !== 'string') return;
      const resolved = resolveEnvTemplate(value, envOverrides);
      const references = getEmbeddedFileReferences(resolved);
      if (!reserveStructuredEntries(references.size)) return;
      for (const reference of references) {
        processFileSelector(reference, TEST_FILE_SELECTOR);
      }
    };
    const processRubricReferences = (
      value: unknown,
      envOverrides?: Record<string, string>,
    ): void => {
      const pending: unknown[] = [value];
      const visited = new WeakSet<object>();
      const references: string[] = [];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === 'string') {
          if (current.includes('file://') || ENV_TEMPLATE.test(current)) {
            references.push(current);
          }
        } else if (
          typeof current === 'object' &&
          current !== null &&
          !visited.has(current)
        ) {
          visited.add(current);
          const nestedValues = Object.values(current);
          for (let index = nestedValues.length - 1; index >= 0; index--) {
            pending.push(nestedValues[index]);
          }
        }
      }
      if (!reserveStructuredEntries(references.length)) return;
      for (const reference of references) {
        processRuntimeFileReference(reference, envOverrides);
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrlPath(fileUrl);
      if (filePath.length > MAX_GLOB_PATTERN_LENGTH) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      if (
        hasExcessiveGlobDepth(filePath) ||
        (filePath.includes('{') && hasMismatchedGlobDelimiters(filePath))
      ) {
        watchWorkspace();
        core.warning(
          'Skipping a malformed config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      if (filePath.includes('{') && hasOversizedNumericBraceRange(filePath)) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized numeric config dependency glob; conservatively watching the repository workspace',
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
        expandedPaths = filePath.includes('{')
          ? braceExpand(filePath, globOptions)
          : [filePath];
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          watchWorkspace();
          core.warning(
            'Skipping config dependency glob with too many brace alternatives; conservatively watching the repository workspace',
          );
          return;
        }
        if (expandedPaths.some(hasExcessiveExpandedExtglobDepth)) {
          watchWorkspace();
          core.warning(
            'Skipping a malformed config dependency glob; conservatively watching the repository workspace',
          );
          return;
        }
        isGlob = glob.hasMagic(filePath, globOptions);
      } catch (error) {
        watchWorkspace();
        core.warning(
          `Failed to parse config dependency glob: ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
          )}; conservatively watching the repository workspace`,
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
            nobrace: true,
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
        const pathParts = filePath
          .slice(filePathRoot.length)
          .split(process.platform === 'win32' ? /[\\/]/ : '/');
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
        const literalBasePath =
          process.platform === 'win32'
            ? basePath
            : unescapeGlob(braceExpand(basePath, globOptions)[0], globOptions);
        dependencies.add(path.resolve(configDir, literalBasePath || '.'));
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
      const rawFilename = fileUrlPath(fileUrl);
      const colon = options.firstColon
        ? rawFilename.indexOf(':', /^[A-Za-z]:[\\/]/.test(rawFilename) ? 2 : 0)
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

    const scannedStructuredFiles = new Set<string>();
    let structuredNodes = 0;
    let structuredEntries = 0;
    const reserveStructuredEntries = (
      count: number,
      commit = true,
    ): boolean => {
      if (structuredEntries + count > MAX_STRUCTURED_ENTRIES) {
        watchWorkspace();
        core.warning(
          'Skipping additional structured prompt entries; conservatively watching the repository workspace',
        );
        return false;
      }
      if (commit) structuredEntries += count;
      return true;
    };
    const scanStructuredPrompt = (
      fileReference: string,
      onParsed?: (value: unknown) => boolean | undefined,
      scanReferences = true,
    ): void => {
      let filePath = fileUrlPath(fileReference);
      const colon = filePath.lastIndexOf(':');
      if (colon !== -1 && TEST_FILE_SELECTOR.test(filePath.slice(0, colon))) {
        filePath = filePath.slice(0, colon);
      }
      if (!/\.(?:json|ya?ml)$/i.test(filePath)) {
        return;
      }
      if (/[*?[\]{}]/.test(filePath)) {
        watchWorkspace();
        return;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'structured prompt dependency',
      );
      if (!absolutePath || scannedStructuredFiles.has(absolutePath)) return;
      if (scannedStructuredFiles.size >= MAX_STRUCTURED_FILES) {
        watchWorkspace();
        core.warning(
          'Skipping additional structured prompt dependencies; conservatively watching the repository workspace',
        );
        return;
      }
      scannedStructuredFiles.add(absolutePath);

      let fileSize: number | undefined;
      try {
        fileSize = fs.statSync(absolutePath).size;
      } catch {
        watchWorkspace();
        core.warning(
          'Failed to inspect a structured prompt dependency; conservatively watching the repository workspace',
        );
        return;
      }

      if (typeof fileSize === 'number' && fileSize > MAX_STRUCTURED_FILE_SIZE) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized structured prompt dependency; conservatively watching the repository workspace',
        );
        return;
      }

      let parsed: unknown;
      try {
        const contents = fs.readFileSync(absolutePath, 'utf8');
        parsed = filePath.toLowerCase().endsWith('.json')
          ? JSON.parse(contents)
          : loadYaml(contents, { schema: CORE_SCHEMA.withTags(mergeTag) });
      } catch {
        watchWorkspace();
        core.warning(
          'Failed to parse a structured prompt dependency; conservatively watching the repository workspace',
        );
        return;
      }

      const visited = new WeakSet<object>();
      const references = new Set<string>();
      const pending: unknown[] = [parsed];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'object' && value !== null && visited.has(value)) {
          continue;
        }
        if (++structuredNodes > MAX_STRUCTURED_NODES) {
          watchWorkspace();
          core.warning(
            'Skipping additional structured prompt fields; conservatively watching the repository workspace',
          );
          return;
        }
        if (typeof value === 'string' && value.startsWith('file://')) {
          references.add(value);
          continue;
        }
        if (typeof value !== 'object' || value === null) {
          continue;
        }
        visited.add(value);
        const nestedValues = Object.values(value);
        for (let index = nestedValues.length - 1; index >= 0; index--) {
          pending.push(nestedValues[index]);
        }
      }

      if (onParsed?.(parsed) === false) return;
      if (!scanReferences) return;
      if (!reserveStructuredEntries(references.size)) return;
      for (const reference of references) {
        processFileSelector(reference, ASSERT_FILE_SELECTOR, {
          firstColon: true,
        });
        scanStructuredPrompt(reference);
      }
    };

    // Extract provider files
    const providers = [config.providers, config.targets].flatMap((value) =>
      Array.isArray(value) ? value : value ? [value] : [],
    );
    const processProviderId = (
      providerId: string,
      baseDir: string = configDir,
      envOverrides?: Record<string, string>,
    ): boolean => {
      const resolvedProviderId = resolveEnvTemplate(providerId, envOverrides);
      if (resolvedProviderId.startsWith('file://')) {
        const providerFile =
          baseDir === configDir
            ? resolvedProviderId
            : `file://${path.resolve(
                baseDir,
                fileUrlPath(resolvedProviderId),
              )}`;
        processFileSelector(providerFile, PROVIDER_FILE_SELECTOR);
        scanStructuredPrompt(providerFile, (parsed) => {
          const externalProviders = Array.isArray(parsed) ? parsed : [parsed];
          if (!reserveStructuredEntries(externalProviders.length)) return false;
          const nestedWork = externalProviders.reduce<number>(
            (count, provider) => {
              if (typeof provider !== 'object' || provider === null)
                return count;
              const options = provider as Record<string, unknown>;
              const config = options.config;
              if (typeof config !== 'object' || config === null) return count;
              const providerConfig = config as Record<string, unknown>;
              const tools = providerConfig.tools;
              const multipart = providerConfig.multipart;
              const parts =
                typeof multipart === 'object' &&
                multipart !== null &&
                'parts' in multipart &&
                Array.isArray(multipart.parts)
                  ? multipart.parts.length
                  : 0;
              return count + (Array.isArray(tools) ? tools.length : 0) + parts;
            },
            0,
          );
          if (!reserveStructuredEntries(nestedWork, false)) return false;
          for (const provider of externalProviders) {
            if (
              typeof provider === 'string' ||
              (typeof provider === 'object' && provider !== null)
            ) {
              processProvider(
                provider as ConfigProvider,
                baseDir,
                envOverrides,
                true,
              );
            }
          }
        });
        return true;
      }
      const scriptProvider = /^(?:python|golang|ruby):(.+)$/.exec(
        resolvedProviderId,
      );
      if (!scriptProvider) return false;
      processFileSelector(
        baseDir === configDir
          ? `file://${scriptProvider[1]}`
          : `file://${path.resolve(baseDir, scriptProvider[1])}`,
        PROVIDER_FILE_SELECTOR,
      );
      return true;
    };
    const resolveEnvTemplate = (
      value: string,
      envOverrides?: Record<string, string>,
    ): string => {
      let resolved = value;
      for (let depth = 0; depth < 4; depth++) {
        const next = resolved.replace(ENV_EXPRESSION, (expression) => {
          const getEnv = (name: string): string | undefined =>
            envOverrides?.[name] ?? config.env?.[name] ?? process.env[name];
          const body = expression.slice(2, -2).trim();
          const parts = body.split(/\s*(?:\+|~)\s*/);
          const values = parts.map((part) => {
            const variable = ENV_VARIABLE.exec(part);
            if (variable && variable[0] === part) {
              return getEnv(variable[1] ?? variable[2]);
            }
            const literal = /^(['"])(.*)\1$/.exec(part);
            return literal?.[2];
          });
          if (values.every((part) => part !== undefined)) {
            return values.join('');
          }
          const match = ENV_VARIABLE.exec(expression);
          if (!match) return expression;
          return getEnv(match[1] ?? match[2]) ?? expression;
        });
        if (next === resolved) break;
        resolved = next;
      }
      return resolved;
    };
    const processToolReferences = (
      tools: unknown,
      envOverrides?: Record<string, string>,
    ): void => {
      const values = Array.isArray(tools) ? tools : [tools];
      if (Array.isArray(tools) && !reserveStructuredEntries(values.length)) {
        return;
      }
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const resolved = resolveEnvTemplate(value, envOverrides);
        const references = getEmbeddedFileReferences(resolved);
        if (!reserveStructuredEntries(references.size)) return;
        for (const reference of references) {
          processFileSelector(reference, TEST_FILE_SELECTOR);
        }
      }
    };
    const processDirectPath = (
      value: unknown,
      envOverrides?: Record<string, string>,
    ): void => {
      if (typeof value !== 'string') return;
      const resolved = resolveEnvTemplate(value, envOverrides);
      if (resolved.includes('file://')) {
        processRuntimeFileReference(resolved, envOverrides);
        return;
      }
      const withoutBlocks = resolved.replace(/\{%[\s\S]*?%\}/g, '').trim();
      processFileUrl(`file://${withoutBlocks}`);
    };
    const processProvider = (
      provider: ConfigProvider,
      baseDir: string = configDir,
      inheritedEnv?: Record<string, string>,
      preferInheritedEnv = false,
    ): void => {
      if (typeof provider === 'string') {
        processProviderId(provider, baseDir, inheritedEnv);
      } else if (typeof provider === 'object' && provider !== null) {
        const httpProviders: Array<[string, unknown]> =
          typeof provider.id === 'string'
            ? [[provider.id, provider]]
            : Object.entries(provider);
        for (const [providerId, options] of httpProviders) {
          const optionEnv =
            typeof options === 'object' &&
            options !== null &&
            'env' in options &&
            typeof options.env === 'object' &&
            options.env !== null
              ? (options.env as Record<string, string>)
              : undefined;
          const providerEnv = preferInheritedEnv
            ? { ...optionEnv, ...inheritedEnv }
            : { ...inheritedEnv, ...optionEnv };
          if (
            typeof options !== 'object' ||
            options === null ||
            !('config' in options) ||
            typeof options.config !== 'object' ||
            options.config === null
          ) {
            processProviderId(providerId, baseDir, providerEnv);
            continue;
          }
          const providerConfig = options.config as Record<string, unknown>;
          for (const key of [
            'functions',
            'response_format',
            'output_format',
            'request',
            'body',
          ]) {
            processRubricReferences(providerConfig[key], providerEnv);
          }
          const session = providerConfig.session;
          if (typeof session === 'object' && session !== null) {
            processRuntimeFileReference(
              'responseParser' in session ? session.responseParser : undefined,
              providerEnv,
            );
          }
          processToolReferences(providerConfig.tools, providerEnv);
          if (
            processProviderId(providerId, baseDir, providerEnv) ||
            (!/^(?:https?:|https?$)/i.test(providerId) &&
              !ENV_TEMPLATE.test(providerId))
          ) {
            continue;
          }
          for (const key of HTTP_FILE_CONFIG_KEYS) {
            const value = providerConfig[key];
            const resolved =
              typeof value === 'string'
                ? resolveEnvTemplate(value, providerEnv)
                : undefined;
            if (resolved?.includes('file://')) {
              const references = getEmbeddedFileReferences(resolved);
              if (!reserveStructuredEntries(references.size)) continue;
              for (const reference of references) {
                processFileSelector(reference, HTTP_FILE_SELECTOR, {
                  requireExport: true,
                });
              }
            }
          }

          const auth = providerConfig.auth;
          if (
            typeof auth === 'object' &&
            auth !== null &&
            'type' in auth &&
            (auth.type === 'file' ||
              (typeof auth.type === 'string' && ENV_TEMPLATE.test(auth.type)))
          ) {
            const authPath = 'path' in auth ? auth.path : undefined;
            const resolvedAuthPath =
              typeof authPath === 'string'
                ? resolveEnvTemplate(authPath, providerEnv)
                : undefined;
            if (
              typeof resolvedAuthPath === 'string' &&
              resolvedAuthPath.includes('file://')
            ) {
              processRuntimeFileReference(resolvedAuthPath, providerEnv);
            } else {
              processDirectPath(authPath, providerEnv);
            }
          }

          const multipart = providerConfig.multipart;
          if (
            typeof multipart === 'object' &&
            multipart !== null &&
            'parts' in multipart &&
            Array.isArray(multipart.parts)
          ) {
            if (!reserveStructuredEntries(multipart.parts.length)) continue;
            for (const part of multipart.parts) {
              if (
                typeof part !== 'object' ||
                part === null ||
                !('kind' in part) ||
                (part.kind !== 'file' &&
                  (typeof part.kind !== 'string' ||
                    !ENV_TEMPLATE.test(part.kind))) ||
                !('source' in part) ||
                typeof part.source !== 'object' ||
                part.source === null ||
                !('type' in part.source) ||
                (part.source.type !== 'path' &&
                  (typeof part.source.type !== 'string' ||
                    !ENV_TEMPLATE.test(part.source.type)))
              ) {
                continue;
              }
              processDirectPath(
                'path' in part.source ? part.source.path : undefined,
                providerEnv,
              );
            }
          }

          for (const [group, keys] of [
            [
              providerConfig.signatureAuth,
              [
                'privateKeyPath',
                'keystorePath',
                'pfxPath',
                'certPath',
                'keyPath',
              ],
            ],
            [
              providerConfig.tls,
              ['caPath', 'certPath', 'keyPath', 'pfxPath', 'jksPath'],
            ],
          ] as const) {
            if (typeof group !== 'object' || group === null) continue;
            const paths = group as Record<string, unknown>;
            for (const key of keys) {
              processDirectPath(paths[key], providerEnv);
            }
          }
        }
      }
    };
    if (reserveStructuredEntries(providers.length * 16)) {
      for (const provider of providers) {
        processProvider(provider, configDir, config.env);
      }
    }

    processRubricReferences(config.extensions, config.env);
    processRubricReferences(config.commandLineOptions?.extension, config.env);

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
        const resolvedPromptPath =
          typeof promptPath === 'string'
            ? resolveEnvTemplate(promptPath, config.env)
            : promptPath;
        if (
          typeof resolvedPromptPath === 'string' &&
          !/[\r\n]|(?:portkey|langfuse|helicone):\/\//.test(
            resolvedPromptPath,
          ) &&
          (resolvedPromptPath.startsWith('file://') ||
            /[\\/]/.test(resolvedPromptPath) ||
            /^[^\s]*[*?][^\s]*$/.test(resolvedPromptPath) ||
            /\.[A-Za-z0-9]{1,8}(?::[^/]*)?$/.test(resolvedPromptPath))
        ) {
          processFileSelector(
            resolvedPromptPath.startsWith('file://')
              ? resolvedPromptPath
              : `file://${resolvedPromptPath}`,
            PROVIDER_FILE_SELECTOR,
          );
          scanStructuredPrompt(resolvedPromptPath);
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
            scanStructuredPrompt(prompt.file);
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (
      vars?: string | string[] | { [key: string]: unknown },
      baseDir: string = configDir,
    ): void => {
      if (!vars) return;
      if (typeof vars === 'string' || Array.isArray(vars)) {
        const values = Array.isArray(vars) ? vars : [vars];
        if (!reserveStructuredEntries(values.length)) return;
        for (const value of values) {
          const resolvedValue = resolveEnvTemplate(value, config.env);
          const rawValue = fileUrlPath(resolvedValue);
          processFileUrl(`file://${path.resolve(baseDir, rawValue)}`);
          scanStructuredPrompt(path.resolve(baseDir, rawValue));
        }
        return;
      }
      for (const value of Object.values(vars)) {
        const resolvedValue =
          typeof value === 'string'
            ? resolveEnvTemplate(value, config.env)
            : value;
        if (
          typeof resolvedValue === 'string' &&
          resolvedValue.includes('file://')
        ) {
          const references = getEmbeddedFileReferences(resolvedValue);
          if (!reserveStructuredEntries(references.size)) continue;
          for (const reference of references) {
            processFileUrl(reference);
          }
        } else if (
          typeof value === 'object' &&
          value !== null &&
          'file' in value &&
          typeof value.file === 'string'
        ) {
          const absolutePath = resolveConfigDependency(
            resolveEnvTemplate(value.file, config.env),
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
      if (!reserveStructuredEntries(asserts.length)) return;
      visitedAssertSets.add(asserts);
      for (const assert of asserts) {
        const assertionValue =
          typeof assert.value === 'string'
            ? resolveEnvTemplate(assert.value, config.env)
            : assert.value;
        if (
          typeof assertionValue === 'string' &&
          assertionValue.includes('file://')
        ) {
          const references = getEmbeddedFileReferences(assertionValue);
          if (!reserveStructuredEntries(references.size)) continue;
          for (const reference of references) {
            processFileSelector(reference, ASSERT_FILE_SELECTOR, {
              firstColon: true,
            });
          }
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
        if (typeof assert.value === 'object' && assert.value !== null) {
          processRubricReferences(assert.value, config.env);
        }
        if (assert.type === 'assert-set' && Array.isArray(assert.assert)) {
          extractAssertFiles(assert.assert);
        }
        if (assert.provider)
          processProvider(assert.provider, configDir, config.env);
        processRuntimeFileReference(assert.contextTransform, config.env);
        processRuntimeFileReference(assert.transform, config.env);
        processRubricReferences(assert.rubricPrompt, config.env);
      }
    };

    const extractTestFiles = (
      tests: string | ConfigTestCase | Array<string | ConfigTestCase>,
      baseDir: string = configDir,
    ): void => {
      if (typeof tests === 'string') {
        const testPath = tests.replace(/(\.(?:xlsx|xls))#[^\\/]*$/i, '$1');
        const rawTestPath = fileUrlPath(testPath);
        const absoluteTestPath = path.resolve(baseDir, rawTestPath);
        processFileSelector(`file://${absoluteTestPath}`, TEST_FILE_SELECTOR);
        scanStructuredPrompt(
          absoluteTestPath,
          (parsed) => {
            const nestedTests =
              typeof parsed === 'object' &&
              parsed !== null &&
              !Array.isArray(parsed) &&
              'tests' in parsed
                ? parsed.tests
                : parsed;
            if (
              typeof nestedTests !== 'string' &&
              !Array.isArray(nestedTests) &&
              (typeof nestedTests !== 'object' || nestedTests === null)
            ) {
              return;
            }
            const count = Array.isArray(nestedTests) ? nestedTests.length : 1;
            if (!reserveStructuredEntries(count)) return false;
            extractTestFiles(
              nestedTests as
                | string
                | ConfigTestCase
                | Array<string | ConfigTestCase>,
              path.dirname(absoluteTestPath),
            );
          },
          false,
        );
        return;
      }
      if (Array.isArray(tests)) {
        for (const test of tests) extractTestFiles(test, baseDir);
        return;
      }
      if (typeof tests.path === 'string') {
        processRubricReferences(tests.config, config.env);
        extractTestFiles(tests.path, baseDir);
        return;
      }
      extractVarFiles(tests.vars, baseDir);
      processRuntimeFileReference(tests.assertScoringFunction, config.env);
      const options = tests.options;
      if (typeof options === 'object' && options !== null) {
        const testOptions = options as Record<string, unknown>;
        processRuntimeFileReference(testOptions.postprocess, config.env);
        processRuntimeFileReference(testOptions.transform, config.env);
        processRuntimeFileReference(testOptions.transformVars, config.env);
        processRubricReferences(testOptions.rubricPrompt, config.env);
        if (testOptions.provider) {
          processProvider(
            testOptions.provider as ConfigProvider,
            configDir,
            config.env,
          );
        }
      }
      extractAssertFiles(tests.assert);
      if (tests.provider) processProvider(tests.provider, baseDir, config.env);
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
          watchWorkspace();
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
