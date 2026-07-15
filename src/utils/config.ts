import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
import {
  binaryTag,
  CORE_SCHEMA,
  defineMappingTag,
  legacyMapTag,
  load as loadYaml,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

type PromptEntry =
  | string
  | { file?: string; id?: string; raw?: string; [key: string]: unknown };

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

const legacySetTag = defineMappingTag<Record<string, unknown>>(
  'tag:yaml.org,2002:set',
  {
    ...legacyMapTag,
    identify: setTag.identify,
    represent: setTag.represent,
    addPair: (container, key, value) => {
      if (value !== null) return 'cannot resolve a set item';
      return legacyMapTag.addPair(container, key, null);
    },
  },
);

const YAML_LOAD_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  binaryTag,
  timestampTag,
  omapTag,
  pairsTag,
  legacySetTag,
);

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function normalizeConfigFilePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? filePath.replace(/^\/(?=[A-Za-z]:[\\/])/, '').replace(/\\/g, '/')
    : filePath;
}

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(
  configPath: string,
  executionCwd = process.cwd(),
): string[] {
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

    if (
      /(?:^|[,{]|\n)\s*(?:-\s*)?(?:\?\s*)?["']?\$ref["']?\s*:/m.test(
        configContent,
      )
    ) {
      core.warning(
        'YAML $ref dependencies cannot be extracted statically; watching all repository changes',
      );
      return ['./'];
    }

    const config = loadYaml(configContent, {
      schema: YAML_LOAD_SCHEMA,
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
    const processFileUrl = (
      fileUrl: string,
      stripFunctionSuffix = false,
    ): void => {
      const rawFilePath = fileUrl.replace('file://', '');
      const filePath = normalizeConfigFilePath(
        stripFunctionSuffix
          ? rawFilePath.replace(/(\.(?:[cm]?[jt]s|py|go|rb)):[^/\\]+$/i, '$1')
          : rawFilePath,
      );
      const globPath = filePath.replace(/\\/g, '/');
      const globOptions = { windowsPathsNoEscape: true };
      const hasGlobMagic = glob.hasMagic(globPath, globOptions);
      const absolutePath = resolveConfigDependency(
        hasGlobMagic ? globPath : filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      // Check if the path contains glob patterns
      if (hasGlobMagic) {
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
        const root = path.parse(globPath).root;
        const pathParts = globPath
          .slice(root.length)
          .split(/[\\/]/)
          .filter(Boolean);
        let basePath = root;
        for (const part of pathParts) {
          if (glob.hasMagic(part, globOptions)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        const watchedDirectory = path.resolve(configDir, basePath || '.');
        dependencies.add(
          matches.length === 0
            ? `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`
            : watchedDirectory,
        );
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

    const extractNestedPromptFileUrls = (promptPath: string): void => {
      const rawPath = promptPath
        .replace(/^file:\/\//, '')
        .replace(/(\.(?:[cm]?[jt]s|py|go|rb)):[^/\\]+$/i, '$1');
      const normalizedPath = normalizeConfigFilePath(rawPath).replace(
        /\\/g,
        '/',
      );
      const isPromptGlob = glob.hasMagic(normalizedPath, {
        windowsPathsNoEscape: true,
      });
      if (!isPromptGlob && !/\.(?:json|ya?ml)$/i.test(normalizedPath)) {
        return;
      }

      const absolutePath = resolveConfigDependency(
        normalizedPath,
        'nested prompt file dependency',
      );
      if (!absolutePath) return;

      const promptFiles = isPromptGlob
        ? glob.sync(absolutePath, {
            nodir: true,
            windowsPathsNoEscape: true,
          })
        : [absolutePath];

      const visited = new WeakSet<object>();
      const walk = (value: unknown): void => {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value);
        } else if (Array.isArray(value)) {
          for (const entry of value) walk(entry);
        } else if (typeof value === 'object' && value !== null) {
          if (visited.has(value)) return;
          visited.add(value);
          for (const entry of Object.values(value)) walk(entry);
        }
      };

      for (const promptFile of promptFiles) {
        if (
          !isPathInside(dependencyRoot, promptFile) ||
          !/\.(?:json|ya?ml)$/i.test(promptFile)
        ) {
          continue;
        }
        try {
          const promptContent = fs.readFileSync(promptFile, 'utf8');
          const parsed = promptFile.endsWith('.json')
            ? JSON.parse(promptContent)
            : loadYaml(promptContent, {
                schema: YAML_LOAD_SCHEMA,
              });
          walk(parsed);
        } catch {
          // Promptfoo falls back to raw prompt content when structured parsing fails.
        }
      }
    };

    // Extract provider files
    if (config.providers) {
      for (const provider of config.providers) {
        if (typeof provider === 'string' && provider.startsWith('file://')) {
          processFileUrl(provider, true);
        } else if (
          typeof provider === 'object' &&
          provider.id?.startsWith('file://')
        ) {
          processFileUrl(provider.id, true);
        }
      }
    }

    const extractPromptFile = (prompt: PromptEntry): void => {
      const processPromptReference = (reference: string): void => {
        if (/[\r\n]/.test(reference) || reference.length > 65_536) return;
        const isExecutable = reference.startsWith('exec:');
        const looksLikePath =
          isExecutable ||
          reference.startsWith('file://') ||
          reference.includes('*') ||
          /[\\/]/.test(reference) ||
          /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|zsh|bat|cmd|ps1|rb|pl)(?::[^\\/]+)?$/i.test(
            reference,
          );

        if (looksLikePath) {
          const executableParts = isExecutable
            ? (
                reference
                  .replace(/^exec:/, '')
                  .match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? []
              ).map((part) => part.replace(/^['"]|['"]$/g, ''))
            : [];
          const promptPath = isExecutable
            ? (executableParts[0] ?? '')
            : reference;
          processFileUrl(
            promptPath.startsWith('file://')
              ? promptPath
              : `file://${promptPath}`,
            true,
          );
          extractNestedPromptFileUrls(promptPath);

          const promptConfig =
            typeof prompt === 'object' &&
            prompt.config !== null &&
            typeof prompt.config === 'object'
              ? (prompt.config as Record<string, unknown>)
              : undefined;
          const promptExecutionCwd =
            typeof promptConfig?.basePath === 'string'
              ? path.resolve(executionCwd, promptConfig.basePath)
              : executionCwd;

          for (const executableArgument of executableParts.slice(1)) {
            const argumentPath = path.isAbsolute(executableArgument)
              ? path.resolve(executableArgument)
              : path.resolve(promptExecutionCwd, executableArgument);
            if (
              !isPathInside(dependencyRoot, argumentPath) ||
              !fs.existsSync(argumentPath)
            ) {
              continue;
            }
            try {
              if (fs.statSync(argumentPath).isFile()) {
                dependencies.add(argumentPath);
              }
            } catch {
              // Ignore unreadable arguments while preserving other dependencies.
            }
          }
        }
      };

      if (typeof prompt === 'string') {
        processPromptReference(prompt);
      } else if (
        typeof prompt === 'object' &&
        prompt !== null &&
        typeof prompt.raw === 'string'
      ) {
        processPromptReference(prompt.raw);
      } else if (
        typeof prompt === 'object' &&
        prompt !== null &&
        typeof prompt.id === 'string'
      ) {
        processPromptReference(prompt.id);
      } else if (
        typeof prompt === 'object' &&
        prompt !== null &&
        typeof prompt.file === 'string'
      ) {
        const absolutePath = resolveConfigDependency(
          prompt.file,
          'prompt file dependency',
        );
        if (absolutePath) {
          dependencies.add(absolutePath);
        }
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
          if (/\.(?:[cm]?[jt]s|py):[^/\\]+$/i.test(value)) {
            processFileUrl(value, true);
          }
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
          if (/\.(?:[cm]?[jt]s|py|rb):[^/\\]+$/i.test(assert.value)) {
            processFileUrl(assert.value, true);
          }
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
            processFileUrl(test, true);
          }
          continue;
        }
        if (typeof test !== 'object' || test === null) continue;

        if (typeof test.path === 'string') {
          processFileUrl(
            test.path.startsWith('file://') ? test.path : `file://${test.path}`,
            true,
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
