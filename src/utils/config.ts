import * as core from '@actions/core';
import * as fs from 'fs';
import * as glob from 'glob';
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
  prompts?: Array<string | { file?: string; [key: string]: unknown }>;
  tests?: Array<{
    vars?: { [key: string]: string | { file?: string } };
    assert?: PromptfooAssertion[];
    [key: string]: unknown;
  }>;
  defaultTest?: {
    vars?: { [key: string]: string | { file?: string } };
    assert?: PromptfooAssertion[];
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

function sanitizeLogText(value: string): string {
  return value
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

  try {
    if (!isPathInside(cwd, resolvedWorkingDirectory)) {
      throw new Error(
        'Promptfoo working directory must stay within the repository workspace',
      );
    }
    if (
      configPath.length > maxGlobPatternLength ||
      isUnsupportedWindowsPath(configPath) ||
      glob.hasMagic(configPath, {
        magicalBraces: true,
        windowsPathsNoEscape: true,
      }) ||
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
    const httpFileAuthParents = new WeakSet<object>();
    const providerIdParents = new WeakSet<object>();
    const nestedFileUrls: string[] = [];
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
        if (next.value.startsWith('file://')) {
          nestedFileUrls.push(
            ...(next.context === 'general'
              ? [next.value]
              : normalizeFileUrlSelectors(
                  next.value,
                  next.context === 'assertion'
                    ? /\.(?:js|cjs|mjs|ts|cts|mts|py|rb)$/
                    : /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
                  false,
                  next.context === 'assertion',
                )),
          );
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
      const objectsForFile =
        inspectedObjects.get(next.file) ?? new WeakSet<object>();
      inspectedObjects.set(next.file, objectsForFile);
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
          if (typeof entry === 'string' && entry.startsWith('file://')) {
            nestedFileUrls.push(
              ...normalizeFileUrlSelectors(
                entry,
                /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
              ),
            );
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
              ([id]) => /^https?(?::|$)/i.test(id) || id.startsWith('file://'),
            );
            providerId = mappedProvider?.[0];
            const mappedValue = mappedProvider?.[1];
            providerConfig =
              typeof mappedValue === 'object' && mappedValue !== null
                ? (mappedValue as Record<string, unknown>).config
                : undefined;
          }
          if (
            typeof providerId === 'string' &&
            providerId.startsWith('file://')
          ) {
            nestedFileUrls.push(
              ...normalizeFileUrlSelectors(
                providerId,
                /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
              ),
            );
            if (provider.id === providerId) {
              providerIdParents.add(provider);
            }
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

          const auth = configRecord.auth;
          if (
            typeof auth === 'object' &&
            auth !== null &&
            (auth as Record<string, unknown>).type === 'file'
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
        const refKey = `${next.file}\0${record.$ref}`;
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
        try {
          lexicalStats = fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
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
        core.warning(
          `Ignoring unsafe config dependency "${sanitizeLogText(filePath)}": ${sanitizeLogText(
            String(error).replace(/^(?:[A-Za-z]+)?Error: /, ''),
          )}`,
        );
        return undefined;
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
      if (glob.hasMagic(filePath)) {
        const braceGroups = filePath.match(/\{[^{}]*\}/g) ?? [];
        const openBraceCount = (filePath.match(/\{/g) ?? []).length;
        let braceExpansions = 1;
        if (openBraceCount !== braceGroups.length) {
          throw new Error('Nested config dependency brace patterns are unsafe');
        }
        for (const braceGroup of braceGroups) {
          if (
            /^\{(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?\}$/.test(
              braceGroup,
            )
          ) {
            throw new Error('Config dependency brace ranges are unsafe');
          }
          braceExpansions *= braceGroup.split(',').length;
          if (braceExpansions > maxGlobBraceExpansions) {
            throw new Error('Config dependency brace expansion is too large');
          }
        }
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, { nodir: true });
        const realDependencyRoots = getRealDependencyRoots();
        for (const match of matches) {
          if (/[\r\n]/.test(match)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path contains an invalid line break',
            );
            continue;
          }
          const absoluteMatch = path.resolve(match);
          if (!isSafeDependency(absoluteMatch)) {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
            continue;
          }
          try {
            const realMatch = path.resolve(fs.realpathSync(absoluteMatch));
            if (
              !realDependencyRoots.some((root) => isPathInside(root, realMatch))
            ) {
              core.warning(
                'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
              );
              continue;
            }
            dependencies.add(absoluteMatch);
          } catch {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const filePathRoot = path.parse(filePath).root;
        const pathParts = filePath.slice(filePathRoot.length).split(/[\\/]/);
        let basePath = filePathRoot;
        for (const part of pathParts) {
          if (glob.hasMagic(part)) {
            break;
          }
          basePath = basePath ? path.join(basePath, part) : part;
        }
        const baseDirectory = path.resolve(configDir, basePath || '.');
        dependencies.add(`${baseDirectory.replace(/[\\/]+$/, '')}${path.sep}`);
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
          for (const fileUrl of normalizeFileUrlSelectors(
            provider,
            /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
          )) {
            processFileUrl(fileUrl);
          }
        } else if (
          typeof provider === 'object' &&
          provider.id?.startsWith('file://')
        ) {
          for (const fileUrl of normalizeFileUrlSelectors(
            provider.id,
            /\.(?:js|cjs|mjs|ts|cts|mts|py|go|rb)$/,
          )) {
            processFileUrl(fileUrl);
          }
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

    for (const fileUrl of nestedFileUrls) {
      processFileUrl(fileUrl);
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
