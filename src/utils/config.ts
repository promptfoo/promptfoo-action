import * as core from '@actions/core';
import { parse as parseCsv } from 'csv-parse/sync';
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
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { isDirectory } from './fs';

const MAX_BRACE_EXPANSIONS = 1024;

interface PromptfooTestConfig {
  path?: string;
  vars?: string | string[] | { [key: string]: string | { file?: string } };
  assert?: Array<{ type?: string; value?: string | { file?: string } }>;
  [key: string]: unknown;
}

export interface PromptfooConfig {
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?:
    | string
    | Record<string, string>
    | Array<string | { file?: string; [key: string]: unknown }>;
  tests?: string | PromptfooTestConfig | Array<string | PromptfooTestConfig>;
  defaultTest?: string | PromptfooTestConfig;
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

function stripNunjucksComments(value: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('{#', cursor);
    if (start === -1) {
      break;
    }
    const end = value.indexOf('#}', start + 2);
    if (end === -1) {
      break;
    }
    result += value.slice(cursor, start);
    cursor = end + 2;
  }
  return result + value.slice(cursor);
}

function expandEnvTemplates(filePath: string): string {
  return stripNunjucksComments(filePath)
    .replace(/\{%(?:[^%]|%(?!\}))*%\}/g, '**/*')
    .replace(/\{\{(?:[^}]|\}(?!\}))*\}\}/g, (template) =>
      /\benv\.|env\[/.test(template) ? '**/*' : template,
    );
}

function splitCsvAssertionValues(value: string): string[] | undefined {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];
    if (afterQuote) {
      if (/\s/.test(char)) {
        continue;
      }
      if (char !== ',') {
        return undefined;
      }
      values.push(current.trim());
      current = '';
      afterQuote = false;
    } else if (quoted && char === '\\' && next === '"') {
      current += '"';
      index++;
    } else if (quoted && char === '"' && next === '"') {
      current += '"';
      index++;
    } else if (char === '"') {
      if (!quoted && current.trim()) {
        return undefined;
      }
      quoted = !quoted;
      afterQuote = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (quoted) {
    return undefined;
  }
  values.push(current.trim());
  return values;
}

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(
  configPath: string,
  refResolutionRoot = process.cwd(),
): string[] {
  const dependencies = new Set<string>();
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const dependencyRoot = isPathInside(cwd, configDir) ? cwd : configDir;
  const isSafeDependency = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);

  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    if (!configContent.trim()) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const config = loadYaml(configContent, {
      schema: CORE_SCHEMA.withTags(
        mergeTag,
        binaryTag,
        timestampTag,
        omapTag,
        pairsTag,
        setTag,
      ),
    }) as PromptfooConfig;

    if (!config) {
      core.debug('Config file is empty or invalid');
      return [];
    }

    const expandAndTrackEnvTemplates = (filePath: string): string => {
      const uncommentedPath = stripNunjucksComments(filePath);
      const expandedPath = expandEnvTemplates(filePath);
      if (expandedPath !== uncommentedPath) {
        dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
      }
      return expandedPath;
    };

    const resolveConfigDependency = (
      filePath: string,
      source: string,
    ): string | undefined => {
      try {
        if (!filePath) {
          throw new Error(`${source} is empty`);
        }
        return path.resolve(configDir, filePath);
      } catch (error) {
        core.warning(
          `Ignoring unsafe config dependency "${filePath}": ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process local paths with glob support
    const processFilePath = (
      filePath: string,
      source = 'config file dependency',
      preserveGlobRoot = false,
      windowsPathsNoEscape = false,
    ): string[] => {
      if (filePath.includes('\0')) {
        core.warning(
          `Ignoring unsafe config dependency "${filePath}": ${source} contains an invalid null byte`,
        );
        return [];
      }
      const normalizedPath = windowsPathsNoEscape
        ? filePath.replace(/\\/g, path.sep)
        : filePath;
      const globOptions = {
        magicalBraces: true,
        braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
        ...(windowsPathsNoEscape ? { windowsPathsNoEscape: true } : {}),
      };
      let isGlob: boolean;
      let expandedPaths: string[];
      try {
        isGlob = glob.hasMagic(normalizedPath, globOptions);
        expandedPaths = isGlob
          ? braceExpand(normalizedPath, {
              braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
            })
          : [normalizedPath];
      } catch (error) {
        dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
        core.warning(
          `Failed to parse config dependency glob (${source}): ${error instanceof Error ? error.message : String(error)}; conservatively watching the dependency root`,
        );
        return [];
      }
      if (expandedPaths.length > MAX_BRACE_EXPANSIONS) {
        dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
        core.warning(
          'Skipping config dependency glob with too many brace alternatives; conservatively watching the dependency root',
        );
        return [];
      }
      const hasParentAlternative = expandedPaths.some((expandedPath) =>
        /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(expandedPath),
      );
      if (
        expandedPaths.some((expandedPath) => {
          const traversalPath = expandedPath.replace(/\[\.\]/g, '.');
          return !isSafeDependency(path.resolve(configDir, traversalPath));
        })
      ) {
        core.warning(
          `Ignoring unsafe config dependency "${normalizedPath}": ${source} must stay within the repository workspace`,
        );
        return [];
      }
      const absolutePath = resolveConfigDependency(normalizedPath, source);
      if (!absolutePath) {
        return [];
      }

      // Check if the path contains glob patterns
      if (isGlob) {
        // It's a glob pattern, expand it
        const matches = glob.sync(absolutePath, {
          nodir: true,
          ...globOptions,
          braceExpandMax: MAX_BRACE_EXPANSIONS,
        });
        const safeMatches: string[] = [];
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          let realDependencyRoot: string;
          let realCwd: string;
          let realMatch: string;
          try {
            realDependencyRoot = fs.realpathSync(dependencyRoot);
            realCwd = fs.realpathSync(cwd);
            realMatch = fs.realpathSync(absoluteMatch);
          } catch {
            core.warning(
              'Ignoring unsafe config dependency glob match: resolved path cannot be verified',
            );
            continue;
          }
          if (
            isSafeDependency(absoluteMatch) &&
            (isPathInside(realDependencyRoot, realMatch) ||
              isPathInside(realCwd, realMatch))
          ) {
            dependencies.add(absoluteMatch);
            safeMatches.push(absoluteMatch);
          } else {
            core.warning(
              'Ignoring unsafe config dependency glob match: config file dependency glob match must stay within the repository workspace',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        const initialGlobRoot = path.isAbsolute(normalizedPath)
          ? path.parse(absolutePath).root
          : configDir;
        const pathParts = path
          .relative(initialGlobRoot, absolutePath)
          .split(/[\\/]/);
        let globRoot = initialGlobRoot;
        for (const part of pathParts) {
          if (glob.hasMagic(part, globOptions) || /[{}]/.test(part)) {
            break;
          }
          globRoot = path.join(globRoot, part);
        }
        if (
          (globRoot === dependencyRoot || hasParentAlternative) &&
          !dependencies.has(
            `${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          )
        ) {
          dependencies.add(absolutePath);
        } else if (globRoot !== initialGlobRoot || preserveGlobRoot) {
          dependencies.add(
            preserveGlobRoot
              ? `${globRoot.replace(/[\\/]+$/, '')}${path.sep}`
              : globRoot,
          );
        }
        return safeMatches;
      } else if (isDirectory(absolutePath)) {
        // It's a directory, preserve trailing slash if it was there
        const directoryPath = filePath.endsWith('/')
          ? `${absolutePath.replace(/[\\/]+$/, '')}${path.sep}`
          : absolutePath;
        dependencies.add(directoryPath);
      } else {
        // It's a regular file path
        dependencies.add(absolutePath);
      }

      return [absolutePath];
    };

    const processFileUrl = (
      fileUrl: string,
      preserveGlobRoot = false,
      baseDir = configDir,
      isProvider = false,
    ): void => {
      let filePath = fileUrl.replace(/^file:\/\//, '');
      const expandedPath = expandAndTrackEnvTemplates(filePath);
      const hasEnvTemplate = expandedPath !== filePath;
      filePath = expandedPath;
      const functionIndex = filePath.lastIndexOf(':');
      if (
        functionIndex > 1 &&
        (/\.(?:py|rb|[cm]?[jt]s)$/i.test(filePath.slice(0, functionIndex)) ||
          (isProvider &&
            /\.(?:go|rb)$/i.test(filePath.slice(0, functionIndex))))
      ) {
        filePath = filePath.slice(0, functionIndex);
      }
      if (baseDir !== configDir) {
        filePath = path.relative(configDir, path.resolve(baseDir, filePath));
      }
      processFilePath(
        filePath,
        'config file dependency',
        preserveGlobRoot || hasEnvTemplate,
        preserveGlobRoot || hasEnvTemplate,
      );
    };

    const providerConfigFiles = new Set<string>();
    const providerConfigs: Array<{ [key: string]: unknown }> = [];
    const processProviderFile = (providerId: string): void => {
      const expandedProviderId = expandAndTrackEnvTemplates(providerId);
      if (expandedProviderId.startsWith('exec:')) {
        dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
        return;
      }
      const localProvider = expandedProviderId.match(
        /^(?:file:\/\/|python:(?=[\s\S]+\.py(?::[^/\\]+)?$)|golang:(?=[\s\S]+\.go(?::[^/\\]+)?$)|ruby:(?=[\s\S]+\.rb(?::[^/\\]+)?$))([\s\S]+)$/i,
      );
      if (!localProvider) {
        return;
      }
      const providerPath = localProvider[1];
      processFileUrl(`file://${providerPath}`, false, configDir, true);
      const absolutePath = path.resolve(configDir, providerPath);
      if (
        /\.(?:ya?ml|json)$/i.test(providerPath) &&
        isSafeDependency(absolutePath)
      ) {
        providerConfigFiles.add(absolutePath);
      }
    };

    // Extract provider files
    const configuredProviders = config.targets || config.providers;
    if (configuredProviders) {
      const providers = Array.isArray(configuredProviders)
        ? configuredProviders
        : [configuredProviders];
      for (const provider of providers) {
        if (typeof provider === 'string') {
          processProviderFile(provider);
        } else if (typeof provider === 'object' && provider !== null) {
          const providerId =
            typeof provider.id === 'string'
              ? provider.id
              : Object.keys(provider)[0];
          if (typeof providerId === 'string') {
            processProviderFile(providerId);
          }
          const providerOptions = providerId ? provider[providerId] : undefined;
          providerConfigs.push(
            typeof provider.id === 'string' ||
              typeof providerOptions !== 'object' ||
              providerOptions === null
              ? provider
              : { ...providerOptions, id: providerId },
          );
        }
      }
    }

    // Extract prompt files
    if (config.prompts) {
      const prompts = Array.isArray(config.prompts)
        ? config.prompts
        : typeof config.prompts === 'string'
          ? [config.prompts]
          : Object.keys(config.prompts);
      for (const prompt of prompts) {
        const promptPath =
          typeof prompt === 'string'
            ? prompt
            : typeof prompt.raw === 'string'
              ? prompt.raw
              : typeof prompt.id === 'string'
                ? prompt.id
                : typeof prompt.file === 'string'
                  ? prompt.file
                  : undefined;
        if (!promptPath) {
          continue;
        }
        const expandedPromptPath = expandAndTrackEnvTemplates(promptPath);
        if (
          expandedPromptPath === '**/*' ||
          /(?:\n|portkey:\/\/|langfuse:\/\/|helicone:\/\/)/i.test(
            expandedPromptPath,
          ) ||
          !(
            expandedPromptPath.startsWith('file://') ||
            /\.(?:cjs|cts|j2|js|jsonl?|md|mjs|mts|py|ts|txt|ya?ml)(?::[^/\\]+)?$/i.test(
              expandedPromptPath,
            ) ||
            /[*/\\]/.test(expandedPromptPath) ||
            expandedPromptPath.charAt(expandedPromptPath.length - 3) === '.' ||
            expandedPromptPath.charAt(expandedPromptPath.length - 4) === '.'
          )
        ) {
          continue;
        }
        processFileUrl(
          `file://${expandedPromptPath.replace(/^file:\/\//, '')}`,
        );
      }
    }

    // Extract test variable files
    const extractVarFiles = (
      vars?: string | string[] | { [key: string]: unknown },
      baseDir = configDir,
    ): void => {
      if (!vars) return;
      if (typeof vars === 'string' || Array.isArray(vars)) {
        const varFiles = Array.isArray(vars) ? vars : [vars];
        for (let varFile of varFiles) {
          if (typeof varFile !== 'string') {
            continue;
          }
          let varBaseDir = baseDir;
          if (varFile.startsWith('file://')) {
            varFile = varFile.slice('file://'.length);
            varBaseDir = configDir;
          } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(varFile)) {
            continue;
          }
          const relativeVarFile = path.relative(
            configDir,
            path.resolve(varBaseDir, varFile),
          );
          for (const resolvedVarFile of processFilePath(
            expandAndTrackEnvTemplates(relativeVarFile),
            'test variable file dependency',
            true,
            true,
          )) {
            if (!/\.(?:csv|jsonl)$/i.test(resolvedVarFile)) {
              inspectTestFile(resolvedVarFile, refResolutionRoot, varBaseDir);
            }
          }
        }
        return;
      }
      for (const value of Object.values(vars)) {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value, true);
        } else if (
          typeof value === 'object' &&
          value !== null &&
          'file' in value &&
          typeof value.file === 'string'
        ) {
          processFilePath(
            expandAndTrackEnvTemplates(value.file),
            'test variable file dependency',
            true,
            true,
          );
        }
      }
    };

    // Extract assert files
    const extractAssertFiles = (
      asserts?: Array<{ type?: string; value?: unknown }>,
    ): void => {
      if (!Array.isArray(asserts)) return;
      for (const assert of asserts) {
        if (typeof assert !== 'object' || assert === null) {
          continue;
        }
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
          processFilePath(
            expandAndTrackEnvTemplates(assert.value.file),
            'assertion file dependency',
            true,
            true,
          );
        }
      }
    };

    const inspectedNestedValues = new WeakSet<object>();
    const inspectedRefValues = new WeakSet<object>();
    const extractNestedFileUrls = (
      value: unknown,
      refBaseDir = refResolutionRoot,
      includeFileUrls = true,
      testBaseDir = configDir,
      localRefFile = configPath,
    ): void => {
      if (typeof value === 'string') {
        if (includeFileUrls && value.startsWith('file://')) {
          processFileUrl(value, true);
        }
        return;
      }
      if (typeof value !== 'object' || value === null) {
        return;
      }
      if (
        value instanceof Uint8Array ||
        value instanceof Date ||
        value instanceof Map ||
        value instanceof Set
      ) {
        return;
      }
      const inspectedValues = includeFileUrls
        ? inspectedNestedValues
        : inspectedRefValues;
      if (inspectedValues.has(value)) {
        return;
      }
      inspectedValues.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          extractNestedFileUrls(
            item,
            refBaseDir,
            includeFileUrls,
            testBaseDir,
            localRefFile,
          );
        }
        return;
      }
      const nestedTest = value as PromptfooTestConfig;
      if (typeof nestedTest.$id === 'string') {
        // JSON-schema scopes can redirect relative refs beyond what this
        // static traversal can safely resolve. Avoid false-negative skips.
        dependencies.add(`${dependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`);
      }
      extractVarFiles(nestedTest.vars, testBaseDir);
      extractAssertFiles(nestedTest.assert);
      for (const [key, item] of Object.entries(value)) {
        if (key === 'provider' && includeFileUrls) {
          const providerId =
            typeof item === 'string'
              ? item
              : typeof item === 'object' &&
                  item !== null &&
                  'id' in item &&
                  typeof item.id === 'string'
                ? item.id
                : undefined;
          const isHttpProvider =
            typeof providerId === 'string' &&
            /^https?(?::|$)/i.test(providerId);
          const providerConfig =
            typeof item === 'object' &&
            item !== null &&
            'config' in item &&
            typeof item.config === 'object' &&
            item.config !== null
              ? item.config
              : undefined;
          const fileAuth =
            providerConfig &&
            'auth' in providerConfig &&
            typeof providerConfig.auth === 'object' &&
            providerConfig.auth !== null
              ? providerConfig.auth
              : undefined;
          if (
            isHttpProvider &&
            fileAuth &&
            'type' in fileAuth &&
            fileAuth.type === 'file' &&
            'path' in fileAuth &&
            typeof fileAuth.path === 'string'
          ) {
            processFileUrl(`file://${fileAuth.path}`, true);
          }
          if (isHttpProvider && providerConfig) {
            const securityGroups: Array<[string, string[]]> = [
              [
                'signatureAuth',
                [
                  'privateKeyPath',
                  'keystorePath',
                  'pfxPath',
                  'certPath',
                  'keyPath',
                ],
              ],
              ['tls', ['certPath', 'keyPath', 'caPath', 'pfxPath', 'jksPath']],
            ];
            for (const [groupKey, pathKeys] of securityGroups) {
              const securityGroup = (providerConfig as Record<string, unknown>)[
                groupKey
              ];
              if (typeof securityGroup !== 'object' || securityGroup === null) {
                continue;
              }
              for (const pathKey of pathKeys) {
                const assetPath = (securityGroup as Record<string, unknown>)[
                  pathKey
                ];
                if (typeof assetPath === 'string') {
                  processFilePath(
                    expandAndTrackEnvTemplates(assetPath),
                    'provider security file dependency',
                    true,
                    true,
                  );
                }
              }
            }
            const responseFormat =
              (providerConfig as Record<string, unknown>).response_format ??
              (providerConfig as Record<string, unknown>).responseFormat;
            if (typeof responseFormat === 'object' && responseFormat !== null) {
              const format = responseFormat as Record<string, unknown>;
              const jsonSchema =
                typeof format.json_schema === 'object' &&
                format.json_schema !== null
                  ? (format.json_schema as Record<string, unknown>)
                  : undefined;
              for (const schema of [format.schema, jsonSchema?.schema]) {
                if (typeof schema === 'string') {
                  expandAndTrackEnvTemplates(schema);
                }
              }
            }
          }
          const localProvider = providerId?.match(
            /^(?:file:\/\/|python:(?=[\s\S]+\.py(?::[^/\\]+)?$)|golang:(?=[\s\S]+\.go(?::[^/\\]+)?$)|ruby:(?=[\s\S]+\.rb(?::[^/\\]+)?$))([\s\S]+)$/i,
          );
          if (localProvider) {
            processFileUrl(
              `file://${localProvider[1]}`,
              true,
              testBaseDir,
              true,
            );
            if (typeof item === 'object' && item !== null) {
              for (const [providerKey, providerValue] of Object.entries(item)) {
                if (providerKey !== 'id') {
                  extractNestedFileUrls(
                    providerValue,
                    refBaseDir,
                    includeFileUrls,
                    testBaseDir,
                    localRefFile,
                  );
                }
              }
            }
            continue;
          }
        }
        if (key === '$ref' && typeof item === 'string') {
          const hashIndex = item.indexOf('#');
          let refPath = hashIndex === -1 ? item : item.slice(0, hashIndex);
          const fragment = hashIndex === -1 ? undefined : item.slice(hashIndex);
          if (!refPath) {
            if (fragment?.startsWith('#/')) {
              inspectTestFile(
                localRefFile,
                refBaseDir,
                testBaseDir,
                fragment,
                true,
              );
            }
            continue;
          }
          if (refPath.startsWith('file://')) {
            refPath = refPath.slice('file://'.length);
          } else if (
            /^[a-z][a-z\d+.-]*:/i.test(refPath) &&
            !/^[a-z]:[\\/]/i.test(refPath)
          ) {
            continue;
          }
          if (
            /%[a-f\d]{2}/i.test(refPath) &&
            !/%(?![a-f\d]{2})/i.test(refPath)
          ) {
            try {
              refPath = decodeURIComponent(refPath);
            } catch {
              // Keep malformed percent-encoded paths literal.
            }
          }

          const relativeRefPath = path.relative(
            configDir,
            path.resolve(refBaseDir, refPath),
          );
          for (const refFile of processFilePath(
            relativeRefPath,
            'test $ref dependency',
            false,
            true,
          )) {
            inspectTestFile(
              refFile,
              path.dirname(refFile),
              testBaseDir,
              fragment,
              true,
            );
          }
          continue;
        }
        extractNestedFileUrls(
          item,
          refBaseDir,
          includeFileUrls,
          testBaseDir,
          localRefFile,
        );
      }
    };

    const inspectedTestFiles = new Set<string>();
    const inspectTestFile = (
      testFile: string,
      refBaseDir = refResolutionRoot,
      testBaseDir = path.dirname(testFile),
      fragment?: string,
      allowBareTestPaths = false,
      asProviderConfig = false,
    ): void => {
      const inspectionKey = `${testFile}\0${refBaseDir}\0${testBaseDir}\0${fragment ?? ''}\0${allowBareTestPaths}\0${asProviderConfig}`;
      if (
        inspectedTestFiles.has(inspectionKey) ||
        !/\.(?:ya?ml|jsonl?|csv|xlsx?|py|[cm]?[jt]s)$/i.test(testFile) ||
        !fs.existsSync(testFile)
      ) {
        return;
      }
      inspectedTestFiles.add(inspectionKey);

      try {
        const realDependencyRoot = fs.realpathSync(dependencyRoot);
        const realCwd = fs.realpathSync(cwd);
        const realTestFile = fs.realpathSync(testFile);
        if (
          !isPathInside(realDependencyRoot, realTestFile) &&
          !isPathInside(realCwd, realTestFile)
        ) {
          core.warning(
            `Ignoring unsafe config dependency "${testFile}": test file dependency must stay within the repository workspace`,
          );
          return;
        }

        if (/\.(?:xlsx?|py|[cm]?[jt]s)$/i.test(realTestFile)) {
          // Excel parsing is asynchronous and generators execute code in
          // Promptfoo. A workspace marker safely prevents skipping referenced
          // changes without loading an untrusted workbook or generator here.
          dependencies.add(
            `${realDependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
          );
          return;
        }

        const testContent = fs.readFileSync(realTestFile, 'utf8');
        if (/\.csv$/i.test(realTestFile)) {
          const rows = parseCsv(testContent, {
            bom: true,
            delimiter: process.env.PROMPTFOO_CSV_DELIMITER || ',',
            relax_quotes: true,
          }) as string[][];
          const headers = rows[0] ?? [];
          for (const [rowIndex, row] of rows.entries()) {
            for (const [columnIndex, value] of row.entries()) {
              const assertionMatch =
                rowIndex > 0 &&
                headers[columnIndex]?.trim().startsWith('__expected')
                  ? value
                      .trim()
                      .match(
                        /^(?:not-)?i?contains-(?:all|any)(?:\(\d+(?:\.\d+)?\))?:([\s\S]*)$/,
                      )
                  : null;
              const values = assertionMatch
                ? splitCsvAssertionValues(assertionMatch[1])
                : [value];
              if (!values) {
                core.warning(
                  `Failed to inspect CSV assertion in test file dependency "${testFile}"`,
                );
                dependencies.add(
                  `${realDependencyRoot.replace(/[\\/]+$/, '')}${path.sep}`,
                );
                continue;
              }
              for (const assertionValue of values) {
                const fileUrlIndex = assertionValue.indexOf('file://');
                if (fileUrlIndex !== -1) {
                  processFileUrl(
                    assertionValue.slice(fileUrlIndex).trim(),
                    true,
                  );
                }
              }
            }
          }
          return;
        }
        const parsedTests = (
          /\.jsonl$/i.test(realTestFile)
            ? testContent
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line))
            : loadYaml(testContent, {
                schema: CORE_SCHEMA.withTags(
                  mergeTag,
                  binaryTag,
                  timestampTag,
                  omapTag,
                  pairsTag,
                  setTag,
                ),
              })
        ) as PromptfooTestConfig | PromptfooTestConfig[] | null;
        const selectedTests = fragment?.startsWith('#/')
          ? fragment
              .slice(2)
              .split('/')
              .reduce<unknown>((value, token) => {
                if (typeof value !== 'object' || value === null) {
                  return undefined;
                }
                let decodedToken = token;
                try {
                  decodedToken = decodeURIComponent(token);
                } catch {
                  // Keep malformed percent-encoded tokens literal.
                }
                const key = decodedToken
                  .replace(/~1/g, '/')
                  .replace(/~0/g, '~');
                return (value as Record<string, unknown>)[key];
              }, parsedTests)
          : parsedTests;
        const testsToInspect = selectedTests ?? parsedTests;
        const nestedTests = Array.isArray(testsToInspect)
          ? testsToInspect
          : testsToInspect
            ? [testsToInspect]
            : [];

        for (const nestedTest of nestedTests) {
          if (typeof nestedTest === 'string' && allowBareTestPaths) {
            const relativeTestPath = path.relative(
              configDir,
              path.resolve(testBaseDir, nestedTest),
            );
            processTestFile(relativeTestPath);
            continue;
          }
          if (typeof nestedTest !== 'object' || nestedTest === null) {
            continue;
          }
          if (typeof nestedTest.path === 'string') {
            processTestFile(nestedTest.path);
          }
          extractVarFiles(nestedTest.vars, testBaseDir);
          extractAssertFiles(nestedTest.assert);
          extractNestedFileUrls(
            asProviderConfig ? { provider: nestedTest } : nestedTest,
            refBaseDir,
            true,
            testBaseDir,
            realTestFile,
          );
        }
      } catch {
        core.warning(`Failed to inspect test file dependency "${testFile}"`);
      }
    };

    const processTestFile = (
      testSource: string,
      testBaseDir?: string,
    ): void => {
      let filePath = testSource;
      if (filePath.startsWith('file://')) {
        filePath = filePath.slice('file://'.length);
      } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
        // Remote source (https://, s3://, ...) — not a local file dependency.
        return;
      }
      filePath = expandAndTrackEnvTemplates(filePath);

      // Drop an Excel sheet reference while preserving `#` in other filenames.
      const fileName = path.basename(filePath);
      const sheetIndex = fileName.indexOf('#');
      if (
        sheetIndex !== -1 &&
        /\.xlsx?$/i.test(fileName.slice(0, sheetIndex))
      ) {
        filePath = path.join(
          path.dirname(filePath),
          fileName.slice(0, sheetIndex),
        );
      }

      // Drop a function qualifier, e.g. `tests.py:generate_tests`. Require the
      // colon past index 1 so a Windows drive letter (`C:\...`) is not stripped.
      const functionIndex = filePath.lastIndexOf(':');
      if (
        functionIndex > 1 &&
        /\.(?:py|[cm]?[jt]s)$/i.test(filePath.slice(0, functionIndex))
      ) {
        filePath = filePath.slice(0, functionIndex);
      }

      for (const testFile of processFilePath(
        filePath,
        'test file dependency',
        true,
        true,
      )) {
        if (isDirectory(testFile)) {
          const nestedTestFiles = glob.sync(
            '**/*.{yaml,yml,json,jsonl,csv,xls,xlsx,py,js,cjs,mjs,ts,cts,mts}',
            {
              cwd: testFile,
              absolute: true,
              nodir: true,
              nocase: true,
            },
          );
          for (const nestedTestFile of nestedTestFiles) {
            inspectTestFile(
              path.resolve(testFile, nestedTestFile),
              refResolutionRoot,
              testBaseDir,
            );
          }
          continue;
        }
        inspectTestFile(testFile, refResolutionRoot, testBaseDir);
      }
    };

    for (const providerConfigFile of providerConfigFiles) {
      inspectTestFile(
        providerConfigFile,
        refResolutionRoot,
        configDir,
        undefined,
        false,
        true,
      );
    }
    for (const providerConfig of providerConfigs) {
      extractNestedFileUrls({ provider: providerConfig });
    }

    // Process defaultTest
    if (typeof config.defaultTest === 'string') {
      processTestFile(config.defaultTest, configDir);
    } else if (config.defaultTest) {
      extractVarFiles(config.defaultTest.vars);
      extractAssertFiles(config.defaultTest.assert);
      extractNestedFileUrls(config.defaultTest, refResolutionRoot, true);
    }

    // Process tests
    if (config.tests) {
      extractNestedFileUrls(config.tests, refResolutionRoot, false);
      const tests = Array.isArray(config.tests) ? config.tests : [config.tests];
      for (const test of tests) {
        if (typeof test === 'string') {
          processTestFile(test);
          continue;
        }
        if (typeof test !== 'object' || test === null) {
          continue;
        }
        if (typeof test.path === 'string') {
          processTestFile(test.path);
          extractNestedFileUrls(test.config);
          extractNestedFileUrls({
            provider: test.provider,
            assert: test.assert,
          });
          continue;
        }
        extractVarFiles(test.vars);
        extractAssertFiles(test.assert);
        extractNestedFileUrls({ provider: test.provider, assert: test.assert });
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
