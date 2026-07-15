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

const MAX_BRACE_EXPANSIONS = 1024;
const HTTP_CREDENTIAL_PATH_KEYS = [
  'privateKeyPath',
  'keystorePath',
  'pfxPath',
  'certPath',
  'keyPath',
  'caPath',
] as const;

type TestEntry = {
  path?: string;
  config?: Record<string, unknown>;
  vars?: { [key: string]: string | { file?: string } };
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
};

export interface PromptfooConfig {
  env?: Record<string, unknown>;
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

function stripSpreadsheetSheetSelector(filePath: string): string {
  const hashIndex = filePath.indexOf('#');
  if (hashIndex === -1) return filePath;

  const pathWithoutSheet = filePath.slice(0, hashIndex);
  if (
    /\.(?:xlsx|xls)$/i.test(pathWithoutSheet) ||
    /\{[^/\\{}]*(?:xlsx|xls)[^/\\{}]*\}$/i.test(pathWithoutSheet)
  ) {
    return pathWithoutSheet;
  }
  return filePath;
}

function renderEnvironmentTemplates(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(/\{\{(?:[^}]|\}(?!\}))*\}\}/g, (template) => {
    const expression = template.slice(2, -2).trim();
    const variable = expression.match(
      /^env(?:\.(\w+)|\[['"]([^'"]+)['"]\])(?=\s*(?:\||$))/,
    );
    if (!variable) return template;

    const name = variable[1] ?? variable[2];
    const filters = expression
      .slice(variable[0].length)
      .split('|')
      .slice(1)
      .map((filter) => filter.trim());
    let rendered = env[name];

    for (const filter of filters) {
      const defaultFilter = filter.match(
        /^(?:default|d)\(\s*(['"])(.*?)\1(?:\s*,\s*(true|false))?\s*\)$/,
      );
      if (defaultFilter) {
        if (
          rendered === undefined ||
          (defaultFilter[3] === 'true' && rendered.length === 0)
        ) {
          rendered = defaultFilter[2];
        }
        continue;
      }

      if (rendered === undefined) return template;
      if (filter === 'lower') {
        rendered = rendered.toLowerCase();
      } else if (filter === 'upper') {
        rendered = rendered.toUpperCase();
      } else if (filter === 'trim') {
        rendered = rendered.trim();
      } else if (filter === 'string') {
        rendered = String(rendered);
      } else if (filter === 'int') {
        rendered = String(Number.parseInt(rendered, 10) || 0);
      } else if (filter === 'float') {
        rendered = String(Number.parseFloat(rendered) || 0);
      } else {
        return template;
      }
    }

    return rendered ?? template;
  });
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
  let hasDynamicPromptDependencies = false;
  let hasUnboundedGlobDependencies = false;
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
      schema: YAML_LOAD_SCHEMA,
    }) as PromptfooConfig;

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const parameterSchemaOwners = new WeakSet<object>();
    if (Array.isArray(config.providers)) {
      for (const provider of config.providers) {
        if (typeof provider !== 'object' || provider === null) continue;
        const providerOptions = provider.config
          ? provider
          : Object.values(provider).find(
              (entry) => typeof entry === 'object' && entry !== null,
            );
        if (typeof providerOptions !== 'object' || providerOptions === null) {
          continue;
        }
        const providerConfig = (
          providerOptions as { config?: Record<string, unknown> }
        ).config;
        if (!providerConfig) continue;

        const functions = providerConfig.functions;
        if (Array.isArray(functions)) {
          for (const entry of functions) {
            const parameters = (entry as { parameters?: unknown }).parameters;
            if (typeof parameters === 'object' && parameters !== null) {
              parameterSchemaOwners.add(entry as object);
            }
          }
        }

        const tools = providerConfig.tools;
        if (Array.isArray(tools)) {
          for (const entry of tools) {
            const toolFunction = (entry as { function?: unknown }).function;
            if (typeof toolFunction !== 'object' || toolFunction === null) {
              continue;
            }
            const parameters = (toolFunction as { parameters?: unknown })
              .parameters;
            if (typeof parameters === 'object' && parameters !== null) {
              parameterSchemaOwners.add(toolFunction as object);
            }
          }
        }
      }
    }

    const visitedConfig = new WeakSet<object>();
    const pendingConfig: unknown[] = [config];
    while (pendingConfig.length > 0) {
      const value = pendingConfig.pop();
      if (typeof value !== 'object' || value === null) continue;
      if (ArrayBuffer.isView(value)) continue;
      if (visitedConfig.has(value)) continue;
      visitedConfig.add(value);
      if (Object.keys(value).includes('$ref')) {
        core.warning(
          'YAML $ref dependencies cannot be extracted statically; watching all repository changes',
        );
        return ['./'];
      }
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'parameters' && parameterSchemaOwners.has(value)) continue;
        pendingConfig.push(entry);
      }
    }

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
        if (!isPathInside(dependencyRoot, absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency "${displayPath}": ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    const configuredEnv = Object.fromEntries(
      Object.entries(config.env ?? {}).flatMap(([name, value]) =>
        typeof value === 'string'
          ? [[name, renderEnvironmentTemplates(value, process.env)]]
          : [],
      ),
    );
    const templateEnv: Record<string, string | undefined> = {
      ...process.env,
      ...configuredEnv,
    };

    const globOptions = {
      windowsPathsNoEscape: true,
      magicalBraces: true,
      braceExpandMax: MAX_BRACE_EXPANSIONS,
    };

    const expandSafeGlobPatterns = (
      globPath: string,
      source: string,
    ): string[] | undefined => {
      const expandedPaths = braceExpand(globPath, {
        ...globOptions,
        braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
      });
      if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
        hasUnboundedGlobDependencies = true;
        core.warning(
          `Skipping ${source} glob with too many brace alternatives; conservatively watching all repository changes`,
        );
        return undefined;
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
          `Ignoring unsafe ${source} glob alternative: glob alternative must stay within the repository workspace`,
        );
      }

      return safePatterns;
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (
      fileUrl: string,
      stripFunctionSuffix = false,
      displayFileUrl = fileUrl,
    ): void => {
      const rawFilePath = fileUrl.replace('file://', '');
      const displayFilePath = displayFileUrl.replace('file://', '');
      const filePath = normalizeConfigFilePath(
        stripFunctionSuffix
          ? rawFilePath.replace(/(\.(?:[cm]?[jt]s|py|go|rb)):[^/\\]+$/i, '$1')
          : rawFilePath,
      );
      const globPath = filePath.replace(/\\/g, '/');
      const hasGlobMagic = glob.hasMagic(globPath, globOptions);

      // Check if the path contains glob patterns
      if (hasGlobMagic) {
        const safePatterns = expandSafeGlobPatterns(
          globPath,
          'config dependency',
        );
        if (!safePatterns || safePatterns.length === 0) return;

        // It's a glob pattern, expand it
        const globInput =
          safePatterns.length === 1 && !globPath.includes('{')
            ? safePatterns[0]
            : safePatterns;
        const matches = glob.sync(globInput, {
          nodir: true,
          ...globOptions,
        });
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (isPathInside(dependencyRoot, absoluteMatch)) {
            dependencies.add(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency match "${
                displayFileUrl === fileUrl ? match : displayFilePath
              }": config file dependency glob match must stay within the repository workspace`,
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        for (const safePattern of safePatterns) {
          const root = path.parse(safePattern).root;
          const pathParts = safePattern
            .slice(root.length)
            .split(/[\\/]/)
            .filter(Boolean);
          let basePath = root;
          for (const part of pathParts) {
            if (glob.hasMagic(part, globOptions)) {
              break;
            }
            basePath = path.join(basePath, part);
          }
          const watchedDirectory = glob.hasMagic(safePattern, globOptions)
            ? basePath
            : path.dirname(safePattern);
          if (path.relative(cwd, watchedDirectory) === '') {
            dependencies.add(safePattern);
          } else {
            const hasMatchesInDirectory = matches.some((match) =>
              isPathInside(watchedDirectory, path.resolve(match)),
            );
            dependencies.add(
              !hasMatchesInDirectory
                ? `${watchedDirectory.replace(/[\\/]+$/, '')}${path.sep}`
                : watchedDirectory,
            );
          }
        }
        return;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
        displayFilePath,
      );
      if (!absolutePath) return;

      if (isDirectory(absolutePath) || /[\\/]$/.test(fileUrl)) {
        // It's a directory, preserve trailing slash if it was there
        const directoryPath = /[\\/]$/.test(fileUrl)
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
        ...globOptions,
      });
      if (!isPromptGlob && !/\.(?:json|ya?ml)$/i.test(normalizedPath)) {
        return;
      }

      const promptPatterns = (
        isPromptGlob
          ? expandSafeGlobPatterns(normalizedPath, 'nested prompt dependency')
          : [
              resolveConfigDependency(
                normalizedPath,
                'nested prompt file dependency',
              ),
            ]
      )?.filter((entry): entry is string => entry !== undefined);
      if (!promptPatterns || promptPatterns.length === 0) return;

      const promptFiles = isPromptGlob
        ? glob.sync(
            promptPatterns.length === 1 && !normalizedPath.includes('{')
              ? promptPatterns[0]
              : promptPatterns,
            { nodir: true, ...globOptions },
          )
        : promptPatterns;

      const visited = new WeakSet<object>();
      const walk = (root: unknown): void => {
        const pending = [root];
        while (pending.length > 0) {
          const value = pending.pop();
          if (typeof value === 'string' && value.startsWith('file://')) {
            const renderedReference = renderEnvironmentTemplates(
              value,
              templateEnv,
            ).replace(/\{#[\s\S]*?#\}/g, '');
            if (/\{(?:\{|%)[\s\S]*?(?:\}\}|%\})/.test(renderedReference)) {
              hasDynamicPromptDependencies = true;
              continue;
            }
            processFileUrl(renderedReference, true, value);
          } else if (typeof value === 'object' && value !== null) {
            if (ArrayBuffer.isView(value)) continue;
            if (visited.has(value)) continue;
            visited.add(value);
            for (const entry of Object.values(value).reverse()) {
              pending.push(entry);
            }
          }
        }
      };

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
              `Ignoring unsafe prompt file dependency "${normalizedPath}": resolved path must stay within the repository workspace`,
            );
            continue;
          }
          const promptContent = fs.readFileSync(physicalPromptFile, 'utf8');
          const parsed = absolutePromptFile.endsWith('.json')
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

    const extractNestedConfigDependencies = (
      root: unknown,
      env = templateEnv,
    ): void => {
      const visited = new WeakSet<object>();
      const pending = [root];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'string') {
          if (!value.startsWith('file://')) {
            if (
              value.includes('file://') &&
              /\{(?:\{|%)[\s\S]*?(?:\}\}|%\})/.test(value)
            ) {
              hasDynamicPromptDependencies = true;
            }
            continue;
          }
          const renderedReference = renderEnvironmentTemplates(value, env);
          if (/\{(?:\{|%)[\s\S]*?(?:\}\}|%\})/.test(renderedReference)) {
            hasDynamicPromptDependencies = true;
            continue;
          }
          processFileUrl(renderedReference, true, value);
          continue;
        }
        if (typeof value !== 'object' || value === null) continue;
        if (ArrayBuffer.isView(value) || visited.has(value)) continue;
        visited.add(value);

        const fileConfig = value as { type?: unknown; path?: unknown };
        if (fileConfig.type === 'file' && typeof fileConfig.path === 'string') {
          const renderedPath = renderEnvironmentTemplates(fileConfig.path, env);
          if (/\{(?:\{|%)[\s\S]*?(?:\}\}|%\})/.test(renderedPath)) {
            hasDynamicPromptDependencies = true;
          } else {
            processFileUrl(
              renderedPath.startsWith('file://')
                ? renderedPath
                : `file://${renderedPath}`,
              true,
              fileConfig.path.startsWith('file://')
                ? fileConfig.path
                : `file://${fileConfig.path}`,
            );
          }
        }

        for (const key of HTTP_CREDENTIAL_PATH_KEYS) {
          const credentialPath = (value as Record<string, unknown>)[key];
          if (typeof credentialPath !== 'string') continue;
          const renderedPath = renderEnvironmentTemplates(credentialPath, env);
          if (/\{(?:\{|%)[\s\S]*?(?:\}\}|%\})/.test(renderedPath)) {
            hasDynamicPromptDependencies = true;
            continue;
          }
          processFileUrl(
            `file://${renderedPath}`,
            false,
            `file://${credentialPath}`,
          );
        }

        for (const entry of Object.values(value).reverse()) {
          pending.push(entry);
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

        if (typeof provider === 'object' && provider !== null) {
          const providerEnv = Object.fromEntries(
            Object.entries(
              typeof provider.env === 'object' && provider.env !== null
                ? provider.env
                : {},
            ).flatMap(([name, value]) =>
              typeof value === 'string'
                ? [[name, renderEnvironmentTemplates(value, templateEnv)]]
                : [],
            ),
          );
          extractNestedConfigDependencies(provider.config, {
            ...templateEnv,
            ...providerEnv,
          });
        }
      }
    }

    const extractPromptFile = (prompt: PromptEntry): void => {
      const processPromptReference = (reference: string): void => {
        if (/[\r\n]/.test(reference) || reference.length > 65_536) return;
        const isExecutable = reference.startsWith('exec:');
        const hasPathPrefix = /^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(
          reference,
        );
        const hasUriScheme = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(reference);
        const firstSeparator = reference.search(/[\\/]/);
        const leadingSegment =
          firstSeparator === -1
            ? reference
            : reference.slice(0, firstSeparator);
        const hasPathLikeSeparator =
          !hasUriScheme &&
          /[\\/]/.test(reference) &&
          !/\s[\\/]\s/.test(reference) &&
          !/(?:^|\s)[*?](?=\s|$)/.test(leadingSegment) &&
          !/(?:^|\s)\*{1,2}\S+?\*{1,2}\s+\S/.test(leadingSegment) &&
          !/(?:^|\s)\[[^\]]*[\\/][^\]]*\](?=\s|$)/.test(reference) &&
          !/(?:^|\s)\[[^\]]+\]\s+\S/.test(leadingSegment) &&
          !/\?\s+\S/.test(leadingSegment);
        const looksLikePath =
          isExecutable ||
          reference.startsWith('file://') ||
          ((!/\s/.test(reference) || hasPathPrefix || hasPathLikeSeparator) &&
            (reference.includes('*') || /[\\/]/.test(reference))) ||
          ((!/\s/.test(reference) || !/[*?[\]{}]/.test(reference)) &&
            (reference.charAt(reference.length - 3) === '.' ||
              reference.charAt(reference.length - 4) === '.')) ||
          /\.(?:cjs|csv|cts|exe|js|json|jsonl|j2|md|mjs|mts|py|ts|txt|yml|yaml|sh|bash|zsh|bat|cmd|ps1|rb|pl)(?::[^\\/]+)?$/i.test(
            reference,
          );

        if (looksLikePath) {
          const executableParts = isExecutable
            ? (
                reference
                  .replace(/^exec:/, '')
                  .match(/(?:\\.|[^\s"'\\]+|"[^"]*"|'[^']*')+/g) ?? []
              ).map((part) =>
                part.replace(/^['"]|['"]$/g, '').replace(/\\(?=\s)/g, ''),
              )
            : [];
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
          const rawPromptPath = isExecutable
            ? (executableParts[0] ?? '')
            : reference;
          if (!rawPromptPath) return;
          const promptPath = isExecutable
            ? path.resolve(
                promptExecutionCwd,
                normalizeConfigFilePath(
                  rawPromptPath.replace(/^file:\/\//, ''),
                ),
              )
            : rawPromptPath;
          processFileUrl(
            promptPath.startsWith('file://')
              ? promptPath
              : `file://${promptPath}`,
            true,
          );
          extractNestedPromptFileUrls(promptPath);

          for (const executableArgument of executableParts.slice(1)) {
            const argumentPath = path.isAbsolute(executableArgument)
              ? path.resolve(executableArgument)
              : path.resolve(promptExecutionCwd, executableArgument);
            if (!isPathInside(dependencyRoot, argumentPath)) {
              continue;
            }
            if (!fs.existsSync(argumentPath)) {
              if (
                !executableArgument.startsWith('-') &&
                (/[\\/]/.test(executableArgument) ||
                  /\.[A-Za-z0-9]{1,10}$/.test(executableArgument))
              ) {
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
      asserts?: Array<{
        type?: string;
        value?: unknown;
        config?: unknown;
        assert?: Array<{ type?: string; value?: unknown }>;
      }>,
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

        extractNestedConfigDependencies(assert.config);
        extractAssertFiles(assert.assert);
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
      const visitedNestedConfig = new WeakSet<object>();
      const extractNestedFileUrls = (root: unknown): void => {
        const pending = [root];
        while (pending.length > 0) {
          const value = pending.pop();
          if (typeof value === 'string' && value.startsWith('file://')) {
            processFileUrl(value);
          } else if (typeof value === 'object' && value !== null) {
            if (ArrayBuffer.isView(value)) continue;
            if (visitedNestedConfig.has(value)) continue;
            visitedNestedConfig.add(value);
            for (const entry of Object.values(value).reverse()) {
              pending.push(entry);
            }
          }
        }
      };

      for (const test of tests) {
        if (typeof test === 'string') {
          if (test.startsWith('file://')) {
            processFileUrl(stripSpreadsheetSheetSelector(test), true);
          }
          continue;
        }
        if (typeof test !== 'object' || test === null) continue;

        if (typeof test.path === 'string') {
          const testPath = stripSpreadsheetSheetSelector(test.path);
          processFileUrl(
            testPath.startsWith('file://') ? testPath : `file://${testPath}`,
            true,
          );
          extractNestedFileUrls(test.config);
        }
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
      }
    }

    if (hasDynamicPromptDependencies) {
      core.warning(
        'Templated prompt file dependencies cannot be extracted statically; watching all repository changes',
      );
      return ['./'];
    }

    if (hasUnboundedGlobDependencies) {
      return ['./'];
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
