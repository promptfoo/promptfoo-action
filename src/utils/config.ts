import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;
const MAX_BRACE_EXPANSIONS = 1024;
const HTTP_FILE_CONFIG_KEYS = [
  'validateStatus',
  'transformRequest',
  'transformResponse',
  'responseParser',
  'sessionParser',
] as const;
const HTTP_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts)$/;
const SCRIPT_FILE_SELECTOR = /\.(?:[cm]?js|[cm]?ts|py|go|rb)$/;

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  targets?: Array<string | { id?: string; [key: string]: unknown }>;
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

function sanitizeLogText(value: string): string {
  return value
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
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

  if (isPathInside(cwd, configDir)) {
    try {
      const realWorkspace = fs.realpathSync(cwd);
      const realConfigDir = fs.realpathSync(configDir);
      if (!isPathInside(realWorkspace, realConfigDir)) {
        core.warning(
          'Ignoring unsafe config path: resolved config directory must stay within the repository workspace',
        );
        return ['./'];
      }
    } catch {
      core.warning(
        'Ignoring unsafe config path: resolved config directory cannot be verified',
      );
      return ['./'];
    }
  }

  const getRealDependencyRoots = (): string[] => {
    const roots: string[] = [];
    for (const root of new Set([dependencyRoot, cwd])) {
      try {
        roots.push(fs.realpathSync(root));
      } catch {}
    }
    return roots;
  };
  const watchWorkspace = (): void => {
    dependencies.add(`${cwd.replace(/[\\/]+$/, '')}${path.sep}`);
  };
  let configParsed = false;

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
    configParsed = true;

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
        if (/[\r\n]/.test(filePath)) {
          throw new Error(`${source} contains an invalid line break`);
        }

        if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependency(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        if (absolutePath.length > MAX_GLOB_PATTERN_LENGTH) {
          return absolutePath;
        }

        try {
          fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return absolutePath;
          }
          throw new Error(`${source} resolved path cannot be verified`);
        }

        try {
          const realPath = fs.realpathSync(absolutePath);
          const realRoots = getRealDependencyRoots();
          if (!realRoots.some((root) => isPathInside(root, realPath))) {
            throw new Error(
              `${source} resolved path must stay within the repository workspace`,
            );
          }
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message.includes('must stay within')
              ? error.message
              : `${source} resolved path cannot be verified`,
          );
        }

        return absolutePath;
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency "${sanitizeLogText(filePath)}": ${sanitizeLogText(
            String(error).replace(/^(?:[A-Za-z]+)?Error: /, ''),
          )}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrl.replace('file://', '');
      if (filePath.length > MAX_GLOB_PATTERN_LENGTH) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      if (absolutePath.length > MAX_GLOB_PATTERN_LENGTH) {
        watchWorkspace();
        core.warning(
          'Skipping an oversized config dependency glob; conservatively watching the repository workspace',
        );
        return;
      }

      const globOptions = {
        magicalBraces: true,
        braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
      };
      let isGlob: boolean;
      let expandedPaths: string[];
      try {
        isGlob = glob.hasMagic(filePath, globOptions);
        expandedPaths = isGlob
          ? braceExpand(filePath, globOptions)
          : [filePath];
      } catch (error) {
        watchWorkspace();
        core.warning(
          `Failed to parse config dependency glob: ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
          )}; conservatively watching the repository workspace`,
        );
        return;
      }

      if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
        watchWorkspace();
        core.warning(
          'Skipping config dependency glob with too many brace alternatives; conservatively watching the repository workspace',
        );
        return;
      }

      // Check if the path contains glob patterns
      if (isGlob) {
        // It's a glob pattern, expand it
        const safePatterns = expandedPaths
          .map((expandedPath) => path.resolve(configDir, expandedPath))
          .filter(isSafeDependency);
        if (safePatterns.length < expandedPaths.length) {
          core.warning(
            'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
          );
        }
        if (safePatterns.length === 0) {
          return;
        }

        let matches: string[];
        try {
          matches = glob.sync(safePatterns, {
            nodir: true,
            ...globOptions,
            braceExpandMax: MAX_BRACE_EXPANSIONS,
          });
        } catch (error) {
          watchWorkspace();
          core.warning(
            `Failed to expand config dependency glob: ${sanitizeLogText(
              error instanceof Error ? error.message : String(error),
            )}; conservatively watching the repository workspace`,
          );
          return;
        }
        const realDependencyRoots = getRealDependencyRoots();

        for (const match of matches) {
          if (/[\r\n]/.test(match)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path contains an invalid line break',
            );
            continue;
          }

          const absoluteMatch = path.resolve(match);
          if (!isSafeDependency(absoluteMatch)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
            continue;
          }

          try {
            const realMatch = fs.realpathSync(absoluteMatch);
            if (
              !realDependencyRoots.some((root) => isPathInside(root, realMatch))
            ) {
              core.warning(
                'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
              );
              continue;
            }

            dependencies.add(absoluteMatch);
          } catch {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const filePathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(filePathRoot.length).split(/[\\/]/);
        let basePath = filePathRoot;
        for (const part of pathParts) {
          let partHasMagic: boolean;
          try {
            partHasMagic = glob.hasMagic(part, globOptions);
          } catch (error) {
            watchWorkspace();
            core.warning(
              `Failed to parse config dependency glob base: ${sanitizeLogText(
                error instanceof Error ? error.message : String(error),
              )}; conservatively watching the repository workspace`,
            );
            return;
          }
          if (partHasMagic) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        dependencies.add(path.resolve(configDir, basePath || '.'));
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

    const stripFileSelector = (fileUrl: string, extension: RegExp): string => {
      const rawFilename = fileUrl.slice('file://'.length);
      const lastColon = rawFilename.lastIndexOf(':');
      const candidateFilename = rawFilename.slice(0, lastColon);
      const candidateExport = rawFilename.slice(lastColon + 1);
      return lastColon !== -1 &&
        candidateExport &&
        extension.test(candidateFilename)
        ? `file://${candidateFilename}`
        : fileUrl;
    };

    // Extract provider files
    const providers = [...(config.providers ?? []), ...(config.targets ?? [])];
    if (providers.length > 0) {
      for (const provider of providers) {
        if (typeof provider === 'string' && provider.startsWith('file://')) {
          processFileUrl(provider);
        } else if (
          typeof provider === 'object' &&
          provider.id?.startsWith('file://')
        ) {
          processFileUrl(provider.id);
        } else if (typeof provider === 'object' && provider !== null) {
          const httpProviders: Array<[string, unknown]> =
            typeof provider.id === 'string'
              ? [[provider.id, provider]]
              : Object.entries(provider);
          for (const [providerId, options] of httpProviders) {
            if (
              !/^(?:https?:|https?$)/i.test(providerId) ||
              typeof options !== 'object' ||
              options === null ||
              !('config' in options) ||
              typeof options.config !== 'object' ||
              options.config === null
            ) {
              continue;
            }
            const providerConfig = options.config as Record<string, unknown>;
            for (const key of HTTP_FILE_CONFIG_KEYS) {
              const value = providerConfig[key];
              if (typeof value === 'string' && value.startsWith('file://')) {
                processFileUrl(stripFileSelector(value, HTTP_FILE_SELECTOR));
              }
            }
          }
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
          processFileUrl(stripFileSelector(value, SCRIPT_FILE_SELECTOR));
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
          processFileUrl(stripFileSelector(assert.value, SCRIPT_FILE_SELECTOR));
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
  } catch (error) {
    core.warning(
      `Failed to extract dependencies from config: ${sanitizeLogText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return configParsed ? ['./'] : [];
  }
}
