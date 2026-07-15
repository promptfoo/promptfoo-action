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
const HTTP_PROVIDER_FILE_PATH_KEYS = new Set([
  'privateKeyPath',
  'keystorePath',
  'pfxPath',
  'certPath',
  'keyPath',
  'caPath',
  'jksPath',
]);

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

export interface PromptfooConfig {
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: PromptfooTestConfig[];
  defaultTest?: string | PromptfooTestConfig;
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

  try {
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

    const realDependencyRoots = dependencyRoots.flatMap((root) => {
      try {
        return [fs.realpathSync(root)];
      } catch {
        return [];
      }
    });

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

        const absolutePath = path.resolve(
          configDir,
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
      try {
        return glob.hasMagic(filePath, globOptions);
      } catch {
        core.warning('Skipping invalid config dependency glob pattern');
        return undefined;
      }
    };

    const hasDynamicFilePath = (filePath: string): boolean =>
      /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/.test(filePath);

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
        let expandedPaths: string[];
        try {
          expandedPaths = braceExpand(filePath.replace(/\\/g, '/'), {
            braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
          });
        } catch {
          core.warning('Skipping invalid config dependency glob pattern');
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
          const absolutePattern = path.resolve(
            configDir,
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
          core.warning('Skipping invalid config dependency glob pattern');
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
          const relativePattern = path.relative(configDir, safePattern);
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
            const absoluteBasePath = path.resolve(configDir, basePath);
            if (path.relative(cwd, absoluteBasePath) === '') {
              dependencies.add(safePattern);
            } else {
              const hasBaseMatch = safeMatches.some((match) =>
                isPathInside(absoluteBasePath, match),
              );
              dependencies.add(
                hasBaseMatch
                  ? absoluteBasePath
                  : `${absoluteBasePath}${path.sep}`,
              );
            }
          } else {
            dependencies.add(
              path.relative(cwd, configDir) === ''
                ? safePattern
                : `${configDir}${path.sep}`,
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
      | 'http-config';
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
      if (typeof value === 'string' && value.includes('file://')) {
        if (!isValidGlobLength(value)) return;
        if (value.includes('\0')) {
          resolveConfigDependency(value, 'config file dependency');
          return;
        }
      }
      if (
        typeof value === 'string' &&
        value.includes('file://') &&
        hasDynamicFilePath(value)
      ) {
        addDependencyRootWatchers();
      } else if (typeof value === 'string' && value.startsWith('file://')) {
        const fileUrl = value.replace(
          /(\.(?:[cm]?[jt]s|py|rb|go)):[^/\\:]+$/i,
          '$1',
        );
        if (inspectNestedFiles && /\.(?:json|ya?ml)$/i.test(fileUrl)) {
          inspectNestedConfigFile(fileUrl, providerContext);
        } else {
          processFileUrl(fileUrl);
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
          value.id.startsWith('file://')
        ) {
          const fileUrl = value.id.replace(
            /(\.(?:[cm]?[jt]s|py|rb|go)):[^/\\:]+$/i,
            '$1',
          );
          if (inspectNestedFiles && /\.(?:json|ya?ml)$/i.test(fileUrl)) {
            inspectNestedConfigFile(fileUrl, 'provider');
          } else {
            processFileUrl(fileUrl);
          }
        }
        const isProviderDefinition =
          (providerContext === 'provider' ||
            providerContext === 'http-provider') &&
          ('id' in value || 'config' in value);
        const isHttpProviderDefinition =
          providerContext === 'http-provider' ||
          ('id' in value && isHttpProviderId(value.id));
        for (const [key, item] of Object.entries(value)) {
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
            item.type === 'file' &&
            'path' in item &&
            typeof item.path === 'string'
          ) {
            const fileUrl = item.path.startsWith('file://')
              ? item.path
              : `file://${item.path}`;
            processFileUrl(
              fileUrl.replace(/(\.(?:[cm]?[jt]s|py|rb|go)):[^/\\:]+$/i, '$1'),
            );
            continue;
          }
          if (inspectNestedFiles && key.startsWith('file://')) {
            const fileUrl = key.replace(
              /(\.(?:[cm]?[jt]s|py|rb|go)):[^/\\:]+$/i,
              '$1',
            );
            if (/\.(?:json|ya?ml)$/i.test(fileUrl)) {
              inspectNestedConfigFile(fileUrl, 'provider');
            } else {
              processFileUrl(fileUrl);
            }
          }
          if (key !== 'file' && key !== 'id') {
            const nextProviderContext =
              providerContext !== 'provider' &&
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
        processFileUrl(fileUrl);
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
        inspectedNestedFiles.add(inspectedFileKey);
        extractFileReferences(
          loadYaml(fs.readFileSync(realFilePath, 'utf8'), {
            schema: CONFIG_SCHEMA,
          }),
          true,
          providerContext,
        );
      } catch {
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
      for (const prompt of config.prompts) {
        if (typeof prompt === 'string' && prompt.startsWith('file://')) {
          processFileUrl(prompt);
        } else if (typeof prompt === 'object' && prompt.file) {
          const absolutePath = resolveConfigDependency(
            prompt.file,
            'prompt file dependency',
          );
          if (absolutePath) dependencies.add(absolutePath);
        }
      }
    }

    // Extract test variable files and inspect external variable maps.
    const inspectedVarFiles = new Set<string>();
    const inspectedVarPaths = new Set<string>();
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
      const filePath = rawFilePath
        .replace(/(\.(?:[cm]?[jt]s|py|rb|go)):[^/\\:]+$/i, '$1')
        .replace(/(\.xlsx?)#.*$/i, '$1');
      const fileUrl = `file://${filePath}`;
      const isVarGlob = getGlobMagic(filePath);
      if (isVarGlob === undefined) return;
      const absolutePath = isVarGlob
        ? path.resolve(configDir, filePath)
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
          const vars = loadYaml(fs.readFileSync(realVarFile, 'utf8'), {
            schema: CONFIG_SCHEMA,
          });
          extractFileReferences(vars);
        } catch {
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
        for (const value of vars) {
          if (typeof value === 'string') {
            inspectVarFile(value);
          }
        }
        return;
      }
      if (!vars || typeof vars !== 'object' || ArrayBuffer.isView(vars)) return;
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
        extractFileReferences(assert.value);
        extractFileReferences(assert.provider, true, 'provider');
        extractFileReferences(assert.config);
        extractFileReferences(assert.rubricPrompt);
        extractFileReferences(assert.transform);
        extractFileReferences(assert.contextTransform);
        extractAssertFiles(assert.assert);
      }
    };

    const extractOptionsFiles = (
      options?: PromptfooTestConfig['options'],
    ): void => {
      if (!options || typeof options !== 'object') return;
      for (const [key, value] of Object.entries(options)) {
        extractFileReferences(
          value,
          key === 'provider',
          key === 'provider' ? 'provider' : undefined,
        );
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
              } else {
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
    if (config.tests) {
      for (const test of config.tests) {
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
        extractFileReferences(test.assertScoringFunction);
        extractFileReferences(test.provider, true, 'provider');
        extractOptionsFiles(test.options);
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(
      `Failed to extract dependencies from config: ${JSON.stringify(reason)}`,
    );
    return [];
  }
}
