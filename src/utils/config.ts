import * as core from '@actions/core';
import * as fs from 'fs';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import * as path from 'path';
import { ErrorCodes, PromptfooActionError } from './errors';

export interface PromptfooConfig {
  providers?:
    | string
    | { id?: string; [key: string]: unknown }
    | Array<string | { id?: string; [key: string]: unknown }>;
  targets?:
    | string
    | { id?: string; [key: string]: unknown }
    | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: string | Array<string | { file?: string; [key: string]: unknown }>;
  tests?:
    | string
    | Array<
        | string
        | {
            path?: string;
            vars?: { [key: string]: string | { file?: string } };
            assert?: Array<{
              type?: string;
              value?: string | { file?: string };
            }>;
            [key: string]: unknown;
          }
      >;
  defaultTest?:
    | string
    | {
        vars?: { [key: string]: string | { file?: string } };
        assert?: Array<{ type?: string; value?: string | { file?: string } }>;
      };
  scenarios?: unknown;
  nunjucksFilters?: { [key: string]: string };
  extensions?: unknown;
}

const MAX_DEPENDENCY_PATH_LENGTH = 65536;
const MAX_ASSERTION_DEPTH = 128;
const MAX_NESTED_CONFIG_VALUES = 100000;
const MAX_TRANSITIVE_CONFIG_BYTES = 1024 * 1024;
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
const UNSAFE_PATH_CHARACTERS = /[\0\r\n]/;
const PROVIDER_EXTENSION = /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/;
const ASSERT_EXTENSION = /\.(?:js|cjs|mjs|ts|cts|mts|py|rb)$/;
const AUTH_EXTENSION = /\.(?:js|cjs|mjs|ts|cts|mts|py)$/;
const HTTP_EXTENSION = /\.(?:js|cjs|mjs|ts|cts|mts)$/;
const JS_EXTENSION_CASE_INSENSITIVE = /\.(?:js|cjs|mjs|ts|cts|mts)$/i;

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

function hasUnsafeGroupedGlob(value: string): boolean {
  const closingDelimiters: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (path.sep === '/' && character === '\\') {
      index++;
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
      character === closingDelimiters[closingDelimiters.length - 1]
    ) {
      closingDelimiters.pop();
      continue;
    }
    if (
      closingDelimiters.length > 0 &&
      (character === '/' ||
        (path.sep !== '/' && character === '\\') ||
        (character === '.' && value[index + 1] === '.'))
    ) {
      return true;
    }
  }
  return closingDelimiters.length > 0;
}

function unescapePosixGlobLiterals(value: string): string {
  return path.sep === '/'
    ? value.replace(/\\([*?[\]{}()@+!\\])/g, '$1')
    : value;
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

function resolvePhysicalPath(targetPath: string): string {
  let existingPath = targetPath;
  while (true) {
    try {
      fs.lstatSync(existingPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        throw error;
      }
      existingPath = parentPath;
    }
  }

  const realExistingPath = fs.realpathSync(existingPath).toString();
  return path.resolve(
    realExistingPath,
    path.relative(existingPath, targetPath),
  );
}

/** Extracts repository-local file dependencies from a Promptfoo config. */
export function extractFileDependencies(configPath: string): string[] {
  const dependencies = new Set<string>();
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  let requiresFullEvaluation = false;

  let physicalConfigDir: string;
  let physicalCwd: string;
  let physicalConfigPath: string;
  try {
    physicalConfigDir = resolvePhysicalPath(configDir);
    physicalCwd = resolvePhysicalPath(cwd);
    physicalConfigPath = resolvePhysicalPath(configPath);
  } catch {
    throw new PromptfooActionError(
      'Invalid config directory: the config must stay within the working directory.',
      ErrorCodes.INVALID_CONFIGURATION,
      'Use a readable config file and directory within the working directory.',
    );
  }
  if (
    isPathInside(cwd, configDir) &&
    (!isPathInside(physicalCwd, physicalConfigDir) ||
      !isPathInside(physicalCwd, physicalConfigPath))
  ) {
    throw new PromptfooActionError(
      'Invalid config directory: the config must stay within the working directory.',
      ErrorCodes.INVALID_CONFIGURATION,
      'Use a readable config file and directory within the working directory.',
    );
  }

  const markUnsafeDependency = (): void => {
    if (!requiresFullEvaluation) {
      core.warning(
        'Ignoring an unsafe config dependency; running a full evaluation.',
      );
    }
    requiresFullEvaluation = true;
  };

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

    const resolveConfigDependency = (filePath: string): string | undefined => {
      if (
        !filePath ||
        filePath.length > MAX_DEPENDENCY_PATH_LENGTH ||
        UNSAFE_PATH_CHARACTERS.test(filePath) ||
        path.isAbsolute(filePath) ||
        path.win32.isAbsolute(filePath)
      ) {
        markUnsafeDependency();
        return undefined;
      }

      const absolutePath = path.resolve(path.join(configDir, filePath));
      if (!isPathInside(dependencyRoot, absolutePath)) {
        markUnsafeDependency();
        return undefined;
      }

      try {
        const physicalPath = resolvePhysicalPath(absolutePath);
        const allowedRoots = [physicalConfigDir, physicalCwd];
        if (!allowedRoots.some((root) => isPathInside(root, physicalPath))) {
          markUnsafeDependency();
          return undefined;
        }
      } catch {
        markUnsafeDependency();
        return undefined;
      }

      return absolutePath;
    };

    const addDirectoryDependency = (directoryPath: string): void => {
      dependencies.add(`${directoryPath.replace(/[\\/]+$/, '')}${path.sep}`);
    };

    const processFilePath = (filePath: string): void => {
      if (
        !filePath ||
        filePath.length > MAX_DEPENDENCY_PATH_LENGTH ||
        UNSAFE_PATH_CHARACTERS.test(filePath) ||
        filePath.includes('{{') ||
        filePath.includes('{%')
      ) {
        markUnsafeDependency();
        return;
      }

      if (hasGlobMagic(filePath)) {
        const pathParts =
          path.sep === '/' ? filePath.split('/') : filePath.split(/[\\/]/);
        const firstMagicPart = pathParts.findIndex(hasGlobMagic);
        const hasCrossDirectoryAlternative = hasUnsafeGroupedGlob(filePath);
        const hasParentAfterMagic = pathParts
          .slice(firstMagicPart)
          .some((part) => part === '..');
        if (hasCrossDirectoryAlternative || hasParentAfterMagic) {
          addDirectoryDependency(cwd);
          return;
        }
        const baseParts: string[] = [];
        for (const part of pathParts) {
          if (hasGlobMagic(part)) {
            break;
          }
          baseParts.push(part);
        }
        const basePath = resolveConfigDependency(
          baseParts.length > 0 ? baseParts.join(path.sep) : '.',
        );
        if (basePath) {
          addDirectoryDependency(basePath);
        }
        return;
      }

      const absolutePath = resolveConfigDependency(
        unescapePosixGlobLiterals(filePath),
      );
      if (!absolutePath) {
        return;
      }

      try {
        if (fs.statSync(absolutePath).isDirectory()) {
          addDirectoryDependency(absolutePath);
          return;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          markUnsafeDependency();
          return;
        }
      }
      dependencies.add(absolutePath);
    };

    const processFileUrl = (
      fileUrl: string,
      selector: 'provider' | 'assert' | 'auth' | 'http' | 'literal' = 'literal',
    ): void => {
      const filePath = fileUrl.slice('file://'.length);
      if (
        !filePath ||
        filePath.length > MAX_DEPENDENCY_PATH_LENGTH ||
        UNSAFE_PATH_CHARACTERS.test(filePath)
      ) {
        markUnsafeDependency();
        return;
      }
      const selectorIndex =
        selector === 'assert'
          ? filePath.indexOf(':')
          : filePath.lastIndexOf(':');
      const candidatePath =
        selectorIndex > -1 &&
        (selector !== 'http' || selectorIndex < filePath.length - 1)
          ? filePath.slice(0, selectorIndex)
          : undefined;
      const extensionPattern =
        selector === 'provider'
          ? PROVIDER_EXTENSION
          : selector === 'assert'
            ? ASSERT_EXTENSION
            : selector === 'auth'
              ? AUTH_EXTENSION
              : selector === 'http'
                ? HTTP_EXTENSION
                : undefined;

      if (candidatePath && extensionPattern?.test(candidatePath)) {
        processFilePath(candidatePath);
        return;
      }
      if (
        candidatePath &&
        extensionPattern &&
        JS_EXTENSION_CASE_INSENSITIVE.test(candidatePath) &&
        !HTTP_EXTENSION.test(candidatePath)
      ) {
        processFilePath(filePath);
        processFilePath(candidatePath);
        return;
      }
      processFilePath(filePath);
    };

    const extractNestedFileReferences = (value: unknown): boolean => {
      const pending: unknown[] = [value];
      const visited = new WeakSet<object>();
      let processed = 0;
      while (pending.length > 0) {
        const current = pending.pop();
        processed++;
        if (processed > MAX_NESTED_CONFIG_VALUES) return true;
        if (typeof current === 'string' && current.startsWith('file://')) {
          processFileUrl(current, 'auth');
          continue;
        }
        if (typeof current !== 'object' || current === null) continue;
        if (visited.has(current)) return true;
        visited.add(current);
        pending.push(...Object.values(current));
      }
      return false;
    };

    const inspectTransitiveReference = (reference: string): void => {
      const rawPath = reference.startsWith('file://')
        ? reference.slice('file://'.length)
        : reference;
      if (
        !rawPath ||
        rawPath.length > MAX_DEPENDENCY_PATH_LENGTH ||
        UNSAFE_PATH_CHARACTERS.test(rawPath)
      ) {
        markUnsafeDependency();
        return;
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
        markUnsafeDependency();
        return;
      }
      if (hasGlobMagic(filePath)) {
        markUnsafeDependency();
        return;
      }

      const absolutePath = resolveConfigDependency(filePath);
      if (!absolutePath) return;
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > MAX_TRANSITIVE_CONFIG_BYTES) {
          markUnsafeDependency();
          return;
        }
        const contents = fs.readFileSync(absolutePath, 'utf8').toString();
        if (
          Buffer.byteLength(contents, 'utf8') > MAX_TRANSITIVE_CONFIG_BYTES ||
          contents.includes('file://') ||
          hasTransitiveNestedReference(contents)
        ) {
          markUnsafeDependency();
        }
      } catch {
        markUnsafeDependency();
      }
    };

    const processHttpProvider = (
      providerId: string,
      providerConfig: unknown,
    ): void => {
      const dynamicProviderId =
        providerId.includes('{{') || providerId.includes('{%');
      if (
        (!/^https?(?::|$)/.test(providerId) && !dynamicProviderId) ||
        typeof providerConfig !== 'object' ||
        providerConfig === null
      ) {
        return;
      }

      const httpConfig = providerConfig as Record<string, unknown>;
      if (extractNestedFileReferences(httpConfig.body)) {
        markUnsafeDependency();
      }
      const processRawReference = (reference: unknown): void => {
        if (typeof reference !== 'string') return;
        processFilePath(reference);
      };

      if (
        typeof httpConfig.validateStatus === 'string' &&
        httpConfig.validateStatus.startsWith('file://')
      ) {
        processFileUrl(httpConfig.validateStatus, 'http');
      }

      for (const field of [
        'transformRequest',
        'transformResponse',
        'responseParser',
        'sessionParser',
      ]) {
        const reference = httpConfig[field];
        if (typeof reference === 'string' && reference.startsWith('file://')) {
          processFileUrl(reference, 'http');
        }
      }
      const session = httpConfig.session;
      if (
        typeof session === 'object' &&
        session !== null &&
        typeof (session as Record<string, unknown>).responseParser ===
          'string' &&
        (
          (session as Record<string, unknown>).responseParser as string
        ).startsWith('file://')
      ) {
        processFileUrl(
          (session as Record<string, unknown>).responseParser as string,
          'http',
        );
      }

      const auth = httpConfig.auth;
      const authType =
        typeof auth === 'object' && auth !== null
          ? (auth as Record<string, unknown>).type
          : undefined;
      if (
        typeof auth === 'object' &&
        auth !== null &&
        (authType === 'file' ||
          (typeof authType === 'string' &&
            (authType.includes('{{') || authType.includes('{%'))))
      ) {
        const authPath = (auth as Record<string, unknown>).path;
        if (typeof authPath === 'string' && authPath.startsWith('file://')) {
          processFileUrl(authPath, 'auth');
        } else {
          processRawReference(authPath);
        }
      }

      const processPathFields = (value: unknown, fields: string[]): void => {
        if (typeof value !== 'object' || value === null) return;
        const paths = value as Record<string, unknown>;
        for (const field of fields) processRawReference(paths[field]);
      };
      processPathFields(httpConfig.tls, [
        'caPath',
        'certPath',
        'keyPath',
        'pfxPath',
        'jksPath',
      ]);
      processPathFields(httpConfig.signatureAuth, [
        'privateKeyPath',
        'keystorePath',
        'pfxPath',
        'certPath',
        'keyPath',
      ]);

      const multipart = httpConfig.multipart;
      if (typeof multipart === 'object' && multipart !== null) {
        const parts = (multipart as Record<string, unknown>).parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part !== 'object' || part === null) continue;
            const partRecord = part as Record<string, unknown>;
            const source = partRecord.source;
            if (typeof source !== 'object' || source === null) continue;
            const sourceRecord = source as Record<string, unknown>;
            const kind = partRecord.kind;
            const sourceType = sourceRecord.type;
            const dynamicKind =
              typeof kind === 'string' &&
              (kind.includes('{{') || kind.includes('{%'));
            const dynamicSourceType =
              typeof sourceType === 'string' &&
              (sourceType.includes('{{') || sourceType.includes('{%'));
            if (
              kind === 'file' ||
              sourceType === 'path' ||
              dynamicKind ||
              dynamicSourceType
            ) {
              const sourcePath = sourceRecord.path;
              if (
                typeof sourcePath === 'string' &&
                sourcePath.startsWith('file://')
              ) {
                processFileUrl(sourcePath);
              } else {
                processRawReference(sourcePath);
              }
            }
          }
        }
      }
    };

    const processProviderId = (providerId: string): void => {
      if (providerId.startsWith('file://')) {
        processFileUrl(providerId, 'provider');
        inspectTransitiveReference(providerId);
        if (
          TRANSITIVE_CONFIG_EXTENSION.test(providerId.slice('file://'.length))
        ) {
          markUnsafeDependency();
        }
        return;
      }
      if (providerId.startsWith('exec:')) {
        const executable = providerId.slice('exec:'.length);
        if (executable.startsWith('file://')) {
          processFileUrl(executable, 'provider');
        } else if (/\s/.test(executable)) {
          markUnsafeDependency();
        } else {
          processFilePath(executable);
        }
        return;
      }
      for (const prefix of ['python:', 'golang:', 'ruby:']) {
        if (providerId.startsWith(prefix)) {
          processFileUrl(
            `file://${providerId.slice(prefix.length)}`,
            'provider',
          );
          return;
        }
      }
      if (JS_EXTENSION_CASE_INSENSITIVE.test(providerId)) {
        processFilePath(providerId);
      }
    };

    const processProvider = (provider: unknown): void => {
      if (typeof provider === 'string') {
        processProviderId(provider);
        return;
      }
      if (typeof provider !== 'object' || provider === null) {
        return;
      }

      const record = provider as Record<string, unknown>;
      const scanProviderConfig = (
        providerId: string,
        config: unknown,
      ): void => {
        if (typeof config !== 'object' || config === null) return;
        const knownHttpFields = new Set([
          'validateStatus',
          'transformRequest',
          'transformResponse',
          'responseParser',
          'sessionParser',
          'session',
          'auth',
          'tls',
          'signatureAuth',
          'body',
        ]);
        for (const [field, value] of Object.entries(config)) {
          if (
            (!/^https?(?::|$)/.test(providerId) ||
              !knownHttpFields.has(field)) &&
            extractNestedFileReferences(value)
          ) {
            markUnsafeDependency();
            return;
          }
        }
      };
      const processTransform = (value: unknown): void => {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value, 'auth');
        }
      };
      if (typeof record.id === 'string') {
        processProviderId(record.id);
        processTransform(record.transform);
        scanProviderConfig(record.id, record.config);
        processHttpProvider(record.id, record.config);
        return;
      }

      const providerEntries = Object.entries(record);
      if (providerEntries.length !== 1) {
        return;
      }
      const [providerId, providerOptions] = providerEntries[0];
      processProviderId(providerId);
      if (typeof providerOptions !== 'object' || providerOptions === null) {
        return;
      }
      const options = providerOptions as Record<string, unknown>;
      processTransform(options.transform);
      scanProviderConfig(providerId, options.config);
      processHttpProvider(providerId, options.config);
    };

    for (const configuredProviders of [config.providers, config.targets]) {
      if (!configuredProviders) continue;
      const providers = Array.isArray(configuredProviders)
        ? configuredProviders
        : [configuredProviders];
      for (const provider of providers) processProvider(provider);
    }

    const processConfigReference = (
      reference: string,
      selector: 'auth' | 'literal' = 'literal',
    ): void => {
      inspectTransitiveReference(reference);
      if (reference.startsWith('file://')) {
        processFileUrl(reference, selector);
      } else if (selector === 'auth') {
        processFileUrl(`file://${reference}`, selector);
      } else {
        processFilePath(reference);
      }
    };

    const processPromptReference = (reference: string): void => {
      if (reference.startsWith('exec:')) {
        const executable = reference.slice('exec:'.length);
        if (executable.startsWith('file://')) {
          processFileUrl(executable, 'provider');
        } else if (/\s/.test(executable)) {
          markUnsafeDependency();
        } else {
          processFilePath(executable);
        }
        return;
      }
      processFileUrl(
        reference.startsWith('file://') ? reference : `file://${reference}`,
        'provider',
      );
    };

    const isPromptReference = (reference: string): boolean => {
      if (
        !reference ||
        reference.length > MAX_DEPENDENCY_PATH_LENGTH ||
        UNSAFE_PATH_CHARACTERS.test(reference)
      ) {
        markUnsafeDependency();
        return false;
      }
      if (reference.includes('{{') || reference.includes('{%')) {
        return reference.includes('file://');
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

    if (typeof config.prompts === 'string') {
      processPromptReference(config.prompts);
    } else if (config.prompts) {
      for (const prompt of config.prompts) {
        if (typeof prompt === 'string') {
          if (isPromptReference(prompt)) {
            processPromptReference(prompt);
          }
        } else if (typeof prompt === 'object' && prompt !== null) {
          for (const field of ['file', 'raw', 'id']) {
            const reference = prompt[field];
            if (typeof reference === 'string' && isPromptReference(reference)) {
              processPromptReference(reference);
            }
          }
          if (
            'config' in prompt &&
            extractNestedFileReferences(prompt.config)
          ) {
            markUnsafeDependency();
          }
        }
      }
    }

    const extractVarFiles = (vars?: unknown): void => {
      if (!vars) return;
      if (typeof vars === 'string') {
        processConfigReference(vars);
        return;
      }
      if (Array.isArray(vars)) {
        for (const value of vars) {
          if (typeof value === 'string') {
            processConfigReference(value);
          } else {
            markUnsafeDependency();
          }
        }
        return;
      }
      if (typeof vars !== 'object') {
        markUnsafeDependency();
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
          const absolutePath = resolveConfigDependency(value.file);
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
      }
    };

    const visitedAssertions = new WeakSet<object>();
    const extractAssertFiles = (asserts?: unknown, depth = 0): void => {
      if (!asserts) return;
      if (
        !Array.isArray(asserts) ||
        depth > MAX_ASSERTION_DEPTH ||
        visitedAssertions.has(asserts)
      ) {
        markUnsafeDependency();
        return;
      }
      visitedAssertions.add(asserts);
      for (const assert of asserts) {
        if (typeof assert !== 'object' || assert === null) {
          markUnsafeDependency();
          continue;
        }
        if (
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processFileUrl(assert.value, 'assert');
        } else if (
          typeof assert.value === 'object' &&
          assert.value !== null &&
          'file' in assert.value &&
          typeof assert.value.file === 'string'
        ) {
          const absolutePath = resolveConfigDependency(assert.value.file);
          if (absolutePath) {
            dependencies.add(absolutePath);
          }
        }
        if ('assert' in assert && assert.assert !== undefined) {
          extractAssertFiles(assert.assert, depth + 1);
        }
        for (const field of ['transform', 'contextTransform']) {
          const reference = assert[field];
          if (
            typeof reference === 'string' &&
            reference.startsWith('file://')
          ) {
            processFileUrl(reference, 'auth');
          }
        }
        if ('provider' in assert) processProvider(assert.provider);
        if (
          'rubricPrompt' in assert &&
          extractNestedFileReferences(assert.rubricPrompt)
        ) {
          markUnsafeDependency();
        }
      }
    };

    const processTestHooks = (test: Record<string, unknown>): void => {
      if ('provider' in test) processProvider(test.provider);
      if (
        typeof test.assertScoringFunction === 'string' &&
        test.assertScoringFunction.startsWith('file://')
      ) {
        processFileUrl(test.assertScoringFunction, 'auth');
      }
      const options = test.options;
      if (typeof options !== 'object' || options === null) return;
      const optionRecord = options as Record<string, unknown>;
      for (const field of ['postprocess', 'transform', 'transformVars']) {
        const reference = optionRecord[field];
        if (typeof reference === 'string' && reference.startsWith('file://')) {
          processFileUrl(reference, 'auth');
        }
      }
      if (
        'rubricPrompt' in optionRecord &&
        extractNestedFileReferences(optionRecord.rubricPrompt)
      ) {
        markUnsafeDependency();
      }
      if ('provider' in optionRecord) processProvider(optionRecord.provider);
    };

    if (typeof config.defaultTest === 'string') {
      processConfigReference(config.defaultTest);
    } else if (config.defaultTest) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
      processTestHooks(config.defaultTest);
    }
    const processTestInputs = (tests: unknown): void => {
      if (typeof tests === 'string') {
        processConfigReference(tests, 'auth');
        return;
      }
      if (!Array.isArray(tests)) {
        markUnsafeDependency();
        return;
      }
      for (const test of tests) {
        if (typeof test === 'string') {
          processConfigReference(test, 'auth');
          continue;
        }
        if (typeof test !== 'object' || test === null) {
          markUnsafeDependency();
          continue;
        }
        if ('path' in test && typeof test.path === 'string') {
          processConfigReference(test.path, 'auth');
          if ('config' in test && test.config !== undefined) {
            markUnsafeDependency();
          }
        }
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
        processTestHooks(test);
      }
    };

    if (config.tests) {
      processTestInputs(config.tests);
    }

    if (config.scenarios) {
      const scenarios = Array.isArray(config.scenarios)
        ? config.scenarios
        : [config.scenarios];
      for (const scenario of scenarios) {
        if (typeof scenario === 'string') {
          processConfigReference(scenario);
          continue;
        }
        if (typeof scenario !== 'object' || scenario === null) {
          markUnsafeDependency();
          continue;
        }
        if ('tests' in scenario && scenario.tests !== undefined) {
          processTestInputs(scenario.tests);
        }
        if ('config' in scenario && scenario.config !== undefined) {
          processTestInputs(scenario.config);
        }
      }
    }

    if (config.nunjucksFilters) {
      for (const filter of Object.values(config.nunjucksFilters)) {
        if (typeof filter === 'string') {
          processFilePath(filter);
        } else {
          markUnsafeDependency();
        }
      }
    }

    if (config.extensions) {
      if (!Array.isArray(config.extensions)) {
        markUnsafeDependency();
      } else {
        for (const extension of config.extensions) {
          if (
            typeof extension === 'string' &&
            extension.startsWith('file://')
          ) {
            processFileUrl(extension, 'auth');
          } else {
            markUnsafeDependency();
          }
        }
      }
    }

    if (requiresFullEvaluation) {
      return ['./'];
    }

    return Array.from(dependencies).map((dependency) => {
      const relativePath = path.relative(cwd, dependency);
      const repositoryPath = relativePath.split(path.sep).join('/');
      if (/[\\/]$/.test(dependency)) {
        return repositoryPath ? `${repositoryPath}/` : './';
      }
      return repositoryPath;
    });
  } catch {
    core.warning(
      'Failed to extract config dependencies safely; running a full evaluation.',
    );
    return ['./'];
  }
}
