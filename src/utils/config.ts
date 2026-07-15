import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

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
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
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
        if (!isPathInside(dependencyRoot, absolutePath)) {
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

    const globOptions = {
      windowsPathsNoEscape: true,
      magicalBraces: true,
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string, resolvedPath?: string): void => {
      const filePath = normalizeConfigFilePath(fileUrl.replace('file://', ''));
      const absolutePath =
        resolvedPath ??
        resolveConfigDependency(filePath, 'config file dependency');
      if (!absolutePath) {
        return;
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath, globOptions)) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, {
          nodir: true,
          ...globOptions,
        });
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (isPathInside(dependencyRoot, absoluteMatch)) {
            dependencies.add(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency match "${match}": config file dependency glob match must stay within the repository workspace`,
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const pathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(pathRoot.length).split(/[\\/]/);
        let basePath = pathRoot;
        for (const part of pathParts) {
          if (glob.hasMagic(part, globOptions)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        if (basePath) {
          const absoluteBasePath = path.resolve(configDir, basePath);
          if (isPathInside(dependencyRoot, absoluteBasePath)) {
            dependencies.add(
              matches.length === 0
                ? `${absoluteBasePath}${path.sep}`
                : absoluteBasePath,
            );
          } else {
            core.warning(
              'Ignoring unsafe config dependency glob base: config file dependency glob base must stay within the repository workspace',
            );
            dependencies.add(`${configDir}${path.sep}`);
          }
        } else {
          dependencies.add(`${configDir}${path.sep}`);
        }
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

    // Extract provider files
    if (config.providers) {
      for (const provider of config.providers) {
        if (typeof provider === 'string' && provider.startsWith('file://')) {
          processFileUrl(provider);
        } else if (
          typeof provider === 'object' &&
          provider.id?.startsWith('file://')
        ) {
          processFileUrl(provider.id);
        }
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
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
      }
    }

    const visitedFileValues = new WeakSet<object>();
    const extractFileReferences = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('file://')) {
        processFileUrl(
          value.replace(/(\.(?:[cm]?[jt]s|py|rb)):[^/\\:]+$/i, '$1'),
        );
      } else if (Array.isArray(value)) {
        if (visitedFileValues.has(value)) return;
        visitedFileValues.add(value);
        for (const item of value) {
          extractFileReferences(item);
        }
      } else if (typeof value === 'object' && value !== null) {
        if (visitedFileValues.has(value)) return;
        visitedFileValues.add(value);
        if ('file' in value && typeof value.file === 'string') {
          const absolutePath = resolveConfigDependency(
            value.file,
            'config file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
        if (
          'id' in value &&
          typeof value.id === 'string' &&
          value.id.startsWith('file://')
        ) {
          processFileUrl(value.id);
        }
        for (const [key, item] of Object.entries(value)) {
          if (key !== 'file' && key !== 'id') {
            extractFileReferences(item);
          }
        }
      }
    };

    // Extract test variable files and inspect external variable maps.
    const inspectedVarFiles = new Set<string>();
    const inspectVarFile = (value: string): void => {
      const fileUrl = value.startsWith('file://') ? value : `file://${value}`;
      const filePath = normalizeConfigFilePath(fileUrl.slice('file://'.length));
      const absolutePath = resolveConfigDependency(
        filePath,
        'test variable file dependency',
      );
      if (!absolutePath) return;
      processFileUrl(fileUrl, absolutePath);

      const varFiles = glob.hasMagic(filePath, globOptions)
        ? glob.sync(absolutePath, { nodir: true, ...globOptions })
        : [absolutePath];
      for (const varFile of varFiles) {
        if (inspectedVarFiles.has(varFile)) continue;
        inspectedVarFiles.add(varFile);
        try {
          const realDependencyRoot = fs.realpathSync(dependencyRoot);
          const realVarFile = fs.realpathSync(varFile);
          if (!isPathInside(realDependencyRoot, realVarFile)) {
            core.warning(
              'Ignoring unsafe external vars file: resolved path must stay within the repository workspace',
            );
            continue;
          }
          const vars = loadYaml(fs.readFileSync(realVarFile, 'utf8'), {
            schema: CORE_SCHEMA.withTags(mergeTag),
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
      if (!vars || typeof vars !== 'object') return;
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
        extractFileReferences(assert.provider);
        extractFileReferences(assert.rubricPrompt);
        extractFileReferences(assert.transform);
        extractFileReferences(assert.contextTransform);
        extractAssertFiles(assert.assert);
      }
    };

    // Process defaultTest
    if (config.defaultTest) {
      if (typeof config.defaultTest === 'string') {
        if (config.defaultTest.startsWith('file://')) {
          const defaultTestFile = config.defaultTest.slice('file://'.length);
          const hasDynamicDefaultTestPath =
            /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/.test(
              defaultTestFile,
            );
          const defaultTestPath = hasDynamicDefaultTestPath
            ? undefined
            : resolveConfigDependency(
                defaultTestFile,
                'defaultTest file dependency',
              );
          if (hasDynamicDefaultTestPath) {
            dependencies.add(`${dependencyRoot}${path.sep}`);
          }
          if (defaultTestPath) {
            processFileUrl(config.defaultTest);
          }
          if (defaultTestPath && !glob.hasMagic(defaultTestFile, globOptions)) {
            try {
              const realDependencyRoot = fs.realpathSync(dependencyRoot);
              const realDefaultTestPath = fs.realpathSync(defaultTestPath);
              if (!isPathInside(realDependencyRoot, realDefaultTestPath)) {
                core.warning(
                  'Ignoring unsafe file-backed defaultTest: resolved path must stay within the repository workspace',
                );
              } else {
                const defaultTest = loadYaml(
                  fs.readFileSync(realDefaultTestPath, 'utf8'),
                  { schema: CORE_SCHEMA.withTags(mergeTag) },
                ) as PromptfooConfig['defaultTest'];
                if (
                  defaultTest &&
                  typeof defaultTest === 'object' &&
                  !Array.isArray(defaultTest)
                ) {
                  extractVarFiles(defaultTest.vars);
                  extractAssertFiles(defaultTest.assert);
                  extractFileReferences(defaultTest.assertScoringFunction);
                  extractFileReferences(defaultTest.provider);
                  extractFileReferences(defaultTest.options);
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
        extractFileReferences(config.defaultTest.provider);
        extractFileReferences(config.defaultTest.options);
      }
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
  } catch (error) {
    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
