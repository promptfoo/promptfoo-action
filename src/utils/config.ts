import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

interface PromptfooTestConfig {
  path?: string;
  vars?: { [key: string]: string | { file?: string } };
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
}

type PromptfooTests =
  | string
  | PromptfooTestConfig
  | Array<string | PromptfooTestConfig>;

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: PromptfooTests;
  scenarios?: Array<
    string | { config?: PromptfooTestConfig; tests?: PromptfooTests }
  >;
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

        const absolutePath = path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.resolve(path.join(configDir, filePath));
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

    // Helper function to process local paths with glob support
    const processFilePath = (
      filePath: string,
      source = 'config file dependency',
    ): void => {
      const absolutePath = resolveConfigDependency(filePath, source);
      if (!absolutePath) {
        return;
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath)) {
        const absoluteGlob = path.isAbsolute(filePath);
        const relativeGlobPath = absoluteGlob
          ? path.relative(dependencyRoot, filePath)
          : filePath;
        const pathParts = relativeGlobPath.split(path.sep);
        let basePath = '';
        for (const part of pathParts) {
          if (glob.hasMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }

        const globRoot = absoluteGlob ? dependencyRoot : configDir;
        const absoluteBasePath = path.resolve(globRoot, basePath);
        let physicalDependencyRoot: string;
        let physicalBasePath: string;
        try {
          physicalDependencyRoot = fs.realpathSync(dependencyRoot);
          physicalBasePath = fs.realpathSync(absoluteBasePath);
        } catch {
          core.warning(
            `Ignoring unsafe config dependency "${filePath}": ${source} glob root could not be resolved safely`,
          );
          return;
        }

        if (!isPathInside(physicalDependencyRoot, physicalBasePath)) {
          core.warning(
            `Ignoring unsafe config dependency "${filePath}": ${source} glob root must stay within the repository workspace`,
          );
          return;
        }

        const matches = glob.sync(absolutePath, { nodir: true });
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (!isPathInside(dependencyRoot, absoluteMatch)) {
            core.warning(
              `Ignoring unsafe config dependency match "${match}": ${source} glob match must stay within the repository workspace`,
            );
            continue;
          }

          let physicalMatch: string;
          try {
            physicalMatch = fs.realpathSync(absoluteMatch);
          } catch {
            core.warning(
              `Ignoring unsafe config dependency match "${match}": ${source} glob match could not be resolved safely`,
            );
            continue;
          }

          if (!isPathInside(physicalDependencyRoot, physicalMatch)) {
            core.warning(
              `Ignoring unsafe config dependency match "${match}": ${source} glob match must stay within the repository workspace`,
            );
            continue;
          }

          dependencies.add(absoluteMatch);
        }

        if (basePath) {
          dependencies.add(absoluteBasePath);
        }
      } else if (isDirectory(absolutePath)) {
        // It's a directory, preserve trailing slash if it was there
        const directoryPath = filePath.endsWith('/')
          ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
          : absolutePath;
        dependencies.add(directoryPath);
      } else {
        // It's a regular file path
        dependencies.add(absolutePath);
      }
    };

    const processFileUrl = (fileUrl: string): void => {
      processFilePath(fileUrl.replace(/^file:\/\//, ''));
    };

    const processTestFile = (testSource: string): void => {
      let filePath = testSource;
      if (filePath.startsWith('file://')) {
        filePath = filePath.slice('file://'.length);
      } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
        return;
      }

      filePath = filePath.replace(/(\.xlsx?)#[^/\\]*$/i, '$1');

      const functionIndex = filePath.lastIndexOf(':');
      if (
        functionIndex > 1 &&
        /\.(?:py|[cm]?[jt]s)$/i.test(filePath.slice(0, functionIndex))
      ) {
        filePath = filePath.slice(0, functionIndex);
      }

      processFilePath(filePath, 'test file dependency');
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

    const extractTests = (configuredTests?: PromptfooTests): void => {
      if (!configuredTests) {
        return;
      }
      const tests = Array.isArray(configuredTests)
        ? configuredTests
        : [configuredTests];
      for (const test of tests) {
        if (typeof test === 'string') {
          processTestFile(test);
          continue;
        }
        if (test.path) {
          processTestFile(test.path);
          continue;
        }
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
      }
    };

    extractTests(config.tests);
    for (const scenario of config.scenarios ?? []) {
      if (typeof scenario === 'string') {
        processTestFile(scenario);
      } else {
        extractVarFiles(scenario.config?.vars);
        extractAssertFiles(scenario.config?.assert);
        extractTests(scenario.tests);
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
    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
