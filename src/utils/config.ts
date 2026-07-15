import * as core from '@actions/core';
import * as fs from 'fs';
import {
  binaryTag,
  CORE_SCHEMA,
  load as loadYaml,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from 'js-yaml';
import * as path from 'path';
import { isDirectory } from './fs';

interface PromptfooAssertion {
  type?: string;
  value?: string | { file?: string };
  assert?: PromptfooAssertion[];
}

export interface PromptfooConfig {
  $ref?: string;
  commandLineOptions?: {
    $ref?: string;
    envPath?: string | string[];
    [key: string]: unknown;
  };
  providers?: Array<string | { id?: string; [key: string]: unknown }>;
  targets?: Array<string | { id?: string; [key: string]: unknown }>;
  prompts?:
    | string
    | Record<string, string>
    | Array<string | { file?: string; [key: string]: unknown }>;
  tests?:
    | string
    | {
        path?: string;
        [key: string]: unknown;
      }
    | Array<
        | string
        | {
            path?: string;
            vars?: { [key: string]: string | { file?: string } };
            assert?: PromptfooAssertion[];
            [key: string]: unknown;
          }
      >;
  defaultTest?:
    | string
    | {
        vars?: { [key: string]: string | { file?: string } };
        assert?: PromptfooAssertion[];
      };
  scenarios?: unknown;
  nunjucksFilters?: Record<string, unknown>;
  extensions?: unknown;
}

const MAX_TRANSITIVE_CONFIG_BYTES = 1024 * 1024;
const MAX_NESTED_CONFIG_VALUES = 100_000;
const TRANSITIVE_CONFIG_EXTENSION =
  /\.(?:yaml|yml|json|jsonl|csv|xlsx|xls)(?:#[^\r\n]*)?$/i;
const BINARY_TRANSITIVE_CONFIG_EXTENSION = /\.(?:xlsx|xls)(?:#[^\r\n]*)?$/i;
const TRANSITIVE_NESTED_EXTENSIONS = new Set([
  'yaml',
  'yml',
  'json',
  'jsonl',
  'csv',
  'xlsx',
  'xls',
  'js',
  'cjs',
  'mjs',
  'ts',
  'cts',
  'mts',
  'py',
  'go',
  'rb',
]);

function hasTransitiveNestedReference(contents: string): boolean {
  for (const token of contents.split(/[\s,"'[\]{}()]+/)) {
    if (!token) continue;
    const normalized = token.startsWith('-') ? token.slice(1) : token;
    if (
      normalized.startsWith('python:') ||
      normalized.startsWith('golang:') ||
      normalized.startsWith('ruby:') ||
      normalized.startsWith('exec:')
    ) {
      return true;
    }
    const sheetIndex = normalized.indexOf('#');
    const withoutSheet =
      sheetIndex > -1 ? normalized.slice(0, sheetIndex) : normalized;
    const selectorIndex = withoutSheet.lastIndexOf(':');
    const candidate =
      selectorIndex > -1 ? withoutSheet.slice(0, selectorIndex) : withoutSheet;
    const extensionIndex = candidate.lastIndexOf('.');
    if (
      extensionIndex > -1 &&
      TRANSITIVE_NESTED_EXTENSIONS.has(
        candidate.slice(extensionIndex + 1).toLowerCase(),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasGlobMagic(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (path.sep === '/' && character === '\\') {
      index++;
      continue;
    }
    if ('*?[]{}'.includes(character)) {
      return true;
    }
    if ('*?@+!'.includes(character) && value[index + 1] === '(') {
      return true;
    }
  }
  return false;
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

function sanitizeLogText(value: string): string {
  return value
    .replace(/\0/g, '\\0')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function isUnsupportedWindowsPath(filePath: string): boolean {
  return (
    /^[A-Za-z]:(?![\\/])/.test(filePath) ||
    (!path.isAbsolute(filePath) && path.win32.isAbsolute(filePath))
  );
}

function hasUnsafeGroupedGlob(value: string): boolean {
  const closingDelimiters: string[] = [];
  let inCharacterClass = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (path.sep === '/' && character === '\\') {
      index++;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
      }
      continue;
    }
    if (character === '{') {
      closingDelimiters.push('}');
      continue;
    }
    if ('*?@+!'.includes(character) && value[index + 1] === '(') {
      closingDelimiters.push(')');
      index++;
      continue;
    }
    if (
      closingDelimiters.length > 0 &&
      (character === '}' || character === ')')
    ) {
      if (character !== closingDelimiters[closingDelimiters.length - 1]) {
        return true;
      }
      closingDelimiters.pop();
      continue;
    }
    if (
      closingDelimiters.length > 0 &&
      (character === '/' ||
        character === '\\' ||
        (character === '.' && value[index + 1] === '.'))
    ) {
      return true;
    }
  }
  return closingDelimiters.length > 0;
}

function normalizeFileUrlSelectors(
  fileUrl: string,
  executableExtensions: RegExp,
  requireFunctionName = false,
  useFirstColon = false,
): string[] {
  const rawFilename = fileUrl.slice('file://'.length);
  const lastColonIndex = useFirstColon
    ? rawFilename.indexOf(':')
    : rawFilename.lastIndexOf(':');
  if (
    lastColonIndex <= 1 ||
    (requireFunctionName && lastColonIndex === rawFilename.length - 1)
  ) {
    return [fileUrl];
  }
  const candidateFilename = rawFilename.slice(0, lastColonIndex);
  const stripped = `file://${candidateFilename}`;
  if (executableExtensions.test(candidateFilename)) {
    return [stripped];
  }
  if (/\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(candidateFilename)) {
    return [fileUrl, stripped];
  }
  return [fileUrl];
}

function normalizeProviderFileUrls(providerPath: string): string[] {
  const executable = providerPath.startsWith('exec:')
    ? providerPath.slice('exec:'.length)
    : undefined;
  if (executable !== undefined && /\s/.test(executable)) {
    throw new Error('Command-style Promptfoo exec providers are unsafe');
  }
  const fileUrl = executable?.startsWith('file://')
    ? executable
    : executable !== undefined
      ? `file://${executable}`
      : providerPath.startsWith('file://')
        ? providerPath
        : /^(?:python|golang|ruby):/.test(providerPath)
          ? `file://${providerPath.slice(providerPath.indexOf(':') + 1)}`
          : /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(providerPath)
            ? `file://${providerPath}`
            : undefined;
  return fileUrl
    ? normalizeFileUrlSelectors(
        fileUrl,
        /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
      )
    : [];
}

function containsEnvTemplate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.includes('{{') || value.includes('{%')) &&
    /\benv(?:\.|\[)/.test(value)
  );
}

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(
  configPath: string,
  workspaceRoot: string = process.cwd(),
  workingDirectory: string = workspaceRoot,
): string[] {
  const dependencies = new Set<string>();
  const lexicalConfigPath = path.resolve(configPath);
  const configDir = path.dirname(lexicalConfigPath);
  const cwd = path.resolve(workspaceRoot);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  const isSafeDependency = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);
  const getRealDependencyRoots = (): string[] => {
    const roots: string[] = [];
    for (const root of new Set([configDir, cwd])) {
      try {
        roots.push(path.resolve(fs.realpathSync(root)));
      } catch {}
    }
    return roots;
  };
  const maxConfigBytes = 2 * 1024 * 1024;
  const maxConfigNodes = 10_000;
  const maxConfigRefs = 100;
  const maxGlobPatternLength = 64 * 1024;
  const maxGlobBraceExpansions = 1024;
  let requiresFullEvaluation = false;

  try {
    if (!isPathInside(cwd, resolvedWorkingDirectory)) {
      throw new Error(
        'Promptfoo working directory must stay within the repository workspace',
      );
    }
    if (
      configPath.length > maxGlobPatternLength ||
      isUnsupportedWindowsPath(configPath) ||
      hasGlobMagic(configPath) ||
      configPath.includes('{{')
    ) {
      throw new Error('Dynamic Promptfoo configs cannot be safely inspected');
    }
    if (!/\.(?:ya?ml|json)$/i.test(lexicalConfigPath)) {
      throw new Error(
        'Executable Promptfoo configs cannot be safely inspected',
      );
    }

    const addSafeDependency = (
      filePath: string,
      baseDir: string,
      source: string,
      trackLexicalPath = true,
    ): string => {
      if (!filePath || filePath.includes('\0')) {
        throw new Error(`${source} is empty or contains an invalid null byte`);
      }
      const absolutePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(baseDir, filePath);
      if (!isPathInside(dependencyRoot, absolutePath)) {
        throw new Error(`${source} must stay within the repository workspace`);
      }

      if (trackLexicalPath) {
        dependencies.add(absolutePath);
      }

      let existingPath = absolutePath;
      while (existingPath !== dependencyRoot && !fs.existsSync(existingPath)) {
        existingPath = path.dirname(existingPath);
      }
      if (fs.existsSync(existingPath)) {
        const realRoot = fs.existsSync(dependencyRoot)
          ? fs.realpathSync(dependencyRoot)
          : dependencyRoot;
        const realExistingPath = fs.realpathSync(existingPath);
        if (!isPathInside(realRoot, realExistingPath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }
        if (
          existingPath === absolutePath &&
          realExistingPath !== absolutePath
        ) {
          dependencies.add(realExistingPath);
        }
      }

      return absolutePath;
    };

    const excludedParameterParents = new WeakSet<object>();
    const readConfig = (filePath: string): unknown => {
      const lexicalStats = fs.lstatSync(filePath);
      const configStats = lexicalStats.isSymbolicLink()
        ? fs.statSync(filePath)
        : lexicalStats;
      if (!configStats.isFile()) {
        throw new Error('Promptfoo config must be a regular file');
      }
      if (configStats.size > maxConfigBytes) {
        throw new Error('Promptfoo config exceeds the dependency size limit');
      }
      const realConfigPath = fs.realpathSync(filePath);
      if (!/\.(?:ya?ml|json)$/i.test(realConfigPath)) {
        throw new Error(
          'Executable Promptfoo configs cannot be safely inspected',
        );
      }

      const content = fs.readFileSync(filePath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > maxConfigBytes) {
        throw new Error('Promptfoo config exceeds the dependency size limit');
      }
      if (!content.trim()) {
        return null;
      }

      const parsed = loadYaml(content, {
        schema: CORE_SCHEMA.withTags(
          mergeTag,
          binaryTag,
          timestampTag,
          omapTag,
          pairsTag,
          setTag,
        ),
      }) as unknown;
      if (
        filePath === lexicalConfigPath &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'providers' in parsed &&
        Array.isArray(parsed.providers)
      ) {
        for (const entry of parsed.providers) {
          if (typeof entry !== 'object' || entry === null) {
            continue;
          }
          let provider = entry as Record<string, unknown>;
          if (!('config' in provider)) {
            const mappedProvider = Object.values(provider)[0];
            if (typeof mappedProvider !== 'object' || mappedProvider === null) {
              continue;
            }
            provider = mappedProvider as Record<string, unknown>;
          }
          if (typeof provider.config !== 'object' || provider.config === null) {
            continue;
          }
          const providerConfig = provider.config as Record<string, unknown>;
          if (Array.isArray(providerConfig.functions)) {
            for (const functionConfig of providerConfig.functions) {
              if (
                typeof functionConfig === 'object' &&
                functionConfig !== null &&
                'parameters' in functionConfig &&
                typeof functionConfig.parameters === 'object' &&
                functionConfig.parameters !== null
              ) {
                excludedParameterParents.add(functionConfig);
              }
            }
          }
          if (Array.isArray(providerConfig.tools)) {
            for (const tool of providerConfig.tools) {
              if (
                typeof tool !== 'object' ||
                tool === null ||
                !('function' in tool) ||
                typeof tool.function !== 'object' ||
                tool.function === null ||
                !('parameters' in tool.function) ||
                typeof tool.function.parameters !== 'object' ||
                tool.function.parameters === null
              ) {
                continue;
              }
              excludedParameterParents.add(tool.function);
            }
          }
        }
      }
      const inspected = new WeakSet<object>();
      const pending: unknown[] = [parsed];
      let nodeCount = 0;
      while (pending.length > 0) {
        const value = pending.pop();
        if (
          typeof value !== 'object' ||
          value === null ||
          (!Array.isArray(value) &&
            Object.getPrototypeOf(value) !== Object.prototype) ||
          inspected.has(value)
        ) {
          continue;
        }
        inspected.add(value);
        nodeCount++;
        if (nodeCount > maxConfigNodes) {
          throw new Error(
            'Promptfoo config exceeds the dependency traversal limit',
          );
        }
        pending.push(...Object.values(value));
      }
      return parsed;
    };

    const loadedConfigs = new Map<string, unknown>();
    const loadConfig = (filePath: string): unknown => {
      if (loadedConfigs.has(filePath)) {
        return loadedConfigs.get(filePath);
      }
      const parsed = readConfig(filePath);
      loadedConfigs.set(filePath, parsed);
      return parsed;
    };

    addSafeDependency(lexicalConfigPath, configDir, 'Promptfoo config', false);
    const config = loadConfig(lexicalConfigPath) as PromptfooConfig;
    const refsDisabled = ['1', 'true', 'yes', 'yup', 'yeppers'].includes(
      (process.env.PROMPTFOO_DISABLE_REF_PARSER ?? '').toLowerCase(),
    );

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const inspectedRefs = new Set<string>();
    const resolveConfigRef = (
      ref: string,
      sourceFile: string,
    ): { config: unknown; file: string; fragment: string } => {
      const hashIndex = ref.indexOf('#');
      const refPath = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex);
      const hasControlCharacters = [...(refPath + fragment)].some(
        (character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        },
      );
      const hasOuterWhitespace =
        refPath.length > 0 &&
        (refPath.charCodeAt(0) <= 32 ||
          refPath.charCodeAt(refPath.length - 1) <= 32);
      if (
        !ref ||
        ref.includes('\0') ||
        ref.includes('{{') ||
        refPath.includes('\\') ||
        fragment.includes('\\') ||
        refPath.includes('%') ||
        fragment.includes('%') ||
        hasControlCharacters ||
        hasOuterWhitespace ||
        /^[a-z][a-z\d+.-]*:/i.test(refPath)
      ) {
        throw new Error(
          'Dynamic or unsafe Promptfoo config refs are unsupported',
        );
      }

      const refBase =
        sourceFile === lexicalConfigPath
          ? resolvedWorkingDirectory
          : path.dirname(sourceFile);
      const refFile = refPath
        ? addSafeDependency(refPath, refBase, 'Promptfoo config ref')
        : sourceFile;
      if (!/\.(?:ya?ml|json)$/i.test(refFile)) {
        throw new Error(
          'Executable Promptfoo config refs cannot be safely inspected',
        );
      }

      let selectedConfig: unknown = loadConfig(refFile);
      if (!fragment || fragment === '#') {
        return { config: selectedConfig, file: refFile, fragment };
      }
      const pointer = fragment.slice(1);
      if (!pointer.startsWith('/')) {
        throw new Error('Unsupported Promptfoo config ref fragment');
      }
      for (const encodedPart of pointer.slice(1).split('/')) {
        if (/~(?![01])/.test(encodedPart)) {
          throw new Error('Invalid Promptfoo config ref fragment');
        }
        const part = encodedPart.replace(/~1/g, '/').replace(/~0/g, '~');
        if (
          typeof selectedConfig !== 'object' ||
          selectedConfig === null ||
          '$id' in selectedConfig ||
          !(part in selectedConfig)
        ) {
          throw new Error('Unsafe or missing Promptfoo config ref fragment');
        }
        selectedConfig = (selectedConfig as Record<string, unknown>)[part];
      }
      return { config: selectedConfig, file: refFile, fragment };
    };

    const discoveredRefs = new Set<string>();
    const inspectedObjects = new Map<string, WeakSet<object>>();
    const httpValidateStatusParents = new WeakSet<object>();
    const httpTransformParents = new WeakSet<object>();
    const httpSessionParserParents = new WeakSet<object>();
    const httpFileAuthParents = new WeakSet<object>();
    const providerIdParents = new WeakSet<object>();
    const nestedFileUrls: string[] = [];
    const normalizedSelectorUrls = new Set<string>();
    const nestedFilePaths: string[] = [];
    const pending: Array<{
      value: unknown;
      file: string;
      context: 'general' | 'provider-list' | 'assertion';
    }> = [{ value: config, file: lexicalConfigPath, context: 'general' }];
    let inspectedNodeCount = 0;
    while (pending.length > 0) {
      const next = pending.pop() as {
        value: unknown;
        file: string;
        context: 'general' | 'provider-list' | 'assertion';
      };
      if (typeof next.value === 'string') {
        if (next.value.includes('file://') && containsEnvTemplate(next.value)) {
          throw new Error(
            'Dynamic Promptfoo file references cannot be safely inspected',
          );
        }
        if (next.context === 'provider-list') {
          nestedFileUrls.push(...normalizeProviderFileUrls(next.value));
        } else if (next.value.startsWith('file://')) {
          const normalizedFileUrls =
            next.context === 'general'
              ? [next.value]
              : normalizeFileUrlSelectors(
                  next.value,
                  /\.(?:js|cjs|mjs|ts|cts|mts|py|rb)$/,
                  false,
                  true,
                );
          if (
            next.context === 'assertion' &&
            normalizedFileUrls.some((fileUrl) => fileUrl !== next.value)
          ) {
            normalizedSelectorUrls.add(next.value);
          }
          nestedFileUrls.push(...normalizedFileUrls);
        }
        continue;
      }
      if (
        typeof next.value !== 'object' ||
        next.value === null ||
        (!Array.isArray(next.value) &&
          Object.getPrototypeOf(next.value) !== Object.prototype)
      ) {
        continue;
      }
      const inspectionContext = `${next.file}\0${next.context}`;
      const objectsForFile =
        inspectedObjects.get(inspectionContext) ?? new WeakSet<object>();
      inspectedObjects.set(inspectionContext, objectsForFile);
      if (objectsForFile.has(next.value)) {
        continue;
      }
      objectsForFile.add(next.value);
      inspectedNodeCount++;
      if (inspectedNodeCount > maxConfigNodes) {
        throw new Error(
          'Promptfoo config exceeds the dependency traversal limit',
        );
      }

      const record = next.value as Record<string, unknown>;
      for (const providers of [record.providers, record.targets]) {
        if (!Array.isArray(providers)) {
          continue;
        }
        for (const entry of providers) {
          if (typeof entry === 'string') {
            nestedFileUrls.push(...normalizeProviderFileUrls(entry));
            continue;
          }
          if (typeof entry !== 'object' || entry === null) {
            continue;
          }
          const provider = entry as Record<string, unknown>;
          let providerId = provider.id;
          let providerConfig = provider.config;
          if (typeof providerId !== 'string') {
            const mappedProvider = Object.entries(provider).find(
              ([id]) =>
                /^https?(?::|$)/i.test(id) ||
                normalizeProviderFileUrls(id).length > 0,
            );
            providerId = mappedProvider?.[0];
            const mappedValue = mappedProvider?.[1];
            providerConfig =
              typeof mappedValue === 'object' && mappedValue !== null
                ? (mappedValue as Record<string, unknown>).config
                : undefined;
          }
          if (typeof providerId === 'string') {
            nestedFileUrls.push(...normalizeProviderFileUrls(providerId));
            if (provider.id === providerId) {
              providerIdParents.add(provider);
            }
          }
          if (
            containsEnvTemplate(providerId) &&
            typeof providerConfig === 'object' &&
            providerConfig !== null &&
            [
              'validateStatus',
              'transformRequest',
              'transformResponse',
              'responseParser',
              'sessionParser',
              'session',
              'auth',
              'tls',
              'signatureAuth',
              'multipart',
            ].some((field) => field in providerConfig)
          ) {
            throw new Error(
              'Dynamic Promptfoo HTTP provider dependencies cannot be safely inspected',
            );
          }
          if (
            typeof providerId !== 'string' ||
            !/^https?(?::|$)/i.test(providerId) ||
            typeof providerConfig !== 'object' ||
            providerConfig === null
          ) {
            continue;
          }
          const configRecord = providerConfig as Record<string, unknown>;
          const validateStatus = configRecord.validateStatus;
          if (
            typeof validateStatus === 'string' &&
            validateStatus.startsWith('file://')
          ) {
            nestedFileUrls.push(
              ...normalizeFileUrlSelectors(
                validateStatus,
                /\.(?:js|cjs|mjs|ts|cts|mts)$/,
                true,
              ),
            );
            httpValidateStatusParents.add(configRecord);
          }
          for (const field of [
            'transformRequest',
            'transformResponse',
            'responseParser',
            'sessionParser',
          ]) {
            const reference = configRecord[field];
            if (
              typeof reference === 'string' &&
              reference.startsWith('file://')
            ) {
              nestedFileUrls.push(
                ...normalizeFileUrlSelectors(
                  reference,
                  /\.(?:js|cjs|mjs|ts|cts|mts)$/,
                  true,
                ),
              );
              httpTransformParents.add(configRecord);
            }
          }
          const session = configRecord.session;
          if (typeof session === 'object' && session !== null) {
            const responseParser = (session as Record<string, unknown>)
              .responseParser;
            if (
              typeof responseParser === 'string' &&
              responseParser.startsWith('file://')
            ) {
              nestedFileUrls.push(
                ...normalizeFileUrlSelectors(
                  responseParser,
                  /\.(?:js|cjs|mjs|ts|cts|mts)$/,
                  true,
                ),
              );
              httpSessionParserParents.add(session);
            }
          }

          const auth = configRecord.auth;
          if (
            typeof auth === 'object' &&
            auth !== null &&
            ((auth as Record<string, unknown>).type === 'file' ||
              containsEnvTemplate((auth as Record<string, unknown>).type))
          ) {
            const authRecord = auth as Record<string, unknown>;
            if (typeof authRecord.path === 'string') {
              if (authRecord.path.startsWith('file://')) {
                nestedFileUrls.push(
                  ...normalizeFileUrlSelectors(
                    authRecord.path,
                    /\.(?:js|cjs|mjs|ts|cts|mts|py)$/,
                  ),
                );
                httpFileAuthParents.add(authRecord);
              } else {
                nestedFilePaths.push(authRecord.path);
              }
            }
          }

          const multipart = configRecord.multipart;
          if (typeof multipart === 'object' && multipart !== null) {
            const parts = (multipart as Record<string, unknown>).parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (typeof part !== 'object' || part === null) {
                  continue;
                }
                const partRecord = part as Record<string, unknown>;
                const source = partRecord.source;
                if (
                  (partRecord.kind === 'file' ||
                    containsEnvTemplate(partRecord.kind)) &&
                  typeof source === 'object' &&
                  source !== null &&
                  ((source as Record<string, unknown>).type === 'path' ||
                    containsEnvTemplate(
                      (source as Record<string, unknown>).type,
                    )) &&
                  typeof (source as Record<string, unknown>).path === 'string'
                ) {
                  nestedFilePaths.push(
                    (source as Record<string, unknown>).path as string,
                  );
                }
              }
            }
          }

          const pathSections: Array<[unknown, string[]]> = [
            [
              configRecord.tls,
              ['caPath', 'certPath', 'keyPath', 'pfxPath', 'jksPath'],
            ],
            [
              configRecord.signatureAuth,
              [
                'privateKeyPath',
                'keystorePath',
                'pfxPath',
                'certPath',
                'keyPath',
              ],
            ],
          ];
          for (const [section, keys] of pathSections) {
            if (typeof section !== 'object' || section === null) {
              continue;
            }
            for (const key of keys) {
              const filePath = (section as Record<string, unknown>)[key];
              if (typeof filePath === 'string') {
                nestedFilePaths.push(filePath);
              }
            }
          }
        }
      }
      if (typeof record.file === 'string') {
        nestedFilePaths.push(record.file);
      }
      if (!refsDisabled && '$id' in record) {
        throw new Error('Promptfoo config refs using $id are unsupported');
      }
      if (!refsDisabled && '$ref' in record) {
        if (typeof record.$ref !== 'string') {
          throw new Error('Invalid Promptfoo config ref');
        }
        const refKey = `${next.file}\0${next.context}\0${record.$ref}`;
        if (!discoveredRefs.has(refKey)) {
          if (discoveredRefs.size >= maxConfigRefs) {
            throw new Error(
              'Promptfoo config exceeds the dependency ref limit',
            );
          }
          discoveredRefs.add(refKey);
          const referenced = resolveConfigRef(record.$ref, next.file);
          pending.push({
            value: referenced.config,
            file: referenced.file,
            context: next.context,
          });
        }
      }
      pending.push(
        ...Object.entries(record)
          .filter(
            ([key]) =>
              (key !== 'parameters' || !excludedParameterParents.has(record)) &&
              (key !== 'validateStatus' ||
                !httpValidateStatusParents.has(record)) &&
              (![
                'transformRequest',
                'transformResponse',
                'responseParser',
                'sessionParser',
              ].includes(key) ||
                !httpTransformParents.has(record)) &&
              (key !== 'responseParser' ||
                !httpSessionParserParents.has(record)) &&
              (key !== 'path' || !httpFileAuthParents.has(record)) &&
              (key !== 'id' || !providerIdParents.has(record)),
          )
          .map(
            ([key, value]): {
              value: unknown;
              file: string;
              context: 'general' | 'provider-list' | 'assertion';
            } => ({
              value,
              file: next.file,
              context:
                key === 'providers' || key === 'targets'
                  ? 'provider-list'
                  : key === 'assert'
                    ? 'assertion'
                    : next.context === 'provider-list'
                      ? Array.isArray(record)
                        ? 'provider-list'
                        : 'general'
                      : next.context,
            }),
          ),
      );
    }

    const inspectEnvironmentDependencies = (
      value: unknown,
      sourceFile: string,
      isCommandLineOptions: boolean,
      depth: number,
    ): boolean => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      if (
        !refsDisabled &&
        !isCommandLineOptions &&
        typeof record.$ref === 'string' &&
        typeof record.commandLineOptions === 'object' &&
        record.commandLineOptions !== null &&
        ('$ref' in record.commandLineOptions ||
          'envPath' in record.commandLineOptions)
      ) {
        throw new Error('Ambiguous extended Promptfoo config envPath refs');
      }

      if (isCommandLineOptions && 'envPath' in record) {
        if (!refsDisabled && '$ref' in record) {
          throw new Error('Ambiguous extended Promptfoo config envPath refs');
        }
        const envPath = record.envPath;
        if (
          typeof envPath !== 'string' &&
          (!Array.isArray(envPath) ||
            envPath.some((entry) => typeof entry !== 'string'))
        ) {
          throw new Error('Invalid commandLineOptions.envPath');
        }
        const rawEntries: string[] = Array.isArray(envPath)
          ? envPath
          : [envPath];
        const envDependencies: string[] = [];
        for (const rawEntry of rawEntries) {
          if (rawEntry.split(',').every((part) => part.trim().length === 0)) {
            continue;
          }
          if (rawEntry.includes('{{')) {
            throw new Error(
              'Dynamic commandLineOptions.envPath cannot be safely inspected',
            );
          }
          if (
            rawEntry
              .split(',')
              .some((part) => isUnsupportedWindowsPath(part.trim()))
          ) {
            throw new Error(
              'commandLineOptions.envPath uses an unsupported Windows path',
            );
          }
          const resolvedEntry = path.isAbsolute(rawEntry)
            ? rawEntry
            : path.resolve(configDir, rawEntry);
          for (const entry of resolvedEntry
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)) {
            envDependencies.push(entry);
            addSafeDependency(
              entry,
              resolvedWorkingDirectory,
              'commandLineOptions.envPath',
            );
          }
        }
        const lastEnvDependency = envDependencies[envDependencies.length - 1];
        if (process.env.DOTENV_KEY && lastEnvDependency) {
          addSafeDependency(
            lastEnvDependency.endsWith('.vault')
              ? lastEnvDependency
              : `${lastEnvDependency}.vault`,
            resolvedWorkingDirectory,
            'commandLineOptions.envPath vault',
          );
        }
        return true;
      }

      if (
        !isCommandLineOptions &&
        'commandLineOptions' in record &&
        inspectEnvironmentDependencies(
          record.commandLineOptions,
          sourceFile,
          true,
          depth + 1,
        )
      ) {
        return true;
      }

      if (!refsDisabled && typeof record.$ref === 'string') {
        const inspectionKey = `${sourceFile}\0${record.$ref}\0${isCommandLineOptions}`;
        if (inspectedRefs.has(inspectionKey)) {
          return false;
        }
        inspectedRefs.add(inspectionKey);
        const referenced = resolveConfigRef(record.$ref, sourceFile);
        return inspectEnvironmentDependencies(
          referenced.config,
          referenced.file,
          isCommandLineOptions,
          depth + 1,
        );
      }
      return false;
    };

    inspectEnvironmentDependencies(config, lexicalConfigPath, false, 0);

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
        if (/[\r\n]/.test(filePath)) {
          throw new Error(`${source} contains an invalid line break`);
        }
        if (isUnsupportedWindowsPath(filePath)) {
          throw new Error(`${source} uses an unsupported Windows path`);
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependency(absolutePath)) {
          throw new Error(
            `${source} must stay within the repository workspace`,
          );
        }

        let lexicalStats: fs.Stats | undefined;
        let existingPath = absolutePath;
        try {
          lexicalStats = fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
          }
          while (true) {
            const parentPath = path.dirname(existingPath);
            if (parentPath === existingPath) {
              throw error;
            }
            existingPath = parentPath;
            try {
              fs.lstatSync(existingPath);
              break;
            } catch (parentError) {
              const parentCode = (parentError as NodeJS.ErrnoException).code;
              if (parentCode !== 'ENOENT' && parentCode !== 'ENOTDIR') {
                throw parentError;
              }
            }
          }
          const realExistingPath = path.resolve(fs.realpathSync(existingPath));
          if (
            !getRealDependencyRoots().some((root) =>
              isPathInside(root, realExistingPath),
            )
          ) {
            throw new Error(
              `${source} resolved path must stay within the repository workspace`,
            );
          }
        }
        if (lexicalStats) {
          let realPath: string | undefined;
          try {
            realPath = path.resolve(fs.realpathSync(absolutePath));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              lexicalStats.isSymbolicLink() ||
              (code !== 'ENOENT' && code !== 'ENOTDIR')
            ) {
              throw new Error(`${source} resolved path cannot be verified`);
            }
          }
          if (
            realPath &&
            !getRealDependencyRoots().some((root) =>
              isPathInside(root, realPath),
            )
          ) {
            throw new Error(
              `${source} resolved path must stay within the repository workspace`,
            );
          }
        }

        return absolutePath;
      } catch (error) {
        if (String(error).includes('resolved path')) {
          requiresFullEvaluation = true;
        }
        core.warning(
          `Ignoring unsafe config dependency "${sanitizeLogText(filePath)}": ${sanitizeLogText(
            String(error).replace(/^(?:[A-Za-z]+)?Error: /, ''),
          )}`,
        );
        return undefined;
      }
    };

    const inspectTransitiveReference = (reference: string): void => {
      const rawPath = reference.startsWith('file://')
        ? reference.slice('file://'.length)
        : reference;
      if (
        !rawPath ||
        rawPath.length > maxGlobPatternLength ||
        /[\0\r\n]/.test(rawPath)
      ) {
        throw new Error('Invalid transitive Promptfoo config dependency');
      }
      const selectorIndex = rawPath.lastIndexOf(':');
      const candidatePath =
        selectorIndex > -1 ? rawPath.slice(0, selectorIndex) : rawPath;
      const filePath = TRANSITIVE_CONFIG_EXTENSION.test(rawPath)
        ? rawPath
        : TRANSITIVE_CONFIG_EXTENSION.test(candidatePath)
          ? candidatePath
          : undefined;
      if (!filePath) return;
      if (BINARY_TRANSITIVE_CONFIG_EXTENSION.test(filePath)) {
        throw new Error(
          'Binary Promptfoo test dependencies cannot be safely inspected',
        );
      }
      if (hasGlobMagic(filePath)) {
        throw new Error(
          'Dynamic transitive Promptfoo config dependencies cannot be safely inspected',
        );
      }
      const absolutePath = resolveConfigDependency(
        filePath,
        'transitive Promptfoo config dependency',
      );
      if (!absolutePath) {
        throw new Error('Unsafe transitive Promptfoo config dependency');
      }
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_TRANSITIVE_CONFIG_BYTES) {
        throw new Error(
          'Transitive Promptfoo config dependency exceeds the size limit',
        );
      }
      const contents = fs.readFileSync(absolutePath, 'utf8').toString();
      if (
        Buffer.byteLength(contents, 'utf8') > MAX_TRANSITIVE_CONFIG_BYTES ||
        contents.includes('file://') ||
        hasTransitiveNestedReference(contents)
      ) {
        throw new Error(
          'Nested transitive Promptfoo config dependencies require a full evaluation',
        );
      }
    };

    // Helper function to process file:// paths with glob support
    const processFileUrl = (fileUrl: string): void => {
      const filePath = fileUrl.replace('file://', '');
      if (filePath.length > maxGlobPatternLength) {
        throw new Error('Config file dependency pattern is too long');
      }
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      // Check if the path contains glob patterns
      if (hasGlobMagic(filePath)) {
        if (hasUnsafeGroupedGlob(filePath)) {
          throw new Error('Unsafe grouped config dependency pattern');
        }
        const braceGroups = filePath.match(/\{[^{}]*\}/g) ?? [];
        const openBraceCount = (filePath.match(/\{/g) ?? []).length;
        let braceExpansions = 1;
        if (openBraceCount !== braceGroups.length) {
          throw new Error('Nested config dependency brace patterns are unsafe');
        }
        for (const braceGroup of braceGroups) {
          braceExpansions *= braceGroup.split(',').length;
          if (braceExpansions > maxGlobBraceExpansions) {
            throw new Error('Config dependency brace expansion is too large');
          }
        }
        // A directory sentinel catches additions and deletions without an
        // eager repository-wide glob walk.
        const filePathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(filePathRoot.length).split(/[\\/]/);
        let basePath = filePathRoot;
        for (const part of pathParts) {
          if (hasGlobMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        const baseDirectory = resolveConfigDependency(
          basePath || '.',
          'config file dependency glob base',
        );
        if (baseDirectory) {
          dependencies.add(
            `${baseDirectory.replace(/[\\/]+$/, '')}${path.sep}`,
          );
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
        if (typeof provider === 'string') {
          for (const fileUrl of normalizeProviderFileUrls(provider)) {
            inspectTransitiveReference(fileUrl);
            if (
              TRANSITIVE_CONFIG_EXTENSION.test(fileUrl.slice('file://'.length))
            ) {
              throw new Error(
                'External Promptfoo provider configs require a full evaluation',
              );
            }
            processFileUrl(fileUrl);
          }
        } else if (
          typeof provider === 'object' &&
          provider !== null &&
          typeof provider.id === 'string'
        ) {
          for (const fileUrl of normalizeProviderFileUrls(provider.id)) {
            inspectTransitiveReference(fileUrl);
            if (
              TRANSITIVE_CONFIG_EXTENSION.test(fileUrl.slice('file://'.length))
            ) {
              throw new Error(
                'External Promptfoo provider configs require a full evaluation',
              );
            }
            processFileUrl(fileUrl);
          }
        }
      }
    }

    const processConfigReference = (reference: string): void => {
      inspectTransitiveReference(reference);
      processFileUrl(
        reference.startsWith('file://') ? reference : `file://${reference}`,
      );
    };

    const processHookReference = (reference: unknown): void => {
      if (typeof reference !== 'string' || !reference.startsWith('file://')) {
        return;
      }
      normalizedSelectorUrls.add(reference);
      for (const fileUrl of normalizeFileUrlSelectors(
        reference,
        /\.(?:js|cjs|mjs|ts|cts|mts|py)$/,
      )) {
        processFileUrl(fileUrl);
      }
    };

    const processNestedHookReferences = (value: unknown): void => {
      const pendingValues: unknown[] = [value];
      const visited = new WeakSet<object>();
      let inspected = 0;
      while (pendingValues.length > 0) {
        const current = pendingValues.pop();
        inspected++;
        if (inspected > MAX_NESTED_CONFIG_VALUES) {
          throw new Error(
            'Nested Promptfoo hook dependencies exceed the limit',
          );
        }
        if (typeof current === 'string') {
          processHookReference(current);
          continue;
        }
        if (typeof current !== 'object' || current === null) continue;
        if (visited.has(current)) {
          throw new Error(
            'Circular Promptfoo hook dependencies are unsupported',
          );
        }
        visited.add(current);
        pendingValues.push(...Object.values(current));
      }
    };

    const processProviderHooks = (provider: unknown): void => {
      if (typeof provider !== 'object' || provider === null) return;
      const record = provider as Record<string, unknown>;
      processHookReference(record.transform);
      const mapped =
        typeof record.id === 'string'
          ? record
          : Object.values(record).find(
              (value) => typeof value === 'object' && value !== null,
            );
      if (typeof mapped !== 'object' || mapped === null) return;
      processHookReference((mapped as Record<string, unknown>).transform);
    };

    for (const providers of [config.providers, config.targets]) {
      if (!providers) continue;
      for (const provider of providers) processProviderHooks(provider);
    }

    const isPromptReference = (reference: string): boolean => {
      if (
        !reference ||
        reference.length > maxGlobPatternLength ||
        reference.includes('\0')
      ) {
        throw new Error('Invalid Promptfoo prompt dependency');
      }
      if (
        ['\n', 'portkey://', 'langfuse://', 'helicone://'].some((value) =>
          reference.includes(value),
        )
      ) {
        return false;
      }
      if (reference.startsWith('file://') || reference.startsWith('exec:')) {
        return true;
      }
      const selectorIndex = reference.lastIndexOf(':');
      const candidate =
        selectorIndex > -1 ? reference.slice(0, selectorIndex) : reference;
      const extensionIndex = candidate.lastIndexOf('.');
      const extension =
        extensionIndex > -1 ? candidate.slice(extensionIndex + 1) : '';
      const hasExtension =
        extension.length > 0 && /^[A-Za-z0-9]+$/.test(extension);
      if (/[\\/*?{}[\]]/.test(reference)) {
        return !/\s/.test(reference) || /[\\/]/.test(reference) || hasExtension;
      }
      return hasExtension;
    };

    const processPromptReference = (reference: string): void => {
      if (!isPromptReference(reference)) {
        return;
      }
      let fileUrl = reference;
      if (reference.startsWith('file://')) {
        normalizedSelectorUrls.add(reference);
      }
      if (reference.startsWith('exec:')) {
        const executable = reference.slice('exec:'.length);
        if (/\s/.test(executable)) {
          throw new Error('Command-style Promptfoo exec prompts are unsafe');
        }
        fileUrl = executable.startsWith('file://')
          ? executable
          : `file://${executable}`;
      } else if (!reference.startsWith('file://')) {
        fileUrl = `file://${reference}`;
      }
      for (const normalizedFileUrl of normalizeFileUrlSelectors(
        fileUrl,
        /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
      )) {
        processFileUrl(normalizedFileUrl);
      }
    };

    // Extract prompt files
    if (typeof config.prompts === 'string') {
      processPromptReference(config.prompts);
    } else if (config.prompts) {
      const prompts = Array.isArray(config.prompts)
        ? config.prompts
        : Object.values(config.prompts);
      for (const prompt of prompts) {
        if (typeof prompt === 'string') {
          processPromptReference(prompt);
        } else if (typeof prompt === 'object' && prompt !== null) {
          for (const field of ['file', 'raw', 'id']) {
            const reference = prompt[field];
            if (typeof reference === 'string') {
              processPromptReference(reference);
            }
          }
        }
      }
    }

    // Extract test variable files
    const extractVarFiles = (vars?: unknown): void => {
      if (!vars) return;
      if (typeof vars === 'string') {
        processConfigReference(vars);
        return;
      }
      if (Array.isArray(vars)) {
        for (const value of vars) {
          if (typeof value !== 'string') {
            throw new Error('Invalid Promptfoo vars file dependency');
          }
          processConfigReference(value);
        }
        return;
      }
      if (typeof vars !== 'object') {
        throw new Error('Invalid Promptfoo vars file dependency');
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
    const inspectedAsserts = new WeakSet<object>();
    const extractAssertFiles = (asserts?: PromptfooAssertion[]): void => {
      if (!Array.isArray(asserts)) return;
      const pendingAsserts: unknown[] = [...asserts];
      for (let index = 0; index < pendingAsserts.length; index++) {
        const assert = pendingAsserts[index];
        if (
          typeof assert !== 'object' ||
          assert === null ||
          Array.isArray(assert) ||
          inspectedAsserts.has(assert)
        ) {
          continue;
        }
        inspectedAsserts.add(assert);
        const assertion = assert as PromptfooAssertion;
        if (
          typeof assertion.value === 'string' &&
          assertion.value.startsWith('file://')
        ) {
          for (const fileUrl of normalizeFileUrlSelectors(
            assertion.value,
            /\.(?:js|cjs|mjs|ts|cts|mts|py|rb)$/,
            false,
            true,
          )) {
            processFileUrl(fileUrl);
          }
        } else if (
          typeof assertion.value === 'object' &&
          assertion.value !== null &&
          'file' in assertion.value &&
          typeof assertion.value.file === 'string'
        ) {
          const absolutePath = resolveConfigDependency(
            assertion.value.file,
            'assertion file dependency',
          );
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
        if (
          assertion.type === 'assert-set' &&
          Array.isArray(assertion.assert)
        ) {
          pendingAsserts.push(...assertion.assert);
        }
        for (const field of ['transform', 'contextTransform']) {
          processHookReference((assertion as Record<string, unknown>)[field]);
        }
        if ('provider' in assertion) {
          processProviderHooks((assertion as Record<string, unknown>).provider);
        }
        if ('rubricPrompt' in assertion) {
          processNestedHookReferences(
            (assertion as Record<string, unknown>).rubricPrompt,
          );
        }
      }
    };

    // Process defaultTest
    if (typeof config.defaultTest === 'string') {
      processConfigReference(config.defaultTest);
    } else if (config.defaultTest) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
      const defaultTest = config.defaultTest as Record<string, unknown>;
      processHookReference(defaultTest.assertScoringFunction);
      processProviderHooks(defaultTest.provider);
      if (typeof defaultTest.options === 'object' && defaultTest.options) {
        const options = defaultTest.options as Record<string, unknown>;
        for (const field of ['postprocess', 'transform', 'transformVars']) {
          processHookReference(options[field]);
        }
        processProviderHooks(options.provider);
        processNestedHookReferences(options.rubricPrompt);
      }
    }

    const processTestInputs = (tests: unknown): void => {
      if (typeof tests === 'string') {
        processConfigReference(tests);
        return;
      }
      const testEntries = Array.isArray(tests) ? tests : [tests];
      for (const test of testEntries) {
        if (typeof test === 'string') {
          processConfigReference(test);
          continue;
        }
        if (typeof test !== 'object' || test === null) {
          throw new Error('Invalid Promptfoo test dependency');
        }
        const testRecord = test as Record<string, unknown>;
        if (typeof testRecord.path === 'string') {
          const rawPath = testRecord.path.startsWith('file://')
            ? testRecord.path
            : `file://${testRecord.path}`;
          normalizedSelectorUrls.add(rawPath);
          for (const fileUrl of normalizeFileUrlSelectors(
            rawPath,
            /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
          )) {
            processFileUrl(fileUrl);
          }
        }
        extractVarFiles(testRecord.vars as unknown);
        extractAssertFiles(
          testRecord.assert as PromptfooAssertion[] | undefined,
        );
        processHookReference(testRecord.assertScoringFunction);
        processProviderHooks(testRecord.provider);
        processNestedHookReferences(testRecord.config);
        if (typeof testRecord.options === 'object' && testRecord.options) {
          const options = testRecord.options as Record<string, unknown>;
          for (const field of ['postprocess', 'transform', 'transformVars']) {
            processHookReference(options[field]);
          }
          processProviderHooks(options.provider);
          processNestedHookReferences(options.rubricPrompt);
        }
      }
    };

    if (config.tests !== undefined) {
      processTestInputs(config.tests);
    }
    if (config.scenarios !== undefined) {
      const scenarios = Array.isArray(config.scenarios)
        ? config.scenarios
        : [config.scenarios];
      for (const scenario of scenarios) {
        if (typeof scenario === 'string') {
          processConfigReference(scenario);
          continue;
        }
        if (typeof scenario !== 'object' || scenario === null) {
          throw new Error('Invalid Promptfoo scenario dependency');
        }
        const scenarioRecord = scenario as Record<string, unknown>;
        if (scenarioRecord.tests !== undefined) {
          processTestInputs(scenarioRecord.tests);
        }
        if (scenarioRecord.config !== undefined) {
          processTestInputs(scenarioRecord.config);
        }
      }
    }
    if (config.nunjucksFilters !== undefined) {
      if (
        typeof config.nunjucksFilters !== 'object' ||
        config.nunjucksFilters === null ||
        Array.isArray(config.nunjucksFilters)
      ) {
        throw new Error('Invalid Promptfoo Nunjucks filter dependency');
      }
      for (const filter of Object.values(config.nunjucksFilters)) {
        if (typeof filter !== 'string') {
          throw new Error('Invalid Promptfoo Nunjucks filter dependency');
        }
        processConfigReference(filter);
      }
    }

    if (config.extensions !== undefined) {
      if (!Array.isArray(config.extensions)) {
        throw new Error('Invalid Promptfoo extension dependency');
      }
      for (const extension of config.extensions) {
        if (typeof extension !== 'string') {
          throw new Error('Invalid Promptfoo extension dependency');
        }
        processHookReference(extension);
      }
    }

    for (const fileUrl of nestedFileUrls) {
      if (!normalizedSelectorUrls.has(fileUrl)) {
        processFileUrl(fileUrl);
      }
    }
    for (const filePath of nestedFilePaths) {
      const absolutePath = resolveConfigDependency(
        filePath,
        'referenced file dependency',
      );
      if (absolutePath) {
        dependencies.add(absolutePath);
      }
    }

    // Convert absolute paths back to relative paths from working directory
    if (isPathInside(cwd, configDir)) {
      for (const configName of ['promptfooconfig', 'redteam']) {
        for (const extension of [
          'yaml',
          'yml',
          'json',
          'cjs',
          'cts',
          'js',
          'mjs',
          'mts',
          'ts',
        ]) {
          const implicitConfig = path.resolve(
            resolvedWorkingDirectory,
            `${configName}.${extension}`,
          );
          if (implicitConfig !== lexicalConfigPath) {
            addSafeDependency(
              implicitConfig,
              resolvedWorkingDirectory,
              'Implicit Promptfoo config',
            );
          }
        }
      }
    }

    if (requiresFullEvaluation) {
      return ['./'];
    }

    // Convert absolute paths back to repository-relative paths.
    return Array.from(dependencies).map((dep) => {
      const relativePath = path.relative(cwd, dep);
      if (relativePath === '') {
        return './';
      }
      const repositoryPath = relativePath.split(path.sep).join('/');
      // Preserve trailing slash for directories
      if (/[\\/]$/.test(dep) && !repositoryPath.endsWith('/')) {
        return `${repositoryPath}/`;
      }
      return repositoryPath;
    });
  } catch (error) {
    core.warning(
      `Failed to extract dependencies from config: ${sanitizeLogText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return ['./'];
  }
}
