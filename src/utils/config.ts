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
import {
  canSafelyInspectGlob,
  MAX_BRACE_EXPANSIONS,
  safelyExpandGlob,
} from './glob';

const MAX_PROVIDER_VALUES = 1_024;
const MAX_PROVIDER_CONFIGS = 128;
const MAX_GLOB_MATCHES = 4_096;
const MAX_STRUCTURED_FILE_BYTES = 10 * 1_024 * 1_024;
const FILE_BEARING_PROVIDER_KEYS = new Set([
  'file',
  'functions',
  'path',
  'request',
  'response_format',
  'responseFormat',
  'responseParser',
  'sessionParser',
  'systemPrompt',
  'tools',
  'transformRequest',
  'transformResponse',
]);
const HTTP_CREDENTIAL_PATH_KEYS = new Set([
  'caPath',
  'certPath',
  'keyPath',
  'keystorePath',
  'pfxPath',
  'privateKeyPath',
]);

type TemplateEnvironment = Record<
  string,
  string | number | boolean | undefined
>;

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

export interface PromptfooConfig {
  env?: { [key: string]: unknown };
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?:
    | string
    | Record<string, string>
    | Array<
        | string
        | { file?: string; raw?: string; id?: string; [key: string]: unknown }
      >;
  tests?: PromptfooTests;
  scenarios?:
    | string
    | Array<string | { tests?: PromptfooTests; config?: PromptfooTests }>;
  defaultTest?: string | PromptfooTestCase;
  nunjucksFilters?: Record<string, string>;
}

interface PromptfooTestCase {
  vars?: string | string[] | { [key: string]: string | { file?: string } };
  assert?: PromptfooAssertion[];
  path?: string;
  provider?: unknown;
  options?: { provider?: unknown; [key: string]: unknown };
  assertScoringFunction?: unknown;
  [key: string]: unknown;
}

type PromptfooTests =
  | string
  | PromptfooTestCase
  | Array<string | PromptfooTestCase>;

interface PromptfooAssertion {
  type?: string;
  value?: string | { file?: string };
  assert?: PromptfooAssertion[];
  provider?: unknown;
  contextTransform?: unknown;
  transform?: unknown;
  rubricPrompt?: unknown;
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

function isForeignWindowsPath(filePath: string): boolean {
  return (
    process.platform !== 'win32' &&
    (/^[A-Za-z]:/.test(filePath) ||
      filePath.startsWith('\\') ||
      filePath.startsWith('//'))
  );
}

// Resolve the underlying file for a `file://` provider reference. Promptfoo
// qualifies script providers with a function selector (`...py:custom_call`).
// Strip callable selectors only for supported script types so literal colon
// paths and non-script paths are not silently reinterpreted.
// JavaScript/TypeScript selectors are supported for nested provider config
// references (such as tools), but not for top-level provider IDs.
function providerFilePath(fileUrl: string, allowJavascript = false): string {
  const encodedPath = fileUrl.slice('file://'.length);
  // On Windows a `file:///C:/...` URL yields a leading slash before the drive
  // letter; drop it so the drive colon is not mistaken for a function selector.
  const rawPath =
    process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(encodedPath)
      ? encodedPath.slice(1)
      : encodedPath;
  const functionSeparator = rawPath.lastIndexOf(':');
  const scriptPath = rawPath.slice(0, functionSeparator);
  const functionName = rawPath.slice(functionSeparator + 1);
  const isSupportedScript =
    /\.py$/i.test(scriptPath) ||
    (allowJavascript
      ? /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(scriptPath)
      : /\.(?:go|rb)$/i.test(scriptPath));
  const isValidFunctionName =
    functionName.length === 0 ||
    (/\.go$/i.test(scriptPath)
      ? /^(?:call_api|CallApi)$/.test(functionName)
      : /^[^\\/:\0]+$/u.test(functionName));
  if (functionSeparator > 1 && isSupportedScript && isValidFunctionName) {
    return scriptPath;
  }
  return rawPath;
}

function assertionFilePath(fileUrl: string): string {
  const encodedPath = fileUrl.slice('file://'.length);
  const rawPath =
    process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(encodedPath)
      ? encodedPath.slice(1)
      : encodedPath;
  const functionSeparator = rawPath.indexOf(
    ':',
    process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(rawPath) ? 2 : 0,
  );
  const scriptPath = rawPath.slice(0, functionSeparator);
  const isSupportedScript =
    /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(scriptPath) ||
    /\.(?:py|rb)$/.test(scriptPath);
  if (functionSeparator > 1 && isSupportedScript) {
    return scriptPath;
  }
  return rawPath;
}

function httpTransformFilePath(
  fileUrl: string,
  caseInsensitive = false,
): string {
  const encodedPath = fileUrl.slice('file://'.length);
  const rawPath =
    process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(encodedPath)
      ? encodedPath.slice(1)
      : encodedPath;
  const functionSeparator = rawPath.lastIndexOf(':');
  const scriptPath = rawPath.slice(0, functionSeparator);
  const functionName = rawPath.slice(functionSeparator + 1);
  const isJavascriptScript = caseInsensitive
    ? /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(scriptPath)
    : /\.(?:js|cjs|mjs|ts|cts|mts)$/.test(scriptPath);
  if (functionSeparator > 1 && functionName && isJavascriptScript) {
    return scriptPath;
  }
  return rawPath;
}

function prefixedScriptProviderFileUrl(value: string): string | undefined {
  const match = /^(python|golang|ruby|exec):(.*)$/.exec(value);
  if (!match || (match[1] === 'exec' && /\s/.test(match[2]))) {
    return undefined;
  }
  return `file://${match[2]}`;
}

function scriptProviderFilePath(fileUrl: string): string {
  const encodedPath = fileUrl.slice('file://'.length);
  const rawPath =
    process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(encodedPath)
      ? encodedPath.slice(1)
      : encodedPath;
  const functionSeparator = rawPath.lastIndexOf(':');
  const scriptPath = rawPath.slice(0, functionSeparator);
  if (
    functionSeparator > 1 &&
    (/\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(scriptPath) ||
      /\.(?:py|go|rb)$/.test(scriptPath))
  ) {
    return scriptPath;
  }
  return rawPath;
}

function renderEnvTemplate(
  value: string,
  environment: TemplateEnvironment,
): string {
  if (
    /^(?:1|true|yes|yup|yeppers)$/i.test(
      String(environment.PROMPTFOO_DISABLE_TEMPLATING ?? ''),
    )
  ) {
    return value;
  }

  const withoutLeadingComments = stripLeadingNunjucksComments(value);
  const uncommentedValue = startsWithEnvExpression(withoutLeadingComments)
    ? withoutLeadingComments
    : value;

  const renderedExpressions = uncommentedValue.replace(
    /\{\{-?\s*env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*(?:\|\s*(?:default|d)\(\s*(['"])([^'"]*)\3\s*(?:,\s*(true|false))?\s*\))?(?:\|\s*(trim))?\s*-?\}\}/g,
    (
      template,
      dotName: string | undefined,
      bracketName: string | undefined,
      _quote: string | undefined,
      defaultValue: string | undefined,
      defaultOnFalsy: string | undefined,
      trimFilter: string | undefined,
    ) => {
      const envValue = environment[dotName ?? (bracketName as string)];
      if (envValue !== undefined) {
        if (defaultOnFalsy === 'true' && !envValue) {
          return defaultValue as string;
        }
        const resolvedValue = String(envValue);
        return trimFilter ? resolvedValue.trim() : resolvedValue;
      }
      return defaultValue ?? template;
    },
  );

  return renderedExpressions.replace(
    /\{%-?\s*if\s+env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*-?%\}([^{}]*)\{%-?\s*endif\s*-?%\}/g,
    (
      _template,
      dotName: string | undefined,
      bracketName: string | undefined,
      body: string,
    ) => (environment[dotName ?? (bracketName as string)] ? body : ''),
  );
}

function environmentValues(
  value: unknown,
  baseEnvironment: TemplateEnvironment,
): TemplateEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue === 'string') {
      entries.push([key, renderEnvTemplate(envValue, baseEnvironment)]);
    } else if (typeof envValue === 'number' || typeof envValue === 'boolean') {
      entries.push([key, envValue]);
    }
  }
  return Object.fromEntries(entries);
}

function stripLeadingNunjucksComments(value: string): string {
  let index = 0;
  let foundComment = false;

  while (index < value.length && value[index]?.trim() === '') {
    index += 1;
  }
  while (value.startsWith('{#', index)) {
    const commentEnd = value.indexOf('#}', index + 2);
    if (commentEnd === -1) {
      return value;
    }
    foundComment = true;
    index = commentEnd + 2;
    while (index < value.length && value[index]?.trim() === '') {
      index += 1;
    }
  }

  return foundComment ? value.slice(index) : value;
}

function stripNunjucksComments(value: string): string {
  const uncommented: string[] = [];
  let index = 0;

  while (index < value.length) {
    const commentStart = value.indexOf('{#', index);
    if (commentStart === -1) {
      break;
    }
    const commentEnd = value.indexOf('#}', commentStart + 2);
    if (commentEnd === -1) {
      break;
    }
    uncommented.push(value.slice(index, commentStart));
    index = commentEnd + 2;
  }
  uncommented.push(value.slice(index));

  return uncommented.join('');
}

function startsWithEnvExpression(value: string): boolean {
  const candidate = value.trimStart();
  if (!candidate.startsWith('{{')) {
    return false;
  }

  let index = candidate.startsWith('{{-') ? 3 : 2;
  while (index < candidate.length && candidate[index]?.trim() === '') {
    index += 1;
  }
  return (
    candidate.startsWith('env.', index) || candidate.startsWith('env[', index)
  );
}

function mayRenderFileUrl(value: string): boolean {
  const candidate = stripLeadingNunjucksComments(value.trimStart());
  if (candidate.startsWith('file://') || startsWithEnvExpression(candidate)) {
    return true;
  }
  return (
    (candidate.includes('file://') && /^\{(?:\{-?|%-?)/.test(candidate)) ||
    (candidate.includes('{#') &&
      stripNunjucksComments(candidate).startsWith('file://'))
  );
}

function hasGlobMagic(pattern: string): boolean | undefined {
  if (!canSafelyInspectGlob(pattern)) {
    return undefined;
  }
  try {
    return glob.hasMagic(pattern, {
      magicalBraces: true,
      braceExpandMax: MAX_BRACE_EXPANSIONS,
    });
  } catch {
    return undefined;
  }
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
  const dependencyRoots =
    dependencyRoot === cwd ? [cwd] : [dependencyRoot, cwd];
  const watchDependencyRoots = (): void => {
    for (const root of dependencyRoots) {
      dependencies.add(`${root}${path.sep}`);
    }
  };
  const toRepositoryPath = (dep: string): string => {
    const relativePath = path.relative(cwd, dep);
    const repositoryPath = relativePath.split(path.sep).join('/');
    if (!repositoryPath) {
      return './';
    }
    if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
      return `${repositoryPath}/`;
    }
    return repositoryPath;
  };
  let configParsed = false;

  try {
    if (fs.statSync(configPath).size > MAX_STRUCTURED_FILE_BYTES) {
      core.warning(
        'Config dependency file is too large to inspect safely. Watching the repository workspace conservatively.',
      );
      watchDependencyRoots();
      return Array.from(dependencies).map(toRepositoryPath);
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
    configParsed = true;

    const rootEnvironment = environmentValues(config.env, process.env);
    const disableTemplateEnvVars =
      rootEnvironment.PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS ??
      process.env.PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS;
    const selfHosted =
      rootEnvironment.PROMPTFOO_SELF_HOSTED ??
      process.env.PROMPTFOO_SELF_HOSTED;
    const hidesProcessEnvironment = /^(?:1|true|yes|yup|yeppers)$/i.test(
      String(disableTemplateEnvVars ?? selfHosted ?? ''),
    );
    const baseEnvironment = hidesProcessEnvironment ? {} : process.env;
    const configOverrides = environmentValues(config.env, baseEnvironment);
    const configEnvironment = {
      ...baseEnvironment,
      ...configOverrides,
    };

    const realDependencyRoots = new Map<string, string | undefined>();
    const isSafeDependencyPath = (absolutePath: string): boolean => {
      const containingRoot = dependencyRoots.find((root) =>
        isPathInside(root, absolutePath),
      );
      if (!containingRoot) {
        return false;
      }

      try {
        if (!realDependencyRoots.has(containingRoot)) {
          realDependencyRoots.set(
            containingRoot,
            fs.realpathSync(containingRoot),
          );
        }
      } catch {
        realDependencyRoots.set(containingRoot, undefined);
        return false;
      }
      const realDependencyRoot = realDependencyRoots.get(containingRoot);
      if (!realDependencyRoot) {
        return false;
      }

      let existingPath = absolutePath;
      while (existingPath !== containingRoot) {
        try {
          const realPath = fs.realpathSync(existingPath);
          return isPathInside(realDependencyRoot, realPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return false;
          }

          try {
            fs.lstatSync(existingPath);
            return false;
          } catch (lstatError) {
            const lstatCode = (lstatError as NodeJS.ErrnoException).code;
            if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
              return false;
            }
          }

          existingPath = path.dirname(existingPath);
        }
      }
      return true;
    };

    let warnedForeignWindowsDependency = false;
    const resolveConfigDependency = (
      filePath: string,
      source: string,
      displayPath = filePath,
    ): string | undefined => {
      const isForeignPath = isForeignWindowsPath(filePath);
      try {
        if (!filePath) {
          throw new Error(`${source} is empty`);
        }
        if (filePath.includes('\0')) {
          throw new Error(`${source} contains an invalid null byte`);
        }
        if (isForeignPath) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependencyPath(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        const containingRoot =
          filePath.length > 0 && !filePath.includes('\0')
            ? dependencyRoots.find((root) =>
                isPathInside(root, path.resolve(configDir, filePath)),
              )
            : undefined;
        if (containingRoot) {
          dependencies.add(`${containingRoot}${path.sep}`);
        }
        if (isForeignPath) {
          if (warnedForeignWindowsDependency) return undefined;
          warnedForeignWindowsDependency = true;
        }
        core.warning(
          `Ignoring unsafe config dependency "${JSON.stringify(displayPath).slice(1, -1)}": ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (
      fileUrl: string,
      isProvider = false,
      allowJavascript = false,
      environment: TemplateEnvironment = configEnvironment,
      isAssertion = false,
      isHttpTransform = false,
      isScriptProvider = false,
    ): string[] => {
      const renderedFileUrl = renderEnvTemplate(fileUrl, environment);
      if (/\{\{|\{%|\{#/.test(renderedFileUrl)) {
        watchDependencyRoots();
        return [];
      }

      const filePath = isHttpTransform
        ? httpTransformFilePath(renderedFileUrl)
        : isScriptProvider
          ? scriptProviderFilePath(renderedFileUrl)
          : isProvider
            ? providerFilePath(renderedFileUrl, allowJavascript)
            : isAssertion
              ? assertionFilePath(renderedFileUrl)
              : renderedFileUrl.slice('file://'.length);
      const displayPath = isHttpTransform
        ? fileUrl.startsWith('file://')
          ? httpTransformFilePath(fileUrl)
          : fileUrl
        : isScriptProvider
          ? scriptProviderFilePath(fileUrl)
          : isProvider
            ? fileUrl.startsWith('file://')
              ? providerFilePath(fileUrl, allowJavascript)
              : fileUrl
            : fileUrl.startsWith('file://')
              ? isAssertion
                ? assertionFilePath(fileUrl)
                : fileUrl.slice('file://'.length)
              : fileUrl;
      if (filePath.includes('\0')) {
        resolveConfigDependency(
          filePath,
          'config file dependency',
          displayPath,
        );
        return [];
      }
      const isFileGlob = hasGlobMagic(filePath);
      if (isFileGlob === undefined) {
        watchDependencyRoots();
        core.warning(
          'Ignoring an invalid or oversized config dependency glob. Watching the repository workspace conservatively.',
        );
        return [];
      }
      if (isFileGlob) {
        const expandedPaths = safelyExpandGlob(filePath);
        if (!expandedPaths) {
          watchDependencyRoots();
          core.warning(
            'Config dependency glob has too many brace alternatives. Watching the repository workspace conservatively.',
          );
          return [];
        }

        const safePatterns: string[] = [];
        let unsafePattern = false;
        for (const expandedPath of expandedPaths) {
          if (isForeignWindowsPath(expandedPath)) {
            unsafePattern = true;
            continue;
          }
          const absolutePattern = path.resolve(configDir, expandedPath);
          if (isSafeDependencyPath(absolutePattern)) {
            safePatterns.push(absolutePattern);
          } else {
            unsafePattern = true;
          }
        }
        if (unsafePattern) {
          watchDependencyRoots();
          core.warning(
            'Ignoring unsafe config dependency glob alternative: brace traversal branches must stay within the repository workspace.',
          );
          return [];
        }

        if (
          safePatterns.some(
            (safePattern) => hasGlobMagic(safePattern) === undefined,
          )
        ) {
          watchDependencyRoots();
          core.warning(
            'Ignoring an invalid or oversized config dependency glob. Watching the repository workspace conservatively.',
          );
          return [];
        }

        const matches = glob.sync(safePatterns, {
          nodir: true,
          braceExpandMax: MAX_BRACE_EXPANSIONS,
        });
        if (matches.length > MAX_GLOB_MATCHES) {
          watchDependencyRoots();
          core.warning(
            'Config dependency glob produced too many matches. Watching the repository workspace conservatively.',
          );
          return [];
        }
        const safeMatches: string[] = [];
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          if (isSafeDependencyPath(absoluteMatch)) {
            dependencies.add(absoluteMatch);
            safeMatches.push(absoluteMatch);
          } else {
            core.warning(
              `Ignoring unsafe config dependency match "${
                renderedFileUrl === fileUrl
                  ? '<redacted unsafe config dependency match>'
                  : JSON.stringify(displayPath).slice(1, -1)
              }": config file dependency glob match must stay within the repository workspace`,
            );
          }
        }

        // Also add the absolute, non-glob prefix for watching deletions.
        for (const safePattern of safePatterns) {
          let basePath = hasGlobMagic(safePattern)
            ? safePattern
            : path.dirname(safePattern);
          while (hasGlobMagic(basePath)) {
            basePath = path.dirname(basePath);
          }
          if (path.relative(cwd, basePath) === '') {
            dependencies.add(safePattern);
          } else {
            dependencies.add(`${basePath.replace(/[\\/]+$/, '')}${path.sep}`);
          }
        }
        return safeMatches;
      }

      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
        displayPath,
      );
      if (!absolutePath) {
        if (renderedFileUrl !== fileUrl) {
          watchDependencyRoots();
        }
        return [];
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
    const inspectedProviderFiles = new Set<string>();
    const activeProviderObjects = new WeakSet<object>();
    let providerValuesVisited = 0;
    let providerValueLimitReached = false;
    let providerConfigLimitReached = false;

    const processProviderValue = (
      value: unknown,
      isProviderReference = false,
      providerOverrides: TemplateEnvironment = {},
      externalProviderConfig = false,
      callerProviderContext = false,
      httpProviderContext = false,
      isFileBearingConfigValue = false,
      parentKey?: string,
      grandparentKey?: string,
      providerDepth = 0,
    ): void => {
      if (providerValueLimitReached) {
        return;
      }
      providerValuesVisited += 1;
      if (providerValuesVisited > MAX_PROVIDER_VALUES) {
        providerValueLimitReached = true;
        watchDependencyRoots();
        core.warning(
          'Provider dependency graph is too large to inspect safely. Watching the repository workspace conservatively.',
        );
        return;
      }

      if (typeof value === 'string') {
        const environment = {
          ...configEnvironment,
          ...providerOverrides,
        };
        const renderedValue = renderEnvTemplate(value, environment);
        const renderedScriptProvider = isProviderReference
          ? prefixedScriptProviderFileUrl(renderedValue)
          : undefined;
        if (renderedScriptProvider) {
          const scriptProvider =
            prefixedScriptProviderFileUrl(value) ?? renderedScriptProvider;
          processFileUrl(
            scriptProvider,
            false,
            false,
            environment,
            false,
            false,
            true,
          );
          return;
        }
        if (isProviderReference && renderedValue.startsWith('exec:')) {
          watchDependencyRoots();
          return;
        }
        if (
          !isProviderReference &&
          !isFileBearingConfigValue &&
          !value.trimStart().startsWith('file://') &&
          !renderedValue.startsWith('file://')
        ) {
          return;
        }
        if (!mayRenderFileUrl(value) && !renderedValue.startsWith('file://')) {
          return;
        }
        if (!renderedValue.startsWith('file://')) {
          if (/\{\{|\{%|\{#/.test(renderedValue)) {
            watchDependencyRoots();
          }
          return;
        }
        if (
          httpProviderContext &&
          parentKey === 'validateStatus' &&
          grandparentKey === 'config'
        ) {
          processFileUrl(value, false, false, environment, false, true);
          const pinnedPath = httpTransformFilePath(renderedValue);
          const latestPath = httpTransformFilePath(renderedValue, true);
          if (latestPath !== pinnedPath) {
            if (renderedValue === value) {
              processFileUrl(`file://${latestPath}`);
            } else {
              watchDependencyRoots();
            }
          }
          return;
        }
        processProviderReference(
          value,
          isProviderReference,
          providerOverrides,
          callerProviderContext,
        );
        return;
      }

      if (!value || typeof value !== 'object') {
        return;
      }

      if (
        ArrayBuffer.isView(value) ||
        value instanceof Date ||
        value instanceof Map ||
        value instanceof Set
      ) {
        return;
      }

      if (activeProviderObjects.has(value)) {
        return;
      }
      activeProviderObjects.add(value);

      try {
        if (Array.isArray(value)) {
          for (const item of value) {
            processProviderValue(
              item,
              isProviderReference,
              providerOverrides,
              externalProviderConfig,
              callerProviderContext,
              httpProviderContext,
              isFileBearingConfigValue,
              parentKey,
              grandparentKey,
              providerDepth,
            );
            if (providerValueLimitReached) {
              break;
            }
          }
          return;
        }

        const providerEnvironment = {
          ...configEnvironment,
          ...providerOverrides,
        };
        const nestedProviderOverrides = {
          ...environmentValues(
            (value as { env?: unknown }).env,
            providerEnvironment,
          ),
          ...(externalProviderConfig && callerProviderContext
            ? configOverrides
            : {}),
          ...providerOverrides,
        };

        const providerId = (value as { id?: unknown }).id;
        const renderedProviderId =
          typeof providerId === 'string'
            ? renderEnvTemplate(providerId, {
                ...configEnvironment,
                ...nestedProviderOverrides,
              })
            : undefined;
        const nestedHttpProviderContext =
          httpProviderContext ||
          (renderedProviderId !== undefined &&
            /^https?(?::|$)/i.test(renderedProviderId));

        const authType = (value as { type?: unknown }).type;
        const renderedAuthType =
          typeof authType === 'string'
            ? renderEnvTemplate(authType, {
                ...configEnvironment,
                ...nestedProviderOverrides,
              })
            : undefined;
        const isHttpAuthContext =
          nestedHttpProviderContext &&
          parentKey === 'auth' &&
          grandparentKey === 'config' &&
          (providerDepth === 2 || providerDepth === 3);
        if (
          isHttpAuthContext &&
          typeof (value as { path?: unknown }).path === 'string' &&
          renderedAuthType !== undefined &&
          /\{\{|\{%|\{#/.test(renderedAuthType)
        ) {
          watchDependencyRoots();
        }
        const fileAuthPath =
          isHttpAuthContext &&
          renderedAuthType === 'file' &&
          typeof (value as { path?: unknown }).path === 'string'
            ? (value as { path: string }).path
            : undefined;
        if (fileAuthPath !== undefined) {
          const authEnvironment = {
            ...configEnvironment,
            ...nestedProviderOverrides,
          };
          const renderedAuthPath = renderEnvTemplate(
            fileAuthPath,
            authEnvironment,
          );
          if (/\{\{|\{%|\{#/.test(renderedAuthPath)) {
            watchDependencyRoots();
          } else {
            const authPath = renderedAuthPath.startsWith('file://')
              ? providerFilePath(renderedAuthPath, true)
              : renderedAuthPath;
            const absoluteAuthPath = resolveConfigDependency(
              authPath,
              'provider file-auth dependency',
              renderedAuthPath === fileAuthPath
                ? '<redacted provider file-auth path>'
                : fileAuthPath,
            );
            if (absoluteAuthPath) {
              dependencies.add(absoluteAuthPath);
            } else if (renderedAuthPath !== fileAuthPath) {
              watchDependencyRoots();
            }
          }
        }

        for (const [key, nestedValue] of Object.entries(value)) {
          if (key === 'env' || (key === 'path' && fileAuthPath !== undefined)) {
            continue;
          }
          if (
            nestedHttpProviderContext &&
            (((providerDepth === 2 || providerDepth === 3) &&
              grandparentKey === 'config' &&
              (parentKey === 'signatureAuth' || parentKey === 'tls') &&
              HTTP_CREDENTIAL_PATH_KEYS.has(key)) ||
              ((providerDepth === 4 || providerDepth === 5) &&
                grandparentKey === 'parts' &&
                parentKey === 'source' &&
                key === 'path' &&
                (value as { type?: unknown }).type === 'path')) &&
            typeof nestedValue === 'string'
          ) {
            const credentialEnvironment = {
              ...configEnvironment,
              ...nestedProviderOverrides,
            };
            const renderedCredentialPath = renderEnvTemplate(
              nestedValue,
              credentialEnvironment,
            );
            if (/\{\{|\{%|\{#/.test(renderedCredentialPath)) {
              watchDependencyRoots();
              continue;
            }
            const credentialPath = renderedCredentialPath.startsWith('file://')
              ? providerFilePath(renderedCredentialPath, true)
              : renderedCredentialPath;
            const absoluteCredentialPath = resolveConfigDependency(
              credentialPath,
              'provider HTTP credential dependency',
              renderedCredentialPath === nestedValue
                ? '<redacted provider HTTP credential path>'
                : nestedValue,
            );
            if (absoluteCredentialPath) {
              dependencies.add(absoluteCredentialPath);
            } else if (renderedCredentialPath !== nestedValue) {
              watchDependencyRoots();
            }
            continue;
          }
          const mappedProviderOverrides = {
            ...environmentValues(
              nestedValue && typeof nestedValue === 'object'
                ? (nestedValue as { env?: unknown }).env
                : undefined,
              {
                ...configEnvironment,
                ...nestedProviderOverrides,
              },
            ),
            ...nestedProviderOverrides,
          };
          const environment = {
            ...configEnvironment,
            ...mappedProviderOverrides,
          };
          const inspectProviderKey =
            key.trimStart().startsWith('file://') ||
            (isProviderReference && mayRenderFileUrl(key));
          const renderedProviderKey = renderEnvTemplate(key, environment);
          const renderedScriptProvider = isProviderReference
            ? prefixedScriptProviderFileUrl(renderedProviderKey)
            : undefined;
          const mappedHttpProviderContext =
            nestedHttpProviderContext ||
            /^https?(?::|$)/i.test(renderedProviderKey);
          if (renderedScriptProvider) {
            const scriptProvider =
              prefixedScriptProviderFileUrl(key) ?? renderedScriptProvider;
            processFileUrl(
              scriptProvider,
              false,
              false,
              environment,
              false,
              false,
              true,
            );
          } else if (
            isProviderReference &&
            renderedProviderKey.startsWith('exec:')
          ) {
            watchDependencyRoots();
          } else if (
            inspectProviderKey &&
            renderedProviderKey.startsWith('file://')
          ) {
            processProviderReference(key, true, mappedProviderOverrides, true);
          } else if (
            inspectProviderKey &&
            /\{\{|\{%|\{#/.test(renderedProviderKey)
          ) {
            watchDependencyRoots();
          }
          processProviderValue(
            nestedValue,
            key === 'id',
            nestedProviderOverrides,
            false,
            key === 'id',
            mappedHttpProviderContext,
            FILE_BEARING_PROVIDER_KEYS.has(key) ||
              ((parentKey === 'response_format' ||
                parentKey === 'responseFormat') &&
                (key === 'schema' || key === 'json_schema')) ||
              (parentKey === 'json_schema' && key === 'schema'),
            key,
            parentKey,
            providerDepth + 1,
          );
          if (providerValueLimitReached) {
            break;
          }
        }
      } finally {
        activeProviderObjects.delete(value);
      }
    };

    const processProviderReference = (
      provider: string,
      isProviderReference = true,
      providerOverrides: TemplateEnvironment = {},
      callerProviderContext = false,
    ): void => {
      const environment = {
        ...configEnvironment,
        ...providerOverrides,
      };
      const allowJavascript = !isProviderReference;
      const renderedProvider = renderEnvTemplate(provider, environment);
      const providerPath = providerFilePath(renderedProvider, allowJavascript);
      const displayProviderPath = provider.startsWith('file://')
        ? providerFilePath(provider, allowJavascript)
        : provider;
      const providerPaths = processFileUrl(
        provider,
        true,
        allowJavascript,
        environment,
      );
      const isProviderGlob = hasGlobMagic(providerPath);
      if (providerPaths.length === 0) {
        if (
          !providerPath ||
          providerPath.includes('\0') ||
          isProviderGlob === undefined
        ) {
          return;
        }
        const containingRoot = dependencyRoots.find((root) =>
          isPathInside(root, path.resolve(configDir, providerPath)),
        );
        if (containingRoot && !isProviderGlob) {
          dependencies.add(`${containingRoot}${path.sep}`);
        }
        return;
      }

      for (const absolutePath of providerPaths) {
        const inspectionKey = `${absolutePath}\0${callerProviderContext}\0${JSON.stringify(
          environment,
          Object.keys(environment).sort(),
        )}`;
        if (
          !/\.(?:ya?ml|json)$/i.test(absolutePath) ||
          inspectedProviderFiles.has(inspectionKey)
        ) {
          continue;
        }

        if (inspectedProviderFiles.size >= MAX_PROVIDER_CONFIGS) {
          watchDependencyRoots();
          if (!providerConfigLimitReached) {
            providerConfigLimitReached = true;
            core.warning(
              'Too many provider config dependencies to inspect safely. Watching the repository workspace conservatively.',
            );
          }
          continue;
        }

        inspectedProviderFiles.add(inspectionKey);
        try {
          if (fs.statSync(absolutePath).size > MAX_STRUCTURED_FILE_BYTES) {
            watchDependencyRoots();
            core.warning(
              'Provider config dependency is too large to inspect safely. Watching the repository workspace conservatively.',
            );
            continue;
          }
          const providerConfig = loadYaml(
            fs.readFileSync(absolutePath, 'utf8'),
            {
              schema: YAML_LOAD_SCHEMA,
            },
          );
          processProviderValue(
            providerConfig,
            false,
            providerOverrides,
            true,
            callerProviderContext,
          );
        } catch {
          core.warning(
            `Failed to inspect provider config dependency "${JSON.stringify(displayProviderPath).slice(1, -1)}". Watching the repository workspace conservatively.`,
          );
          watchDependencyRoots();
        }
      }
    };

    for (const providers of [config.providers, config.targets]) {
      if (providers) {
        processProviderValue(providers, true);
      }
    }

    const processPotentialFileUrl = (
      value: string,
      isAssertion = false,
    ): void => {
      const renderedValue = renderEnvTemplate(value, configEnvironment);
      if (renderedValue.startsWith('file://')) {
        processFileUrl(value, false, false, configEnvironment, isAssertion);
      } else if (
        mayRenderFileUrl(value) &&
        /\{\{|\{%|\{#/.test(renderedValue)
      ) {
        watchDependencyRoots();
      }
    };

    const processTemplatedDependency = (
      filePath: string,
      source: string,
    ): void => {
      const renderedPath = renderEnvTemplate(filePath, configEnvironment);
      if (/\{\{|\{%|\{#/.test(renderedPath)) {
        watchDependencyRoots();
        return;
      }

      const absolutePath = resolveConfigDependency(
        renderedPath,
        source,
        filePath,
      );
      if (absolutePath) {
        dependencies.add(absolutePath);
      }
    };

    const inspectedStructuredPrompts = new Set<string>();
    let structuredPromptValuesVisited = 0;
    const inspectStructuredPrompt = (value: string): void => {
      const renderedValue = renderEnvTemplate(value, configEnvironment);
      if (/\{\{|\{%|\{#/.test(renderedValue)) {
        watchDependencyRoots();
        return;
      }
      const fileUrl = renderedValue.startsWith('file://')
        ? value
        : `file://${value}`;
      const promptPaths = processFileUrl(fileUrl);
      for (const promptPath of promptPaths) {
        if (
          !/\.(?:ya?ml|json)$/i.test(promptPath) ||
          inspectedStructuredPrompts.has(promptPath)
        ) {
          continue;
        }
        if (inspectedStructuredPrompts.size >= MAX_PROVIDER_CONFIGS) {
          watchDependencyRoots();
          core.warning(
            'Too many structured prompt dependencies to inspect safely. Watching the repository workspace conservatively.',
          );
          return;
        }
        inspectedStructuredPrompts.add(promptPath);
        try {
          if (fs.statSync(promptPath).size > MAX_STRUCTURED_FILE_BYTES) {
            watchDependencyRoots();
            core.warning(
              'Structured prompt dependency is too large to inspect safely. Watching the repository workspace conservatively.',
            );
            continue;
          }
          const structuredPrompt = loadYaml(
            fs.readFileSync(promptPath, 'utf8'),
            {
              schema: YAML_LOAD_SCHEMA,
            },
          );
          const pending: unknown[] = [structuredPrompt];
          const visitedObjects = new WeakSet<object>();
          while (pending.length > 0) {
            const current = pending.pop();
            structuredPromptValuesVisited += 1;
            if (structuredPromptValuesVisited > MAX_PROVIDER_VALUES) {
              watchDependencyRoots();
              core.warning(
                'Structured prompt dependency graph is too large to inspect safely. Watching the repository workspace conservatively.',
              );
              return;
            }
            if (typeof current === 'string') {
              const renderedCurrent = renderEnvTemplate(
                current,
                configEnvironment,
              );
              if (renderedCurrent.startsWith('file://')) {
                inspectStructuredPrompt(current);
              } else if (
                mayRenderFileUrl(current) &&
                /\{\{|\{%|\{#/.test(renderedCurrent)
              ) {
                watchDependencyRoots();
              }
            } else if (
              current &&
              typeof current === 'object' &&
              !visitedObjects.has(current)
            ) {
              visitedObjects.add(current);
              pending.push(...Object.values(current));
            }
          }
        } catch {
          watchDependencyRoots();
          core.warning(
            'Failed to inspect a structured prompt dependency. Watching the repository workspace conservatively.',
          );
        }
      }
    };

    // Extract prompt files
    if (config.prompts) {
      const prompts =
        typeof config.prompts === 'string'
          ? [config.prompts]
          : Array.isArray(config.prompts)
            ? config.prompts
            : Object.keys(config.prompts);
      for (const prompt of prompts) {
        const promptPath =
          typeof prompt === 'string' ? prompt : (prompt.raw ?? prompt.id);
        if (typeof promptPath === 'string') {
          if (promptPath.startsWith('exec:')) {
            const executablePath = promptPath.slice('exec:'.length);
            processFileUrl(
              executablePath.startsWith('file://')
                ? executablePath
                : `file://${executablePath}`,
              false,
              false,
              configEnvironment,
              false,
              false,
              true,
            );
          } else if (mayRenderFileUrl(promptPath)) {
            processPotentialFileUrl(promptPath);
          } else if (
            !promptPath.includes('\n') &&
            !promptPath.includes('file://') &&
            (/[\\/]/.test(promptPath) ||
              (!/\s/.test(promptPath) && promptPath.includes('*')) ||
              /\.(?:txt|md|j2|jsonl?|ya?ml|csv|js|cjs|mjs|ts|cts|mts|py|rb)(?::.*)?$/i.test(
                promptPath,
              ))
          ) {
            processFileUrl(`file://${promptPath}`);
          }
        }
        if (
          typeof prompt === 'object' &&
          prompt !== null &&
          typeof prompt.file === 'string'
        ) {
          inspectStructuredPrompt(prompt.file);
        }
      }
    }

    // Extract test variable files
    const processVarFile = (value: string): void => {
      const renderedValue = renderEnvTemplate(value, configEnvironment);
      processFileUrl(
        renderedValue.startsWith('file://') ? value : `file://${value}`,
      );
    };
    const extractVarFiles = (vars: unknown): void => {
      if (typeof vars === 'string') {
        processVarFile(vars);
        return;
      }
      if (Array.isArray(vars)) {
        for (const value of vars) {
          if (typeof value === 'string') {
            processVarFile(value);
          }
        }
        return;
      }
      if (!vars || typeof vars !== 'object') return;
      for (const value of Object.values(vars)) {
        if (typeof value === 'string') {
          processPotentialFileUrl(value);
        } else if (
          typeof value === 'object' &&
          value !== null &&
          'file' in value &&
          typeof value.file === 'string'
        ) {
          processTemplatedDependency(
            value.file,
            'test variable file dependency',
          );
        }
      }
    };

    // Extract assert files
    const visitedAssertionSets = new WeakSet<PromptfooAssertion[]>();
    const processTestFileBearingValue = (value: unknown): void => {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const fileValue =
          typeof item === 'string'
            ? item
            : item &&
                typeof item === 'object' &&
                'content' in item &&
                typeof item.content === 'string'
              ? item.content
              : undefined;
        if (!fileValue) continue;
        const renderedValue = renderEnvTemplate(fileValue, configEnvironment);
        if (renderedValue.startsWith('file://')) {
          processFileUrl(
            fileValue,
            false,
            false,
            configEnvironment,
            false,
            false,
            true,
          );
        } else if (
          mayRenderFileUrl(fileValue) &&
          /\{\{|\{%|\{#/.test(renderedValue)
        ) {
          watchDependencyRoots();
        }
      }
    };
    const rebaseExternalProvider = (
      provider: unknown,
      baseDir: string,
    ): unknown => {
      const clonedValues = new WeakMap<object, unknown>();
      const visit = (value: unknown): unknown => {
        if (typeof value === 'string') {
          const match = /^(file:\/\/|python:|golang:|ruby:|exec:)(.*)$/.exec(
            value,
          );
          if (!match) return value;
          const prefix = match[1] as string;
          const providerPath = match[2] as string;
          if (prefix === 'exec:' && /\s/.test(providerPath)) return value;
          const rebasedPath =
            path.isAbsolute(providerPath) || isForeignWindowsPath(providerPath)
              ? providerPath
              : path.relative(configDir, path.resolve(baseDir, providerPath));
          return `${prefix}${rebasedPath}`;
        }
        if (!value || typeof value !== 'object') return value;
        const existing = clonedValues.get(value);
        if (existing) return existing;
        if (Array.isArray(value)) {
          const cloned: unknown[] = [];
          clonedValues.set(value, cloned);
          cloned.push(...value.map(visit));
          return cloned;
        }
        const cloned: Record<string, unknown> = {};
        clonedValues.set(value, cloned);
        for (const [key, nestedValue] of Object.entries(value)) {
          cloned[visit(key) as string] = visit(nestedValue);
        }
        return cloned;
      };
      return visit(provider);
    };
    const extractAssertFiles = (asserts?: PromptfooAssertion[]): void => {
      if (!asserts || visitedAssertionSets.has(asserts)) return;
      visitedAssertionSets.add(asserts);
      for (const assert of asserts) {
        if (typeof assert.value === 'string') {
          processPotentialFileUrl(assert.value, true);
        } else if (
          typeof assert.value === 'object' &&
          assert.value !== null &&
          'file' in assert.value &&
          typeof assert.value.file === 'string'
        ) {
          processTemplatedDependency(
            assert.value.file,
            'assertion file dependency',
          );
        }
        if (assert.provider) {
          processProviderValue(assert.provider, true);
        }
        processTestFileBearingValue(assert.contextTransform);
        processTestFileBearingValue(assert.transform);
        processTestFileBearingValue(assert.rubricPrompt);
        extractAssertFiles(assert.assert);
      }
    };

    const inspectedExternalTestFiles = new Set<string>();
    let externalTestValuesVisited = 0;
    const processTestFile = (
      value: string,
      rebaseExternalTests = true,
    ): void => {
      const sheetSeparator = value.indexOf('#');
      const pathWithoutSheet = value.slice(0, sheetSeparator);
      const lowerPath = pathWithoutSheet.toLowerCase();
      const testPath =
        sheetSeparator !== -1 &&
        (lowerPath.endsWith('.xls') || lowerPath.endsWith('.xlsx'))
          ? pathWithoutSheet
          : value;
      const fileUrl = testPath.startsWith('file://')
        ? testPath
        : `file://${testPath}`;
      const testPaths = processFileUrl(
        fileUrl,
        false,
        false,
        configEnvironment,
        false,
        false,
        true,
      );

      for (const externalTestPath of testPaths) {
        if (!/\.(?:ya?ml|jsonl?)$/i.test(externalTestPath)) {
          continue;
        }
        const inspectionKey = `${externalTestPath}\0${rebaseExternalTests}`;
        if (inspectedExternalTestFiles.has(inspectionKey)) {
          continue;
        }
        if (inspectedExternalTestFiles.size >= MAX_PROVIDER_CONFIGS) {
          watchDependencyRoots();
          core.warning(
            'Too many external test dependencies to inspect safely. Watching the repository workspace conservatively.',
          );
          return;
        }
        inspectedExternalTestFiles.add(inspectionKey);
        try {
          if (fs.statSync(externalTestPath).size > MAX_STRUCTURED_FILE_BYTES) {
            watchDependencyRoots();
            core.warning(
              'External test dependency is too large to inspect safely. Watching the repository workspace conservatively.',
            );
            continue;
          }
          const externalTestContent = fs.readFileSync(externalTestPath, 'utf8');
          const externalTests = externalTestPath
            .toLowerCase()
            .endsWith('.jsonl')
            ? externalTestContent
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line) as unknown)
            : loadYaml(externalTestContent, { schema: YAML_LOAD_SCHEMA });
          const pending: unknown[] = [externalTests];
          const visitedObjects = new WeakSet<object>();
          while (pending.length > 0) {
            const current = pending.pop();
            externalTestValuesVisited += 1;
            if (externalTestValuesVisited > MAX_PROVIDER_VALUES) {
              watchDependencyRoots();
              core.warning(
                'External test dependency graph is too large to inspect safely. Watching the repository workspace conservatively.',
              );
              return;
            }
            if (typeof current === 'string') {
              const renderedCurrent = renderEnvTemplate(
                current,
                configEnvironment,
              );
              if (renderedCurrent.startsWith('file://')) {
                processTestFile(current, rebaseExternalTests);
              } else if (
                mayRenderFileUrl(current) &&
                /\{\{|\{%|\{#/.test(renderedCurrent)
              ) {
                watchDependencyRoots();
              }
              continue;
            }
            if (
              !current ||
              typeof current !== 'object' ||
              visitedObjects.has(current)
            ) {
              continue;
            }
            visitedObjects.add(current);
            const nestedVars = (current as { vars?: unknown }).vars;
            const nestedAssertions = (current as { assert?: unknown }).assert;
            if (Array.isArray(nestedAssertions)) {
              extractAssertFiles(nestedAssertions as PromptfooAssertion[]);
            }
            const targetProvider = (current as { provider?: unknown }).provider;
            if (targetProvider) {
              processProviderValue(
                rebaseExternalTests
                  ? rebaseExternalProvider(
                      targetProvider,
                      path.dirname(externalTestPath),
                    )
                  : targetProvider,
                true,
              );
            }
            const gradingProvider = (
              current as { options?: { provider?: unknown } }
            ).options?.provider;
            if (gradingProvider) {
              processProviderValue(gradingProvider, true);
            }
            const rawVars = Array.isArray(nestedVars)
              ? nestedVars
              : [nestedVars];
            for (const rawVar of rawVars) {
              if (typeof rawVar !== 'string') {
                continue;
              }
              const renderedVar = renderEnvTemplate(rawVar, configEnvironment);
              if (renderedVar.startsWith('file://')) {
                const varPath = renderedVar.slice('file://'.length);
                const rebasedVar =
                  path.isAbsolute(varPath) || isForeignWindowsPath(varPath)
                    ? varPath
                    : path.relative(
                        configDir,
                        path.resolve(
                          rebaseExternalTests
                            ? path.dirname(externalTestPath)
                            : configDir,
                          varPath,
                        ),
                      );
                processTestFile(`file://${rebasedVar}`, rebaseExternalTests);
                continue;
              }
              const rebasedVar =
                path.isAbsolute(renderedVar) ||
                isForeignWindowsPath(renderedVar)
                  ? renderedVar
                  : path.relative(
                      configDir,
                      path.resolve(
                        rebaseExternalTests
                          ? path.dirname(externalTestPath)
                          : configDir,
                        renderedVar,
                      ),
                    );
              processTestFile(rebasedVar, rebaseExternalTests);
            }
            for (const [key, nestedValue] of Object.entries(current)) {
              if (
                (key === 'vars' &&
                  (typeof nestedVars === 'string' ||
                    Array.isArray(nestedVars))) ||
                (key === 'assert' && Array.isArray(nestedAssertions)) ||
                (key === 'provider' && targetProvider === nestedValue)
              ) {
                continue;
              }
              if (
                key === 'options' &&
                nestedValue &&
                typeof nestedValue === 'object'
              ) {
                for (const [optionKey, optionValue] of Object.entries(
                  nestedValue,
                )) {
                  if (optionKey !== 'provider') pending.push(optionValue);
                }
                continue;
              }
              pending.push(nestedValue);
            }
          }
        } catch {
          watchDependencyRoots();
          core.warning(
            'Failed to inspect an external test dependency. Watching the repository workspace conservatively.',
          );
        }
      }
    };

    const visitedRebasedTestCollections = new WeakSet<
      Array<string | PromptfooTestCase>
    >();
    const visitedConfigTestCollections = new WeakSet<
      Array<string | PromptfooTestCase>
    >();
    const extractTestFiles = (
      tests?: PromptfooTests,
      rebaseExternalTests = true,
    ): void => {
      if (!tests) return;
      if (typeof tests === 'string') {
        processTestFile(tests, rebaseExternalTests);
        return;
      }
      if (Array.isArray(tests)) {
        const visitedTestCollections = rebaseExternalTests
          ? visitedRebasedTestCollections
          : visitedConfigTestCollections;
        if (visitedTestCollections.has(tests)) return;
        visitedTestCollections.add(tests);
        for (const test of tests) {
          extractTestFiles(test, rebaseExternalTests);
        }
        return;
      }
      if (typeof tests.path === 'string') {
        processTestFile(tests.path, rebaseExternalTests);
        processProviderValue(tests.config);
      }
      extractVarFiles(tests.vars);
      processTestFileBearingValue(tests.assertScoringFunction);
      if (tests.provider) {
        processProviderValue(tests.provider, true);
      }
      if (tests.options?.provider) {
        processProviderValue(tests.options.provider, true);
      }
      for (const key of [
        'postprocess',
        'transform',
        'transformVars',
        'rubricPrompt',
      ]) {
        processTestFileBearingValue(tests.options?.[key]);
      }
      extractAssertFiles(tests.assert);
    };

    // Process defaultTest
    if (config.defaultTest) {
      extractTestFiles(config.defaultTest);
    }

    // Process tests
    extractTestFiles(config.tests);

    if (config.scenarios) {
      if (typeof config.scenarios === 'string') {
        processTestFile(config.scenarios, false);
      } else {
        for (const scenario of config.scenarios) {
          if (typeof scenario === 'string') {
            processTestFile(scenario, false);
            continue;
          }
          extractTestFiles(scenario.config, false);
          extractTestFiles(scenario.tests, false);
        }
      }
    }

    if (config.nunjucksFilters) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        processFileUrl(`file://${filterPath}`);
      }
    }

    // Convert absolute paths back to relative paths from working directory
    return Array.from(dependencies).map(toRepositoryPath);
  } catch (error) {
    if (configParsed) {
      core.warning(
        'Failed to extract config dependencies. Watching the repository workspace conservatively.',
      );
      dependencies.clear();
      watchDependencyRoots();
      return Array.from(dependencies).map(toRepositoryPath);
    }

    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
