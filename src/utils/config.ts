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

const MAX_PROVIDER_VALUES = 1_024;
const MAX_PROVIDER_CONFIGS = 128;
const MAX_GLOB_MATCHES = 4_096;
const MAX_GLOB_PATTERN_LENGTH = 64 * 1_024;
const MAX_BRACE_EXPANSIONS = 1_024;
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
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: Array<{
    vars?: string | string[] | { [key: string]: string | { file?: string } };
    assert?: Array<{ type?: string; value?: string | { file?: string } }>;
    [key: string]: unknown;
  }>;
  defaultTest?: {
    vars?: string | string[] | { [key: string]: string | { file?: string } };
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

  return uncommentedValue.replace(
    /\{\{-?\s*env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])\s*(?:\|\s*(?:default|d)\(\s*(['"])([^'"]*)\3\s*(?:,\s*(true|false))?\s*\))?\s*-?\}\}/g,
    (
      template,
      dotName: string | undefined,
      bracketName: string | undefined,
      _quote: string | undefined,
      defaultValue: string | undefined,
      defaultOnFalsy: string | undefined,
    ) => {
      const envValue = environment[dotName ?? (bracketName as string)];
      if (envValue !== undefined) {
        if (defaultOnFalsy === 'true' && !envValue) {
          return defaultValue as string;
        }
        return String(envValue);
      }
      return defaultValue ?? template;
    },
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
      candidate.replace(/\{#[\s\S]*?#\}/g, '').startsWith('file://'))
  );
}

function hasGlobMagic(pattern: string): boolean | undefined {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return undefined;
  }
  try {
    return glob.hasMagic(pattern, { magicalBraces: true });
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
  let configParsed = false;

  try {
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

    let realDependencyRoot: string | undefined;
    let dependencyRootResolved = false;
    const isSafeDependencyPath = (absolutePath: string): boolean => {
      if (!isPathInside(dependencyRoot, absolutePath)) {
        return false;
      }

      try {
        if (!dependencyRootResolved) {
          dependencyRootResolved = true;
          realDependencyRoot = fs.realpathSync(dependencyRoot);
        }
      } catch {
        return false;
      }
      if (!realDependencyRoot) {
        return false;
      }

      let existingPath = absolutePath;
      while (existingPath !== dependencyRoot) {
        try {
          const realPath = fs.realpathSync(existingPath);
          return isPathInside(realDependencyRoot, realPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return false;
          }

          existingPath = path.dirname(existingPath);
        }
      }
      return true;
    };

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
        if (!isSafeDependencyPath(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        return absolutePath;
      } catch (error) {
        if (
          filePath.length > 0 &&
          !filePath.includes('\0') &&
          isPathInside(dependencyRoot, path.resolve(configDir, filePath))
        ) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
        core.warning(
          `Ignoring unsafe config dependency "${displayPath}": ${String(
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
    ): string[] => {
      const renderedFileUrl = renderEnvTemplate(fileUrl, environment);
      if (/\{\{|\{%|\{#/.test(renderedFileUrl)) {
        dependencies.add(`${dependencyRoot}${path.sep}`);
        return [];
      }

      const filePath = isProvider
        ? providerFilePath(renderedFileUrl, allowJavascript)
        : renderedFileUrl.slice('file://'.length);
      const displayPath = isProvider
        ? fileUrl.startsWith('file://')
          ? providerFilePath(fileUrl, allowJavascript)
          : fileUrl
        : fileUrl.slice('file://'.length);
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
        dependencies.add(`${dependencyRoot}${path.sep}`);
        core.warning(
          'Ignoring an invalid or oversized config dependency glob. Watching the repository workspace conservatively.',
        );
        return [];
      }
      if (isFileGlob) {
        const expandedPaths = braceExpand(filePath, {
          braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
        });
        if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
          core.warning(
            'Config dependency glob has too many brace alternatives. Watching the repository workspace conservatively.',
          );
          return [];
        }

        const safePatterns: string[] = [];
        let unsafePattern = false;
        for (const expandedPath of expandedPaths) {
          const absolutePattern = path.resolve(configDir, expandedPath);
          if (isSafeDependencyPath(absolutePattern)) {
            safePatterns.push(absolutePattern);
          } else {
            unsafePattern = true;
          }
        }
        if (unsafePattern) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
                renderedFileUrl === fileUrl ? match : displayPath
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
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
        dependencies.add(`${dependencyRoot}${path.sep}`);
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
            dependencies.add(`${dependencyRoot}${path.sep}`);
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

        const authType = (value as { type?: unknown }).type;
        const renderedAuthType =
          typeof authType === 'string'
            ? renderEnvTemplate(authType, {
                ...configEnvironment,
                ...nestedProviderOverrides,
              })
            : undefined;
        const isHttpAuthContext =
          parentKey === 'auth' &&
          grandparentKey === 'config' &&
          (providerDepth === 2 || providerDepth === 3);
        if (
          isHttpAuthContext &&
          typeof (value as { path?: unknown }).path === 'string' &&
          renderedAuthType !== undefined &&
          /\{\{|\{%|\{#/.test(renderedAuthType)
        ) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
            dependencies.add(`${dependencyRoot}${path.sep}`);
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
              dependencies.add(`${dependencyRoot}${path.sep}`);
            }
          }
        }

        for (const [key, nestedValue] of Object.entries(value)) {
          if (key === 'env' || (key === 'path' && fileAuthPath !== undefined)) {
            continue;
          }
          if (
            (providerDepth === 2 || providerDepth === 3) &&
            grandparentKey === 'config' &&
            (parentKey === 'signatureAuth' || parentKey === 'tls') &&
            HTTP_CREDENTIAL_PATH_KEYS.has(key) &&
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
              dependencies.add(`${dependencyRoot}${path.sep}`);
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
              dependencies.add(`${dependencyRoot}${path.sep}`);
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
          if (inspectProviderKey && renderedProviderKey.startsWith('file://')) {
            processProviderReference(key, true, mappedProviderOverrides, true);
          } else if (
            inspectProviderKey &&
            /\{\{|\{%|\{#/.test(renderedProviderKey)
          ) {
            dependencies.add(`${dependencyRoot}${path.sep}`);
          }
          processProviderValue(
            nestedValue,
            key === 'id',
            nestedProviderOverrides,
            false,
            key === 'id',
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
      const isProviderConfig = /\.(?:ya?ml|json)$/i.test(providerPath);
      const isProviderGlob = hasGlobMagic(providerPath);
      if (providerPaths.length === 0) {
        if (
          !providerPath ||
          providerPath.includes('\0') ||
          isProviderGlob === undefined
        ) {
          return;
        }
        const isContainedReference = isPathInside(
          dependencyRoot,
          path.resolve(configDir, providerPath),
        );
        if (
          (isProviderConfig && !isProviderGlob) ||
          (isContainedReference && !isProviderGlob)
        ) {
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
          dependencies.add(`${dependencyRoot}${path.sep}`);
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
            `Failed to inspect provider config dependency "${displayProviderPath}". Watching the repository workspace conservatively.`,
          );
          dependencies.add(`${dependencyRoot}${path.sep}`);
        }
      }
    };

    for (const providers of [config.providers, config.targets]) {
      if (providers) {
        processProviderValue(providers, true);
      }
    }

    const processPotentialFileUrl = (value: string): void => {
      const renderedValue = renderEnvTemplate(value, configEnvironment);
      if (renderedValue.startsWith('file://')) {
        processFileUrl(value);
      } else if (
        mayRenderFileUrl(value) &&
        /\{\{|\{%|\{#/.test(renderedValue)
      ) {
        dependencies.add(`${dependencyRoot}${path.sep}`);
      }
    };

    const processTemplatedDependency = (
      filePath: string,
      source: string,
    ): void => {
      const renderedPath = renderEnvTemplate(filePath, configEnvironment);
      if (/\{\{|\{%|\{#/.test(renderedPath)) {
        dependencies.add(`${dependencyRoot}${path.sep}`);
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

    // Extract prompt files
    if (config.prompts) {
      for (const prompt of config.prompts) {
        if (typeof prompt === 'string') {
          processPotentialFileUrl(prompt);
        } else if (
          typeof prompt === 'object' &&
          prompt !== null &&
          typeof prompt.file === 'string'
        ) {
          processTemplatedDependency(prompt.file, 'prompt file dependency');
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars: unknown): void => {
      if (typeof vars === 'string') {
        processPotentialFileUrl(vars);
        return;
      }
      if (Array.isArray(vars)) {
        for (const value of vars) {
          if (typeof value === 'string') {
            processPotentialFileUrl(value);
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
    const extractAssertFiles = (
      asserts?: Array<{ type?: string; value?: unknown }>,
    ): void => {
      if (!asserts) return;
      for (const assert of asserts) {
        if (typeof assert.value === 'string') {
          processPotentialFileUrl(assert.value);
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
        return repositoryPath ? `${repositoryPath}/` : './';
      }
      return repositoryPath;
    });
  } catch (error) {
    if (configParsed) {
      core.warning(
        'Failed to extract config dependencies. Watching the repository workspace conservatively.',
      );
      const relativeRoot = path.relative(cwd, dependencyRoot);
      return [
        relativeRoot ? `${relativeRoot.split(path.sep).join('/')}/` : './',
      ];
    }

    core.warning(
      `Failed to extract dependencies from config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
