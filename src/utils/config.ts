import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

type PromptEntry =
  | string
  | { file?: string; id?: string; [key: string]: unknown };

type TestEntry = {
  path?: string;
  config?: Record<string, unknown>;
  vars?: { [key: string]: string | { file?: string } };
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
};

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: PromptEntry[] | Record<string, string>;
  tests?: string | TestEntry | Array<string | TestEntry>;
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
    if (/\.(?:[cm]?[jt]s)$/i.test(configPath)) {
      core.warning(
        'JavaScript/TypeScript config dependencies cannot be extracted statically; watching all repository changes',
      );
      return ['.'];
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

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrl
        .replace('file://', '')
        .replace(/(\.(?:[cm]?[jt]s|py|go|rb)):[^/\\]+$/i, '$1');
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath)) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, { nodir: true });
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
        const pathParts = filePath.split('/');
        let basePath = '';
        for (const part of pathParts) {
          if (glob.hasMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        if (basePath) {
          dependencies.add(path.resolve(path.join(configDir, basePath)));
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

    const extractPromptFile = (prompt: PromptEntry): void => {
      if (typeof prompt === 'string' && prompt.startsWith('file://')) {
        processFileUrl(prompt);
      } else if (
        typeof prompt === 'object' &&
        typeof prompt.file === 'string'
      ) {
        const absolutePath = resolveConfigDependency(
          prompt.file,
          'prompt file dependency',
        );
        if (absolutePath) {
          dependencies.add(absolutePath);
        }
      } else if (
        typeof prompt === 'object' &&
        typeof prompt.id === 'string' &&
        prompt.id.startsWith('file://')
      ) {
        processFileUrl(prompt.id);
      }
    };

    // Extract prompt files. Promptfoo supports an array and a mapping form
    // whose keys contain prompt content and whose values are labels; the map
    // keys flow through the same visitor as array entries.
    if (config.prompts) {
      const promptEntries = Array.isArray(config.prompts)
        ? config.prompts
        : Object.keys(config.prompts);
      for (const prompt of promptEntries) {
        extractPromptFile(prompt);
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
      const tests = Array.isArray(config.tests) ? config.tests : [config.tests];
      const extractNestedFileUrls = (value: unknown): void => {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value);
        } else if (Array.isArray(value)) {
          for (const entry of value) {
            extractNestedFileUrls(entry);
          }
        } else if (typeof value === 'object' && value !== null) {
          for (const entry of Object.values(value)) {
            extractNestedFileUrls(entry);
          }
        }
      };

      for (const test of tests) {
        if (typeof test === 'string') {
          if (test.startsWith('file://')) {
            processFileUrl(test);
          }
          continue;
        }

        if (typeof test.path === 'string') {
          processFileUrl(
            test.path.startsWith('file://') ? test.path : `file://${test.path}`,
          );
          extractNestedFileUrls(test.config);
        }
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
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to extract dependencies from config: ${message}`);
  }
}
