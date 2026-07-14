import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

interface PromptfooTestConfig {
  path?: string;
  vars?: string | string[] | { [key: string]: string | { file?: string } };
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
}

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: string | PromptfooTestConfig | Array<string | PromptfooTestConfig>;
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

        const absolutePath = path.resolve(path.join(configDir, filePath));
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
      preserveGlobRoot = false,
    ): string[] => {
      const absolutePath = resolveConfigDependency(filePath, source);
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
          if (isPathInside(dependencyRoot, absoluteMatch)) {
            dependencies.add(absoluteMatch);
            safeMatches.push(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency match "${match}": ${source} glob match must stay within the repository workspace`,
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const pathParts = filePath.split(/[\\/]/);
        let basePath = '';
        for (const part of pathParts) {
          if (glob.hasMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        if (basePath || preserveGlobRoot) {
          const globRoot = path.resolve(configDir, basePath || '.');
          dependencies.add(
            preserveGlobRoot
              ? `${globRoot.replace(/[\\/]+$/, '')}${path.sep}`
              : globRoot,
          );
        }
        return safeMatches;
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

      return [absolutePath];
    };

    const processFileUrl = (fileUrl: string): void => {
      processFilePath(fileUrl.replace(/^file:\/\//, ''));
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
    const extractVarFiles = (
      vars?: string | string[] | { [key: string]: unknown },
      baseDir = configDir,
    ): void => {
      if (!vars) return;
      if (typeof vars === 'string' || Array.isArray(vars)) {
        const varFiles = Array.isArray(vars) ? vars : [vars];
        for (let varFile of varFiles) {
          if (varFile.startsWith('file://')) {
            varFile = varFile.slice('file://'.length);
          } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(varFile)) {
            continue;
          }
          const relativeVarFile = path.relative(
            configDir,
            path.resolve(baseDir, varFile),
          );
          processFilePath(
            relativeVarFile,
            'test variable file dependency',
            true,
          );
        }
        return;
      }
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

    const extractNestedFileUrls = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.startsWith('file://')) {
          processFileUrl(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          extractNestedFileUrls(item);
        }
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) {
          extractNestedFileUrls(item);
        }
      }
    };

    const inspectedTestFiles = new Set<string>();
    const inspectTestFile = (testFile: string): void => {
      if (
        inspectedTestFiles.has(testFile) ||
        !/\.(?:ya?ml|json)$/i.test(testFile) ||
        !fs.existsSync(testFile)
      ) {
        return;
      }
      inspectedTestFiles.add(testFile);

      try {
        const testContent = fs.readFileSync(testFile, 'utf8');
        const parsedTests = loadYaml(testContent, {
          schema: CORE_SCHEMA.withTags(mergeTag),
        }) as PromptfooTestConfig | PromptfooTestConfig[] | null;
        const nestedTests = Array.isArray(parsedTests)
          ? parsedTests
          : parsedTests
            ? [parsedTests]
            : [];

        for (const nestedTest of nestedTests) {
          if (typeof nestedTest !== 'object' || nestedTest === null) {
            continue;
          }
          extractVarFiles(nestedTest.vars, path.dirname(testFile));
          extractAssertFiles(nestedTest.assert);
        }
      } catch (error) {
        core.warning(
          `Failed to inspect test file dependency "${testFile}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const processTestFile = (testSource: string): void => {
      let filePath = testSource;
      if (filePath.startsWith('file://')) {
        filePath = filePath.slice('file://'.length);
      } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
        // Remote source (https://, s3://, ...) — not a local file dependency.
        return;
      }

      // Drop a spreadsheet sheet reference, e.g. `tests.csv#Sheet1`.
      const sheetIndex = filePath.indexOf('#');
      if (sheetIndex !== -1) {
        filePath = filePath.slice(0, sheetIndex);
      }

      // Drop a function qualifier, e.g. `tests.py:generate_tests`. Require the
      // colon past index 1 so a Windows drive letter (`C:\...`) is not stripped.
      const functionIndex = filePath.lastIndexOf(':');
      if (functionIndex > 1) {
        filePath = filePath.slice(0, functionIndex);
      }

      for (const testFile of processFilePath(
        filePath,
        'test file dependency',
        true,
      )) {
        inspectTestFile(testFile);
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
      for (const test of tests) {
        if (typeof test === 'string') {
          processTestFile(test);
          continue;
        }
        if (test.path) {
          processTestFile(test.path);
          extractNestedFileUrls(test.config);
          continue;
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
    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
