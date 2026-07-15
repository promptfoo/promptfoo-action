import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

export interface PromptfooConfig {
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
  const isValidFunctionName = /\.go$/i.test(scriptPath)
    ? /^(?:call_api|CallApi)$/.test(functionName)
    : /^[^\\/:\0]+$/u.test(functionName);
  if (functionSeparator > 1 && isSupportedScript && isValidFunctionName) {
    return scriptPath;
  }
  return rawPath;
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

    let realDependencyRoot: string | undefined;
    const isSafeDependencyPath = (absolutePath: string): boolean => {
      if (!isPathInside(dependencyRoot, absolutePath)) {
        return false;
      }

      try {
        if (!realDependencyRoot) {
          realDependencyRoot = fs.realpathSync(dependencyRoot);
        }
        const realPath = fs.realpathSync(absolutePath);
        return isPathInside(realDependencyRoot, realPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR';
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
        core.warning(
          `Ignoring unsafe config dependency "${filePath}": ${String(
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
    ): string[] => {
      const filePath = isProvider
        ? providerFilePath(fileUrl, allowJavascript)
        : fileUrl.slice('file://'.length);
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
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
              `Ignoring unsafe config dependency match "${match}": config file dependency glob match must stay within the repository workspace`,
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
    const inspectedProviderObjects = new WeakSet<object>();

    const processProviderValue = (
      value: unknown,
      isProviderReference = false,
    ): void => {
      if (typeof value === 'string') {
        if (!value.startsWith('file://')) {
          return;
        }
        processProviderReference(value, isProviderReference);
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      if (inspectedProviderObjects.has(value)) {
        return;
      }
      inspectedProviderObjects.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          processProviderValue(item, isProviderReference);
        }
        return;
      }

      for (const [key, nestedValue] of Object.entries(value)) {
        if (key.startsWith('file://')) {
          processProviderReference(key);
        }
        processProviderValue(nestedValue, key === 'id');
      }
    };

    const processProviderReference = (
      provider: string,
      isProviderReference = true,
    ): void => {
      const allowJavascript = !isProviderReference;
      const providerPath = providerFilePath(provider, allowJavascript);
      const providerPaths = processFileUrl(provider, true, allowJavascript);
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
        if (
          !/\.(?:ya?ml|json)$/i.test(absolutePath) ||
          inspectedProviderFiles.has(absolutePath)
        ) {
          continue;
        }

        inspectedProviderFiles.add(absolutePath);
        try {
          const providerConfig = loadYaml(
            fs.readFileSync(absolutePath, 'utf8'),
            {
              schema: CORE_SCHEMA.withTags(mergeTag),
            },
          );
          processProviderValue(providerConfig);
        } catch {
          core.warning(
            `Failed to inspect provider config dependency "${providerPath}". Watching the repository workspace conservatively.`,
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
