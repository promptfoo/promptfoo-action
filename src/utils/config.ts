import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;

export interface PromptfooConfig {
  extensions?: unknown;
  commandLineOptions?: unknown;
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
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
  const isSafeDependency = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);
  let configParsed = false;

  try {
    if (/\.(?:[cm]?js|[cm]?ts)$/i.test(configPath)) {
      core.warning(
        'Unable to statically resolve dependencies from an executable config. Watching the repository workspace for changes.',
      );
      return ['./'];
    }

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
    configParsed = true;

    let resolvedDependencyRoots: string[] | undefined;
    const getResolvedDependencyRoots = (): string[] => {
      if (resolvedDependencyRoots) {
        return resolvedDependencyRoots;
      }
      resolvedDependencyRoots = Array.from(new Set([configDir, cwd])).flatMap(
        (root) => {
          try {
            return [fs.realpathSync(root)];
          } catch {
            core.warning(
              'Unable to resolve an allowed dependency root. Ignoring this root.',
            );
            return [];
          }
        },
      );
      return resolvedDependencyRoots;
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

        if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) {
          throw new Error(
            `${source} must stay within the checkout or config directory`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependency(absolutePath)) {
          throw new Error(
            `${source} must stay within the checkout or config directory`,
          );
        }

        if (
          filePath.length > MAX_GLOB_PATTERN_LENGTH ||
          absolutePath.length > MAX_GLOB_PATTERN_LENGTH
        ) {
          return absolutePath;
        }

        try {
          fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return absolutePath;
          }
          core.warning(
            'Unable to resolve an existing config dependency. Ignoring this dependency.',
          );
          return undefined;
        }

        let resolvedPath: string;
        try {
          resolvedPath = fs.realpathSync(absolutePath);
        } catch {
          core.warning(
            'Unable to resolve an existing config dependency. Ignoring this dependency.',
          );
          return undefined;
        }
        if (
          !getResolvedDependencyRoots().some((root) =>
            isPathInside(root, resolvedPath),
          )
        ) {
          core.warning(
            `Ignoring unsafe config dependency ${JSON.stringify(
              filePath,
            )}: config dependency must stay within an allowed dependency root`,
          );
          return undefined;
        }

        return absolutePath;
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency ${JSON.stringify(filePath)}: ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      let filePath = fileUrl.replace('file://', '');
      if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      if (
        filePath.length > MAX_GLOB_PATTERN_LENGTH ||
        absolutePath.length > MAX_GLOB_PATTERN_LENGTH
      ) {
        dependencies.add(cwd);
        core.warning(
          'Unable to statically resolve an oversized config file dependency pattern. Watching the repository workspace for changes.',
        );
        return;
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath)) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, { nodir: true });
        const globDependencyRoots = getResolvedDependencyRoots();
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          try {
            const resolvedMatch = fs.realpathSync(absoluteMatch);
            if (
              isSafeDependency(absoluteMatch) &&
              globDependencyRoots.some((root) =>
                isPathInside(root, resolvedMatch),
              )
            ) {
              dependencies.add(absoluteMatch);
              continue;
            }
            core.warning(
              `Ignoring unsafe config dependency glob match ${JSON.stringify(
                match,
              )}: config file dependency glob match must stay within an allowed dependency root`,
            );
          } catch {
            core.warning(
              'Unable to resolve a config dependency glob match. Ignoring this match.',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const filePathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(filePathRoot.length).split(/[\\/]/);
        let basePath = filePathRoot;
        for (const part of pathParts) {
          if (glob.hasMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        if (basePath) {
          const absoluteBase = path.resolve(configDir, basePath);
          dependencies.add(
            absoluteBase.endsWith(path.sep)
              ? absoluteBase
              : `${absoluteBase}${path.sep}`,
          );
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

    // Process extension hook files
    const extensions: unknown[] = [];
    const commandLineOptions =
      config.commandLineOptions != null &&
      typeof config.commandLineOptions === 'object'
        ? config.commandLineOptions
        : undefined;
    let watchWorkspace =
      (typeof config === 'object' && '$ref' in config) ||
      (commandLineOptions != null && '$ref' in commandLineOptions);
    for (const extensionList of [
      config.extensions,
      commandLineOptions != null && 'extension' in commandLineOptions
        ? commandLineOptions.extension
        : undefined,
    ]) {
      if (extensionList == null) {
        continue;
      }
      if (!Array.isArray(extensionList)) {
        watchWorkspace = true;
        continue;
      }
      extensions.push(...extensionList);
    }

    const fileSchemeLength = 'file://'.length;
    for (const extension of extensions) {
      if (typeof extension !== 'string') {
        if (
          extension !== null &&
          typeof extension === 'object' &&
          '$ref' in extension
        ) {
          watchWorkspace = true;
        }
        continue;
      }
      if (extension.includes('{{') || extension.includes('{%')) {
        watchWorkspace = true;
        continue;
      }
      if (!extension.startsWith('file://')) {
        continue;
      }

      const hookSeparator = extension.lastIndexOf(':');
      const windowsDrive = /^file:\/\/\/?[A-Za-z]:[\\/]/.test(extension);
      const windowsDriveSeparator = windowsDrive
        ? extension.indexOf(':', fileSchemeLength)
        : -1;
      const candidateFileUrl = extension.slice(0, hookSeparator);
      const hasHookSuffix =
        hookSeparator > fileSchemeLength &&
        hookSeparator !== windowsDriveSeparator &&
        (/\.(?:[cm]?js|[cm]?ts)$/i.test(candidateFileUrl) ||
          candidateFileUrl.endsWith('.py'));
      processFileUrl(hasHookSuffix ? candidateFileUrl : extension);
    }

    if (watchWorkspace) {
      dependencies.add(cwd);
      core.warning(
        'Unable to statically resolve all config extension dependencies. Watching the repository workspace for changes.',
      );
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      if (relativePath === '') {
        return './';
      }
      const repositoryPath = relativePath.split(path.sep).join('/');
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch {
    if (configParsed) {
      core.warning(
        'Failed to extract dependencies from a parsed config. Watching the repository workspace for changes.',
      );
      return ['./'];
    }
    core.warning(
      'Failed to read or parse the config while extracting dependencies.',
    );
    return [];
  }
}
