import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

export interface PromptfooConfig {
  env?: { [key: string]: unknown };
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
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

// Resolve the underlying file for a `file://` provider reference. Promptfoo
// qualifies script providers with a function selector (`...py:custom_call`).
// Strip callable selectors only for supported script types so literal colon
// paths and non-script paths are not silently reinterpreted.
// JavaScript/TypeScript selectors are supported for nested provider config
// references (such as tools), but not for top-level provider IDs.
function providerFilePath(fileUrl: string, allowJavascript = false): string {
  const encodedPath = fileUrl.slice('file://'.length);
  // On Windows a `file:///C:/...` URL yields a leading slash before the drive
  // letter; drop it so the drive colon is not mistaken for a function selector.
  const rawPath =
    process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(encodedPath)
      ? encodedPath.slice(1)
      : encodedPath;
  const functionSeparator = rawPath.lastIndexOf(':');
  const scriptPath = rawPath.slice(0, functionSeparator);
  const functionName = rawPath.slice(functionSeparator + 1);
  const isSupportedScript =
    /\.py$/i.test(scriptPath) ||
    (allowJavascript
      ? /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(scriptPath)
      : /\.(?:go|rb)$/i.test(scriptPath));
  const isValidFunctionName =
    functionName.length === 0 ||
    (/\.go$/i.test(scriptPath)
      ? /^(?:call_api|CallApi)$/.test(functionName)
      : /^[^\\/:\0]+$/u.test(functionName));
  if (functionSeparator > 1 && isSupportedScript && isValidFunctionName) {
    return scriptPath;
  }
  return rawPath;
}

function renderEnvTemplate(
  value: string,
  environment: Record<string, string | undefined>,
): string {
  return value.replace(
    /\{\{\s*env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*\}\}/g,
    (template, dotName: string | undefined, bracketName: string | undefined) =>
      environment[dotName ?? (bracketName as string)] ?? template,
  );
}

function environmentValues(
  value: unknown,
  baseEnvironment: Record<string, string | undefined>,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, envValue]) => {
      if (typeof envValue === 'string') {
        return [[key, renderEnvTemplate(envValue, baseEnvironment)]];
      }
      if (typeof envValue === 'number' || typeof envValue === 'boolean') {
        return [[key, String(envValue)]];
      }
      return [];
    }),
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

    const configEnvironment = {
      ...process.env,
      ...environmentValues(config.env, process.env),
    };

    let realDependencyRoot: string | undefined;
    const isSafeDependencyPath = (absolutePath: string): boolean => {
      if (!isPathInside(dependencyRoot, absolutePath)) {
        return false;
      }

      try {
        if (!realDependencyRoot) {
          realDependencyRoot = fs.realpathSync(dependencyRoot);
        }
      } catch {
        return false;
      }

      let existingPath = absolutePath;
      while (existingPath !== dependencyRoot) {
        try {
          const realPath = fs.realpathSync(existingPath);
          return isPathInside(realDependencyRoot, realPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return false;
          }

          existingPath = path.dirname(existingPath);
        }
      }
      return true;
    };

    const resolveConfigDependency = (
      filePath: string,
      source: string,
      displayPath = filePath,
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
          filePath.length > 0 &&
          !filePath.includes('\0') &&
          isPathInside(dependencyRoot, path.resolve(configDir, filePath))
        ) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
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
      isProvider = false,
      allowJavascript = false,
      environment: Record<string, string | undefined> = configEnvironment,
    ): string[] => {
      const renderedFileUrl = renderEnvTemplate(fileUrl, environment);
      if (/\{\{|\{%/.test(renderedFileUrl)) {
        dependencies.add(`${dependencyRoot}${path.sep}`);
        return [];
      }

      const filePath = isProvider
        ? providerFilePath(renderedFileUrl, allowJavascript)
        : renderedFileUrl.slice('file://'.length);
      const displayPath = isProvider
        ? providerFilePath(fileUrl, allowJavascript)
        : fileUrl.slice('file://'.length);
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
        displayPath,
      );
      if (!absolutePath) {
        if (renderedFileUrl !== fileUrl) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
        return [];
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath)) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, { nodir: true });
        const safeMatches: string[] = [];
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (isSafeDependencyPath(absoluteMatch)) {
            dependencies.add(absoluteMatch);
            safeMatches.push(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency match "${
                renderedFileUrl === fileUrl ? match : displayPath
              }": config file dependency glob match must stay within the repository workspace`,
            );
          }
        }

        // Also add the absolute, non-glob prefix for watching deletions.
        let basePath = absolutePath;
        while (glob.hasMagic(basePath)) {
          basePath = path.dirname(basePath);
        }
        dependencies.add(`${basePath.replace(/[\\/]+$/, '')}${path.sep}`);
        return safeMatches;
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

      return [absolutePath];
    };

    // Extract provider files
    const inspectedProviderFiles = new Set<string>();
    const activeProviderObjects = new WeakSet<object>();

    const processProviderValue = (
      value: unknown,
      isProviderReference = false,
      environment: Record<string, string | undefined> = configEnvironment,
    ): void => {
      if (typeof value === 'string') {
        if (!value.startsWith('file://')) {
          return;
        }
        processProviderReference(value, isProviderReference, environment);
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      if (activeProviderObjects.has(value)) {
        return;
      }
      activeProviderObjects.add(value);

      try {
        if (Array.isArray(value)) {
          for (const item of value) {
            processProviderValue(item, isProviderReference, environment);
          }
          return;
        }

        const providerEnvironment = {
          ...environmentValues((value as { env?: unknown }).env, environment),
          ...environment,
        };

        for (const [key, nestedValue] of Object.entries(value)) {
          if (key.startsWith('file://')) {
            processProviderReference(key, true, providerEnvironment);
          }
          processProviderValue(nestedValue, key === 'id', providerEnvironment);
        }
      } finally {
        activeProviderObjects.delete(value);
      }
    };

    const processProviderReference = (
      provider: string,
      isProviderReference = true,
      environment: Record<string, string | undefined> = configEnvironment,
    ): void => {
      const allowJavascript = !isProviderReference;
      const renderedProvider = renderEnvTemplate(provider, environment);
      const providerPath = providerFilePath(renderedProvider, allowJavascript);
      const displayProviderPath = providerFilePath(provider, allowJavascript);
      const providerPaths = processFileUrl(
        provider,
        true,
        allowJavascript,
        environment,
      );
      const isProviderConfig = /\.(?:ya?ml|json)$/i.test(providerPath);
      if (providerPaths.length === 0) {
        const isContainedReference = isPathInside(
          dependencyRoot,
          path.resolve(configDir, providerPath),
        );
        if (
          isProviderConfig ||
          (providerPath.length > 0 &&
            !providerPath.includes('\0') &&
            isContainedReference &&
            !glob.hasMagic(providerPath))
        ) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
        return;
      }

      for (const absolutePath of providerPaths) {
        const inspectionKey = `${absolutePath}\0${JSON.stringify(
          environment,
          Object.keys(environment).sort(),
        )}`;
        if (
          !/\.(?:ya?ml|json)$/i.test(absolutePath) ||
          inspectedProviderFiles.has(inspectionKey)
        ) {
          continue;
        }

        inspectedProviderFiles.add(inspectionKey);
        try {
          const providerConfig = loadYaml(
            fs.readFileSync(absolutePath, 'utf8'),
            {
              schema: CORE_SCHEMA.withTags(mergeTag),
            },
          );
          processProviderValue(providerConfig, false, environment);
        } catch {
          core.warning(
            `Failed to inspect provider config dependency "${displayProviderPath}". Watching the repository workspace conservatively.`,
          );
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
      }
    };

    for (const providers of [config.providers, config.targets]) {
      if (providers) {
        processProviderValue(providers, true);
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
