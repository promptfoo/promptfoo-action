import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import {
  binaryTag,
  CORE_SCHEMA,
  defineMappingTag,
  legacyMapTag,
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
import { normalizeGlobSeparators, preflightGlob } from './glob';

type PromptEntry =
  | string
  | { file?: string; id?: string; raw?: string; [key: string]: unknown };
type ProviderEntry = string | { id?: string; [key: string]: unknown };
type TestVars = string | string[] | { [key: string]: unknown };
type TestAssertion = {
  type?: string;
  value?: string | { file?: string };
  provider?: unknown;
  contextTransform?: unknown;
  transform?: unknown;
  rubricPrompt?: unknown;
  assert?: TestAssertion[];
};

type LegacyYamlSet = Record<string, unknown>;
const MAX_BRACE_EXPANSIONS = 1024;
const MAX_DEPENDENCY_REFERENCE_LENGTH = 65_536;
const MAX_STRUCTURED_PROMPT_FILE_SIZE = 10 * 1024 * 1024;
const PROVIDER_SELECTOR_EXTENSIONS = new Set([
  'cjs',
  'cts',
  'js',
  'mjs',
  'mts',
  'py',
  'ts',
  'go',
  'rb',
]);
const ASSERTION_SELECTOR_EXTENSIONS = new Set([
  'cjs',
  'cts',
  'js',
  'mjs',
  'mts',
  'py',
  'ts',
  'rb',
]);
const JAVASCRIPT_SELECTOR_EXTENSIONS = new Set([
  'cjs',
  'cts',
  'js',
  'mjs',
  'mts',
  'ts',
]);
const TRANSFORM_SELECTOR_EXTENSIONS = new Set([
  ...JAVASCRIPT_SELECTOR_EXTENSIONS,
  'py',
]);
const JAVASCRIPT_FILE_REFERENCE_FIELDS = new Set([
  'validateStatus',
  'transformRequest',
  'transformResponse',
  'responseParser',
  'sessionParser',
]);
const PROMPT_FILE_EXTENSIONS = new Set([
  'cjs',
  'csv',
  'cts',
  'exe',
  'js',
  'json',
  'jsonl',
  'j2',
  'md',
  'mjs',
  'mts',
  'py',
  'ts',
  'txt',
  'yml',
  'yaml',
  'sh',
  'bash',
  'bat',
  'cmd',
  'ps1',
  'rb',
  'pl',
]);
const GLOB_MAGIC_OPTIONS = {
  magicalBraces: true,
  nonegate: true,
  braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
};
const EXPANDED_GLOB_MAGIC_OPTIONS = {
  ...GLOB_MAGIC_OPTIONS,
  nobrace: true,
};
const GLOB_SYNC_OPTIONS = {
  nodir: true,
  windowsPathsNoEscape: path.sep === '\\',
  nobrace: true,
  braceExpandMax: MAX_BRACE_EXPANSIONS,
};

const legacySetTag = defineMappingTag<LegacyYamlSet>('tag:yaml.org,2002:set', {
  ...legacyMapTag,
  identify: setTag.identify,
  represent: setTag.represent,
  addPair: (container, key, value) => {
    if (value !== null) {
      return 'cannot resolve a set item';
    }
    return legacyMapTag.addPair(container, key, null);
  },
});

const CONFIG_YAML_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  binaryTag,
  timestampTag,
  omapTag,
  pairsTag,
  legacySetTag,
);

export interface PromptfooConfig {
  providers?: ProviderEntry | ProviderEntry[];
  targets?: ProviderEntry | ProviderEntry[];
  prompts?: string | PromptEntry[] | Record<string, string>;
  tests?: unknown;
  scenarios?: unknown;
  nunjucksFilters?: Record<string, string>;
  extensions?: unknown;
  defaultTest?: {
    vars?: TestVars;
    assert?: TestAssertion[];
    assertScoringFunction?: unknown;
    options?: Record<string, unknown>;
  };
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

function isTraversableRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}

function compactTemplateWhitespace(value: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('{{', cursor);
    if (start < 0) {
      result += value.slice(cursor);
      break;
    }
    const end = value.indexOf('}', start + 2);
    if (end < 0) {
      result += value.slice(cursor);
      break;
    }
    if (value.charAt(end + 1) !== '}') {
      result += value.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }
    result += value.slice(cursor, start);
    result += value.slice(start, end + 2).replace(/\s+/g, '');
    cursor = end + 2;
  }
  return result;
}

function stripFunctionSelector(
  value: string,
  extensions: Set<string>,
  caseInsensitive = false,
): string {
  if (
    value.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    return value;
  }
  let extensionIndex = -1;
  let selectorIndex = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (character === '.') {
      extensionIndex = index;
      continue;
    }
    if (character !== ':' || index === value.length - 1) {
      continue;
    }
    const extensionLength = index - extensionIndex - 1;
    if (extensionIndex < 0 || extensionLength < 1 || extensionLength > 5) {
      continue;
    }
    const extension = value.slice(extensionIndex + 1, index);
    const normalizedExtension = caseInsensitive
      ? extension.toLowerCase()
      : extension;
    if (extensions.has(normalizedExtension)) {
      selectorIndex = index;
    }
  }
  return selectorIndex >= 0 ? value.slice(0, selectorIndex) : value;
}

function hasPromptFileExtension(value: string): boolean {
  if (
    value.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    return false;
  }
  const separatorIndex = Math.max(
    value.lastIndexOf('/'),
    value.lastIndexOf('\\'),
  );
  const candidate = stripFunctionSelector(value, PROMPT_FILE_EXTENSIONS, true);
  const extensionIndex = candidate.lastIndexOf('.');
  return (
    extensionIndex > separatorIndex &&
    PROMPT_FILE_EXTENSIONS.has(
      candidate.slice(extensionIndex + 1).toLowerCase(),
    )
  );
}

function stripSpreadsheetSheetSelector(value: string): string {
  const sheetIndex = value.indexOf('#');
  if (sheetIndex < 0) return value;
  const candidate = value.slice(0, sheetIndex);
  const extensionIndex = candidate.lastIndexOf('.');
  if (extensionIndex < 0) return value;
  const extension = candidate.slice(extensionIndex + 1).toLowerCase();
  return extension === 'xlsx' || extension === 'xls' ? candidate : value;
}

function isUnsupportedForeignPath(value: string): boolean {
  const drivePath = /^\/[A-Za-z]:[\\/]/.test(value) ? value.slice(1) : value;
  const driveLetter = drivePath.charAt(0);
  const hasDrivePrefix =
    drivePath.charAt(1) === ':' &&
    ((driveLetter >= 'A' && driveLetter <= 'Z') ||
      (driveLetter >= 'a' && driveLetter <= 'z'));
  const isDriveAbsolute =
    hasDrivePrefix &&
    (drivePath.charAt(2) === '/' || drivePath.charAt(2) === '\\');
  const isUncPath =
    value.startsWith('\\\\') ||
    (value.startsWith('//') && value.indexOf('/', 2) > 2);
  return path.sep === '/' && (isDriveAbsolute || isUncPath);
}

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(
  configPath: string,
  executionCwd = process.cwd(),
): string[] {
  const dependencies = new Set<string>();
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  const dependencyRoots =
    dependencyRoot === cwd ? [dependencyRoot] : [dependencyRoot, cwd];
  const isInsideDependencyRoots = (filePath: string): boolean =>
    dependencyRoots.some((root) => isPathInside(root, filePath));
  let physicalDependencyRoots: string[] | undefined;
  const isInsidePhysicalDependencyRoots = (filePath: string): boolean => {
    if (!physicalDependencyRoots) {
      physicalDependencyRoots = [];
      for (const root of dependencyRoots) {
        try {
          physicalDependencyRoots.push(fs.realpathSync(root));
        } catch {
          // Another configured root may still safely contain this dependency.
        }
      }
    }
    return physicalDependencyRoots.some((root) => isPathInside(root, filePath));
  };
  let parsedConfig = false;
  let warnedForeignAbsoluteDependency = false;
  const warnForeignAbsoluteDependency = (): void => {
    if (warnedForeignAbsoluteDependency) return;
    warnedForeignAbsoluteDependency = true;
    core.warning(
      'Ignoring unsafe config dependency: foreign absolute paths are not supported',
    );
  };

  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    if (!configContent.trim()) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const config = loadYaml(configContent, {
      schema: CONFIG_YAML_SCHEMA,
    }) as PromptfooConfig;

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }
    parsedConfig = true;

    const resolveConfigDependency = (
      filePath: string,
      source: string,
    ): string | undefined => {
      if (isUnsupportedForeignPath(filePath)) {
        warnForeignAbsoluteDependency();
        return undefined;
      }
      try {
        if (!filePath) {
          throw new Error(`${source} is empty`);
        }
        if (filePath.includes('\0')) {
          throw new Error(`${source} contains an invalid null byte`);
        }

        const absolutePath = path.isAbsolute(filePath)
          ? path.resolve(filePath)
          : path.resolve(path.join(configDir, filePath));
        if (!isInsideDependencyRoots(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency "${filePath}": ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): string[] | undefined => {
      const filePath = normalizeGlobSeparators(
        fileUrl.replace('file://', ''),
        path.sep === '\\',
      );
      if (filePath.includes('\0')) {
        core.warning(
          'Ignoring unsafe config dependency: config file dependency contains an invalid null byte',
        );
        return;
      }
      if (isUnsupportedForeignPath(filePath)) {
        warnForeignAbsoluteDependency();
        return;
      }
      if (
        filePath.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
        filePath.includes('\r') ||
        filePath.includes('\n')
      ) {
        core.warning(
          'Ignoring invalid config dependency glob; preserving other dependencies',
        );
        return;
      }

      try {
        const isTemplatedPath = /\{[{%#]/.test(filePath);
        if (!isTemplatedPath) {
          const globPreflight = preflightGlob(filePath, {
            maxLength: MAX_DEPENDENCY_REFERENCE_LENGTH,
            maxBraceExpansions: MAX_BRACE_EXPANSIONS,
          });
          if (globPreflight === 'invalid') {
            core.warning(
              'Ignoring invalid config dependency glob; preserving other dependencies',
            );
            return;
          }
          if (globPreflight === 'too-many-braces') {
            dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
            core.warning(
              'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
            );
            return;
          }
        }

        // Check if the path contains glob patterns
        if (!isTemplatedPath && glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS)) {
          const expandedPaths = braceExpand(filePath, {
            braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
          });
          if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
            dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
            core.warning(
              'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
            );
            return;
          }

          const safePatterns: string[] = [];
          let unsafeAlternative = false;
          for (const expandedPath of expandedPaths) {
            const absolutePattern = path.resolve(configDir, expandedPath);
            if (isInsideDependencyRoots(absolutePattern)) {
              safePatterns.push(absolutePattern);
            } else {
              unsafeAlternative = true;
            }
          }
          if (unsafeAlternative) {
            core.warning(
              'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
            );
          }
          if (safePatterns.length === 0) {
            return;
          }

          const matches = glob.sync(
            safePatterns.length === 1 ? safePatterns[0] : safePatterns,
            GLOB_SYNC_OPTIONS,
          );
          for (const match of matches) {
            const absoluteMatch = path.resolve(match);
            if (!isInsideDependencyRoots(absoluteMatch)) {
              core.warning(
                'Ignoring unsafe config dependency glob match: resolved path must stay within the repository workspace',
              );
              continue;
            }
            try {
              const physicalMatch = fs.realpathSync(absoluteMatch);
              if (!isInsidePhysicalDependencyRoots(physicalMatch)) {
                core.warning(
                  'Ignoring unsafe config dependency glob match: resolved path must stay within the repository workspace',
                );
                continue;
              }
              dependencies.add(absoluteMatch);
            } catch {
              core.warning(
                'Ignoring unreadable config dependency glob match: unable to resolve path',
              );
            }
          }

          for (const absolutePattern of safePatterns) {
            if (!glob.hasMagic(absolutePattern, EXPANDED_GLOB_MAGIC_OPTIONS)) {
              dependencies.add(absolutePattern);
              continue;
            }
            const absoluteRoot = path.parse(absolutePattern).root;
            const pathParts = path
              .relative(absoluteRoot, absolutePattern)
              .split(path.sep);
            let basePath = absoluteRoot;
            for (const part of pathParts) {
              if (glob.hasMagic(part, EXPANDED_GLOB_MAGIC_OPTIONS)) {
                break;
              }
              basePath = path.join(basePath, part);
            }
            dependencies.add(
              path.relative(cwd, basePath) === ''
                ? absolutePattern
                : matches.length === 0
                  ? `${basePath.replace(/[\\/]+$/, '')}${path.sep}`
                  : basePath,
            );
          }
          return safePatterns;
        }

        const absolutePath = resolveConfigDependency(
          filePath,
          'config file dependency',
        );
        if (!absolutePath) {
          return;
        }

        if (isDirectory(absolutePath)) {
          // It's a directory, preserve trailing slash if it was there
          const directoryPath = fileUrl.endsWith('/')
            ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
            : absolutePath;
          dependencies.add(directoryPath);
        } else {
          // It's a regular file path
          dependencies.add(absolutePath);
        }
        return [absolutePath];
      } catch {
        core.warning(
          'Ignoring invalid config dependency glob; preserving other dependencies',
        );
      }
    };

    // Extract provider and target files
    const stripProviderFunctionSelector = (value: string): string =>
      stripFunctionSelector(value, PROVIDER_SELECTOR_EXTENSIONS);
    const stripAssertionFunctionSelector = (value: string): string =>
      stripFunctionSelector(value, ASSERTION_SELECTOR_EXTENSIONS);
    const stripJavascriptFunctionSelector = (value: string): string =>
      stripFunctionSelector(value, JAVASCRIPT_SELECTOR_EXTENSIONS);
    const stripTransformFunctionSelector = (value: string): string =>
      stripFunctionSelector(value, TRANSFORM_SELECTOR_EXTENSIONS);
    const processCompatibleFileUrl = (
      value: string,
      stripReferenceSelector = stripProviderFunctionSelector,
    ): string[] | undefined => {
      const primary = stripReferenceSelector(value);
      const patterns = processFileUrl(primary);
      const selectorSuffix = value.slice(primary.length + 1);
      if (
        stripReferenceSelector === stripProviderFunctionSelector &&
        primary !== value &&
        (/[\\/]/.test(selectorSuffix) ||
          (primary.endsWith('.rb') && selectorSuffix.includes(':')))
      ) {
        processFileUrl(value);
      }
      const latestJavascriptPath =
        primary === value
          ? stripFunctionSelector(value, JAVASCRIPT_SELECTOR_EXTENSIONS, true)
          : primary;
      if (latestJavascriptPath !== value && latestJavascriptPath !== primary) {
        processFileUrl(latestJavascriptPath);
      }
      return patterns;
    };
    const processFileBackedProviderReference = (value: string): void => {
      const prefix = ['python:', 'golang:', 'ruby:', 'exec:'].find(
        (candidate) => value.startsWith(candidate),
      );
      if (prefix) {
        const providerPath = value.slice(prefix.length);
        processCompatibleFileUrl(
          providerPath.startsWith('file://')
            ? providerPath
            : `file://${providerPath}`,
        );
      }
    };
    const watchExternalProviderConfig = (value: string): void => {
      if (
        value.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
        value.includes('\0') ||
        value.includes('\r') ||
        value.includes('\n')
      ) {
        return;
      }
      if (/[.{,(|](?:ya?ml|jsonl?)(?=$|[},:#?|)])/i.test(value)) {
        dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
      }
    };
    const visitedProviderValues = new WeakSet<object>();
    const visitProviderReferences = (
      value: unknown,
      fieldName?: string,
    ): void => {
      if (typeof value === 'string' && value.startsWith('file://')) {
        processCompatibleFileUrl(
          value,
          JAVASCRIPT_FILE_REFERENCE_FIELDS.has(fieldName ?? '')
            ? stripJavascriptFunctionSelector
            : stripProviderFunctionSelector,
        );
      } else if (Array.isArray(value)) {
        if (visitedProviderValues.has(value)) {
          return;
        }
        visitedProviderValues.add(value);
        for (const nestedValue of value) {
          visitProviderReferences(nestedValue, fieldName);
        }
      } else if (isTraversableRecord(value)) {
        if (visitedProviderValues.has(value)) {
          return;
        }
        visitedProviderValues.add(value);
        for (const [nestedFieldName, nestedValue] of Object.entries(value)) {
          visitProviderReferences(nestedValue, nestedFieldName);
        }
      }
    };

    const addHttpProviderPath = (
      value: unknown,
      stripFunctionSelector = stripProviderFunctionSelector,
    ): void => {
      if (typeof value !== 'string' || !value) {
        return;
      }
      const rawFilePath = value.replace(/^file:\/\//, '').replace(/\\/g, '/');
      const filePath = stripFunctionSelector(rawFilePath);
      const staticSegments: string[] = [];
      for (const segment of filePath.split('/')) {
        if (/\{[{%#]/.test(segment)) {
          break;
        }
        staticSegments.push(segment);
      }
      const hasTemplate = staticSegments.length < filePath.split('/').length;
      const staticPath = hasTemplate
        ? staticSegments.length > 0
          ? staticSegments.join('/')
          : '.'
        : filePath;
      const absolutePath = path.isAbsolute(staticPath)
        ? path.resolve(staticPath)
        : path.resolve(path.join(configDir, staticPath));
      if (filePath.includes('\0') || !isInsideDependencyRoots(absolutePath)) {
        core.warning(
          'Ignoring unsafe HTTP provider file dependency: path must stay within the repository workspace',
        );
        return;
      }
      if (isUnsupportedForeignPath(filePath)) {
        warnForeignAbsoluteDependency();
        return;
      }
      if (hasTemplate) {
        dependencies.add(`${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`);
        return;
      }
      processCompatibleFileUrl(`file://${rawFilePath}`, stripFunctionSelector);
    };

    for (const providers of [config.providers, config.targets]) {
      const providerEntries =
        typeof providers === 'string'
          ? [providers]
          : Array.isArray(providers)
            ? providers
            : isTraversableRecord(providers)
              ? [providers]
              : [];
      for (const provider of providerEntries) {
        visitProviderReferences(provider);
        if (typeof provider === 'string') {
          processFileBackedProviderReference(provider);
          watchExternalProviderConfig(provider);
        }
        if (!isTraversableRecord(provider)) {
          continue;
        }

        const mappedProvider = Object.entries(provider);
        if (
          mappedProvider.length === 1 &&
          mappedProvider[0][0].startsWith('file://')
        ) {
          processCompatibleFileUrl(mappedProvider[0][0]);
          watchExternalProviderConfig(mappedProvider[0][0]);
        }
        const providerId =
          typeof provider.id === 'string'
            ? provider.id
            : mappedProvider.length === 1
              ? mappedProvider[0][0]
              : undefined;
        const providerOptions =
          typeof provider.id === 'string'
            ? provider
            : mappedProvider.length === 1 &&
                isTraversableRecord(mappedProvider[0][1])
              ? mappedProvider[0][1]
              : undefined;
        if (providerId) {
          processFileBackedProviderReference(providerId);
          watchExternalProviderConfig(providerId);
        }
        if (
          !providerId ||
          (!/^https?(?::|$)/.test(providerId) && !/\{[{%#]/.test(providerId)) ||
          !providerOptions ||
          !isTraversableRecord(providerOptions.config)
        ) {
          continue;
        }

        const { auth, tls, signatureAuth, validateStatus, multipart } =
          providerOptions.config;
        if (
          typeof validateStatus === 'string' &&
          validateStatus.startsWith('file://')
        ) {
          addHttpProviderPath(validateStatus, stripJavascriptFunctionSelector);
        }
        if (
          isTraversableRecord(auth) &&
          (auth.type === 'file' ||
            (typeof auth.type === 'string' && /\{[{%#]/.test(auth.type)))
        ) {
          addHttpProviderPath(auth.path);
        }
        if (isTraversableRecord(tls)) {
          for (const key of [
            'caPath',
            'certPath',
            'keyPath',
            'pfxPath',
            'jksPath',
          ]) {
            addHttpProviderPath(tls[key]);
          }
        }
        if (isTraversableRecord(signatureAuth)) {
          for (const key of [
            'privateKeyPath',
            'keystorePath',
            'pfxPath',
            'certPath',
            'keyPath',
          ]) {
            addHttpProviderPath(signatureAuth[key]);
          }
        }
        if (isTraversableRecord(multipart) && Array.isArray(multipart.parts)) {
          for (const part of multipart.parts) {
            if (!isTraversableRecord(part)) continue;
            const isFilePart =
              part.kind === 'file' ||
              (typeof part.kind === 'string' && /\{[{%#]/.test(part.kind));
            if (!isFilePart || !isTraversableRecord(part.source)) continue;
            const isPathSource =
              part.source.type === 'path' ||
              (typeof part.source.type === 'string' &&
                /\{[{%#]/.test(part.source.type));
            if (isPathSource) addHttpProviderPath(part.source.path);
          }
        }
      }
    }

    // Extract prompt files
    if (config.prompts) {
      const prompts =
        typeof config.prompts === 'string'
          ? [config.prompts]
          : Array.isArray(config.prompts)
            ? config.prompts
            : isTraversableRecord(config.prompts)
              ? Object.keys(config.prompts)
              : [];

      const visitedPromptFiles = new Set<string>();
      const resolvePromptProbe = (
        filePath: string,
        baseDir = configDir,
      ): string | undefined => {
        if (
          !filePath ||
          filePath.includes('\0') ||
          isUnsupportedForeignPath(filePath)
        ) {
          return undefined;
        }
        const absolutePath = path.isAbsolute(filePath)
          ? path.resolve(filePath)
          : path.resolve(path.join(baseDir, filePath));
        return isInsideDependencyRoots(absolutePath) ? absolutePath : undefined;
      };
      const processPromptReference = (
        reference: string,
        declaredFile = false,
        promptExecutionCwd = executionCwd,
      ): void => {
        const isExecutable = reference.startsWith('exec:');
        const isFileUrl = reference.startsWith('file://');
        const isTemplated = !isExecutable && /\{[{%#]/.test(reference);
        const isEnvironmentTemplate =
          /^\s*\{\{-?\s*env(?:\.|\s*\[)[^}]*-?\}\}\s*$/.test(reference);
        if (isTemplated && !isFileUrl && reference.includes('file://')) {
          dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
          return;
        }
        if (
          !declaredFile &&
          !isExecutable &&
          !isFileUrl &&
          (reference.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
            ['\n', 'portkey://', 'langfuse://', 'helicone://'].some((value) =>
              reference.includes(value),
            ))
        ) {
          return;
        }
        if (
          !declaredFile &&
          !isExecutable &&
          !isFileUrl &&
          /\s/.test(reference) &&
          /(?:^|\s)(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(reference) &&
          !/^\s*(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(reference)
        ) {
          return;
        }
        let referenceHasMagic = false;
        if (
          !reference.includes('*') &&
          !reference.includes('\0') &&
          !/\s/.test(reference) &&
          !isTemplated
        ) {
          const referencePreflight = preflightGlob(reference, {
            maxLength: MAX_DEPENDENCY_REFERENCE_LENGTH,
            maxBraceExpansions: MAX_BRACE_EXPANSIONS,
            windowsPathsNoEscape: path.sep === '\\',
          });
          referenceHasMagic =
            referencePreflight === 'too-many-braces' ||
            (referencePreflight === 'safe' &&
              glob.hasMagic(reference, GLOB_MAGIC_OPTIONS));
        }
        const looksLikePath =
          declaredFile ||
          isExecutable ||
          isFileUrl ||
          isEnvironmentTemplate ||
          (reference.includes('*') &&
            (/\*+\.(?:[A-Za-z0-9_-]|\{|@\()/.test(reference) ||
              /^[^*]*\*+$/.test(reference) ||
              (!/\s/.test(reference) && /\*\([^/]*\)/.test(reference)))) ||
          referenceHasMagic ||
          (/[\\/]/.test(reference) && !/\s/.test(reference)) ||
          hasPromptFileExtension(reference);

        if (!looksLikePath) {
          const candidatePath = resolvePromptProbe(reference);
          const hasShortExtension =
            reference.charAt(reference.length - 3) === '.' ||
            reference.charAt(reference.length - 4) === '.';
          if (!candidatePath) {
            return;
          }
          if (!fs.existsSync(candidatePath)) {
            if (!hasShortExtension) {
              return;
            }
          } else {
            try {
              const candidateStats = fs.statSync(candidatePath);
              if (
                !candidateStats.isFile() ||
                (candidateStats.mode & 0o111) === 0
              ) {
                return;
              }
            } catch {
              return;
            }
          }
        }

        const executableParts = isExecutable
          ? (
              compactTemplateWhitespace(reference.replace(/^exec:/, '')).match(
                /[^\s"']+|"[^"]*"|'[^']*'/g,
              ) ?? []
            ).map((part) => part.replace(/^['"]|['"]$/g, ''))
          : [];
        const rawPromptPath = (
          isExecutable ? (executableParts[0] ?? '') : reference
        ).replace(/^file:\/\//, '');
        const promptPath = stripFunctionSelector(
          normalizeGlobSeparators(rawPromptPath, path.sep === '\\'),
          PROVIDER_SELECTOR_EXTENSIONS,
        );
        const promptPatterns = processCompatibleFileUrl(
          `file://${rawPromptPath}`,
        );
        if (promptPath.includes('\0')) {
          return;
        }

        for (const rawExecutableArgument of executableParts.slice(1)) {
          const equalsIndex = rawExecutableArgument.indexOf('=');
          const executableArgument =
            rawExecutableArgument.startsWith('-') && equalsIndex >= 0
              ? rawExecutableArgument.slice(equalsIndex + 1)
              : rawExecutableArgument;
          if (/\{[{%#]/.test(executableArgument)) {
            const staticSegments: string[] = [];
            for (const segment of executableArgument.split(/[\\/]/)) {
              if (/\{[{%#]/.test(segment)) {
                break;
              }
              staticSegments.push(segment);
            }
            const watchedDirectory = resolvePromptProbe(
              staticSegments.length > 0 ? staticSegments.join(path.sep) : '.',
              promptExecutionCwd,
            );
            if (watchedDirectory) {
              dependencies.add(
                `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
              );
            }
            continue;
          }
          const argumentPath = resolvePromptProbe(
            executableArgument,
            promptExecutionCwd,
          );
          if (!argumentPath) {
            continue;
          }
          if (!fs.existsSync(argumentPath)) {
            const hasShortExtension =
              executableArgument.charAt(executableArgument.length - 3) ===
                '.' ||
              executableArgument.charAt(executableArgument.length - 4) === '.';
            const looksLikeFileArgument =
              !executableArgument.startsWith('-') &&
              (/[\\/]/.test(executableArgument) ||
                hasShortExtension ||
                /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|bat|cmd|ps1|rb|pl)$/i.test(
                  executableArgument,
                ));
            if (looksLikeFileArgument) {
              dependencies.add(argumentPath);
            }
            continue;
          }
          try {
            if (fs.statSync(argumentPath).isFile()) {
              dependencies.add(argumentPath);
            }
          } catch {
            // Ignore unreadable arguments while preserving other dependencies.
          }
        }

        if (isTemplated) {
          const staticSegments: string[] = [];
          for (const segment of promptPath.split(/[\\/]/)) {
            if (/\{[{%#]/.test(segment)) {
              break;
            }
            staticSegments.push(segment);
          }
          const watchedDirectory =
            staticSegments.length === 0
              ? dependencyRoot
              : resolveConfigDependency(
                  staticSegments.join(path.sep),
                  'prompt file dependency',
                );
          if (watchedDirectory) {
            dependencies.add(
              `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
            );
          }
          return;
        }

        let isPromptGlob: boolean;
        try {
          if (
            preflightGlob(promptPath, {
              maxLength: MAX_DEPENDENCY_REFERENCE_LENGTH,
              maxBraceExpansions: MAX_BRACE_EXPANSIONS,
            }) !== 'safe'
          ) {
            return;
          }
          isPromptGlob = glob.hasMagic(promptPath, GLOB_MAGIC_OPTIONS);
        } catch {
          return;
        }
        const isStructuredPrompt = /\.(?:json|ya?ml)$/i.test(promptPath);
        const hasFixedExtension = /\.[A-Za-z0-9_-]+$/.test(promptPath);
        if (!isStructuredPrompt && (!isPromptGlob || hasFixedExtension)) {
          return;
        }

        const absolutePath = resolveConfigDependency(
          promptPath,
          'prompt file dependency',
        );
        if (!absolutePath) {
          return;
        }
        let promptFiles: string[];
        if (isPromptGlob) {
          if (!promptPatterns?.length) {
            return;
          }
          promptFiles = glob.sync(
            promptPatterns.length === 1 ? promptPatterns[0] : promptPatterns,
            GLOB_SYNC_OPTIONS,
          );
        } else {
          promptFiles = [absolutePath];
        }
        for (const promptFile of promptFiles) {
          const absolutePromptFile = path.resolve(promptFile);
          if (
            !isInsideDependencyRoots(absolutePromptFile) ||
            !/\.(?:json|ya?ml)$/i.test(absolutePromptFile)
          ) {
            continue;
          }

          try {
            if (!isPromptGlob && !fs.existsSync(absolutePromptFile)) {
              try {
                fs.lstatSync(absolutePromptFile);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                  continue;
                }
                throw error;
              }
            }
            const physicalPromptFile = fs.realpathSync(absolutePromptFile);
            if (!isInsidePhysicalDependencyRoots(physicalPromptFile)) {
              core.warning(
                isPromptGlob
                  ? 'Ignoring unsafe prompt file dependency glob match: resolved path must stay within the repository workspace'
                  : `Ignoring unsafe prompt file dependency "${promptPath}": resolved path must stay within the repository workspace`,
              );
              continue;
            }
            if (visitedPromptFiles.has(physicalPromptFile)) {
              continue;
            }
            visitedPromptFiles.add(physicalPromptFile);

            if (
              fs.statSync(physicalPromptFile).size >
              MAX_STRUCTURED_PROMPT_FILE_SIZE
            ) {
              dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
              core.warning(
                'Skipping oversized structured prompt dependency; nested references will not be inspected',
              );
              continue;
            }

            const nestedConfig = loadYaml(
              fs.readFileSync(physicalPromptFile, 'utf8'),
              { schema: CONFIG_YAML_SCHEMA },
            );
            const visitedNestedValues = new WeakSet<object>();
            const visitNestedReferences = (value: unknown): void => {
              if (typeof value === 'string' && value.startsWith('file://')) {
                processPromptReference(value);
              } else if (Array.isArray(value)) {
                if (visitedNestedValues.has(value)) {
                  return;
                }
                visitedNestedValues.add(value);
                for (const nestedValue of value) {
                  visitNestedReferences(nestedValue);
                }
              } else if (isTraversableRecord(value)) {
                if (visitedNestedValues.has(value)) {
                  return;
                }
                visitedNestedValues.add(value);
                for (const nestedValue of Object.values(value)) {
                  visitNestedReferences(nestedValue);
                }
              }
            };
            visitNestedReferences(nestedConfig);
          } catch {
            dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
            core.warning(
              isPromptGlob
                ? 'Failed to inspect prompt file dependency glob match: unable to read or parse file'
                : `Failed to inspect prompt file dependency "${promptPath}": unable to read or parse file`,
            );
          }
        }
      };

      for (const prompt of prompts) {
        if (typeof prompt === 'string') {
          processPromptReference(prompt);
        } else if (typeof prompt === 'object' && prompt !== null) {
          const promptReference = prompt.raw || prompt.file || prompt.id;
          if (typeof promptReference === 'string') {
            const promptConfig = prompt.config;
            const promptBasePath =
              typeof promptConfig === 'object' &&
              promptConfig !== null &&
              'basePath' in promptConfig &&
              typeof promptConfig.basePath === 'string'
                ? promptConfig.basePath
                : undefined;
            processPromptReference(
              promptReference,
              Boolean(prompt.file && !prompt.raw),
              promptBasePath
                ? path.resolve(executionCwd, promptBasePath)
                : executionCwd,
            );
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars?: TestVars): void => {
      const declaredVarPaths = typeof vars === 'string' || Array.isArray(vars);
      const values =
        typeof vars === 'string'
          ? [vars]
          : Array.isArray(vars)
            ? vars
            : isTraversableRecord(vars)
              ? Object.values(vars)
              : [];
      for (const value of values) {
        if (
          typeof value === 'string' &&
          (value.startsWith('file://') || declaredVarPaths)
        ) {
          processFileUrl(
            value.startsWith('file://') ? value : `file://${value}`,
          );
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
    const extractGradingProvider = (provider: unknown): void => {
      if (typeof provider === 'string') {
        if (provider.startsWith('file://')) {
          processCompatibleFileUrl(provider);
        }
        processFileBackedProviderReference(provider);
        watchExternalProviderConfig(provider);
        return;
      }
      if (!isTraversableRecord(provider)) return;

      visitProviderReferences(provider);
      const entries = Object.entries(provider);
      const providerId =
        typeof provider.id === 'string'
          ? provider.id
          : entries.length === 1
            ? entries[0][0]
            : undefined;
      if (!providerId) return;
      if (providerId.startsWith('file://')) {
        processCompatibleFileUrl(providerId);
      }
      processFileBackedProviderReference(providerId);
      watchExternalProviderConfig(providerId);
      if (/^https?(?::|$)/.test(providerId) || /\{[{%#]/.test(providerId)) {
        dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
      }
    };
    const extractRuntimeFileReferences = (
      value: unknown,
      stripReferenceSelector = stripTransformFunctionSelector,
      visitedRuntimeValues = new WeakSet<object>(),
    ): void => {
      if (typeof value === 'string') {
        if (value.startsWith('file://')) {
          addHttpProviderPath(value, stripReferenceSelector);
        }
        return;
      }
      if (!Array.isArray(value) && !isTraversableRecord(value)) return;
      if (visitedRuntimeValues.has(value)) return;
      visitedRuntimeValues.add(value);
      for (const nestedValue of Array.isArray(value)
        ? value
        : Object.values(value)) {
        extractRuntimeFileReferences(
          nestedValue,
          stripReferenceSelector,
          visitedRuntimeValues,
        );
      }
    };
    const extractTestRuntimeFiles = (test: Record<string, unknown>): void => {
      extractRuntimeFileReferences(test.assertScoringFunction);
      if (!isTraversableRecord(test.options)) return;
      extractGradingProvider(test.options.provider);
      for (const field of [
        'postprocess',
        'transform',
        'transformVars',
        'rubricPrompt',
      ]) {
        extractRuntimeFileReferences(
          test.options[field],
          field === 'rubricPrompt'
            ? stripJavascriptFunctionSelector
            : stripTransformFunctionSelector,
        );
      }
    };
    const visitedAssertValues = new WeakSet<object>();
    const extractAssertFiles = (asserts?: TestAssertion[]): void => {
      if (!Array.isArray(asserts) || visitedAssertValues.has(asserts)) return;
      visitedAssertValues.add(asserts);
      for (const assert of asserts) {
        if (
          assert !== null &&
          typeof assert === 'object' &&
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processCompatibleFileUrl(
            assert.value,
            stripAssertionFunctionSelector,
          );
        } else if (
          assert !== null &&
          typeof assert === 'object' &&
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
        extractGradingProvider(assert.provider);
        extractRuntimeFileReferences(assert.contextTransform);
        extractRuntimeFileReferences(assert.transform);
        extractRuntimeFileReferences(
          assert.rubricPrompt,
          stripJavascriptFunctionSelector,
        );
        extractAssertFiles(assert.assert);
      }
    };

    // Process defaultTest
    if (isTraversableRecord(config.defaultTest)) {
      extractVarFiles(config.defaultTest.vars);
      extractTestRuntimeFiles(config.defaultTest);
      extractAssertFiles(config.defaultTest.assert);
    }

    const visitedTestValues = new WeakSet<object>();
    const extractTestPath = (testPath: string): void => {
      if (
        testPath.length > MAX_DEPENDENCY_REFERENCE_LENGTH ||
        testPath.includes('\0') ||
        testPath.includes('\r') ||
        testPath.includes('\n')
      ) {
        core.warning(
          'Ignoring invalid test file dependency; preserving other dependencies',
        );
        return;
      }
      const testsPath = stripSpreadsheetSheetSelector(testPath);
      processCompatibleFileUrl(
        testsPath.startsWith('file://') ? testsPath : `file://${testsPath}`,
      );

      // Structured test files can contain their own vars and assertions with
      // file dependencies. Conservatively watch the workspace for changes.
      if (/[.{,(|](?:ya?ml|jsonl?|xlsx?|csv)(?=$|[},:#?|)])/i.test(testsPath)) {
        dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
      }
    };
    const extractTestValues = (tests: unknown): void => {
      if (typeof tests === 'string') {
        extractTestPath(tests);
        return;
      }
      if (Array.isArray(tests)) {
        if (visitedTestValues.has(tests)) return;
        visitedTestValues.add(tests);
        for (const test of tests) {
          extractTestValues(test);
        }
        return;
      }
      if (!isTraversableRecord(tests) || visitedTestValues.has(tests)) return;
      visitedTestValues.add(tests);
      if (typeof tests.path === 'string') {
        extractTestPath(tests.path);
      }
      extractVarFiles(tests.vars as TestVars | undefined);
      extractTestRuntimeFiles(tests);
      extractAssertFiles(tests.assert as TestAssertion[] | undefined);
      if ('tests' in tests) {
        extractTestValues(tests.tests);
      }
      if ('config' in tests) {
        extractTestValues(tests.config);
      }
    };

    extractTestValues(config.tests);
    extractTestValues(config.scenarios);

    const extensions =
      typeof config.extensions === 'string'
        ? [config.extensions]
        : Array.isArray(config.extensions)
          ? config.extensions
          : [];
    for (const extension of extensions) {
      if (typeof extension !== 'string' || !extension) continue;
      addHttpProviderPath(
        extension.startsWith('file://') ? extension : `file://${extension}`,
        stripTransformFunctionSelector,
      );
    }

    if (isTraversableRecord(config.nunjucksFilters)) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        if (typeof filterPath === 'string') {
          processFileUrl(
            filterPath.startsWith('file://')
              ? filterPath
              : `file://${filterPath}`,
          );
        }
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      const repositoryPath = relativePath.split(path.sep).join('/');
      if (repositoryPath === '') {
        return './';
      }
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch {
    core.warning(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    return parsedConfig ? ['./'] : [];
  }
}
