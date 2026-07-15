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
const MAX_GLOB_PATTERN_LENGTH = 65_536;
const MAX_STRUCTURED_PROMPT_BYTES = 10_485_760;
const JAVASCRIPT_EXTENSIONS = new Set(['cjs', 'cts', 'js', 'mjs', 'mts', 'ts']);
const SCRIPT_EXTENSIONS = new Set(['py', 'go', 'rb']);
const PROMPT_FILE_EXTENSIONS = new Set([
  'cjs',
  'csv',
  'cts',
  'exe',
  'js',
  'json',
  'jsonl',
  'j2',
  'md',
  'mjs',
  'mts',
  'py',
  'ts',
  'txt',
  'yml',
  'yaml',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'rb',
  'pl',
]);
const HTTP_CREDENTIAL_PATH_KEYS = [
  'privateKeyPath',
  'keystorePath',
  'pfxPath',
  'certPath',
  'keyPath',
  'caPath',
  'jksPath',
] as const;

type TestVars =
  | string
  | string[]
  | { [key: string]: string | { file?: string } };

type TestEntry = {
  path?: string;
  config?: Record<string, unknown>;
  vars?: TestVars;
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
};

export interface PromptfooConfig {
  env?: Record<string, unknown>;
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: string | PromptEntry[] | Record<string, string>;
  tests?: string | TestEntry | Array<string | TestEntry>;
  defaultTest?: string | TestEntry;
  scenarios?: unknown;
  nunjucksFilters?: Record<string, string>;
  extensions?: unknown;
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

function isForeignWindowsAbsolutePath(filePath: string): boolean {
  return (
    process.platform !== 'win32' &&
    path.win32.isAbsolute(filePath) &&
    !path.isAbsolute(filePath)
  );
}

function sanitizeDependencyDisplayPath(filePath: string): string {
  return /[\0\r\n]/.test(filePath) ? '[redacted]' : filePath;
}

function getPathSuffix(filePath: string):
  | {
      extension: string;
      pathWithoutSelector: string;
      hasSelector: boolean;
    }
  | undefined {
  if (filePath.length > MAX_GLOB_PATTERN_LENGTH || /[\0\r\n]/.test(filePath)) {
    return undefined;
  }
  let separator = -1;
  let extensionStart = -1;
  let selector:
    | {
        extension: string;
        pathWithoutSelector: string;
        hasSelector: true;
      }
    | undefined;
  for (let index = 0; index < filePath.length; index += 1) {
    const character = filePath[index];
    if (character === '/' || character === '\\') {
      separator = index;
      extensionStart = -1;
      continue;
    }
    if (character === '.') {
      extensionStart = index;
      continue;
    }
    if (
      character !== ':' ||
      extensionStart <= separator ||
      index === filePath.length - 1
    ) {
      continue;
    }
    const extension = filePath.slice(extensionStart + 1, index);
    if (!/^[A-Za-z0-9]{1,10}$/.test(extension)) continue;
    selector = {
      extension,
      pathWithoutSelector: filePath.slice(0, index),
      hasSelector: true,
    };
  }
  if (selector) return selector;
  if (extensionStart <= separator) return undefined;
  const extension = filePath.slice(extensionStart + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(extension)) return undefined;
  return {
    extension,
    pathWithoutSelector: filePath,
    hasSelector: false,
  };
}

function getFileFunctionSelector(filePath: string):
  | {
      extension: string;
      pathWithoutSelector: string;
      isJavascript: boolean;
    }
  | undefined {
  const suffix = getPathSuffix(filePath);
  if (!suffix?.hasSelector) return undefined;
  const isJavascript = JAVASCRIPT_EXTENSIONS.has(
    suffix.extension.toLowerCase(),
  );
  if (!isJavascript && !SCRIPT_EXTENSIONS.has(suffix.extension)) {
    return undefined;
  }
  return {
    extension: suffix.extension,
    pathWithoutSelector: suffix.pathWithoutSelector,
    isJavascript,
  };
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
  if (filePath.length > MAX_GLOB_PATTERN_LENGTH || /[\0\r\n]/.test(filePath)) {
    return filePath;
  }
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

function stripNunjucksComments(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let start = value.indexOf('{#', cursor);
  while (start !== -1) {
    const end = value.indexOf('#}', start + 2);
    if (end === -1) break;
    parts.push(value.slice(cursor, start));
    cursor = end + 2;
    start = value.indexOf('{#', cursor);
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function isHttpProviderId(providerId: string): boolean {
  return /^https?(?::|$)/.test(providerId);
}

function renderEnvironmentTemplates(
  value: string,
  env: Record<string, string | undefined>,
): string {
  const renderTemplate = (template: string): string => {
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
  };

  const parts: string[] = [];
  let cursor = 0;
  let start = value.indexOf('{{', cursor);
  while (start !== -1) {
    const end = value.indexOf('}}', start + 2);
    if (end === -1) break;
    parts.push(value.slice(cursor, start));
    parts.push(renderTemplate(value.slice(start, end + 2)));
    cursor = end + 2;
    start = value.indexOf('{{', cursor);
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function hasNunjucksTemplate(value: string): boolean {
  const expressionStart = value.indexOf('{{');
  const blockStart = value.indexOf('{%');
  const start =
    expressionStart === -1
      ? blockStart
      : blockStart === -1
        ? expressionStart
        : Math.min(expressionStart, blockStart);
  if (start === -1) return false;
  return (
    value.indexOf('}}', start + 2) !== -1 ||
    value.indexOf('%}', start + 2) !== -1
  );
}

function renderPathEnvironmentVariables(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (template, bracedName: string | undefined, bareName: string | undefined) =>
      env[bracedName ?? (bareName as string)] ?? template,
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
  let hasDynamicPromptDependencies = false;
  let hasUnboundedGlobDependencies = false;
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  const isDependencyPathInside = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);
  let physicalDependencyRoots: string[] | undefined;
  const isPhysicalDependencyPathInside = (targetPath: string): boolean => {
    if (!physicalDependencyRoots) {
      physicalDependencyRoots = [];
      let physicalConfigDir: string | undefined;
      let physicalCwd: string | undefined;
      for (const root of new Set([configDir, cwd])) {
        try {
          const physicalRoot = fs.realpathSync(root);
          physicalDependencyRoots.push(physicalRoot);
          if (root === configDir) physicalConfigDir = physicalRoot;
          if (root === cwd) physicalCwd = physicalRoot;
        } catch {
          // Another allowed root may still contain this dependency.
        }
      }
      if (
        isPathInside(cwd, configDir) &&
        (!physicalConfigDir ||
          !physicalCwd ||
          !isPathInside(physicalCwd, physicalConfigDir))
      ) {
        throw new Error(
          'Config directory symlinks must stay within the repository workspace',
        );
      }
    }
    return physicalDependencyRoots.some((root) =>
      isPathInside(root, targetPath),
    );
  };

  try {
    if (isPathInside(cwd, configDir)) {
      isPhysicalDependencyPathInside(configDir);
    }
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
    const providerArrays = [config.providers, config.targets].filter(
      Array.isArray,
    );
    for (const providerArray of providerArrays) {
      for (const provider of providerArray) {
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
        if (isForeignWindowsAbsolutePath(filePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isDependencyPathInside(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        const message = String(error);
        const reason = message.includes(
          'must stay within the repository workspace',
        )
          ? `${source} must stay within the repository workspace`
          : message.includes('contains an invalid null byte')
            ? `${source} contains an invalid null byte`
            : `${source} is empty or invalid`;
        core.warning(
          `Ignoring unsafe config dependency "${sanitizeDependencyDisplayPath(displayPath)}": ${reason}`,
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

    const tryHasGlobMagic = (
      globPath: string,
      source: string,
    ): boolean | undefined => {
      if (globPath.length > MAX_GLOB_PATTERN_LENGTH) {
        core.warning(`Ignoring ${source}: pattern is too long`);
        return undefined;
      }
      try {
        return glob.hasMagic(globPath, globOptions);
      } catch {
        core.warning(`Ignoring ${source}: pattern is invalid`);
        return undefined;
      }
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
        if (isForeignWindowsAbsolutePath(expandedPath)) {
          unsafeAlternative = true;
          continue;
        }
        const absolutePattern = path.resolve(configDir, expandedPath);
        if (absolutePattern.length > MAX_GLOB_PATTERN_LENGTH) {
          core.warning(`Ignoring ${source}: pattern is too long`);
          continue;
        }
        if (isDependencyPathInside(absolutePattern)) {
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
      redactDisplayPath = false,
    ): void => {
      const rawFilePath = stripSpreadsheetSheetSelector(
        fileUrl.replace('file://', ''),
      );
      const displayFilePath = sanitizeDependencyDisplayPath(
        redactDisplayPath
          ? '[redacted]'
          : displayFileUrl.replace('file://', ''),
      );
      const selector = stripFunctionSuffix
        ? getFileFunctionSelector(rawFilePath)
        : undefined;
      const hasCaseVariantJavascriptSelector =
        selector?.isJavascript === true &&
        selector.extension !== selector.extension.toLowerCase();
      if (hasCaseVariantJavascriptSelector) {
        processFileUrl(fileUrl, false, displayFileUrl, redactDisplayPath);
      }
      const filePath = normalizeConfigFilePath(
        selector?.pathWithoutSelector ?? rawFilePath,
      );
      const globPath = filePath.replace(/\\/g, '/');
      const hasGlobMagic = tryHasGlobMagic(globPath, 'config dependency');
      if (hasGlobMagic === undefined) return;

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
        let matches: string[];
        try {
          matches = glob.sync(globInput, {
            nodir: true,
            ...globOptions,
          });
        } catch {
          core.warning('Ignoring config dependency: pattern is invalid');
          return;
        }
        for (const match of matches) {
          if (isForeignWindowsAbsolutePath(match)) {
            core.warning(
              `Ignoring unsafe config dependency glob match "${displayFilePath}": resolved path must stay within an allowed dependency root`,
            );
            continue;
          }
          const absoluteMatch = path.resolve(match);
          let physicalMatch: string;
          try {
            physicalMatch = fs.realpathSync(absoluteMatch);
          } catch {
            core.warning(
              `Ignoring unsafe config dependency glob match "${displayFilePath}": resolved path must stay within an allowed dependency root`,
            );
            continue;
          }
          if (
            isDependencyPathInside(absoluteMatch) &&
            isPhysicalDependencyPathInside(physicalMatch)
          ) {
            dependencies.add(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency glob match "${displayFilePath}": resolved path must stay within an allowed dependency root`,
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        for (const safePattern of safePatterns) {
          const safePatternHasMagic = tryHasGlobMagic(
            safePattern,
            'config dependency',
          );
          if (safePatternHasMagic === undefined) continue;
          if (!safePatternHasMagic) {
            dependencies.add(safePattern);
            continue;
          }
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
          const watchedDirectory = basePath;
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

      let pathExists = true;
      try {
        fs.lstatSync(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          core.warning(
            `Ignoring unsafe config dependency "${displayFilePath}": resolved path must stay within an allowed dependency root`,
          );
          return;
        }
        pathExists = false;
      }
      if (pathExists) {
        let physicalPath: string;
        try {
          physicalPath = fs.realpathSync(absolutePath);
        } catch {
          core.warning(
            `Ignoring unsafe config dependency "${displayFilePath}": resolved path must stay within an allowed dependency root`,
          );
          return;
        }
        if (!isPhysicalDependencyPathInside(physicalPath)) {
          core.warning(
            `Ignoring unsafe config dependency "${displayFilePath}": resolved path must stay within an allowed dependency root`,
          );
          return;
        }
      }

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

    const extractHttpFileDependencies = (
      record: Record<string, unknown>,
      env: Record<string, string | undefined>,
    ): void => {
      const auth = record.auth;
      if (
        typeof auth === 'object' &&
        auth !== null &&
        typeof (auth as { path?: unknown }).path === 'string'
      ) {
        const authType = (auth as { type?: unknown }).type;
        const renderedAuthType =
          typeof authType === 'string'
            ? renderEnvironmentTemplates(authType, env)
            : undefined;
        if (renderedAuthType && hasNunjucksTemplate(renderedAuthType)) {
          hasDynamicPromptDependencies = true;
        } else if (renderedAuthType === 'file') {
          const authPath = (auth as { path: string }).path;
          const renderedPath = renderEnvironmentTemplates(authPath, env);
          if (hasNunjucksTemplate(renderedPath)) {
            hasDynamicPromptDependencies = true;
          } else {
            processFileUrl(
              renderedPath.startsWith('file://')
                ? renderedPath
                : `file://${renderedPath}`,
              true,
              authPath.startsWith('file://') ? authPath : `file://${authPath}`,
              true,
            );
          }
        }
      }

      for (const containerKey of ['signatureAuth', 'tls'] as const) {
        const container = record[containerKey];
        if (typeof container !== 'object' || container === null) continue;
        for (const key of HTTP_CREDENTIAL_PATH_KEYS) {
          const credentialPath = (container as Record<string, unknown>)[key];
          if (typeof credentialPath !== 'string') continue;
          const renderedPath = renderEnvironmentTemplates(credentialPath, env);
          if (hasNunjucksTemplate(renderedPath)) {
            hasDynamicPromptDependencies = true;
            continue;
          }
          processFileUrl(
            `file://${renderedPath}`,
            false,
            `file://${credentialPath}`,
            true,
          );
        }
      }

      const multipart = record.multipart;
      const parts =
        typeof multipart === 'object' &&
        multipart !== null &&
        Array.isArray((multipart as { parts?: unknown }).parts)
          ? (multipart as { parts: unknown[] }).parts
          : [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const source = (part as { source?: unknown }).source;
        if (
          typeof source !== 'object' ||
          source === null ||
          typeof (source as { path?: unknown }).path !== 'string'
        ) {
          continue;
        }
        const sourceType = (source as { type?: unknown }).type;
        const renderedSourceType =
          typeof sourceType === 'string'
            ? renderEnvironmentTemplates(sourceType, env)
            : undefined;
        if (renderedSourceType && hasNunjucksTemplate(renderedSourceType)) {
          hasDynamicPromptDependencies = true;
          continue;
        }
        if (renderedSourceType !== 'path') continue;
        const sourcePath = (source as { path: string }).path;
        const renderedPath = renderEnvironmentTemplates(sourcePath, env);
        if (hasNunjucksTemplate(renderedPath)) {
          hasDynamicPromptDependencies = true;
          continue;
        }
        processFileUrl(
          renderedPath.startsWith('file://')
            ? renderedPath
            : `file://${renderedPath}`,
          false,
          sourcePath.startsWith('file://')
            ? sourcePath
            : `file://${sourcePath}`,
          true,
        );
      }
    };

    const visitedStructuredFiles = new Set<string>();
    const extractNestedPromptFileUrls = (
      promptPath: string,
      displayPromptPath = promptPath,
      scanProviderPaths = false,
      resolveNestedProviderPaths = false,
      knownHttpProvider = false,
      initialEnv = templateEnv,
      failClosedOnRefs = false,
    ): void => {
      const pathWithoutPrefix = promptPath.replace(/^file:\/\//, '');
      const rawPath =
        getFileFunctionSelector(pathWithoutPrefix)?.pathWithoutSelector ??
        pathWithoutPrefix;
      const normalizedPath = normalizeConfigFilePath(rawPath).replace(
        /\\/g,
        '/',
      );
      const isPromptGlob = tryHasGlobMagic(
        normalizedPath,
        'nested prompt dependency',
      );
      if (isPromptGlob === undefined) return;
      if (!isPromptGlob && !/\.(?:jsonl?|ya?ml)$/i.test(normalizedPath)) {
        return;
      }

      const promptPatterns = (
        isPromptGlob
          ? expandSafeGlobPatterns(normalizedPath, 'nested prompt dependency')
          : [
              resolveConfigDependency(
                normalizedPath,
                'nested prompt file dependency',
                displayPromptPath.replace(/^file:\/\//, ''),
              ),
            ]
      )?.filter((entry): entry is string => entry !== undefined);
      if (!promptPatterns || promptPatterns.length === 0) return;

      let promptFiles = promptPatterns;
      if (isPromptGlob) {
        try {
          promptFiles = glob.sync(
            promptPatterns.length === 1 && !normalizedPath.includes('{')
              ? promptPatterns[0]
              : promptPatterns,
            { nodir: true, ...globOptions },
          );
        } catch {
          core.warning('Ignoring nested prompt dependency: pattern is invalid');
          return;
        }
      }

      const visited = new WeakMap<object, number>();
      const walk = (root: unknown, sourcePath: string): void => {
        const pending: Array<{
          value: unknown;
          env: Record<string, string | undefined>;
          providerContext: boolean;
          providerRoot: boolean;
          testVarsFileContext: boolean;
        }> = [
          {
            value: root,
            env: initialEnv,
            providerContext: scanProviderPaths,
            providerRoot: false,
            testVarsFileContext: false,
          },
        ];
        while (pending.length > 0) {
          const current = pending[pending.length - 1];
          pending.length -= 1;
          const {
            value,
            env,
            providerContext,
            providerRoot,
            testVarsFileContext,
          } = current;
          if (providerRoot) {
            extractProviderDependencies(
              value,
              resolveNestedProviderPaths ? path.dirname(sourcePath) : configDir,
              env,
            );
          }
          if (
            typeof value === 'string' &&
            (value.startsWith('file://') || testVarsFileContext)
          ) {
            const fileReference = value.startsWith('file://')
              ? value
              : `file://${value}`;
            const renderedReference = stripNunjucksComments(
              renderEnvironmentTemplates(fileReference, env),
            );
            if (hasNunjucksTemplate(renderedReference)) {
              hasDynamicPromptDependencies = true;
              continue;
            }
            const providerReference =
              (providerContext || testVarsFileContext) &&
              resolveNestedProviderPaths &&
              !path.isAbsolute(renderedReference.replace(/^file:\/\//, '')) &&
              !isForeignWindowsAbsolutePath(
                renderedReference.replace(/^file:\/\//, ''),
              )
                ? `file://${path.resolve(
                    path.dirname(sourcePath),
                    renderedReference.replace(/^file:\/\//, ''),
                  )}`
                : renderedReference;
            processFileUrl(providerReference, true, fileReference);
            extractNestedPromptFileUrls(
              providerReference,
              fileReference,
              providerContext,
              false,
              false,
              env,
              failClosedOnRefs && !providerContext,
            );
          } else if (typeof value === 'object' && value !== null) {
            if (ArrayBuffer.isView(value)) continue;
            const visitBit =
              1 << ((providerContext ? 1 : 0) | (testVarsFileContext ? 2 : 0));
            const visitedContexts = visited.get(value) ?? 0;
            if ((visitedContexts & visitBit) !== 0) continue;
            visited.set(value, visitedContexts | visitBit);

            const record = value as Record<string, unknown>;
            if (failClosedOnRefs && Object.keys(record).includes('$ref')) {
              hasDynamicPromptDependencies = true;
              continue;
            }
            const localEnv = Object.fromEntries(
              Object.entries(
                typeof record.env === 'object' && record.env !== null
                  ? record.env
                  : {},
              ).flatMap(([name, entry]) =>
                typeof entry === 'string'
                  ? [[name, renderEnvironmentTemplates(entry, env)]]
                  : [],
              ),
            );
            const nestedEnv = { ...env, ...localEnv };
            const httpConfig =
              knownHttpProvider && value === root
                ? record
                : typeof record.config === 'object' && record.config !== null
                  ? (record.config as Record<string, unknown>)
                  : undefined;
            if (
              providerContext &&
              httpConfig &&
              (knownHttpProvider ||
                (typeof record.id === 'string' && isHttpProviderId(record.id)))
            ) {
              extractHttpFileDependencies(httpConfig, nestedEnv);
            }

            for (const [key, entry] of Object.entries(value).reverse()) {
              pending.push({
                value: entry,
                env: nestedEnv,
                providerContext: providerContext || key === 'provider',
                providerRoot: key === 'provider',
                testVarsFileContext:
                  testVarsFileContext ||
                  (key === 'vars' &&
                    (typeof entry === 'string' || Array.isArray(entry))),
              });
            }
          }
        }
      };

      for (const promptFile of promptFiles) {
        if (isForeignWindowsAbsolutePath(promptFile)) {
          core.warning(
            `Ignoring unsafe prompt file dependency "${sanitizeDependencyDisplayPath(displayPromptPath)}": resolved path must stay within an allowed dependency root`,
          );
          continue;
        }
        const absolutePromptFile = path.resolve(promptFile);
        if (
          !isDependencyPathInside(absolutePromptFile) ||
          !/\.(?:jsonl?|ya?ml)$/i.test(absolutePromptFile)
        ) {
          continue;
        }
        let physicalPromptFile: string;
        try {
          physicalPromptFile = fs.realpathSync(absolutePromptFile);
        } catch {
          core.warning(
            `Ignoring unsafe prompt file dependency "${sanitizeDependencyDisplayPath(displayPromptPath)}": resolved path must stay within an allowed dependency root`,
          );
          continue;
        }
        if (!isPhysicalDependencyPathInside(physicalPromptFile)) {
          core.warning(
            `Ignoring unsafe prompt file dependency "${sanitizeDependencyDisplayPath(displayPromptPath)}": resolved path must stay within an allowed dependency root`,
          );
          continue;
        }
        let promptContent: string | undefined;
        try {
          if (visitedStructuredFiles.has(physicalPromptFile)) continue;
          visitedStructuredFiles.add(physicalPromptFile);
          let promptSize: number;
          try {
            promptSize = fs.statSync(physicalPromptFile).size;
          } catch {
            hasDynamicPromptDependencies = true;
            core.warning(
              'Structured prompt file could not be inspected safely; watching all repository changes',
            );
            continue;
          }
          if (promptSize > MAX_STRUCTURED_PROMPT_BYTES) {
            hasDynamicPromptDependencies = true;
            core.warning(
              'Structured prompt file is too large to scan safely; watching all repository changes',
            );
            continue;
          }
          promptContent = fs.readFileSync(physicalPromptFile, 'utf8');
          const parsed = absolutePromptFile.endsWith('.jsonl')
            ? promptContent
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line))
            : absolutePromptFile.endsWith('.json')
              ? JSON.parse(promptContent)
              : loadYaml(promptContent, {
                  schema: YAML_LOAD_SCHEMA,
                });
          walk(parsed, physicalPromptFile);
        } catch {
          if (
            promptContent !== undefined &&
            absolutePromptFile.endsWith('.jsonl')
          ) {
            hasDynamicPromptDependencies = true;
            core.warning(
              'Structured dependency file could not be parsed safely; watching all repository changes',
            );
          }
        }
      }
    };

    const extractNestedConfigDependencies = (
      root: unknown,
      env = templateEnv,
      scanProviderPaths = false,
    ): void => {
      const visited = new WeakSet<object>();
      const pending = [root];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'string') {
          if (!value.startsWith('file://')) {
            if (value.includes('file://') && hasNunjucksTemplate(value)) {
              hasDynamicPromptDependencies = true;
            }
            continue;
          }
          const renderedReference = renderEnvironmentTemplates(value, env);
          if (hasNunjucksTemplate(renderedReference)) {
            hasDynamicPromptDependencies = true;
            continue;
          }
          processFileUrl(renderedReference, true, value);
          continue;
        }
        if (typeof value !== 'object' || value === null) continue;
        if (ArrayBuffer.isView(value) || visited.has(value)) continue;
        visited.add(value);
        if (scanProviderPaths && value === root) {
          extractHttpFileDependencies(value as Record<string, unknown>, env);
        }

        for (const [, entry] of Object.entries(value).reverse()) {
          pending.push(entry);
        }
      }
    };

    const extractProviderDependencies = (
      provider: unknown,
      providerBaseDir = configDir,
      initialEnv = templateEnv,
    ): void => {
      const processProviderReference = (
        reference: string,
        env: Record<string, string | undefined>,
        knownHttpProvider = false,
      ): void => {
        const renderedReference = renderEnvironmentTemplates(reference, env);
        if (hasNunjucksTemplate(renderedReference)) {
          hasDynamicPromptDependencies = true;
          return;
        }
        if (renderedReference.startsWith('exec:')) {
          const commandParts =
            renderedReference
              .slice('exec:'.length)
              .match(/(?:\\.|[^\s"'\\]+|"[^"]*"|'[^']*')+/g) ?? [];
          for (const rawPart of commandParts) {
            const part = rawPart
              .replace(/^['"]|['"]$/g, '')
              .replace(/\\(?=\s)/g, '');
            if (
              part.startsWith('-') ||
              (!/[\\/]/.test(part) && !/\.[A-Za-z0-9]{1,10}$/.test(part))
            ) {
              continue;
            }
            const absolutePath = resolveConfigDependency(
              path.isAbsolute(part) || isForeignWindowsAbsolutePath(part)
                ? part
                : path.resolve(providerBaseDir, part),
              'executable provider dependency',
              '[redacted]',
            );
            if (absolutePath) dependencies.add(absolutePath);
          }
          return;
        }
        for (const prefix of ['python:', 'golang:', 'ruby:']) {
          if (!renderedReference.startsWith(prefix)) continue;
          const providerPath = renderedReference.slice(prefix.length);
          processFileUrl(
            `file://${
              path.isAbsolute(providerPath) ||
              isForeignWindowsAbsolutePath(providerPath)
                ? providerPath
                : path.resolve(providerBaseDir, providerPath)
            }`,
            true,
            `file://${reference.slice(prefix.length)}`,
          );
          return;
        }
        if (!renderedReference.startsWith('file://')) return;
        const providerPath = renderedReference.slice('file://'.length);
        if (!providerPath || providerPath.includes('\0')) {
          processFileUrl(renderedReference, true, reference);
          return;
        }
        const resolvedReference =
          providerBaseDir === configDir ||
          path.isAbsolute(providerPath) ||
          isForeignWindowsAbsolutePath(providerPath)
            ? renderedReference
            : `file://${path.resolve(providerBaseDir, providerPath)}`;
        processFileUrl(resolvedReference, true, reference);
        extractNestedPromptFileUrls(
          resolvedReference,
          reference,
          true,
          false,
          knownHttpProvider,
          env,
        );
      };

      if (typeof provider === 'string') {
        processProviderReference(provider, initialEnv);
        return;
      }
      if (typeof provider !== 'object' || provider === null) return;

      const providerEntry = provider as {
        id?: unknown;
        config?: unknown;
      };
      if (typeof providerEntry.id !== 'string') {
        const gradingTypes = [
          'embedding',
          'classification',
          'text',
          'moderation',
        ] as const;
        let foundGradingProvider = false;
        for (const type of gradingTypes) {
          if (!(type in providerEntry)) continue;
          foundGradingProvider = true;
          extractProviderDependencies(
            (providerEntry as Record<string, unknown>)[type],
            providerBaseDir,
            initialEnv,
          );
        }
        if (foundGradingProvider) return;
      }

      const mappedEntry = Object.entries(providerEntry).find(
        ([key, entry]) =>
          key !== 'id' && typeof entry === 'object' && entry !== null,
      );
      const providerReference =
        typeof providerEntry.id === 'string'
          ? providerEntry.id
          : mappedEntry?.[0];
      const providerOptions =
        providerEntry.config ||
        typeof providerEntry.id === 'string' ||
        'transform' in providerEntry ||
        'env' in providerEntry
          ? providerEntry
          : mappedEntry?.[1];
      if (typeof providerOptions !== 'object' || providerOptions === null) {
        return;
      }
      const providerRecord = providerOptions as {
        env?: unknown;
        config?: unknown;
        transform?: unknown;
      };
      const providerEnv = Object.fromEntries(
        Object.entries(
          typeof providerRecord.env === 'object' && providerRecord.env !== null
            ? providerRecord.env
            : {},
        ).flatMap(([name, value]) =>
          typeof value === 'string'
            ? [[name, renderEnvironmentTemplates(value, initialEnv)]]
            : [],
        ),
      );
      const mergedProviderEnv = {
        ...initialEnv,
        ...providerEnv,
      };
      if (providerReference) {
        processProviderReference(providerReference, mergedProviderEnv);
      }
      const isHttpProvider =
        typeof providerReference === 'string' &&
        isHttpProviderId(
          renderEnvironmentTemplates(providerReference, mergedProviderEnv),
        );
      extractNestedConfigDependencies(
        providerRecord.config,
        mergedProviderEnv,
        isHttpProvider,
      );
      extractNestedConfigDependencies(
        providerRecord.transform,
        mergedProviderEnv,
      );
      if (
        typeof providerRecord.config === 'string' &&
        providerRecord.config.startsWith('file://')
      ) {
        processProviderReference(
          providerRecord.config,
          mergedProviderEnv,
          isHttpProvider,
        );
      }
    };

    // Promptfoo normalizes the targets alias into providers before evaluation.
    const configuredProviders = config.targets || config.providers;
    if (configuredProviders) {
      const providers =
        typeof configuredProviders === 'string'
          ? [configuredProviders]
          : configuredProviders;
      for (const provider of providers) {
        extractProviderDependencies(provider);
      }
    }

    extractNestedConfigDependencies(config.scenarios);
    const pendingScenarios: unknown[] = [config.scenarios];
    const visitedScenarios = new WeakSet<object>();
    while (pendingScenarios.length > 0) {
      const scenario = pendingScenarios.pop();
      if (typeof scenario === 'string' && scenario.startsWith('file://')) {
        const renderedScenario = renderEnvironmentTemplates(
          scenario,
          templateEnv,
        );
        if (hasNunjucksTemplate(renderedScenario)) {
          hasDynamicPromptDependencies = true;
          continue;
        }
        extractNestedPromptFileUrls(
          renderedScenario,
          scenario,
          false,
          false,
          false,
          templateEnv,
          true,
        );
      } else if (typeof scenario === 'object' && scenario !== null) {
        if (visitedScenarios.has(scenario)) continue;
        visitedScenarios.add(scenario);
        for (const entry of Object.values(scenario).reverse()) {
          pendingScenarios.push(entry);
        }
      }
    }
    if (config.nunjucksFilters) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        const renderedFilterPath = renderEnvironmentTemplates(
          filterPath,
          templateEnv,
        );
        if (hasNunjucksTemplate(renderedFilterPath)) {
          hasDynamicPromptDependencies = true;
          continue;
        }
        processFileUrl(
          `file://${renderedFilterPath}`,
          true,
          `file://${filterPath}`,
        );
      }
    }
    extractNestedConfigDependencies(config.extensions);

    const extractPromptFile = (prompt: PromptEntry): void => {
      const processPromptReference = (reference: string): void => {
        if (/[\0\r\n]/.test(reference) || reference.length > 65_536) return;
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
          PROMPT_FILE_EXTENSIONS.has(
            getPathSuffix(reference)?.extension.toLowerCase() ?? '',
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
          if (
            typeof promptConfig?.basePath === 'string' &&
            isForeignWindowsAbsolutePath(promptConfig.basePath)
          ) {
            return;
          }
          const promptExecutionCwd =
            typeof promptConfig?.basePath === 'string'
              ? path.resolve(executionCwd, promptConfig.basePath)
              : executionCwd;
          const rawPromptPath = isExecutable
            ? (executableParts[0] ?? '')
            : reference;
          if (!rawPromptPath) return;
          const renderedPromptPath = isExecutable
            ? rawPromptPath
            : renderEnvironmentTemplates(
                renderPathEnvironmentVariables(rawPromptPath, templateEnv),
                templateEnv,
              );
          if (
            hasNunjucksTemplate(renderedPromptPath) ||
            /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(
              renderedPromptPath,
            )
          ) {
            hasDynamicPromptDependencies = true;
            return;
          }
          const promptPath = isExecutable
            ? isForeignWindowsAbsolutePath(
                normalizeConfigFilePath(
                  renderedPromptPath.replace(/^file:\/\//, ''),
                ),
              )
              ? undefined
              : path.resolve(
                  promptExecutionCwd,
                  normalizeConfigFilePath(
                    renderedPromptPath.replace(/^file:\/\//, ''),
                  ),
                )
            : renderedPromptPath;
          if (!promptPath) return;
          processFileUrl(
            promptPath.startsWith('file://')
              ? promptPath
              : `file://${promptPath}`,
            true,
            rawPromptPath,
          );
          extractNestedPromptFileUrls(
            promptPath,
            rawPromptPath.replace(/^file:\/\//, ''),
          );

          for (const executableArgument of executableParts.slice(1)) {
            if (isForeignWindowsAbsolutePath(executableArgument)) continue;
            const argumentPath = path.isAbsolute(executableArgument)
              ? path.resolve(executableArgument)
              : path.resolve(promptExecutionCwd, executableArgument);
            if (!isDependencyPathInside(argumentPath)) {
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
          extractNestedPromptFileUrls(`file://${absolutePath}`, prompt.file);
        }
      }
    };

    // Extract prompt files. Promptfoo supports an array and a mapping form
    // whose keys contain prompt content and whose values are labels; the map
    // keys flow through the same visitor as array entries.
    if (config.prompts) {
      const promptEntries = Array.isArray(config.prompts)
        ? config.prompts
        : typeof config.prompts === 'string'
          ? [config.prompts]
          : Object.keys(config.prompts);
      for (const prompt of promptEntries) {
        extractPromptFile(prompt);
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars?: TestVars): void => {
      const isVarsFileList = typeof vars === 'string' || Array.isArray(vars);
      const values =
        typeof vars === 'string'
          ? [vars]
          : Array.isArray(vars)
            ? vars
            : vars
              ? Object.values(vars)
              : [];
      for (const value of values) {
        if (typeof value === 'string' && isVarsFileList) {
          const renderedReference = renderEnvironmentTemplates(
            value.startsWith('file://') ? value : `file://${value}`,
            templateEnv,
          );
          if (hasNunjucksTemplate(renderedReference)) {
            hasDynamicPromptDependencies = true;
            continue;
          }
          processFileUrl(renderedReference, true, value);
          extractNestedPromptFileUrls(
            renderedReference,
            value,
            false,
            false,
            false,
            templateEnv,
            true,
          );
          continue;
        }
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value);
          const selector = getFileFunctionSelector(value);
          if (selector?.isJavascript || selector?.extension === 'py') {
            processFileUrl(value, true);
          }
        } else if (
          typeof value === 'string' &&
          value.includes('file://') &&
          hasNunjucksTemplate(value)
        ) {
          hasDynamicPromptDependencies = true;
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
    const visitedAssertionLists = new WeakSet<object>();
    const extractAssertFiles = (
      asserts?: Array<{
        type?: string;
        value?: unknown;
        config?: unknown;
        transform?: unknown;
        contextTransform?: unknown;
        provider?: unknown;
        rubricPrompt?: unknown;
        assert?: Array<{ type?: string; value?: unknown }>;
      }>,
    ): void => {
      if (!asserts || visitedAssertionLists.has(asserts)) return;
      visitedAssertionLists.add(asserts);
      for (const assert of asserts) {
        if (
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processFileUrl(assert.value);
          const selector = getFileFunctionSelector(assert.value);
          if (
            selector?.isJavascript ||
            selector?.extension === 'py' ||
            selector?.extension === 'rb'
          ) {
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
        extractNestedConfigDependencies(assert.transform);
        extractNestedConfigDependencies(assert.contextTransform);
        extractNestedConfigDependencies(assert.rubricPrompt);
        extractProviderDependencies(assert.provider);
        extractAssertFiles(assert.assert);
      }
    };

    // Process defaultTest
    if (typeof config.defaultTest === 'string') {
      processFileUrl(config.defaultTest, true);
      extractNestedPromptFileUrls(
        config.defaultTest,
        config.defaultTest,
        false,
        false,
        false,
        templateEnv,
        true,
      );
    } else if (config.defaultTest) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
      extractProviderDependencies(config.defaultTest.provider);
      extractNestedConfigDependencies(config.defaultTest.options);
      extractProviderDependencies(
        (config.defaultTest.options as { provider?: unknown } | undefined)
          ?.provider,
      );
      extractNestedConfigDependencies(config.defaultTest.assertScoringFunction);
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
          if (
            !test.startsWith('file://') &&
            !/[\\/*?{}]/.test(test) &&
            !getPathSuffix(test)
          ) {
            continue;
          }
          const testPath = stripSpreadsheetSheetSelector(test);
          const testReference = testPath.startsWith('file://')
            ? testPath
            : `file://${testPath}`;
          processFileUrl(testReference, true);
          extractNestedPromptFileUrls(
            testReference,
            testPath,
            false,
            true,
            false,
            templateEnv,
            true,
          );
          continue;
        }
        if (typeof test !== 'object' || test === null) continue;

        if (typeof test.path === 'string') {
          const testPath = stripSpreadsheetSheetSelector(test.path);
          processFileUrl(
            testPath.startsWith('file://') ? testPath : `file://${testPath}`,
            true,
          );
          extractNestedPromptFileUrls(
            testPath,
            testPath,
            false,
            true,
            false,
            templateEnv,
            true,
          );
          extractNestedFileUrls(test.config);
        }
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
        extractProviderDependencies(test.provider);
        extractNestedConfigDependencies(test.options);
        extractProviderDependencies(
          (test.options as { provider?: unknown } | undefined)?.provider,
        );
        extractNestedConfigDependencies(test.assertScoringFunction);
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
    throw new Error(
      `Failed to extract dependencies from config: ${sanitizeDependencyDisplayPath(message)}`,
    );
  }
}
