import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

type ProviderEntry = string | { id?: string; [key: string]: unknown };
type ProviderEnv = Record<string, string | number | boolean | undefined>;
type AssertionEntry = {
  type?: string;
  value?: unknown;
  assert?: AssertionEntry[];
  provider?: unknown;
  transform?: unknown;
  contextTransform?: unknown;
};
type TestEntry = {
  path?: string;
  vars?: string | string[] | { [key: string]: string | { file?: string } };
  assert?: AssertionEntry[];
  assertScoringFunction?: string;
  [key: string]: unknown;
};
const MAX_BRACE_EXPANSIONS = 1024;
const MAX_STRUCTURED_DEPENDENCY_BYTES = 10 * 1024 * 1024;
const MAX_TEST_PATH_LENGTH = 4096;
const GLOB_MAGIC_OPTIONS = {
  magicalBraces: true,
  braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
};
const FILE_BEARING_PROVIDER_KEYS = new Set([
  'file',
  'functions',
  'request',
  'response_format',
  'responseFormat',
  'responseParser',
  'sessionParser',
  'tools',
  'transformRequest',
  'transformResponse',
]);
const HTTP_FILE_BEARING_PROVIDER_KEYS = new Set(['validateStatus']);
const FILE_BACKED_PROVIDER_PREFIX_PATTERN = /^(?:exec|python|golang|ruby):/;
const ASSERTION_FILE_SELECTOR_PATTERN =
  /(\.(?:js|cjs|mjs|ts|cts|mts|py|rb)):[\s\S]*$/;
const TEST_FILE_SELECTOR_PATTERN = /(\.(?:js|cjs|mjs|ts|cts|mts|py)):[\s\S]*$/;
const TEST_SHEET_SELECTOR_PATTERN = /(\.(?:xlsx|xls))#[\s\S]*$/i;
const PROMPT_FILE_SELECTOR_PATTERN =
  /(\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)):[\s\S]*$/;
const HTTP_CREDENTIAL_PATH_KEYS = new Set([
  'caPath',
  'certPath',
  'jksPath',
  'keyPath',
  'keystorePath',
  'pfxPath',
  'privateKeyPath',
]);

export interface PromptfooConfig {
  env?: Record<string, unknown>;
  providers?: ProviderEntry | ProviderEntry[];
  targets?: ProviderEntry | ProviderEntry[];
  prompts?:
    | string
    | Record<string, unknown>
    | Array<string | { file?: string; [key: string]: unknown }>;
  tests?: string | TestEntry | Array<string | TestEntry>;
  defaultTest?: string | TestEntry;
  scenarios?: Array<
    | string
    | {
        tests?: string | TestEntry | Array<string | TestEntry>;
        config?: TestEntry[];
      }
  >;
  nunjucksFilters?: Record<string, string>;
  extensions?: string | string[];
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

function isForeignWindowsPath(filePath: string): boolean {
  return (
    process.platform !== 'win32' &&
    (/^[A-Za-z]:/.test(filePath) || filePath.startsWith('\\'))
  );
}

function hasBalancedGlobDelimiters(pattern: string): boolean {
  const expectedClosers: string[] = [];
  const closers: Record<string, string> = {
    '{': '}',
    '(': ')',
    '[': ']',
  };
  let inCharacterClass = false;

  for (const character of pattern) {
    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
      }
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
    } else if (character in closers) {
      expectedClosers.push(closers[character]);
    } else if (character === '}' || character === ')' || character === ']') {
      if (expectedClosers.pop() !== character) {
        return false;
      }
    }
  }

  return expectedClosers.length === 0 && !inCharacterClass;
}

function isPromptFilePath(prompt: string): boolean {
  if (
    prompt.includes('\n') ||
    prompt.includes('portkey://') ||
    prompt.includes('langfuse://') ||
    prompt.includes('helicone://')
  ) {
    return false;
  }

  return (
    prompt.startsWith('file://') ||
    /\.(?:cjs|cts|j2|js|json|jsonl|md|mjs|mts|py|ts|txt|ya?ml)(?::[^:]*)?$/.test(
      prompt,
    ) ||
    prompt.charAt(prompt.length - 3) === '.' ||
    prompt.charAt(prompt.length - 4) === '.' ||
    prompt.includes('*') ||
    prompt.includes('/') ||
    prompt.includes('\\')
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
  const getContainingDependencyRoot = (
    absolutePath: string,
  ): string | undefined =>
    dependencyRoots.find((root) => isPathInside(root, absolutePath));
  const watchDependencyRoots = (): void => {
    for (const root of dependencyRoots) {
      dependencies.add(`${root.replace(/[\\/]+$/, '')}${path.sep}`);
    }
  };

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

    let dependencyRootUnavailable = false;
    let dependencyRootWarningEmitted = false;
    const realDependencyRoots = new Map<string, string | undefined>();
    const resolveSafeDependencyPath = (
      absolutePath: string,
    ): string | undefined => {
      const containingRoot = getContainingDependencyRoot(absolutePath);
      if (!containingRoot) {
        return undefined;
      }

      for (const root of dependencyRoots) {
        if (!realDependencyRoots.has(root)) {
          try {
            realDependencyRoots.set(root, fs.realpathSync(root));
          } catch {
            dependencyRootUnavailable = true;
            realDependencyRoots.set(root, undefined);
          }
        }
      }
      const safeRealRoots = Array.from(realDependencyRoots.values()).filter(
        (root): root is string => root !== undefined,
      );

      let existingPath = absolutePath;
      const missingSegments: string[] = [];

      while (true) {
        try {
          const realExistingPath = fs.realpathSync(existingPath);
          if (
            !safeRealRoots.some((root) => isPathInside(root, realExistingPath))
          ) {
            return undefined;
          }
          return path.resolve(realExistingPath, ...missingSegments.reverse());
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return undefined;
          }

          try {
            if (
              code === 'ENOTDIR' ||
              fs.lstatSync(existingPath).isSymbolicLink()
            ) {
              return undefined;
            }
          } catch (lstatError) {
            const lstatCode = (lstatError as NodeJS.ErrnoException).code;
            if (lstatCode !== 'ENOENT') {
              return undefined;
            }
          }

          const parentPath = path.dirname(existingPath);
          if (parentPath === existingPath) {
            return undefined;
          }
          missingSegments.push(path.basename(existingPath));
          existingPath = parentPath;
        }
      }
    };
    const isSafeDependencyPath = (absolutePath: string): boolean =>
      resolveSafeDependencyPath(absolutePath) !== undefined;
    const addDependencyPath = (absolutePath: string): void => {
      dependencies.add(absolutePath);
      const realPath = resolveSafeDependencyPath(absolutePath);
      if (
        realPath &&
        realPath !== absolutePath &&
        isPathInside(cwd, realPath)
      ) {
        dependencies.add(
          /[\\/]$/.test(absolutePath)
            ? `${realPath.replace(/[\\/]+$/, '')}${path.sep}`
            : realPath,
        );
      }
    };

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
          throw new Error(`${source} uses an unsupported absolute path`);
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependencyPath(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch {
        const lexicalPath =
          filePath &&
          !filePath.includes('\0') &&
          !isForeignWindowsPath(filePath)
            ? path.resolve(configDir, filePath)
            : undefined;
        const containingRoot = lexicalPath
          ? getContainingDependencyRoot(lexicalPath)
          : undefined;
        if (lexicalPath && containingRoot) {
          if (dependencyRootUnavailable) {
            watchDependencyRoots();
          } else {
            dependencies.add(lexicalPath);
          }
        }
        if (!dependencyRootWarningEmitted) {
          core.warning(
            'Skipping unsafe config dependency content; its path may still be tracked for change detection',
          );
          dependencyRootWarningEmitted = true;
        }
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrlUnchecked = (fileUrl: string): string[] | undefined => {
      const filePath = fileUrl.replace('file://', '');
      if (isForeignWindowsPath(filePath)) {
        core.warning(
          'Skipping unsafe config dependency content; its path may still be tracked for change detection',
        );
        return [];
      }
      const isGlob = glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS);
      if (isGlob && !hasBalancedGlobDelimiters(filePath)) {
        throw new Error('invalid config dependency glob delimiters');
      }

      const resolvedPaths: string[] = [];

      // Check if the path contains glob patterns
      if (isGlob) {
        const expandedPaths = braceExpand(filePath, {
          braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
        });
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          watchDependencyRoots();
          core.warning(
            'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
          );
          return [];
        }

        const safePatterns: string[] = [];
        let unsafeAlternative = false;
        for (const expandedPath of expandedPaths) {
          const absolutePattern = path.resolve(configDir, expandedPath);
          if (isSafeDependencyPath(absolutePattern)) {
            safePatterns.push(absolutePattern);
          } else {
            unsafeAlternative = true;
          }
        }
        if (unsafeAlternative) {
          watchDependencyRoots();
          core.warning(
            'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
          );
        }
        if (safePatterns.length === 0) {
          return [];
        }

        // It's a glob pattern, expand it
        const matches = glob.sync(safePatterns, {
          nodir: true,
          braceExpandMax: MAX_BRACE_EXPANSIONS,
        });
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (isSafeDependencyPath(absoluteMatch)) {
            addDependencyPath(absoluteMatch);
            resolvedPaths.push(absoluteMatch);
          } else {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        for (const safePattern of safePatterns) {
          let basePath = glob.hasMagic(safePattern, GLOB_MAGIC_OPTIONS)
            ? safePattern
            : path.dirname(safePattern);
          while (glob.hasMagic(basePath, GLOB_MAGIC_OPTIONS)) {
            const parentPath = path.dirname(basePath);
            if (parentPath === basePath) {
              break;
            }
            basePath = parentPath;
          }
          if (isSafeDependencyPath(basePath)) {
            if (path.relative(cwd, basePath) === '') {
              dependencies.add(safePattern);
            } else {
              addDependencyPath(
                `${basePath.replace(/[\\/]+$/, '')}${path.sep}`,
              );
            }
          }
        }
      } else {
        const absolutePath = resolveConfigDependency(
          filePath,
          'config file dependency',
        );
        if (!absolutePath) {
          return undefined;
        }

        if (isDirectory(absolutePath)) {
          // It's a directory, preserve trailing slash if it was there
          const directoryPath = fileUrl.endsWith('/')
            ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
            : absolutePath;
          addDependencyPath(directoryPath);
          resolvedPaths.push(absolutePath);
        } else {
          // It's a regular file path
          addDependencyPath(absolutePath);
          resolvedPaths.push(absolutePath);
        }
      }

      return resolvedPaths;
    };

    const processFileUrl = (fileUrl: string): string[] | undefined => {
      try {
        return processFileUrlUnchecked(fileUrl);
      } catch {
        watchDependencyRoots();
        core.warning(
          'Skipping invalid config dependency glob; conservatively watching the dependency root',
        );
        return [];
      }
    };

    const hasGlobMagicSafely = (filePath: string): boolean => {
      try {
        return glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS);
      } catch {
        return true;
      }
    };

    // Extract provider files
    const visitedProviderConfigs = new Set<string>();
    const activeProviderConfigs = new Set<string>();
    const visitedProviderValues = new WeakMap<object, Set<string>>();
    const activeProviderValues = new WeakSet<object>();
    const activeProviderValueEnvs = new WeakMap<object, string>();
    let providerTraversalCount = 0;
    let providerTraversalStopped = false;
    const stopProviderTraversal = (): void => {
      watchDependencyRoots();
      if (!providerTraversalStopped) {
        providerTraversalStopped = true;
        core.warning(
          'Provider dependency traversal stopped; conservatively watching the dependency root',
        );
      }
    };
    const envTemplatePattern =
      /\{\{-?\s*env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*-?\}\}/g;
    const envDefaultTemplatePattern =
      /\{\{-?\s*env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*\|\s*(?:default|d)\(\s*(['"])([^'"]*)\3(?:\s*,\s*(true|false))?\s*\)\s*-?\}\}/g;
    const renderEnvTemplates = (
      value: string,
      activeEnv: ProviderEnv,
    ): string =>
      value
        .replace(
          envDefaultTemplatePattern,
          (
            _template: string,
            dotKey: string,
            bracketKey: string,
            _quote: string,
            fallback: string,
            useFalsyDefault: string,
          ) => {
            const envValue = activeEnv[dotKey || bracketKey];
            if (
              envValue === undefined ||
              (useFalsyDefault === 'true' && !envValue)
            ) {
              return fallback;
            }
            return String(envValue);
          },
        )
        .replace(
          envTemplatePattern,
          (template: string, dotKey: string, bracketKey: string) =>
            String(activeEnv[dotKey || bracketKey] ?? template),
        );
    const isHttpProviderId = (
      providerId: string,
      activeEnv: ProviderEnv,
    ): boolean => {
      const renderedProviderId = renderEnvTemplates(providerId, {
        ...process.env,
        ...activeEnv,
      });
      return (
        /^(?:https?:|https?$)/.test(renderedProviderId) ||
        /^\s*\{\{(?:[^}]|\}(?!\}))*['"]https?:\/\//.test(renderedProviderId)
      );
    };
    const withEnvOverrides = (
      baseEnv: ProviderEnv,
      overrides: unknown,
    ): ProviderEnv => {
      if (
        typeof overrides !== 'object' ||
        overrides === null ||
        Array.isArray(overrides)
      ) {
        return baseEnv;
      }

      const mergedEnv = { ...baseEnv };
      const renderEnv = { ...process.env, ...baseEnv };
      for (const [key, value] of Object.entries(overrides)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          mergedEnv[key] =
            typeof value === 'string'
              ? renderEnvTemplates(value, renderEnv)
              : value;
        }
      }
      return mergedEnv;
    };
    const getEnvContextKey = (activeEnv: ProviderEnv): string =>
      JSON.stringify(
        Object.keys(activeEnv)
          .sort()
          .map((key) => [key, activeEnv[key]]),
      );
    const configEnv = withEnvOverrides({}, config.env);
    const processProviderValue = (
      value: unknown,
      nestedReference: boolean = false,
      activeEnv: ProviderEnv = configEnv,
      externalProviderConfig: boolean = false,
      referencedFromProviderObject: boolean = false,
      isProviderReference: boolean = false,
      isFileBearingConfigValue: boolean = false,
      parentKey?: string,
      grandparentKey?: string,
      greatGrandparentKey?: string,
      httpProviderContext: boolean = false,
    ): void => {
      if (providerTraversalCount >= 1024) {
        stopProviderTraversal();
        return;
      }
      providerTraversalCount += 1;

      if (typeof value === 'string') {
        const templateEnv = {
          ...process.env,
          ...activeEnv,
        };
        let renderedProvider = renderEnvTemplates(value, templateEnv);
        const isLanguageProvider =
          isProviderReference &&
          FILE_BACKED_PROVIDER_PREFIX_PATTERN.test(renderedProvider);
        if (isLanguageProvider) {
          const providerScript = renderedProvider.replace(
            FILE_BACKED_PROVIDER_PREFIX_PATTERN,
            '',
          );
          if (
            renderedProvider.startsWith('exec:') &&
            /\s/.test(providerScript)
          ) {
            watchDependencyRoots();
            return;
          }
          renderedProvider = providerScript.startsWith('file://')
            ? providerScript
            : `file://${providerScript}`;
        }
        const unresolvedLeadingEnvTemplate =
          /^\s*\{\{-?(?:[^}]|\}(?!\}))*\benv(?:\.|\[)/.test(renderedProvider);
        const unresolvedComputedFileTemplate =
          /^\s*\{\{-?(?:[^}]|\}(?!\}))*['"]file:\/\//.test(renderedProvider);
        const unresolvedLeadingFileEnvTemplate =
          unresolvedLeadingEnvTemplate &&
          Array.from(
            renderedProvider.matchAll(
              /\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])/g,
            ),
            (match) => match[1] || match[2],
          ).some((key) => {
            const envValue = templateEnv[key];
            return (
              typeof envValue === 'string' && envValue.startsWith('file://')
            );
          });
        const unresolvedMissingEnvTemplate =
          unresolvedLeadingEnvTemplate &&
          Array.from(
            renderedProvider.matchAll(
              /\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])/g,
            ),
            (match) => match[1] || match[2],
          ).some((key) => templateEnv[key] === undefined);
        const unresolvedBlockFileTemplate =
          /\{%/.test(renderedProvider) &&
          (renderedProvider.includes('file://') ||
            Array.from(
              renderedProvider.matchAll(
                /\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])/g,
              ),
              (match) => match[1] || match[2],
            ).some((key) => {
              const envValue = templateEnv[key];
              return (
                typeof envValue === 'string' && envValue.startsWith('file://')
              );
            }));
        if (!renderedProvider.startsWith('file://')) {
          if (
            (isProviderReference &&
              !isHttpProviderId(renderedProvider, activeEnv) &&
              /\{\{|\{%|\{#/.test(renderedProvider)) ||
            ((grandparentKey === 'config' || isFileBearingConfigValue) &&
              (unresolvedLeadingFileEnvTemplate ||
                unresolvedMissingEnvTemplate ||
                unresolvedComputedFileTemplate ||
                unresolvedBlockFileTemplate))
          ) {
            watchDependencyRoots();
          }
          return;
        }

        const encodedProviderPath = renderedProvider.slice('file://'.length);
        const providerPath =
          process.platform === 'win32' &&
          /^\/[A-Za-z]:[\\/]/.test(encodedProviderPath)
            ? encodedProviderPath.slice(1)
            : encodedProviderPath;
        if (/\{\{|\}\}|\{%|\{#/.test(providerPath)) {
          watchDependencyRoots();
          return;
        }

        const selectorIndex = providerPath.lastIndexOf(':');
        const candidatePath = providerPath.slice(0, selectorIndex);
        const selector = providerPath.slice(selectorIndex + 1);
        const isHttpStatusValidator =
          httpProviderContext &&
          parentKey === 'validateStatus' &&
          grandparentKey === 'config';
        const executablePattern = isHttpStatusValidator
          ? /\.(?:js|cjs|mjs|ts|cts|mts)$/
          : isLanguageProvider
            ? /\.(?:py|go|rb)$/
            : nestedReference
              ? /\.(?:py|js|cjs|mjs|ts|cts|mts)$/i
              : /\.(?:py|go|rb|js|cjs|mjs|ts|cts|mts)$/i;
        const isJavascriptReference = isHttpStatusValidator
          ? /\.(?:js|cjs|mjs|ts|cts|mts)$/.test(candidatePath)
          : /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(candidatePath);
        const isValidSelector = isHttpStatusValidator
          ? selector.length > 0
          : isLanguageProvider
            ? true
            : /\.go$/i.test(candidatePath)
              ? /^(?:call_api|CallApi)$/.test(selector)
              : isJavascriptReference
                ? selector.length > 0
                : /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*[!?]?$/u.test(
                    selector,
                  );
        const cleanPath =
          selectorIndex > 1 &&
          executablePattern.test(candidatePath) &&
          isValidSelector
            ? candidatePath
            : providerPath;

        const processedPaths = processFileUrl(`file://${cleanPath}`);
        const resolvedPaths = processedPaths ?? [];
        if (
          resolvedPaths.length === 0 &&
          cleanPath &&
          !hasGlobMagicSafely(cleanPath) &&
          !cleanPath.includes('\0') &&
          !isForeignWindowsPath(cleanPath)
        ) {
          const lexicalPath = path.resolve(configDir, cleanPath);
          if (getContainingDependencyRoot(lexicalPath)) {
            dependencies.add(lexicalPath);
          }
        }

        for (const absolutePath of resolvedPaths) {
          if (providerTraversalCount >= 1024) {
            stopProviderTraversal();
            break;
          }
          const providerConfigKey = JSON.stringify([
            absolutePath,
            getEnvContextKey(activeEnv),
            nestedReference,
            referencedFromProviderObject,
          ]);
          if (
            !/\.(?:ya?ml|json)$/i.test(absolutePath) ||
            visitedProviderConfigs.has(providerConfigKey)
          ) {
            continue;
          }

          if (activeProviderConfigs.has(absolutePath)) {
            stopProviderTraversal();
            continue;
          }

          visitedProviderConfigs.add(providerConfigKey);
          activeProviderConfigs.add(absolutePath);
          try {
            if (
              fs.statSync(absolutePath).size > MAX_STRUCTURED_DEPENDENCY_BYTES
            ) {
              throw new Error('nested provider dependency is too large');
            }
            const providerConfig = loadYaml(
              fs.readFileSync(absolutePath, 'utf8'),
              {
                schema: CORE_SCHEMA.withTags(mergeTag),
              },
            );
            processProviderValue(
              providerConfig,
              nestedReference,
              activeEnv,
              true,
              referencedFromProviderObject,
              true,
            );
          } catch {
            watchDependencyRoots();
            core.warning(
              'Failed to extract nested provider dependencies; conservatively watching the dependency root',
            );
          } finally {
            activeProviderConfigs.delete(absolutePath);
          }
        }
        return;
      }

      if (typeof value !== 'object' || value === null) {
        return;
      }

      const envContextKey = getEnvContextKey(activeEnv);
      const providerValueContextKey = JSON.stringify([
        envContextKey,
        nestedReference,
        externalProviderConfig,
        referencedFromProviderObject,
        isProviderReference,
        isFileBearingConfigValue,
        parentKey,
        grandparentKey,
        greatGrandparentKey,
        httpProviderContext,
      ]);
      const visitedContexts = visitedProviderValues.get(value);
      if (visitedContexts?.has(providerValueContextKey)) {
        return;
      }
      if (activeProviderValues.has(value)) {
        if (activeProviderValueEnvs.get(value) === envContextKey) {
          return;
        }
        stopProviderTraversal();
        return;
      }
      if (visitedContexts) {
        visitedContexts.add(providerValueContextKey);
      } else {
        visitedProviderValues.set(value, new Set([providerValueContextKey]));
      }

      activeProviderValues.add(value);
      activeProviderValueEnvs.set(value, envContextKey);

      try {
        if (Array.isArray(value)) {
          for (const entry of value) {
            processProviderValue(
              entry,
              nestedReference,
              activeEnv,
              externalProviderConfig,
              referencedFromProviderObject,
              isProviderReference,
              isFileBearingConfigValue,
              parentKey,
              grandparentKey,
              greatGrandparentKey,
              httpProviderContext,
            );
          }
          return;
        }

        const isProviderOptionsObject =
          (externalProviderConfig || isProviderReference) &&
          ('id' in value || 'env' in value || 'config' in value);
        const isProviderMap = isProviderReference && !isProviderOptionsObject;
        const valueEnv =
          isProviderOptionsObject && 'env' in value ? value.env : undefined;
        const providerEnv =
          externalProviderConfig && referencedFromProviderObject
            ? { ...withEnvOverrides({}, valueEnv), ...activeEnv }
            : withEnvOverrides(activeEnv, valueEnv);
        const isHttpProvider =
          isProviderOptionsObject &&
          'id' in value &&
          typeof value.id === 'string'
            ? isHttpProviderId(value.id, providerEnv)
            : httpProviderContext;
        const fileAuthPath =
          isHttpProvider &&
          parentKey === 'auth' &&
          grandparentKey === 'config' &&
          'type' in value &&
          typeof value.type === 'string' &&
          renderEnvTemplates(value.type, {
            ...process.env,
            ...providerEnv,
          }) === 'file' &&
          'path' in value &&
          typeof value.path === 'string'
            ? renderEnvTemplates(value.path, {
                ...process.env,
                ...providerEnv,
              })
            : undefined;
        if (fileAuthPath !== undefined) {
          processProviderValue(
            fileAuthPath.startsWith('file://')
              ? fileAuthPath
              : `file://${fileAuthPath}`,
            true,
            providerEnv,
            false,
            true,
          );
        }
        for (const [key, nestedValue] of Object.entries(value)) {
          if (key === 'env' || (key === 'path' && fileAuthPath !== undefined)) {
            continue;
          }
          if (
            HTTP_FILE_BEARING_PROVIDER_KEYS.has(key) &&
            (!isHttpProvider || parentKey !== 'config')
          ) {
            continue;
          }
          if (
            isHttpProvider &&
            parentKey === 'parts' &&
            grandparentKey === 'multipart' &&
            greatGrandparentKey === 'config' &&
            'kind' in value &&
            typeof value.kind === 'string' &&
            renderEnvTemplates(value.kind, {
              ...process.env,
              ...providerEnv,
            }) === 'file' &&
            key === 'source' &&
            typeof nestedValue === 'object' &&
            nestedValue !== null &&
            'type' in nestedValue &&
            typeof nestedValue.type === 'string' &&
            renderEnvTemplates(nestedValue.type, {
              ...process.env,
              ...providerEnv,
            }) === 'path' &&
            'path' in nestedValue &&
            typeof nestedValue.path === 'string'
          ) {
            const multipartPath = renderEnvTemplates(nestedValue.path, {
              ...process.env,
              ...providerEnv,
            });
            processProviderValue(
              multipartPath.startsWith('file://')
                ? multipartPath
                : `file://${multipartPath}`,
              true,
              providerEnv,
              false,
              true,
            );
            continue;
          }
          if (
            isHttpProvider &&
            grandparentKey === 'config' &&
            (parentKey === 'signatureAuth' || parentKey === 'tls') &&
            HTTP_CREDENTIAL_PATH_KEYS.has(key) &&
            typeof nestedValue === 'string'
          ) {
            const credentialPath = renderEnvTemplates(nestedValue, {
              ...process.env,
              ...providerEnv,
            });
            processProviderValue(
              `file://${credentialPath}`,
              true,
              providerEnv,
              false,
              true,
            );
            continue;
          }
          if (
            key.startsWith('file://') ||
            (isProviderReference &&
              FILE_BACKED_PROVIDER_PREFIX_PATTERN.test(key)) ||
            (isProviderReference &&
              (key.includes('{{') || key.includes('{%') || key.includes('{#')))
          ) {
            const mappedProviderEnv =
              typeof nestedValue === 'object' &&
              nestedValue !== null &&
              'env' in nestedValue
                ? withEnvOverrides(providerEnv, nestedValue.env)
                : providerEnv;
            processProviderValue(
              key,
              nestedReference,
              mappedProviderEnv,
              false,
              true,
              true,
            );
          }
          const mappedProviderEnv =
            typeof nestedValue === 'object' &&
            nestedValue !== null &&
            'env' in nestedValue
              ? withEnvOverrides(providerEnv, nestedValue.env)
              : providerEnv;
          processProviderValue(
            nestedValue,
            nestedReference || key !== 'id',
            providerEnv,
            false,
            true,
            key === 'id' || isProviderMap,
            FILE_BEARING_PROVIDER_KEYS.has(key) ||
              (isHttpProvider &&
                parentKey === 'config' &&
                HTTP_FILE_BEARING_PROVIDER_KEYS.has(key)) ||
              ((parentKey === 'response_format' ||
                parentKey === 'responseFormat') &&
                (key === 'schema' || key === 'json_schema')) ||
              (parentKey === 'json_schema' && key === 'schema'),
            key,
            parentKey,
            grandparentKey,
            key !== 'body' &&
              key !== 'header' &&
              key !== 'headers' &&
              key !== 'data' &&
              key !== 'metadata' &&
              (isHttpProvider ||
                (isProviderMap && isHttpProviderId(key, mappedProviderEnv))),
          );
        }
      } finally {
        activeProviderValues.delete(value);
        activeProviderValueEnvs.delete(value);
      }
    };

    processProviderValue(
      config.providers,
      false,
      configEnv,
      false,
      false,
      true,
    );
    processProviderValue(config.targets, false, configEnv, false, false, true);

    const structuredPromptFiles: string[] = [];
    // Extract prompt files
    if (config.prompts) {
      const prompts = Array.isArray(config.prompts)
        ? config.prompts
        : typeof config.prompts === 'string'
          ? [config.prompts]
          : Object.keys(config.prompts);
      for (const prompt of prompts) {
        const rawPrompt =
          typeof prompt === 'string'
            ? prompt
            : typeof prompt.raw === 'string'
              ? prompt.raw
              : typeof prompt.id === 'string'
                ? prompt.id
                : undefined;
        if (rawPrompt !== undefined) {
          const promptPath = rawPrompt.startsWith('exec:')
            ? rawPrompt.slice('exec:'.length)
            : rawPrompt;
          const renderedPromptPath = renderEnvTemplates(promptPath, {
            ...process.env,
            ...configEnv,
          });
          if (
            rawPrompt.startsWith('exec:') ||
            isPromptFilePath(renderedPromptPath) ||
            /\benv(?:\.|\[)/.test(promptPath)
          ) {
            if (/\{\{|\}\}|\{%|\{#/.test(renderedPromptPath)) {
              watchDependencyRoots();
              continue;
            }
            processFileUrl(
              (renderedPromptPath.startsWith('file://')
                ? renderedPromptPath
                : `file://${renderedPromptPath}`
              ).replace(PROMPT_FILE_SELECTOR_PATTERN, '$1'),
            );
          }
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) {
            addDependencyPath(absolutePath);
            if (/\.(?:ya?ml|json)$/i.test(absolutePath)) {
              structuredPromptFiles.push(absolutePath);
            }
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (
      vars?: string | string[] | { [key: string]: unknown },
      testBaseDir: string = configDir,
    ): void => {
      if (!vars) return;
      if (typeof vars === 'string' || Array.isArray(vars)) {
        const varPaths = typeof vars === 'string' ? [vars] : vars;
        for (const varPath of varPaths) {
          const rawVarPath = varPath.startsWith('file://')
            ? varPath.slice('file://'.length)
            : varPath;
          const absoluteVarPath = path.isAbsolute(rawVarPath)
            ? rawVarPath
            : path.resolve(testBaseDir, rawVarPath);
          processFileUrl(`file://${absoluteVarPath}`);
        }
        return;
      }
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
            addDependencyPath(absolutePath);
          }
        }
      }
    };

    // Extract assert files
    const activeAssertions = new WeakSet<AssertionEntry>();
    const visitedAssertions = new WeakSet<AssertionEntry>();
    let assertionTraversalCount = 0;
    const extractAssertFiles = (
      asserts?: AssertionEntry[],
      nested: boolean = false,
    ): void => {
      if (!asserts) return;
      for (const assert of asserts) {
        if (activeAssertions.has(assert)) {
          stopProviderTraversal();
          return;
        }
        if (visitedAssertions.has(assert)) {
          continue;
        }
        if (assertionTraversalCount >= 1024) {
          stopProviderTraversal();
          return;
        }
        assertionTraversalCount += 1;
        activeAssertions.add(assert);
        try {
          if (
            typeof assert.value === 'string' &&
            assert.value.startsWith('file://')
          ) {
            processFileUrl(
              assert.value.replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'),
            );
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
              addDependencyPath(absolutePath);
            }
          }
          for (const transformValue of [
            assert.transform,
            assert.contextTransform,
          ]) {
            if (
              typeof transformValue === 'string' &&
              transformValue.startsWith('file://')
            ) {
              processFileUrl(
                transformValue.replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'),
              );
            }
          }
          if (assert.provider !== undefined && assert.provider !== null) {
            processProviderValue(
              assert.provider,
              false,
              configEnv,
              false,
              false,
              true,
            );
          }
          if (
            !nested &&
            assert.type === 'assert-set' &&
            Array.isArray(assert.assert)
          ) {
            extractAssertFiles(assert.assert, true);
          }
        } finally {
          activeAssertions.delete(assert);
          visitedAssertions.add(assert);
        }
      }
    };

    const visitedGeneratorConfigs = new WeakSet<object>();
    const activeTestEntries = new WeakSet<object>();
    const visitedTestEntries = new WeakSet<object>();
    const visitedTestFiles = new Set<string>();
    let testTraversalCount = 0;
    const extractGeneratorConfigReferences = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('file://')) {
        processFileUrl(value.replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'));
        return;
      }
      if (typeof value !== 'object' || value === null) {
        return;
      }
      if (visitedGeneratorConfigs.has(value)) {
        return;
      }
      if (testTraversalCount >= 1024) {
        stopProviderTraversal();
        return;
      }
      testTraversalCount += 1;
      visitedGeneratorConfigs.add(value);
      for (const entry of Array.isArray(value) ? value : Object.values(value)) {
        extractGeneratorConfigReferences(entry);
      }
    };

    for (const promptFile of structuredPromptFiles) {
      if (!fs.existsSync(promptFile)) {
        continue;
      }
      try {
        if (fs.statSync(promptFile).size > MAX_STRUCTURED_DEPENDENCY_BYTES) {
          throw new Error('nested prompt dependency is too large');
        }
        extractGeneratorConfigReferences(
          loadYaml(fs.readFileSync(promptFile, 'utf8'), {
            schema: CORE_SCHEMA.withTags(mergeTag),
          }),
        );
      } catch {
        watchDependencyRoots();
        core.warning(
          'Failed to extract nested prompt dependencies; conservatively watching the dependency root',
        );
      }
    }

    const extractTests = (
      tests?: string | TestEntry | Array<string | TestEntry>,
      testBaseDir: string = configDir,
      keepTestBaseDir: boolean = false,
    ): void => {
      if (!tests) return;
      if (typeof tests === 'string') {
        if (tests.length > MAX_TEST_PATH_LENGTH || /[\0\r\n]/.test(tests)) {
          watchDependencyRoots();
          core.warning(
            'Skipping invalid test dependency path; conservatively watching the dependency root',
          );
          return;
        }
        const rawTestPath = tests.startsWith('file://')
          ? tests.slice('file://'.length)
          : tests;
        const rebasedTestPath =
          path.isAbsolute(rawTestPath) || isForeignWindowsPath(rawTestPath)
            ? rawTestPath
            : path.resolve(testBaseDir, rawTestPath);
        const resolvedPaths = processFileUrl(
          `file://${rebasedTestPath}`
            .replace(TEST_FILE_SELECTOR_PATTERN, '$1')
            .replace(TEST_SHEET_SELECTOR_PATTERN, '$1'),
        );
        for (const testFile of resolvedPaths ?? []) {
          if (
            !/\.(?:ya?ml|jsonl?|csv)$/i.test(testFile) ||
            visitedTestFiles.has(testFile) ||
            !fs.existsSync(testFile)
          ) {
            continue;
          }
          if (testTraversalCount >= 1024) {
            stopProviderTraversal();
            break;
          }
          testTraversalCount += 1;
          visitedTestFiles.add(testFile);
          try {
            if (fs.statSync(testFile).size > MAX_STRUCTURED_DEPENDENCY_BYTES) {
              throw new Error('nested test dependency is too large');
            }
            const testContent = fs.readFileSync(testFile, 'utf8');
            if (/\.csv$/i.test(testFile)) {
              for (const match of testContent.matchAll(
                /file:\/\/[^,"'\r\n\]}]+/g,
              )) {
                processFileUrl(
                  match[0].replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'),
                );
              }
            } else if (/\.jsonl$/i.test(testFile)) {
              for (const line of testContent.split(/\r?\n/)) {
                if (line.trim()) {
                  extractTests(
                    JSON.parse(line) as TestEntry,
                    path.dirname(testFile),
                    keepTestBaseDir,
                  );
                }
              }
            } else {
              extractTests(
                loadYaml(testContent, {
                  schema: CORE_SCHEMA.withTags(mergeTag),
                }) as TestEntry | TestEntry[],
                keepTestBaseDir ? testBaseDir : path.dirname(testFile),
                keepTestBaseDir,
              );
            }
          } catch {
            watchDependencyRoots();
            core.warning(
              'Failed to extract nested test dependencies; conservatively watching the dependency root',
            );
          }
        }
        return;
      }
      if (Array.isArray(tests)) {
        if (activeTestEntries.has(tests)) {
          stopProviderTraversal();
          return;
        }
        if (visitedTestEntries.has(tests)) {
          return;
        }
        if (testTraversalCount >= 1024) {
          stopProviderTraversal();
          return;
        }
        testTraversalCount += 1;
        activeTestEntries.add(tests);
        visitedTestEntries.add(tests);
        try {
          for (const test of tests) {
            extractTests(test, testBaseDir, keepTestBaseDir);
          }
        } finally {
          activeTestEntries.delete(tests);
        }
        return;
      }

      if (tests.path) {
        extractTests(tests.path, testBaseDir, keepTestBaseDir);
        extractGeneratorConfigReferences(tests.config);
      }
      if (typeof tests.$ref === 'string') {
        const refPath = tests.$ref.split('#')[0];
        if (refPath) {
          extractTests(
            `file://${
              path.isAbsolute(refPath) ? refPath : path.resolve(cwd, refPath)
            }`,
            testBaseDir,
          );
        }
      }
      const providerValue = tests.provider;
      if (
        typeof providerValue === 'string' ||
        (typeof providerValue === 'object' && providerValue !== null)
      ) {
        const providerObject =
          typeof providerValue === 'object'
            ? (providerValue as Record<string, unknown>)
            : undefined;
        const providerId =
          typeof providerValue === 'string'
            ? providerValue
            : typeof providerObject?.id === 'string'
              ? providerObject.id
              : undefined;
        const providerPathMatch = providerId?.match(
          /^(file:\/\/|exec:|python:|golang:|ruby:)([\s\S]*)$/,
        );
        const normalizedProviderId = providerPathMatch
          ? `${providerPathMatch[1]}${
              path.isAbsolute(providerPathMatch[2])
                ? providerPathMatch[2]
                : path.resolve(testBaseDir, providerPathMatch[2])
            }`
          : providerId;
        const normalizedProvider = providerObject
          ? { ...providerObject, id: normalizedProviderId }
          : normalizedProviderId;
        processProviderValue(
          normalizedProvider,
          false,
          configEnv,
          false,
          false,
          true,
        );
      }
      extractVarFiles(tests.vars, testBaseDir);
      extractAssertFiles(tests.assert);
      if (tests.assertScoringFunction?.startsWith('file://')) {
        processFileUrl(
          tests.assertScoringFunction.replace(
            ASSERTION_FILE_SELECTOR_PATTERN,
            '$1',
          ),
        );
      }
      if (
        typeof tests.options === 'object' &&
        tests.options !== null &&
        !Array.isArray(tests.options)
      ) {
        const options = tests.options as Record<string, unknown>;
        for (const key of ['transformVars', 'transform', 'postprocess']) {
          const transformValue = options[key];
          if (
            typeof transformValue === 'string' &&
            transformValue.startsWith('file://')
          ) {
            processFileUrl(
              transformValue.replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'),
            );
          }
        }
      }
    };

    if (config.extensions) {
      const extensions = Array.isArray(config.extensions)
        ? config.extensions
        : [config.extensions];
      for (const extension of extensions) {
        if (extension.startsWith('file://')) {
          processFileUrl(
            extension.replace(ASSERTION_FILE_SELECTOR_PATTERN, '$1'),
          );
        }
      }
    }

    extractTests(config.defaultTest);
    extractTests(config.tests);

    if (config.scenarios) {
      for (const scenario of config.scenarios) {
        if (typeof scenario === 'string') {
          extractTests(scenario);
          continue;
        }
        extractTests(scenario.tests, configDir, true);
        if (scenario.config) {
          for (const test of scenario.config) {
            extractTests(test);
          }
        }
      }
    }

    if (config.nunjucksFilters) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        if (!filterPath.startsWith('file://')) {
          processFileUrl(`file://${filterPath}`);
        }
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      const repositoryPath = relativePath.split(path.sep).join('/');
      if (!repositoryPath) {
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
      'Failed to extract dependencies from config; conservatively watching the dependency root',
    );
    return dependencyRoots.map((root) => {
      const relativeRoot = path.relative(cwd, root).split(path.sep).join('/');
      return relativeRoot ? `${relativeRoot}/` : './';
    });
  }
}
