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
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

type PromptEntry =
  | string
  | { file?: string; id?: string; raw?: string; [key: string]: unknown };
type TestVars = string | string[] | { [key: string]: unknown };

type LegacyYamlSet = Record<string, unknown>;
const MAX_BRACE_EXPANSIONS = 1024;
const GLOB_MAGIC_OPTIONS = {
  magicalBraces: true,
  nonegate: true,
  braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
};

const legacySetTag = defineMappingTag<LegacyYamlSet>('tag:yaml.org,2002:set', {
  ...legacyMapTag,
  identify: setTag.identify,
  represent: setTag.represent,
  addPair: (container, key, value) => {
    if (value !== null) {
      return 'cannot resolve a set item';
    }
    return legacyMapTag.addPair(container, key, null);
  },
});

const CONFIG_YAML_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  binaryTag,
  timestampTag,
  omapTag,
  pairsTag,
  legacySetTag,
);

export interface PromptfooConfig {
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: string | PromptEntry[] | Record<string, string>;
  tests?: Array<{
    vars?: TestVars;
    assert?: Array<{ type?: string; value?: string | { file?: string } }>;
    [key: string]: unknown;
  }>;
  defaultTest?: {
    vars?: TestVars;
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

function isTraversableRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
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
    const configContent = fs.readFileSync(configPath, 'utf8');
    if (!configContent.trim()) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const config = loadYaml(configContent, {
      schema: CONFIG_YAML_SCHEMA,
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
    const processFileUrl = (fileUrl: string): string[] | undefined => {
      const filePath = fileUrl.replace('file://', '').replace(/\\/g, '/');
      if (filePath.includes('\0')) {
        core.warning(
          'Ignoring unsafe config dependency: config file dependency contains an invalid null byte',
        );
        return;
      }

      // Check if the path contains glob patterns
      if (glob.hasMagic(filePath, GLOB_MAGIC_OPTIONS)) {
        const expandedPaths = braceExpand(filePath, {
          braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
        });
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          dependencies.add(
            `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          );
          core.warning(
            'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
          );
          return;
        }

        const safePatterns: string[] = [];
        let unsafeAlternative = false;
        for (const expandedPath of expandedPaths) {
          const absolutePattern = path.resolve(configDir, expandedPath);
          if (isPathInside(dependencyRoot, absolutePattern)) {
            safePatterns.push(absolutePattern);
          } else {
            unsafeAlternative = true;
          }
        }
        if (unsafeAlternative) {
          core.warning(
            'Ignoring unsafe config dependency glob alternative: config file dependency glob alternative must stay within the repository workspace',
          );
        }
        if (safePatterns.length === 0) {
          return;
        }

        const matches = glob.sync(
          safePatterns.length === 1 ? safePatterns[0] : safePatterns,
          {
            nodir: true,
            windowsPathsNoEscape: true,
          },
        );
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

        for (const absolutePattern of safePatterns) {
          if (!glob.hasMagic(absolutePattern, GLOB_MAGIC_OPTIONS)) {
            dependencies.add(absolutePattern);
            continue;
          }
          const absoluteRoot = path.parse(absolutePattern).root;
          const pathParts = path
            .relative(absoluteRoot, absolutePattern)
            .split(path.sep);
          let basePath = absoluteRoot;
          for (const part of pathParts) {
            if (glob.hasMagic(part, GLOB_MAGIC_OPTIONS)) {
              break;
            }
            basePath = path.join(basePath, part);
          }
          dependencies.add(
            path.relative(cwd, basePath) === ''
              ? absolutePattern
              : matches.length === 0
                ? `${basePath.replace(/[\\/]+$/, '')}${path.sep}`
                : basePath,
          );
        }
        return safePatterns;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      if (isDirectory(absolutePath)) {
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
    if (Array.isArray(config.providers)) {
      for (const provider of config.providers) {
        if (typeof provider === 'string' && provider.startsWith('file://')) {
          processFileUrl(provider);
        } else if (
          typeof provider === 'object' &&
          provider !== null &&
          typeof provider.id === 'string' &&
          provider.id.startsWith('file://')
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
            : isTraversableRecord(config.prompts)
              ? Object.keys(config.prompts)
              : [];

      const visitedPromptFiles = new Set<string>();
      const resolvePromptProbe = (
        filePath: string,
        baseDir = configDir,
      ): string | undefined => {
        if (!filePath || filePath.includes('\0')) {
          return undefined;
        }
        const absolutePath = path.isAbsolute(filePath)
          ? path.resolve(filePath)
          : path.resolve(path.join(baseDir, filePath));
        return isPathInside(dependencyRoot, absolutePath)
          ? absolutePath
          : undefined;
      };
      const processPromptReference = (
        reference: string,
        declaredFile = false,
        promptExecutionCwd = executionCwd,
      ): void => {
        const isExecutable = reference.startsWith('exec:');
        const isFileUrl = reference.startsWith('file://');
        const isTemplated = !isExecutable && /\{[{%#]/.test(reference);
        const isEnvironmentTemplate =
          /^\s*\{\{-?\s*env(?:\.|\s*\[)[^}]*-?\}\}\s*$/.test(reference);
        if (
          !declaredFile &&
          !isExecutable &&
          !isFileUrl &&
          (reference.length > 65_536 ||
            ['\n', 'portkey://', 'langfuse://', 'helicone://'].some((value) =>
              reference.includes(value),
            ))
        ) {
          return;
        }
        if (
          !declaredFile &&
          !isExecutable &&
          !isFileUrl &&
          /\s/.test(reference) &&
          /(?:^|\s)(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(reference) &&
          !/^\s*(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(reference)
        ) {
          return;
        }
        const looksLikePath =
          declaredFile ||
          isExecutable ||
          isFileUrl ||
          isEnvironmentTemplate ||
          (reference.includes('*') &&
            (/\*+\.(?:[A-Za-z0-9_-]|\{|@\()/.test(reference) ||
              /^[^*]*\*+$/.test(reference) ||
              (!/\s/.test(reference) && /\*\([^/]*\)/.test(reference)))) ||
          (!reference.includes('*') &&
            !reference.includes('\0') &&
            !/\s/.test(reference) &&
            !isTemplated &&
            glob.hasMagic(reference, GLOB_MAGIC_OPTIONS)) ||
          (/[\\/]/.test(reference) && !/\s/.test(reference)) ||
          /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|bat|cmd|ps1|rb|pl)(?::[^\\/]+)?$/i.test(
            reference,
          );

        if (!looksLikePath) {
          const candidatePath = resolvePromptProbe(reference);
          const hasShortExtension =
            reference.charAt(reference.length - 3) === '.' ||
            reference.charAt(reference.length - 4) === '.';
          if (!candidatePath) {
            return;
          }
          if (!fs.existsSync(candidatePath)) {
            if (!hasShortExtension) {
              return;
            }
          } else {
            try {
              const candidateStats = fs.statSync(candidatePath);
              if (
                !candidateStats.isFile() ||
                (candidateStats.mode & 0o111) === 0
              ) {
                return;
              }
            } catch {
              return;
            }
          }
        }

        const executableParts = isExecutable
          ? (
              reference
                .replace(/^exec:/, '')
                .replace(/\{\{[^}]*\}\}/g, (template) =>
                  template.replace(/\s+/g, ''),
                )
                .match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? []
            ).map((part) => part.replace(/^['"]|['"]$/g, ''))
          : [];
        const promptPath = (
          isExecutable ? (executableParts[0] ?? '') : reference
        )
          .replace(/^file:\/\//, '')
          .replace(/(\.(?:cjs|cts|js|mjs|mts|py|ts|go|rb)):[^\\/]+$/i, '$1')
          .replace(/\\/g, '/');
        const promptPatterns = processFileUrl(`file://${promptPath}`);
        if (promptPath.includes('\0')) {
          return;
        }

        for (const rawExecutableArgument of executableParts.slice(1)) {
          const equalsIndex = rawExecutableArgument.indexOf('=');
          const executableArgument =
            rawExecutableArgument.startsWith('-') && equalsIndex >= 0
              ? rawExecutableArgument.slice(equalsIndex + 1)
              : rawExecutableArgument;
          if (/\{[{%#]/.test(executableArgument)) {
            const staticSegments: string[] = [];
            for (const segment of executableArgument.split(/[\\/]/)) {
              if (/\{[{%#]/.test(segment)) {
                break;
              }
              staticSegments.push(segment);
            }
            const watchedDirectory = resolvePromptProbe(
              staticSegments.length > 0 ? staticSegments.join(path.sep) : '.',
              promptExecutionCwd,
            );
            if (watchedDirectory) {
              dependencies.add(
                `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
              );
            }
            continue;
          }
          const argumentPath = resolvePromptProbe(
            executableArgument,
            promptExecutionCwd,
          );
          if (!argumentPath) {
            continue;
          }
          if (!fs.existsSync(argumentPath)) {
            const hasShortExtension =
              executableArgument.charAt(executableArgument.length - 3) ===
                '.' ||
              executableArgument.charAt(executableArgument.length - 4) === '.';
            const looksLikeFileArgument =
              !executableArgument.startsWith('-') &&
              (/[\\/]/.test(executableArgument) ||
                hasShortExtension ||
                /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|bat|cmd|ps1|rb|pl)$/i.test(
                  executableArgument,
                ));
            if (looksLikeFileArgument) {
              dependencies.add(argumentPath);
            }
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

        if (isTemplated) {
          const staticSegments: string[] = [];
          for (const segment of promptPath.split(/[\\/]/)) {
            if (/\{[{%#]/.test(segment)) {
              break;
            }
            staticSegments.push(segment);
          }
          const watchedDirectory =
            staticSegments.length === 0
              ? dependencyRoot
              : resolveConfigDependency(
                  staticSegments.join(path.sep),
                  'prompt file dependency',
                );
          if (watchedDirectory) {
            dependencies.add(
              `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
            );
          }
          return;
        }

        const isPromptGlob = glob.hasMagic(promptPath, GLOB_MAGIC_OPTIONS);
        const isStructuredPrompt = /\.(?:json|ya?ml)$/i.test(promptPath);
        const hasFixedExtension = /\.[A-Za-z0-9_-]+$/.test(promptPath);
        if (!isStructuredPrompt && (!isPromptGlob || hasFixedExtension)) {
          return;
        }

        const absolutePath = resolveConfigDependency(
          promptPath,
          'prompt file dependency',
        );
        if (!absolutePath) {
          return;
        }
        let promptFiles: string[];
        if (isPromptGlob) {
          if (!promptPatterns?.length) {
            return;
          }
          promptFiles = glob.sync(
            promptPatterns.length === 1 ? promptPatterns[0] : promptPatterns,
            {
              nodir: true,
              windowsPathsNoEscape: true,
            },
          );
        } else {
          promptFiles = [absolutePath];
        }
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
              { schema: CONFIG_YAML_SCHEMA },
            );
            const visitNestedReferences = (value: unknown): void => {
              if (typeof value === 'string' && value.startsWith('file://')) {
                processPromptReference(value);
              } else if (Array.isArray(value)) {
                for (const nestedValue of value) {
                  visitNestedReferences(nestedValue);
                }
              } else if (isTraversableRecord(value)) {
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
          const promptReference = prompt.raw || prompt.file || prompt.id;
          if (typeof promptReference === 'string') {
            const promptConfig = prompt.config;
            const promptBasePath =
              typeof promptConfig === 'object' &&
              promptConfig !== null &&
              'basePath' in promptConfig &&
              typeof promptConfig.basePath === 'string'
                ? promptConfig.basePath
                : undefined;
            processPromptReference(
              promptReference,
              Boolean(prompt.file && !prompt.raw),
              promptBasePath
                ? path.resolve(executionCwd, promptBasePath)
                : executionCwd,
            );
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars?: TestVars): void => {
      const values =
        typeof vars === 'string'
          ? [vars]
          : Array.isArray(vars)
            ? vars
            : isTraversableRecord(vars)
              ? Object.values(vars)
              : [];
      for (const value of values) {
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
      if (!Array.isArray(asserts)) return;
      for (const assert of asserts) {
        if (
          assert !== null &&
          typeof assert === 'object' &&
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processFileUrl(assert.value);
        } else if (
          assert !== null &&
          typeof assert === 'object' &&
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
    if (isTraversableRecord(config.defaultTest)) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
    }

    // Process tests
    if (Array.isArray(config.tests)) {
      for (const test of config.tests) {
        if (test === null || typeof test !== 'object') continue;
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      const repositoryPath = relativePath.split(path.sep).join('/');
      if (repositoryPath === '') {
        return './';
      }
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch {
    core.warning(
      'Failed to extract dependencies from config: unable to read or parse config',
    );
    return [];
  }
}
