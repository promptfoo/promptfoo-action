import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

type PromptEntry =
  | string
  | { file?: string; id?: string; raw?: string; [key: string]: unknown };

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: string | PromptEntry[] | Record<string, string>;
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
          ? path.resolve(filePath)
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

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrl.replace('file://', '');
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

    // Extract prompt files
    if (config.prompts) {
      const prompts =
        typeof config.prompts === 'string'
          ? [config.prompts]
          : Array.isArray(config.prompts)
            ? config.prompts
            : Object.keys(config.prompts);

      const visitedPromptFiles = new Set<string>();
      const processPromptReference = (
        reference: string,
        declaredFile = false,
      ): void => {
        const isExecutable = reference.startsWith('exec:');
        const isFileUrl = reference.startsWith('file://');
        const looksLikePath =
          declaredFile ||
          isExecutable ||
          isFileUrl ||
          glob.hasMagic(reference) ||
          /[\\/]/.test(reference) ||
          /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|bat|cmd|ps1|rb|pl)(?::[^\\/]+)?$/i.test(
            reference,
          );

        if (!looksLikePath) {
          return;
        }

        const executablePath = reference
          .replace(/^exec:/, '')
          .match(/^[^\s"']+|"([^"]*)"|'([^']*)'/)?.[0]
          ?.replace(/^['"]|['"]$/g, '');
        const promptPath = (isExecutable ? (executablePath ?? '') : reference)
          .replace(/^file:\/\//, '')
          .replace(/(\.(?:cjs|cts|js|mjs|mts|py|ts|go|rb)):[^\\/]+$/i, '$1');
        processFileUrl(`file://${promptPath}`);

        if (/\{[{%]/.test(promptPath)) {
          const staticSegments: string[] = [];
          for (const segment of promptPath.split(/[\\/]/)) {
            if (/\{[{%]/.test(segment)) {
              break;
            }
            staticSegments.push(segment);
          }
          const staticPath = staticSegments.join(path.sep) || '.';
          const watchedDirectory = resolveConfigDependency(
            staticPath,
            'prompt file dependency',
          );
          if (watchedDirectory) {
            dependencies.add(
              `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
            );
          }
          return;
        }

        const isPromptGlob = glob.hasMagic(promptPath);
        if (!isPromptGlob && !/\.(?:json|ya?ml)$/i.test(promptPath)) {
          return;
        }

        const absolutePath = resolveConfigDependency(
          promptPath,
          'prompt file dependency',
        );
        if (!absolutePath) {
          return;
        }

        const promptFiles = isPromptGlob
          ? glob.sync(absolutePath, { nodir: true })
          : [absolutePath];
        for (const promptFile of promptFiles) {
          const absolutePromptFile = path.resolve(promptFile);
          if (
            !isPathInside(dependencyRoot, absolutePromptFile) ||
            !/\.(?:json|ya?ml)$/i.test(absolutePromptFile)
          ) {
            continue;
          }

          try {
            const physicalPromptFile = fs.existsSync(absolutePromptFile)
              ? fs.realpathSync(absolutePromptFile)
              : absolutePromptFile;
            if (!isPathInside(dependencyRoot, physicalPromptFile)) {
              core.warning(
                `Ignoring unsafe prompt file dependency "${promptPath}": resolved path must stay within the repository workspace`,
              );
              continue;
            }
            if (visitedPromptFiles.has(physicalPromptFile)) {
              continue;
            }
            visitedPromptFiles.add(physicalPromptFile);

            const nestedConfig = loadYaml(
              fs.readFileSync(physicalPromptFile, 'utf8'),
            );
            const visitNestedReferences = (value: unknown): void => {
              if (typeof value === 'string' && value.startsWith('file://')) {
                processPromptReference(value);
              } else if (Array.isArray(value)) {
                for (const nestedValue of value) {
                  visitNestedReferences(nestedValue);
                }
              } else if (typeof value === 'object' && value !== null) {
                for (const nestedValue of Object.values(value)) {
                  visitNestedReferences(nestedValue);
                }
              }
            };
            visitNestedReferences(nestedConfig);
          } catch {
            core.warning(
              `Failed to inspect prompt file dependency "${promptPath}": unable to read or parse file`,
            );
          }
        }
      };

      for (const prompt of prompts) {
        if (typeof prompt === 'string') {
          processPromptReference(prompt);
        } else if (typeof prompt === 'object' && prompt !== null) {
          const promptReference = prompt.file || prompt.raw || prompt.id;
          if (typeof promptReference === 'string') {
            processPromptReference(promptReference, Boolean(prompt.file));
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
