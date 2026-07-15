import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

type ProviderEntry = string | { id?: string; [key: string]: unknown };
type ProviderEnv = Record<string, string | number | boolean | undefined>;
const MAX_BRACE_EXPANSIONS = 1024;
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
const ASSERTION_FILE_SELECTOR_PATTERN =
  /(\.(?:js|cjs|mjs|ts|cts|mts|py|rb)):[\s\S]*$/;
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
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: Array<{
    vars?: { [key: string]: string | { file?: string } };
    assert?: Array<{ type?: string; value?: string | { file?: string } }>;
    [key: string]: unknown;
  }>;
  defaultTest?: {
    vars?: { [key: string]: string | { file?: string } };
    assert?: Array<{ type?: string; value?: string | { file?: string } }>;
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

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependencyPath(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch {
        const lexicalPath =
          filePath && !filePath.includes('\0')
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
      const isGlob = glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS);

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
      return /^(?:https?:|https?$)/.test(renderedProviderId);
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
        const renderedProvider = renderEnvTemplates(value, templateEnv);
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
        if (!renderedProvider.startsWith('file://')) {
          if (
            (isProviderReference && /\{\{|\{%|\{#/.test(renderedProvider)) ||
            (isFileBearingConfigValue && unresolvedLeadingEnvTemplate) ||
            ((grandparentKey === 'config' || isFileBearingConfigValue) &&
              (unresolvedLeadingFileEnvTemplate ||
                unresolvedComputedFileTemplate))
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
          : nestedReference
            ? /\.(?:py|js|cjs|mjs|ts|cts|mts)$/i
            : /\.(?:py|go|rb|js|cjs|mjs|ts|cts|mts)$/i;
        const isJavascriptReference = isHttpStatusValidator
          ? /\.(?:js|cjs|mjs|ts|cts|mts)$/.test(candidatePath)
          : /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(candidatePath);
        const isValidSelector = isHttpStatusValidator
          ? selector.length > 0
          : /\.go$/i.test(candidatePath)
            ? /^(?:call_api|CallApi)$/.test(selector)
            : isJavascriptReference
              ? selector.length > 0 && !/[\\/:\0]/.test(selector)
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
          !cleanPath.includes('\0')
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
          value.type === 'file' &&
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
            value.kind === 'file' &&
            key === 'source' &&
            typeof nestedValue === 'object' &&
            nestedValue !== null &&
            'type' in nestedValue &&
            nestedValue.type === 'path' &&
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

    // Extract prompt files
    if (config.prompts) {
      for (const prompt of config.prompts) {
        if (typeof prompt === 'string' && prompt.startsWith('file://')) {
          processFileUrl(prompt);
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) {
            addDependencyPath(absolutePath);
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
            addDependencyPath(absolutePath);
          }
        }
      }
    };

    // Extract assert files
    const extractAssertFiles = (
      asserts?: Array<{ type?: string; value?: unknown }>,
    ): void => {
      if (!asserts) return;
      for (const assert of asserts) {
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
      }
    };

    // Process defaultTest
    if (config.defaultTest) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
    }

    // Process tests
    if (config.tests) {
      for (const test of config.tests) {
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
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
