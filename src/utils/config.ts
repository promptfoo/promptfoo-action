import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import {
  binaryTag,
  CORE_SCHEMA,
  load as loadYaml,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

const CONFIG_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  binaryTag,
  timestampTag,
  omapTag,
  pairsTag,
  setTag,
);
const MAX_BRACE_EXPANSIONS = 1024;
const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;
const MAX_NESTED_TEST_FILES = 256;
const MAX_NESTED_CONFIG_FILES = 256;
const MAX_STRUCTURED_FILE_SIZE = 10 * 1024 * 1024;
const HTTP_PROVIDER_FILE_PATH_KEYS = new Set([
  'privateKeyPath',
  'keystorePath',
  'pfxPath',
  'certPath',
  'keyPath',
  'caPath',
  'jksPath',
]);
const JAVASCRIPT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.cts',
  '.mts',
]);
const HTTP_PROVIDER_FUNCTION_KEYS = new Set([
  'validateStatus',
  'transformRequest',
  'transformResponse',
  'responseParser',
  'sessionParser',
]);

type FileSelectorContext = 'generic' | 'assertion' | 'http' | 'tests';

function getFileReferenceCandidates(
  fileUrl: string,
  context: FileSelectorContext,
): string[] {
  const lastSeparator = Math.max(
    fileUrl.lastIndexOf('/'),
    fileUrl.lastIndexOf('\\'),
  );

  if (context === 'assertion') {
    const rubySelector = fileUrl.lastIndexOf('.rb:');
    if (rubySelector > lastSeparator) {
      const method = fileUrl.slice(rubySelector + 4);
      if (method) {
        return [fileUrl.slice(0, rubySelector + 3)];
      }
    }
  }

  const selector = fileUrl.lastIndexOf(':');
  if (selector === fileUrl.length - 1) {
    return [fileUrl];
  }
  const candidate = fileUrl.slice(0, selector);
  const extension = path.extname(candidate);
  const lowercaseExtension = extension.toLowerCase();
  const supportsJavascript = JAVASCRIPT_EXTENSIONS.has(lowercaseExtension);
  const supportsOther =
    (context === 'generic' &&
      (extension === '.py' || extension === '.rb' || extension === '.go')) ||
    ((context === 'assertion' || context === 'tests') && extension === '.py');

  if (supportsJavascript) {
    return extension === lowercaseExtension
      ? [candidate]
      : [fileUrl, candidate];
  }
  return supportsOther ? [candidate] : [fileUrl];
}

function stripSpreadsheetSelector(filePath: string): string {
  const sheetSelector = filePath.indexOf('#');
  return sheetSelector >= 0 &&
    /\.xlsx?$/i.test(filePath.slice(0, sheetSelector))
    ? filePath.slice(0, sheetSelector)
    : filePath;
}

function parseExecReference(
  value: string,
): { filePath?: string; hasArguments: boolean } | undefined {
  if (!value.startsWith('exec:')) return undefined;
  const command = value.slice('exec:'.length).trim();
  if (!command) return { hasArguments: true };
  if (command[0] === '"' || command[0] === "'") {
    const closingQuote = command.indexOf(command[0], 1);
    if (closingQuote < 0) return { hasArguments: true };
    return {
      filePath: command.slice(1, closingQuote),
      hasArguments: command.slice(closingQuote + 1).trim().length > 0,
    };
  }
  const firstWhitespace = command.search(/\s/);
  return firstWhitespace < 0
    ? { filePath: command, hasArguments: false }
    : {
        filePath: command.slice(0, firstWhitespace),
        hasArguments: true,
      };
}

function getProviderFileUrl(value: string): string | undefined {
  const execReference = parseExecReference(value);
  if (execReference) {
    return execReference.filePath
      ? `file://${execReference.filePath}`
      : undefined;
  }
  const separator = value.indexOf(':');
  const prefix = value.slice(0, separator);
  if (
    separator < 0 ||
    (prefix !== 'python' && prefix !== 'golang' && prefix !== 'ruby')
  ) {
    return undefined;
  }
  const providerPath = value.slice(separator + 1);
  return providerPath.startsWith('file://')
    ? providerPath
    : `file://${providerPath}`;
}

export function hasBalancedGlobDelimiters(
  filePath: string,
  windowsPathsNoEscape = true,
): boolean {
  const expectedClosers: string[] = [];
  let escaped = false;
  for (let index = 0; index < filePath.length; index++) {
    const character = filePath[index];
    if (!windowsPathsNoEscape && character === '\\') {
      escaped = !escaped;
      continue;
    }
    if (!windowsPathsNoEscape && escaped && '{}[]()'.includes(character)) {
      escaped = false;
      continue;
    }
    escaped = false;
    if (expectedClosers[expectedClosers.length - 1] === ']') {
      if (character === ']') expectedClosers.pop();
      continue;
    }
    if (character === '{') {
      expectedClosers.push('}');
    } else if (character === '[') {
      expectedClosers.push(']');
    } else if (
      character === '(' &&
      index > 0 &&
      ['!', '?', '+', '*', '@'].includes(filePath[index - 1])
    ) {
      expectedClosers.push(')');
    } else if (character === '}' || character === ']' || character === ')') {
      const expected = expectedClosers[expectedClosers.length - 1];
      if (expected && expected !== character) return false;
      if (expected === character) expectedClosers.pop();
    }
  }
  return expectedClosers.length === 0;
}

export function hasSafeNumericBraceRanges(
  filePath: string,
  maxExpansions: number,
  windowsPathsNoEscape = true,
): boolean {
  const frames: Array<{ product: number; sum: number; alternatives: boolean }> =
    [{ product: 1, sum: 0, alternatives: false }];
  let escaped = false;
  let literalBraceDepth = 0;
  const readInteger = (
    start: number,
  ): { value: number; next: number; safe: boolean } | undefined => {
    let next = start;
    if (filePath[next] === '-') next++;
    const digits = next;
    while (
      next < filePath.length &&
      filePath.charCodeAt(next) >= 48 &&
      filePath.charCodeAt(next) <= 57
    ) {
      next++;
    }
    if (next === digits) return undefined;
    const value = Number(filePath.slice(start, next));
    return {
      value,
      next,
      safe: next - digits <= 32 && Number.isSafeInteger(value),
    };
  };

  for (let index = 0; index < filePath.length; index++) {
    if (!windowsPathsNoEscape && filePath[index] === '\\') {
      escaped = !escaped;
      continue;
    }
    if (
      !windowsPathsNoEscape &&
      escaped &&
      '{}[](),'.includes(filePath[index])
    ) {
      escaped = false;
      continue;
    }
    escaped = false;
    const character = filePath[index];
    if (literalBraceDepth > 0) {
      if (character === '{') literalBraceDepth++;
      if (character === '}') literalBraceDepth--;
      continue;
    }
    if (character === '{' && filePath[index - 1] === '$') {
      literalBraceDepth = 1;
      continue;
    }
    if (character === '{') {
      const start = readInteger(index + 1);
      if (start && filePath.slice(start.next, start.next + 2) === '..') {
        const end = readInteger(start.next + 2);
        if (end) {
          let next = end.next;
          let step = 1;
          if (filePath.slice(next, next + 2) === '..') {
            const parsedStep = readInteger(next + 2);
            if (parsedStep) {
              if (!parsedStep.safe) return false;
              step = Math.abs(parsedStep.value);
              next = parsedStep.next;
            }
          }
          if (filePath[next] === '}') {
            if (!start.safe || !end.safe || step === 0) return false;
            const range =
              Math.floor(Math.abs(end.value - start.value) / step) + 1;
            const frame = frames[frames.length - 1];
            if (range > maxExpansions / frame.product) return false;
            frame.product *= range;
            index = next;
            continue;
          }
        }
      }
      frames.push({ product: 1, sum: 0, alternatives: false });
      continue;
    }
    const frame = frames[frames.length - 1];
    if (character === ',' && frames.length > 1) {
      frame.sum += frame.product;
      if (frame.sum > maxExpansions) return false;
      frame.product = 1;
      frame.alternatives = true;
      continue;
    }
    if (character === '}' && frames.length > 1) {
      frames.pop();
      const alternatives = frame.alternatives
        ? frame.sum + frame.product
        : frame.product;
      const parent = frames[frames.length - 1];
      if (alternatives > maxExpansions / parent.product) return false;
      parent.product *= alternatives;
    }
  }
  return true;
}

export function isForeignWindowsPath(filePath: string): boolean {
  return (
    process.platform !== 'win32' &&
    (/^[A-Za-z]:/.test(filePath) || filePath.startsWith('\\'))
  );
}

export function normalizeConfigFilePath(
  filePath: string,
  platform = process.platform,
): string {
  return platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(filePath)
    ? filePath.slice(1)
    : filePath;
}

interface PromptfooAssertion {
  type?: string;
  value?: unknown;
  assert?: PromptfooAssertion[];
  provider?: unknown;
  config?: unknown;
  rubricPrompt?: unknown;
  transform?: unknown;
  contextTransform?: unknown;
}

interface PromptfooTestConfig {
  vars?: unknown;
  assert?: PromptfooAssertion[];
  assertScoringFunction?: unknown;
  provider?: unknown;
  options?: {
    provider?: unknown;
    rubricPrompt?: unknown;
    postprocess?: unknown;
    transform?: unknown;
    transformVars?: unknown;
  };
  [key: string]: unknown;
}

interface PromptfooTestGeneratorConfig {
  path: string;
  config?: unknown;
}

export interface PromptfooConfig {
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?:
    | string
    | Record<string, string>
    | Array<
        | string
        | { file?: string; id?: string; raw?: string; [key: string]: unknown }
      >;
  tests?:
    | string
    | PromptfooTestGeneratorConfig
    | Array<string | PromptfooTestConfig | PromptfooTestGeneratorConfig>;
  defaultTest?: string | PromptfooTestConfig;
  scenarios?: Array<
    | string
    | {
        tests?: unknown;
        config?: unknown;
      }
  >;
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

function isHttpProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('http:') ||
      value.startsWith('https:') ||
      value === 'http' ||
      value === 'https')
  );
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
  const dependencyRoots =
    dependencyRoot === cwd ? [dependencyRoot] : [dependencyRoot, cwd];
  const isInsideDependencyRoots = (targetPath: string): boolean =>
    dependencyRoots.some((root) => isPathInside(root, targetPath));
  const addDependencyRootWatchers = (): void => {
    for (const root of dependencyRoots) {
      dependencies.add(`${root}${path.sep}`);
    }
  };
  const canReadStructuredFile = (filePath: string): boolean => {
    try {
      const fileStats = fs.statSync(filePath);
      if (!fileStats.isFile()) {
        addDependencyRootWatchers();
        core.warning(
          'Skipping non-regular structured config dependency; conservatively watching the dependency root',
        );
        return false;
      }
      if (fileStats.size > MAX_STRUCTURED_FILE_SIZE) {
        addDependencyRootWatchers();
        core.warning(
          'Skipping oversized structured config dependency; conservatively watching the dependency root',
        );
        return false;
      }
    } catch {
      addDependencyRootWatchers();
      core.warning(
        'Skipping structured config dependency whose size cannot be verified; conservatively watching the dependency root',
      );
      return false;
    }
    return true;
  };
  let parsedConfig = false;
  let dependencyBaseDir = configDir;

  try {
    if (isPathInside(cwd, configPath)) {
      let realWorkspaceRoot: string;
      let realConfigPath: string;
      try {
        realWorkspaceRoot = fs.realpathSync(cwd);
        realConfigPath = fs.realpathSync(configPath);
      } catch {
        core.warning(
          'Skipping config file whose path cannot be verified safely',
        );
        return [];
      }
      if (!isPathInside(realWorkspaceRoot, realConfigPath)) {
        core.warning(
          'Skipping config file that resolves outside the repository workspace',
        );
        return [];
      }
    }
    if (!canReadStructuredFile(configPath)) return ['./'];
    const configContent = fs.readFileSync(configPath, 'utf8');
    if (!configContent.trim()) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const config = loadYaml(configContent, {
      schema: CONFIG_SCHEMA,
    }) as PromptfooConfig;

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }
    parsedConfig = true;

    const realDependencyRoots = dependencyRoots.flatMap((root) => {
      try {
        return [fs.realpathSync(root)];
      } catch {
        return [];
      }
    });

    let warnedForeignWindowsPath = false;
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
        if (isForeignWindowsPath(filePath)) {
          if (warnedForeignWindowsPath) return undefined;
          warnedForeignWindowsPath = true;
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        const absolutePath = path.resolve(
          dependencyBaseDir,
          normalizeConfigFilePath(filePath),
        );
        if (!isInsideDependencyRoots(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        const reason = String(error).replace(/^(?:[A-Za-z]+)?Error: /, '');
        core.warning(
          `Ignoring unsafe config dependency ${JSON.stringify(filePath)}: ${JSON.stringify(reason)}`,
        );
        return undefined;
      }
    };

    const globOptions = {
      windowsPathsNoEscape: true,
      magicalBraces: true,
      braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
    };

    const isValidGlobLength = (filePath: string): boolean => {
      if (filePath.length > MAX_GLOB_PATTERN_LENGTH) {
        core.warning(
          'Skipping config dependency that exceeds the maximum glob pattern length',
        );
        return false;
      }
      return true;
    };

    const getGlobMagic = (filePath: string): boolean | undefined => {
      if (!isValidGlobLength(filePath)) return undefined;
      if (filePath.includes('\0')) {
        addDependencyRootWatchers();
        core.warning(
          'Skipping invalid config dependency glob pattern containing a NUL byte; conservatively watching the dependency root',
        );
        return undefined;
      }
      if (!hasSafeNumericBraceRanges(filePath, MAX_BRACE_EXPANSIONS)) {
        addDependencyRootWatchers();
        core.warning(
          'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
        );
        return undefined;
      }
      try {
        return glob.hasMagic(filePath, globOptions);
      } catch {
        addDependencyRootWatchers();
        core.warning(
          'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
        );
        return undefined;
      }
    };

    const hasDynamicFilePath = (filePath: string): boolean =>
      [
        ['{{', '}}'],
        ['{%', '%}'],
        ['{#', '#}'],
      ].some(([open, close]) => {
        let start = filePath.indexOf(open);
        while (start >= 0) {
          if (filePath.indexOf(close, start + 2) < 0) return false;
          if (
            open !== '{{' ||
            !/^-?\d+\.\.-?\d+/.test(filePath.slice(start + 2))
          ) {
            return true;
          }
          start = filePath.indexOf(open, start + 2);
        }
        return false;
      });

    const watchDynamicFilePath = (filePath: string): boolean => {
      if (!hasDynamicFilePath(filePath)) return false;
      addDependencyRootWatchers();
      return true;
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (
      fileUrl: string,
      resolvedPath?: string,
    ): string[] => {
      const filePath = normalizeConfigFilePath(fileUrl.replace('file://', ''));
      if (!filePath || filePath.includes('\0')) {
        resolveConfigDependency(filePath, 'config file dependency');
        return [];
      }
      if (!isValidGlobLength(filePath)) return [];
      if (watchDynamicFilePath(filePath)) return [];

      // Check if the path contains glob patterns
      const isGlob = getGlobMagic(filePath);
      if (isGlob === undefined) return [];
      if (isGlob) {
        if (!hasBalancedGlobDelimiters(filePath)) {
          addDependencyRootWatchers();
          core.warning(
            'Skipping invalid config dependency glob pattern with mismatched or unclosed delimiters; conservatively watching the dependency root',
          );
          return [];
        }
        let expandedPaths: string[];
        try {
          expandedPaths = braceExpand(filePath.replace(/\\/g, '/'), {
            braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
          });
        } catch {
          addDependencyRootWatchers();
          core.warning(
            'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
          );
          return [];
        }
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          addDependencyRootWatchers();
          core.warning(
            'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
          );
          return [];
        }

        const safePatterns: string[] = [];
        let unsafeAlternative = false;
        if (realDependencyRoots.length === 0) {
          addDependencyRootWatchers();
          core.warning(
            'Skipping config dependency glob whose workspace root cannot be resolved; conservatively watching the dependency root',
          );
          return [];
        }
        for (const expandedPath of expandedPaths) {
          if (isForeignWindowsPath(expandedPath)) {
            unsafeAlternative = true;
            continue;
          }
          const absolutePattern = path.resolve(
            dependencyBaseDir,
            expandedPath.replace(/[\\/]/g, path.sep),
          );
          if (!isInsideDependencyRoots(absolutePattern)) {
            unsafeAlternative = true;
            continue;
          }

          let existingPath = absolutePattern;
          while (true) {
            try {
              if (
                realDependencyRoots.some((root) =>
                  isPathInside(root, fs.realpathSync(existingPath)),
                )
              ) {
                safePatterns.push(absolutePattern);
              } else {
                unsafeAlternative = true;
              }
              break;
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                unsafeAlternative = true;
                break;
              }
              try {
                fs.lstatSync(existingPath);
                unsafeAlternative = true;
                break;
              } catch (lstatError) {
                const lstatCode = (lstatError as NodeJS.ErrnoException).code;
                if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
                  unsafeAlternative = true;
                  break;
                }
              }
              const parentPath = path.dirname(existingPath);
              if (parentPath === existingPath) {
                unsafeAlternative = true;
                break;
              }
              existingPath = parentPath;
            }
          }
        }
        if (unsafeAlternative) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
          core.warning(
            'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
          );
        }
        if (safePatterns.length === 0) return [];

        // It's a glob pattern, expand it
        let matches: string[];
        try {
          matches = glob.sync(safePatterns, {
            nodir: true,
            ...globOptions,
            braceExpandMax: MAX_BRACE_EXPANSIONS,
          });
        } catch {
          addDependencyRootWatchers();
          core.warning(
            'Skipping invalid config dependency glob pattern; conservatively watching the dependency root',
          );
          return [];
        }
        const safeMatches: string[] = [];
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          let realMatch: string;
          try {
            realMatch = fs.realpathSync(absoluteMatch);
          } catch {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
            );
            continue;
          }
          if (
            isInsideDependencyRoots(absoluteMatch) &&
            realDependencyRoots.some((root) => isPathInside(root, realMatch))
          ) {
            dependencies.add(absoluteMatch);
            safeMatches.push(absoluteMatch);
          } else {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        for (const safePattern of safePatterns) {
          const relativePattern = path.relative(dependencyBaseDir, safePattern);
          const pathRoot = path.parse(relativePattern).root;
          const pathParts = relativePattern
            .slice(pathRoot.length)
            .split(/[\\/]/);
          const hasRelativeGlobMagic = getGlobMagic(relativePattern);
          if (hasRelativeGlobMagic === undefined) continue;
          let basePath = hasRelativeGlobMagic
            ? pathRoot
            : path.dirname(relativePattern);
          if (hasRelativeGlobMagic) {
            for (const part of pathParts) {
              if (getGlobMagic(part) !== false) break;
              basePath = basePath ? path.join(basePath, part) : part;
            }
          }
          if (basePath) {
            const absoluteBasePath = path.resolve(dependencyBaseDir, basePath);
            if (path.relative(cwd, absoluteBasePath) === '') {
              dependencies.add(safePattern);
            } else {
              dependencies.add(`${absoluteBasePath}${path.sep}`);
            }
          } else {
            dependencies.add(
              path.relative(cwd, dependencyBaseDir) === ''
                ? safePattern
                : `${dependencyBaseDir}${path.sep}`,
            );
          }
        }
        return safeMatches;
      }

      const absolutePath =
        resolvedPath ??
        resolveConfigDependency(filePath, 'config file dependency');
      if (!absolutePath) return [];
      if (isDirectory(absolutePath) || /[\\/]$/.test(fileUrl)) {
        // It's a directory, preserve trailing slash if it was there
        const directoryPath = /[\\/]$/.test(fileUrl)
          ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
          : absolutePath;
        dependencies.add(directoryPath);
        return [];
      } else {
        // It's a regular file path
        dependencies.add(absolutePath);
        return [absolutePath];
      }
    };

    type ProviderReferenceContext =
      | 'provider'
      | 'http-provider'
      | 'config'
      | 'http-config'
      | 'http-validate-status'
      | 'assertion';
    const visitedFileValues = new WeakSet<object>();
    const visitedNestedFileValues = new WeakSet<object>();
    const visitedProviderValues = new WeakSet<object>();
    const visitedHttpProviderValues = new WeakSet<object>();
    const visitedProviderConfigValues = new WeakSet<object>();
    const visitedHttpProviderConfigValues = new WeakSet<object>();
    const inspectedNestedFiles = new Set<string>();
    const extractFileReferences = (
      value: unknown,
      inspectNestedFiles = false,
      providerContext?: ProviderReferenceContext,
    ): void => {
      const providerFileUrl =
        typeof value === 'string' &&
        (providerContext === 'provider' || providerContext === 'http-provider')
          ? getProviderFileUrl(value)
          : undefined;
      const fileValue = providerFileUrl ?? value;
      if (
        typeof value === 'string' &&
        (providerContext === 'provider' ||
          providerContext === 'http-provider') &&
        parseExecReference(value)?.hasArguments
      ) {
        addDependencyRootWatchers();
      }
      if (typeof fileValue === 'string' && fileValue.includes('file://')) {
        if (!isValidGlobLength(fileValue)) return;
        if (fileValue.includes('\0')) {
          resolveConfigDependency(fileValue, 'config file dependency');
          return;
        }
      }
      if (
        typeof fileValue === 'string' &&
        fileValue.includes('file://') &&
        hasDynamicFilePath(fileValue)
      ) {
        addDependencyRootWatchers();
      } else if (
        typeof fileValue === 'string' &&
        fileValue.startsWith('file://')
      ) {
        const selectorContext =
          providerContext === 'assertion'
            ? 'assertion'
            : providerContext === 'http-validate-status'
              ? 'http'
              : 'generic';
        for (const fileUrl of getFileReferenceCandidates(
          fileValue,
          selectorContext,
        )) {
          if (inspectNestedFiles && /\.(?:json|ya?ml)$/i.test(fileUrl)) {
            inspectNestedConfigFile(fileUrl, providerContext);
          } else {
            processFileUrl(fileUrl);
          }
        }
      } else if (Array.isArray(value)) {
        const visitedValues = !inspectNestedFiles
          ? visitedFileValues
          : providerContext === 'provider' ||
              providerContext === 'http-provider'
            ? visitedProviderValues
            : visitedNestedFileValues;
        if (visitedValues.has(value)) return;
        visitedValues.add(value);
        for (const item of value) {
          extractFileReferences(item, inspectNestedFiles, providerContext);
        }
      } else if (
        typeof value === 'object' &&
        value !== null &&
        !ArrayBuffer.isView(value)
      ) {
        const visitedValues = !inspectNestedFiles
          ? visitedFileValues
          : providerContext === 'provider'
            ? visitedProviderValues
            : providerContext === 'http-provider'
              ? visitedHttpProviderValues
              : providerContext === 'config'
                ? visitedProviderConfigValues
                : providerContext === 'http-config'
                  ? visitedHttpProviderConfigValues
                  : visitedNestedFileValues;
        if (visitedValues.has(value)) return;
        visitedValues.add(value);
        if ('file' in value && typeof value.file === 'string') {
          const hasValidFileLength = isValidGlobLength(value.file);
          if (hasValidFileLength && value.file.includes('\0')) {
            resolveConfigDependency(value.file, 'config file dependency');
          } else if (hasValidFileLength && !watchDynamicFilePath(value.file)) {
            const absolutePath = resolveConfigDependency(
              value.file,
              'config file dependency',
            );
            if (absolutePath) {
              dependencies.add(absolutePath);
            }
          }
        }
        if (
          'id' in value &&
          typeof value.id === 'string' &&
          (value.id.startsWith('file://') || getProviderFileUrl(value.id))
        ) {
          if (parseExecReference(value.id)?.hasArguments) {
            addDependencyRootWatchers();
          }
          const providerId = getProviderFileUrl(value.id) ?? value.id;
          for (const fileUrl of getFileReferenceCandidates(
            providerId,
            'generic',
          )) {
            if (inspectNestedFiles && /\.(?:json|ya?ml)$/i.test(fileUrl)) {
              inspectNestedConfigFile(fileUrl, 'provider');
            } else {
              processFileUrl(fileUrl);
            }
          }
        }
        const isProviderDefinition =
          (providerContext === 'provider' ||
            providerContext === 'http-provider') &&
          ('id' in value || 'config' in value);
        const isHttpProviderDefinition =
          providerContext === 'http-provider' ||
          ('id' in value &&
            (isHttpProviderId(value.id) ||
              (typeof value.id === 'string' && hasDynamicFilePath(value.id))));
        for (const [key, item] of Object.entries(value)) {
          if (providerContext === 'config' && key === 'validateStatus') {
            continue;
          }
          if (
            providerContext === 'http-config' &&
            (key === 'signatureAuth' || key === 'tls') &&
            item &&
            typeof item === 'object'
          ) {
            for (const [pathKey, pathValue] of Object.entries(item)) {
              if (
                HTTP_PROVIDER_FILE_PATH_KEYS.has(pathKey) &&
                typeof pathValue === 'string'
              ) {
                processFileUrl(
                  pathValue.startsWith('file://')
                    ? pathValue
                    : `file://${pathValue}`,
                );
              }
            }
          }
          if (
            providerContext === 'http-config' &&
            key === 'auth' &&
            item &&
            typeof item === 'object' &&
            'type' in item &&
            (item.type === 'file' ||
              (typeof item.type === 'string' &&
                hasDynamicFilePath(item.type))) &&
            'path' in item &&
            typeof item.path === 'string'
          ) {
            const fileUrl = item.path.startsWith('file://')
              ? item.path
              : `file://${item.path}`;
            for (const reference of getFileReferenceCandidates(
              fileUrl,
              'generic',
            )) {
              processFileUrl(reference);
            }
            continue;
          }
          if (
            providerContext === 'http-config' &&
            key === 'multipart' &&
            item &&
            typeof item === 'object' &&
            'parts' in item &&
            Array.isArray(item.parts)
          ) {
            for (const part of item.parts) {
              if (
                !part ||
                typeof part !== 'object' ||
                !('source' in part) ||
                !part.source ||
                typeof part.source !== 'object' ||
                !('type' in part.source) ||
                !('path' in part.source) ||
                typeof part.source.path !== 'string'
              ) {
                continue;
              }
              if (
                part.source.type === 'path' ||
                (typeof part.source.type === 'string' &&
                  hasDynamicFilePath(part.source.type))
              ) {
                processFileUrl(
                  part.source.path.startsWith('file://')
                    ? part.source.path
                    : `file://${part.source.path}`,
                );
              }
            }
          }
          const providerKey = getProviderFileUrl(key);
          if (inspectNestedFiles && parseExecReference(key)?.hasArguments) {
            addDependencyRootWatchers();
          }
          if (
            inspectNestedFiles &&
            (key.startsWith('file://') || providerKey)
          ) {
            for (const fileUrl of getFileReferenceCandidates(
              providerKey ?? key,
              'generic',
            )) {
              if (/\.(?:json|ya?ml)$/i.test(fileUrl)) {
                inspectNestedConfigFile(fileUrl, 'provider');
              } else {
                processFileUrl(fileUrl);
              }
            }
          }
          if (key !== 'file' && key !== 'id') {
            const nextProviderContext =
              providerContext === 'http-config' &&
              HTTP_PROVIDER_FUNCTION_KEYS.has(key)
                ? 'http-validate-status'
                : providerContext !== 'provider' &&
                    providerContext !== 'http-provider'
                  ? undefined
                  : key === 'config'
                    ? isHttpProviderDefinition
                      ? 'http-config'
                      : 'config'
                    : isProviderDefinition
                      ? undefined
                      : isHttpProviderId(key)
                        ? 'http-provider'
                        : providerContext;
            extractFileReferences(
              item,
              inspectNestedFiles,
              nextProviderContext,
            );
          }
        }
      }
    };

    const inspectNestedConfigFile = (
      fileUrl: string,
      providerContext?: ProviderReferenceContext,
    ): void => {
      const filePath = normalizeConfigFilePath(fileUrl.slice('file://'.length));
      if (!filePath || filePath.includes('\0')) {
        resolveConfigDependency(filePath, 'nested config file dependency');
        return;
      }
      const isNestedGlob = getGlobMagic(filePath);
      if (isNestedGlob === undefined) return;
      if (isNestedGlob) {
        const matches = processFileUrl(fileUrl);
        for (const match of matches) {
          if (/\.(?:json|ya?ml)$/i.test(match)) {
            inspectNestedConfigFile(`file://${match}`, providerContext);
          }
        }
        return;
      }
      const absolutePath = resolveConfigDependency(
        filePath,
        'nested config file dependency',
      );
      if (!absolutePath) return;
      processFileUrl(fileUrl, absolutePath);

      try {
        const realFilePath = fs.realpathSync(absolutePath);
        if (
          !realDependencyRoots.some((root) => isPathInside(root, realFilePath))
        ) {
          core.warning(
            'Ignoring unsafe nested config file: resolved path must stay within the repository workspace',
          );
          return;
        }
        const inspectedFileKey = `${realFilePath}:${providerContext ?? 'nested'}`;
        if (inspectedNestedFiles.has(inspectedFileKey)) return;
        if (inspectedNestedFiles.size >= MAX_NESTED_CONFIG_FILES) {
          addDependencyRootWatchers();
          core.warning(
            'Skipping config dependencies with too many nested files; conservatively watching the dependency root',
          );
          return;
        }
        inspectedNestedFiles.add(inspectedFileKey);
        if (!canReadStructuredFile(realFilePath)) return;
        extractFileReferences(
          loadYaml(fs.readFileSync(realFilePath, 'utf8'), {
            schema: CONFIG_SCHEMA,
          }),
          true,
          providerContext,
        );
      } catch {
        addDependencyRootWatchers();
        core.warning(
          'Failed to inspect nested config file; nested file dependencies may be incomplete',
        );
      }
    };

    for (const configuredProviders of [config.providers, config.targets]) {
      if (configuredProviders) {
        extractFileReferences(configuredProviders, true, 'provider');
      }
    }

    // Extract prompt files
    if (config.prompts) {
      const configuredPrompts =
        typeof config.prompts === 'string'
          ? [config.prompts]
          : Array.isArray(config.prompts)
            ? config.prompts
            : Object.keys(config.prompts);
      for (const configuredPrompt of configuredPrompts) {
        if (configuredPrompt == null) continue;
        const prompt =
          typeof configuredPrompt === 'object' &&
          (configuredPrompt.raw || configuredPrompt.id)
            ? configuredPrompt.raw || configuredPrompt.id
            : configuredPrompt;
        if (typeof prompt === 'string' && prompt.startsWith('file://')) {
          for (const fileUrl of getFileReferenceCandidates(prompt, 'generic')) {
            if (
              /\.(?:json|ya?ml)$/i.test(fileUrl) ||
              getGlobMagic(fileUrl.slice('file://'.length)) === true
            ) {
              inspectNestedConfigFile(fileUrl);
            } else {
              processFileUrl(fileUrl);
            }
          }
        } else if (
          typeof prompt === 'string' &&
          !prompt.includes('\n') &&
          !['portkey://', 'langfuse://', 'helicone://'].some((prefix) =>
            prompt.includes(prefix),
          ) &&
          (/[\\/]/.test(prompt) ||
            /\.[A-Za-z0-9]{1,5}(?::[^\\/]*)?$/.test(prompt) ||
            prompt.includes('*'))
        ) {
          const execReference = parseExecReference(prompt);
          if (execReference?.hasArguments) addDependencyRootWatchers();
          const promptPath = execReference?.filePath ?? prompt;
          const promptFileUrl = promptPath.startsWith('file://')
            ? promptPath
            : `file://${promptPath}`;
          for (const fileUrl of getFileReferenceCandidates(
            promptFileUrl,
            'generic',
          )) {
            if (
              /\.(?:json|ya?ml)$/i.test(fileUrl) ||
              getGlobMagic(fileUrl.slice('file://'.length)) === true
            ) {
              inspectNestedConfigFile(fileUrl);
            } else {
              processFileUrl(fileUrl);
            }
          }
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) dependencies.add(absolutePath);
          if (absolutePath && /\.(?:json|ya?ml)$/i.test(prompt.file)) {
            inspectNestedConfigFile(`file://${prompt.file}`);
          }
        }
      }
    }

    // Extract test variable files and inspect external variable maps.
    const inspectedVarFiles = new Set<string>();
    const inspectedVarPaths = new Set<string>();
    const visitedVarValues = new WeakSet<object>();
    const inspectVarFile = (value: string): void => {
      const rawFileUrl = value.startsWith('file://')
        ? value
        : `file://${value}`;
      const rawFilePath = normalizeConfigFilePath(
        rawFileUrl.slice('file://'.length),
      );
      if (!rawFilePath || rawFilePath.includes('\0')) {
        resolveConfigDependency(rawFilePath, 'test variable file dependency');
        return;
      }
      if (!isValidGlobLength(rawFilePath)) return;
      if (watchDynamicFilePath(rawFilePath)) return;
      const filePath = stripSpreadsheetSelector(rawFilePath);
      const fileUrl = `file://${filePath}`;
      const isVarGlob = getGlobMagic(filePath);
      if (isVarGlob === undefined) return;
      const absolutePath = isVarGlob
        ? path.resolve(dependencyBaseDir, filePath)
        : resolveConfigDependency(filePath, 'test variable file dependency');
      if (!absolutePath) return;
      if (inspectedVarPaths.has(absolutePath)) return;
      inspectedVarPaths.add(absolutePath);
      const varFiles = processFileUrl(fileUrl, absolutePath);
      for (const varFile of varFiles) {
        if (!/\.(?:json|ya?ml)$/i.test(varFile)) continue;
        if (inspectedVarFiles.has(varFile)) continue;
        inspectedVarFiles.add(varFile);
        try {
          const realVarFile = fs.realpathSync(varFile);
          if (
            !realDependencyRoots.some((root) => isPathInside(root, realVarFile))
          ) {
            core.warning(
              'Ignoring unsafe external vars file: resolved path must stay within the repository workspace',
            );
            continue;
          }
          if (!canReadStructuredFile(realVarFile)) continue;
          const vars = loadYaml(fs.readFileSync(realVarFile, 'utf8'), {
            schema: CONFIG_SCHEMA,
          });
          extractFileReferences(vars);
        } catch {
          addDependencyRootWatchers();
          core.warning(
            'Failed to inspect external vars file; nested file dependencies may be incomplete',
          );
        }
      }
    };
    const extractVarFiles = (vars?: unknown): void => {
      if (typeof vars === 'string') {
        inspectVarFile(vars);
        return;
      }
      if (Array.isArray(vars)) {
        if (visitedVarValues.has(vars)) return;
        visitedVarValues.add(vars);
        for (const value of vars) {
          if (typeof value === 'string') {
            inspectVarFile(value);
          }
        }
        return;
      }
      if (!vars || typeof vars !== 'object' || ArrayBuffer.isView(vars)) return;
      if (visitedVarValues.has(vars)) return;
      visitedVarValues.add(vars);
      for (const value of Object.values(vars)) {
        extractFileReferences(value);
      }
    };

    // Extract assert files
    const visitedAssertSets = new WeakSet<PromptfooAssertion[]>();
    const extractAssertFiles = (asserts?: PromptfooAssertion[]): void => {
      if (!Array.isArray(asserts) || visitedAssertSets.has(asserts)) return;
      visitedAssertSets.add(asserts);
      for (const assert of asserts) {
        if (!assert || typeof assert !== 'object') continue;
        extractFileReferences(assert.value, false, 'assertion');
        extractFileReferences(assert.provider, true, 'provider');
        extractFileReferences(assert.config);
        extractFileReferences(assert.rubricPrompt);
        extractFileReferences(assert.transform);
        extractFileReferences(assert.contextTransform);
        extractAssertFiles(assert.assert);
      }
    };

    const visitedOptionValues = new WeakSet<object>();
    const extractOptionsFiles = (
      options?: PromptfooTestConfig['options'],
    ): void => {
      if (!options || typeof options !== 'object') return;
      if (visitedOptionValues.has(options)) return;
      visitedOptionValues.add(options);
      for (const [key, value] of Object.entries(options)) {
        extractFileReferences(
          value,
          key === 'provider',
          key === 'provider' ? 'provider' : undefined,
        );
      }
    };

    const inspectedTestFiles = new Set<string>();
    const inspectTestFile = (
      value: string,
      rebaseNestedDependencies = true,
      inspectScenarios = false,
    ): void => {
      if (/^(?:https?:\/\/|az:\/\/|huggingface:\/\/)/i.test(value)) return;
      const rawFilePath = normalizeConfigFilePath(
        value.startsWith('file://') ? value.slice('file://'.length) : value,
      );
      if (!rawFilePath || rawFilePath.includes('\0')) {
        resolveConfigDependency(rawFilePath, 'test file dependency');
        return;
      }
      if (!isValidGlobLength(rawFilePath)) return;
      if (watchDynamicFilePath(rawFilePath)) return;

      const filePath = stripSpreadsheetSelector(rawFilePath);
      const references = getFileReferenceCandidates(
        `file://${filePath}`,
        'tests',
      );
      for (const reference of references) {
        const testFiles = processFileUrl(reference);
        for (const testFile of testFiles) {
          if (!/\.(?:json|ya?ml)$/i.test(testFile)) continue;
          let realTestFile: string;
          try {
            realTestFile = fs.realpathSync(testFile);
          } catch {
            addDependencyRootWatchers();
            core.warning(
              'Failed to inspect file-backed tests; nested test dependencies may be incomplete',
            );
            continue;
          }
          if (
            !realDependencyRoots.some((root) =>
              isPathInside(root, realTestFile),
            )
          ) {
            core.warning(
              'Ignoring unsafe file-backed tests: resolved path must stay within the repository workspace',
            );
            continue;
          }
          const inspectedTestFileKey = `${realTestFile}:${rebaseNestedDependencies}:${inspectScenarios}`;
          if (inspectedTestFiles.has(inspectedTestFileKey)) continue;
          if (inspectedTestFiles.size >= MAX_NESTED_TEST_FILES) {
            addDependencyRootWatchers();
            core.warning(
              'Skipping file-backed tests with too many nested files; conservatively watching the dependency root',
            );
            return;
          }
          inspectedTestFiles.add(inspectedTestFileKey);
          if (!canReadStructuredFile(realTestFile)) continue;
          const previousBaseDir = dependencyBaseDir;
          dependencyBaseDir = rebaseNestedDependencies
            ? path.dirname(testFile)
            : previousBaseDir;
          try {
            const parsedTests = loadYaml(
              fs.readFileSync(realTestFile, 'utf8'),
              { schema: CONFIG_SCHEMA },
            );
            if (inspectScenarios) {
              const scenarios = Array.isArray(parsedTests)
                ? parsedTests
                : [parsedTests];
              for (const scenario of scenarios) processScenario(scenario);
              continue;
            }
            const nestedTests =
              parsedTests &&
              typeof parsedTests === 'object' &&
              !Array.isArray(parsedTests) &&
              'tests' in parsedTests
                ? parsedTests.tests
                : parsedTests;
            if (Array.isArray(nestedTests)) {
              for (const test of nestedTests) {
                processTestConfig(test, rebaseNestedDependencies);
              }
            } else {
              processTestConfig(nestedTests, rebaseNestedDependencies);
            }
          } catch {
            addDependencyRootWatchers();
            core.warning(
              'Failed to inspect file-backed tests; nested test dependencies may be incomplete',
            );
          } finally {
            dependencyBaseDir = previousBaseDir;
          }
        }
      }
    };

    const processTestConfig = (
      test: unknown,
      rebaseNestedDependencies = true,
    ): void => {
      if (typeof test === 'string') {
        inspectTestFile(test, rebaseNestedDependencies);
        return;
      }
      if (!test || typeof test !== 'object' || ArrayBuffer.isView(test)) return;
      if ('path' in test && typeof test.path === 'string') {
        inspectTestFile(test.path, rebaseNestedDependencies);
        if ('config' in test) extractFileReferences(test.config);
        return;
      }
      const inlineTest = test as PromptfooTestConfig;
      extractVarFiles(inlineTest.vars);
      extractAssertFiles(inlineTest.assert);
      extractFileReferences(inlineTest.assertScoringFunction);
      extractFileReferences(inlineTest.provider, true, 'provider');
      extractOptionsFiles(inlineTest.options);
    };

    const processScenario = (scenario: unknown): void => {
      if (typeof scenario === 'string') {
        inspectTestFile(scenario, false, true);
        return;
      }
      if (!scenario || typeof scenario !== 'object') return;
      const scenarioConfig = scenario as { tests?: unknown; config?: unknown };
      for (const entries of [scenarioConfig.tests, scenarioConfig.config]) {
        if (Array.isArray(entries)) {
          for (const entry of entries) processTestConfig(entry);
        } else if (entries) {
          processTestConfig(entries, false);
        }
      }
    };

    // Process defaultTest
    if (config.defaultTest) {
      if (typeof config.defaultTest === 'string') {
        if (config.defaultTest.startsWith('file://')) {
          const defaultTestFile = config.defaultTest.slice('file://'.length);
          const hasInvalidDefaultTestPath =
            !defaultTestFile || defaultTestFile.includes('\0');
          if (hasInvalidDefaultTestPath) {
            resolveConfigDependency(
              defaultTestFile,
              'defaultTest file dependency',
            );
          }
          const isDefaultTestGlob =
            !hasInvalidDefaultTestPath && getGlobMagic(defaultTestFile);
          const hasDynamicDefaultTestPath =
            !hasInvalidDefaultTestPath &&
            isDefaultTestGlob !== undefined &&
            hasDynamicFilePath(defaultTestFile);
          const defaultTestPath =
            hasInvalidDefaultTestPath ||
            isDefaultTestGlob === undefined ||
            hasDynamicDefaultTestPath ||
            isDefaultTestGlob
              ? undefined
              : resolveConfigDependency(
                  defaultTestFile,
                  'defaultTest file dependency',
                );
          if (hasDynamicDefaultTestPath) {
            addDependencyRootWatchers();
          }
          if (
            !hasInvalidDefaultTestPath &&
            isDefaultTestGlob !== undefined &&
            !hasDynamicDefaultTestPath
          ) {
            processFileUrl(config.defaultTest);
          }
          if (defaultTestPath && !isDefaultTestGlob) {
            try {
              const realDefaultTestPath = fs.realpathSync(defaultTestPath);
              if (
                !realDependencyRoots.some((root) =>
                  isPathInside(root, realDefaultTestPath),
                )
              ) {
                core.warning(
                  'Ignoring unsafe file-backed defaultTest: resolved path must stay within the repository workspace',
                );
              } else if (canReadStructuredFile(realDefaultTestPath)) {
                const defaultTest = loadYaml(
                  fs.readFileSync(realDefaultTestPath, 'utf8'),
                  { schema: CONFIG_SCHEMA },
                ) as PromptfooConfig['defaultTest'];
                if (
                  defaultTest &&
                  typeof defaultTest === 'object' &&
                  !Array.isArray(defaultTest)
                ) {
                  extractVarFiles(defaultTest.vars);
                  extractAssertFiles(defaultTest.assert);
                  extractFileReferences(defaultTest.assertScoringFunction);
                  extractFileReferences(defaultTest.provider, true, 'provider');
                  extractOptionsFiles(defaultTest.options);
                }
              }
            } catch {
              addDependencyRootWatchers();
              core.warning(
                'Failed to inspect file-backed defaultTest; nested file dependencies may be incomplete',
              );
            }
          }
        }
      } else if (
        typeof config.defaultTest === 'object' &&
        !Array.isArray(config.defaultTest)
      ) {
        extractVarFiles(config.defaultTest.vars);
        extractAssertFiles(config.defaultTest.assert);
        extractFileReferences(config.defaultTest.assertScoringFunction);
        extractFileReferences(config.defaultTest.provider, true, 'provider');
        extractOptionsFiles(config.defaultTest.options);
      }
    }

    // Process tests
    if (Array.isArray(config.tests)) {
      for (const test of config.tests) {
        processTestConfig(test);
      }
    } else if (
      config.tests &&
      (typeof config.tests === 'string' || typeof config.tests === 'object')
    ) {
      processTestConfig(config.tests);
    } else if (config.tests) {
      throw new Error('config.tests is not iterable');
    }

    if (Array.isArray(config.scenarios)) {
      for (const scenario of config.scenarios) {
        processScenario(scenario);
      }
    }

    if (config.nunjucksFilters) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        processFileUrl(`file://${filterPath}`);
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      const repositoryPath = relativePath.split(path.sep).join('/');
      if (!repositoryPath) return './';
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(
      `Failed to extract dependencies from config: ${JSON.stringify(reason)}`,
    );
    return parsedConfig ? ['./'] : [];
  }
}
