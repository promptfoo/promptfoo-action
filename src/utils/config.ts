import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

type ProviderEntry = string | { id?: string; [key: string]: unknown };

export interface PromptfooConfig {
  providers?: string | ProviderEntry[];
  targets?: string | ProviderEntry[];
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

    const isSafeDependencyPath = (absolutePath: string): boolean => {
      if (!isPathInside(dependencyRoot, absolutePath)) {
        return false;
      }

      try {
        const realRoot = fs.realpathSync(dependencyRoot);
        const realPath = fs.realpathSync(absolutePath);
        return isPathInside(realRoot, realPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR';
      }
    };

    const resolveConfigDependency = (
      filePath: string,
      source: string,
      displayPath: string = filePath,
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
        core.warning(
          `Ignoring unsafe config dependency "${displayPath}": ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (
      fileUrl: string,
      displayFileUrl: string = fileUrl,
    ): string[] => {
      const filePath = fileUrl.replace('file://', '');
      const displayPath = displayFileUrl.replace('file://', '');
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
        displayPath,
      );
      if (!absolutePath) {
        return [];
      }

      const resolvedPaths: string[] = [];

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath)) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, { nodir: true });
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
        let basePath = absolutePath;
        while (glob.hasMagic(basePath)) {
          const parentPath = path.dirname(basePath);
          if (parentPath === basePath) {
            break;
          }
          basePath = parentPath;
        }
        if (isSafeDependencyPath(basePath)) {
          if (path.relative(cwd, basePath) === '') {
            dependencies.add(absolutePath);
          } else {
            dependencies.add(`${basePath.replace(/[\\/]+$/, '')}${path.sep}`);
          }
        }
      } else if (isDirectory(absolutePath)) {
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

      return resolvedPaths;
    };

    // Extract provider files
    const visitedProviderConfigs = new Set<string>();
    const visitedProviderValues = new WeakSet<object>();
    const processProviderValue = (
      value: unknown,
      nestedReference: boolean = false,
    ): void => {
      if (typeof value === 'string') {
        if (!value.startsWith('file://')) {
          return;
        }

        const rawProviderPath = value.slice('file://'.length);
        let unresolvedTemplate = false;
        const providerPath = rawProviderPath.replace(
          /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
          (template: string, key: string) => {
            const envValue = process.env[key];
            if (envValue === undefined) {
              unresolvedTemplate = true;
              return template;
            }
            return envValue;
          },
        );
        if (unresolvedTemplate || /\{\{|\}\}/.test(providerPath)) {
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

        const resolvedPaths = processFileUrl(`file://${cleanPath}`, value);
        if (
          resolvedPaths.length === 0 &&
          cleanPath &&
          !cleanPath.includes('\0') &&
          !glob.hasMagic(cleanPath)
        ) {
          const lexicalPath = path.resolve(configDir, cleanPath);
          if (isPathInside(dependencyRoot, lexicalPath)) {
            dependencies.add(lexicalPath);
          }
        }

        for (const absolutePath of resolvedPaths) {
          if (
            !/\.(?:ya?ml|json)$/i.test(absolutePath) ||
            visitedProviderConfigs.has(absolutePath)
          ) {
            continue;
          }

          visitedProviderConfigs.add(absolutePath);
          try {
            const providerConfig = loadYaml(
              fs.readFileSync(absolutePath, 'utf8'),
              {
                schema: CORE_SCHEMA.withTags(mergeTag),
              },
            );
            processProviderValue(providerConfig, nestedReference);
          } catch {
            core.warning(
              `Failed to extract nested provider dependencies from "${rawProviderPath}"; tracking the provider config file only`,
            );
          }
        }
        return;
      }

      if (typeof value !== 'object' || value === null) {
        return;
      }

      if (visitedProviderValues.has(value)) {
        return;
      }
      visitedProviderValues.add(value);

      if (Array.isArray(value)) {
        for (const entry of value) {
          processProviderValue(entry, nestedReference);
        }
        return;
      }

      for (const [key, nestedValue] of Object.entries(value)) {
        if (key.startsWith('file://')) {
          processProviderValue(key, nestedReference);
        }
        processProviderValue(nestedValue, nestedReference || key !== 'id');
      }
    };

    processProviderValue(config.providers);
    processProviderValue(config.targets);

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
  } catch (error) {
    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
