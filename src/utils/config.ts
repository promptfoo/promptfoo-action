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
    let dependencyRootResolved = false;
    let realDependencyRoot: string | undefined;
    const isSafeDependencyPath = (absolutePath: string): boolean => {
      if (!isPathInside(dependencyRoot, absolutePath)) {
        return false;
      }

      if (!dependencyRootResolved) {
        dependencyRootResolved = true;
        try {
          realDependencyRoot = fs.realpathSync(dependencyRoot);
        } catch {
          dependencyRootUnavailable = true;
          return false;
        }
      }
      if (!realDependencyRoot) {
        return false;
      }

      let existingPath = absolutePath;

      while (true) {
        try {
          return isPathInside(
            realDependencyRoot,
            fs.realpathSync(existingPath),
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return false;
          }

          const parentPath = path.dirname(existingPath);
          if (parentPath === existingPath) {
            return false;
          }
          existingPath = parentPath;
        }
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
      } catch (error) {
        if (
          filePath &&
          !filePath.includes('\0') &&
          isPathInside(dependencyRoot, path.resolve(configDir, filePath))
        ) {
          dependencies.add(
            dependencyRootUnavailable
              ? `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`
              : path.resolve(configDir, filePath),
          );
        }
        core.warning(
          `Skipping unsafe config dependency content; its path may still be tracked for change detection: ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): string[] | undefined => {
      const filePath = fileUrl.replace('file://', '');
      const isGlob = glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS);

      const resolvedPaths: string[] = [];

      // Check if the path contains glob patterns
      if (isGlob) {
        const expandedPaths = braceExpand(filePath, {
          braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
        });
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          dependencies.add(
            `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          );
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
          dependencies.add(
            `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          );
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
            dependencies.add(absoluteMatch);
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
              dependencies.add(`${basePath.replace(/[\\/]+$/, '')}${path.sep}`);
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
          dependencies.add(directoryPath);
          resolvedPaths.push(absolutePath);
        } else {
          // It's a regular file path
          dependencies.add(absolutePath);
          resolvedPaths.push(absolutePath);
        }
      }

      return resolvedPaths;
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
      dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
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
    ): void => {
      if (providerTraversalCount >= 1024) {
        stopProviderTraversal();
        return;
      }
      providerTraversalCount += 1;

      if (typeof value === 'string') {
        const renderedProvider = renderEnvTemplates(value, {
          ...process.env,
          ...activeEnv,
        });
        const unresolvedLeadingEnvTemplate =
          /^\s*\{\{-?(?:[^}]|\}(?!\}))*\benv(?:\.|\[)/.test(renderedProvider);
        const unresolvedComputedFileTemplate =
          /^\s*\{\{-?(?:[^}]|\}(?!\}))*['"]file:\/\//.test(renderedProvider);
        if (!renderedProvider.startsWith('file://')) {
          if (
            (isProviderReference && /\{\{|\{%|\{#/.test(renderedProvider)) ||
            (isFileBearingConfigValue && unresolvedLeadingEnvTemplate) ||
            unresolvedComputedFileTemplate
          ) {
            dependencies.add(
              `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
            );
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
          dependencies.add(
            `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          );
          return;
        }

        const selectorIndex = providerPath.lastIndexOf(':');
        const candidatePath = providerPath.slice(0, selectorIndex);
        const selector = providerPath.slice(selectorIndex + 1);
        const executablePattern = nestedReference
          ? /\.(?:py|js|cjs|mjs|ts|cts|mts)$/i
          : /\.(?:py|go|rb)$/i;
        const isJavascriptReference = /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(
          candidatePath,
        );
        const isValidSelector = /\.go$/i.test(candidatePath)
          ? /^(?:call_api|CallApi)$/.test(selector)
          : nestedReference && isJavascriptReference
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
          !glob.hasMagic(cleanPath, GLOB_MAGIC_OPTIONS) &&
          !cleanPath.includes('\0')
        ) {
          const lexicalPath = path.resolve(configDir, cleanPath);
          if (isPathInside(dependencyRoot, lexicalPath)) {
            dependencies.add(lexicalPath);
          }
        }

        for (const absolutePath of resolvedPaths) {
          if (providerTraversalCount >= 1024) {
            stopProviderTraversal();
            break;
          }
          const providerConfigKey = `${absolutePath}\0${getEnvContextKey(
            activeEnv,
          )}`;
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
            dependencies.add(
              `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
            );
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
            );
          }
          return;
        }

        const valueEnv = 'env' in value ? value.env : undefined;
        const providerEnv =
          externalProviderConfig && referencedFromProviderObject
            ? { ...withEnvOverrides({}, valueEnv), ...activeEnv }
            : withEnvOverrides(activeEnv, valueEnv);
        const fileAuthPath =
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
          processProviderValue(
            nestedValue,
            nestedReference || key !== 'id',
            providerEnv,
            false,
            true,
            key === 'id',
            FILE_BEARING_PROVIDER_KEYS.has(key) ||
              ((parentKey === 'response_format' ||
                parentKey === 'responseFormat') &&
                (key === 'schema' || key === 'json_schema')) ||
              (parentKey === 'json_schema' && key === 'schema'),
            key,
            parentKey,
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
    const extractAssertFiles = (
      asserts?: Array<{ type?: string; value?: unknown }>,
    ): void => {
      if (!asserts) return;
      for (const assert of asserts) {
        if (
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processFileUrl(assert.value);
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
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return repositoryPath ? `${repositoryPath}/` : './';
      }
      return repositoryPath;
    });
  } catch {
    core.warning(
      'Failed to extract dependencies from config; conservatively watching the dependency root',
    );
    const relativeRoot = path
      .relative(cwd, dependencyRoot)
      .split(path.sep)
      .join('/');
    return [relativeRoot ? `${relativeRoot}/` : './'];
  }
}
