import * as core from '@actions/core';
import { parse as parseCsv } from 'csv-parse/sync';
import * as fs from 'fs';
import * as glob from 'glob';
import { CORE_SCHEMA, load as loadYaml, mergeTag } from 'js-yaml';
import { braceExpand } from 'minimatch';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isDirectory } from './fs';
import {
  MAX_GLOB_BRACE_EXPANSIONS,
  MAX_GLOB_PATTERN_LENGTH,
  validateGlobPattern,
} from './glob';

const MAX_STRUCTURED_DEPENDENCY_SIZE = 10 * 1024 * 1024;
const MAX_UNSAFE_DEPENDENCY_WARNINGS = 10;

class UnsafeConfigDependencyError extends Error {}

export interface PromptfooConfig {
  extensions?: unknown;
  commandLineOptions?: unknown;
  providers?: string | Array<string | { id?: string; [key: string]: unknown }>;
  targets?: string | Array<string | { id?: string; [key: string]: unknown }>;
  prompts?: unknown;
  tests?: unknown;
  scenarios?: unknown;
  nunjucksFilters?: unknown;
  defaultTest?: unknown;
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

/**
 * Extracts file dependencies from a promptfoo configuration file.
 * This includes custom provider files, prompt files, test data files, etc.
 */
export function extractFileDependencies(configPath: string): string[] {
  const dependencies = new Set<string>();
  const configDir = path.dirname(configPath);
  const cwd = process.cwd();
  const configIsInCheckout = isPathInside(cwd, configDir);
  const dependencyRoot = configIsInCheckout ? cwd : configDir;
  const isSafeDependency = (targetPath: string): boolean =>
    isPathInside(dependencyRoot, targetPath) || isPathInside(cwd, targetPath);
  let configParsed = false;
  let watchDynamicDependency = false;
  let unsafeDependencyWarnings = 0;

  try {
    if (/\.(?:[cm]?js|[cm]?ts)$/i.test(configPath)) {
      core.warning(
        'Unable to statically resolve dependencies from an executable config. Watching the repository workspace for changes.',
      );
      return ['./'];
    }

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
    configParsed = true;

    let resolvedDependencyRoots: string[] | undefined;
    if (configIsInCheckout) {
      try {
        const resolvedCwd = fs.realpathSync(cwd);
        const resolvedConfigDir = fs.realpathSync(configDir);
        if (!isPathInside(resolvedCwd, resolvedConfigDir)) {
          core.warning(
            'Ignoring an in-checkout config directory that resolves outside the checkout.',
          );
          return [];
        }
        resolvedDependencyRoots = [resolvedCwd];
      } catch {
        core.warning(
          'Unable to resolve an in-checkout config directory. Ignoring its dependencies.',
        );
        return [];
      }
    }

    const getResolvedDependencyRoots = (): string[] => {
      if (resolvedDependencyRoots) {
        return resolvedDependencyRoots;
      }
      resolvedDependencyRoots = Array.from(new Set([configDir, cwd])).flatMap(
        (root) => {
          try {
            return [fs.realpathSync(root)];
          } catch {
            core.warning(
              'Unable to resolve an allowed dependency root. Ignoring this root.',
            );
            return [];
          }
        },
      );
      return resolvedDependencyRoots;
    };

    const warnUnsafeDependency = (message: string): void => {
      if (unsafeDependencyWarnings < MAX_UNSAFE_DEPENDENCY_WARNINGS) {
        core.warning(message);
      } else if (unsafeDependencyWarnings === MAX_UNSAFE_DEPENDENCY_WARNINGS) {
        core.warning('Suppressing further unsafe config dependency warnings.');
      }
      unsafeDependencyWarnings++;
    };

    const resolveConfigDependency = (
      filePath: string,
      source: string,
    ): string | undefined => {
      try {
        if (!filePath) {
          throw new Error(`${source} is empty`);
        }
        if (filePath.includes('{{') || filePath.includes('{%')) {
          watchDynamicDependency = true;
          return undefined;
        }
        if (filePath.includes('\0')) {
          throw new Error(`${source} contains an invalid null byte`);
        }

        if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) {
          throw new Error(
            `${source} must stay within the checkout or config directory`,
          );
        }

        const absolutePath = path.resolve(configDir, filePath);
        if (!isSafeDependency(absolutePath)) {
          throw new Error(
            `${source} must stay within the checkout or config directory`,
          );
        }

        if (
          filePath.length > MAX_GLOB_PATTERN_LENGTH ||
          absolutePath.length > MAX_GLOB_PATTERN_LENGTH
        ) {
          return absolutePath;
        }

        try {
          fs.lstatSync(absolutePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return absolutePath;
          }
          warnUnsafeDependency(
            'Unable to resolve an existing config dependency. Ignoring this dependency.',
          );
          return undefined;
        }

        let resolvedPath: string;
        try {
          resolvedPath = fs.realpathSync(absolutePath);
        } catch {
          warnUnsafeDependency(
            'Unable to resolve an existing config dependency. Ignoring this dependency.',
          );
          return undefined;
        }
        if (
          !getResolvedDependencyRoots().some((root) =>
            isPathInside(root, resolvedPath),
          )
        ) {
          throw new UnsafeConfigDependencyError(
            'An existing config dependency resolves outside an allowed dependency root.',
          );
        }

        return absolutePath;
      } catch (error) {
        if (error instanceof UnsafeConfigDependencyError) {
          throw error;
        }
        warnUnsafeDependency(
          `Ignoring unsafe config dependency ${JSON.stringify(filePath)}: ${String(
            error,
          ).replace(/^(?:[A-Za-z]+)?Error: /, '')}`,
        );
        return undefined;
      }
    };

    // Helper function to process file:// paths with glob support
    const hasGlobSyntax = (filePath: string): boolean => {
      if (
        filePath.length > MAX_GLOB_PATTERN_LENGTH ||
        filePath.includes('\0')
      ) {
        return false;
      }
      validateGlobPattern(filePath, 'Config file dependency pattern');
      return glob.hasMagic(filePath);
    };
    const processFileUrl = (
      fileUrl: string,
      decodeFileUrl = false,
      windowsPathsNoEscape = false,
      magicalBraces = true,
    ): void => {
      let filePath = fileUrl.replace('file://', '');
      if (decodeFileUrl) {
        const urlBody = fileUrl.slice('file://'.length);
        const authoritySeparator = urlBody.search(/[\\/]/);
        const lexicalFilePath =
          authoritySeparator === -1
            ? ''
            : urlBody.slice(authoritySeparator).replace(/\\/g, path.sep);
        const lexicalFilePathIsSafe =
          lexicalFilePath !== '' &&
          isSafeDependency(path.resolve(configDir, lexicalFilePath));
        try {
          const decodedFilePath = fileURLToPath(fileUrl);
          if (lexicalFilePathIsSafe) {
            filePath = decodedFilePath;
            if (!isSafeDependency(path.resolve(configDir, filePath))) {
              throw new UnsafeConfigDependencyError(
                'An existing config dependency resolves outside an allowed dependency root.',
              );
            }
          }
        } catch (error) {
          if (error instanceof UnsafeConfigDependencyError) {
            throw error;
          }
          if (lexicalFilePathIsSafe && /%(?:2f|5c)/i.test(fileUrl)) {
            throw new UnsafeConfigDependencyError(
              'An existing config dependency resolves outside an allowed dependency root.',
            );
          }
        }
      }
      if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      if (windowsPathsNoEscape) {
        filePath = filePath.replace(/\\/g, '/');
      }
      const absolutePath = resolveConfigDependency(
        filePath,
        'config file dependency',
      );
      if (!absolutePath) {
        return;
      }

      if (
        filePath.length > MAX_GLOB_PATTERN_LENGTH ||
        absolutePath.length > MAX_GLOB_PATTERN_LENGTH
      ) {
        dependencies.add(cwd);
        warnUnsafeDependency(
          'Unable to statically resolve an oversized config file dependency pattern. Watching the repository workspace for changes.',
        );
        return;
      }

      // Check if the path contains glob patterns
      validateGlobPattern(filePath, 'Config file dependency pattern');
      if (
        glob.hasMagic(filePath, {
          magicalBraces,
          windowsPathsNoEscape,
        })
      ) {
        const safePatterns: string[] = [];
        const expandedPatterns = braceExpand(filePath, {
          braceExpandMax: MAX_GLOB_BRACE_EXPANSIONS + 1,
        });
        if (expandedPatterns.length > MAX_GLOB_BRACE_EXPANSIONS) {
          throw new Error(
            `Config file dependency pattern expands to more than ${MAX_GLOB_BRACE_EXPANSIONS} alternatives.`,
          );
        }
        const matches = expandedPatterns.flatMap((pattern) => {
          const absolutePattern = path.resolve(configDir, pattern);
          if (
            (path.win32.isAbsolute(pattern) && !path.isAbsolute(pattern)) ||
            !isSafeDependency(absolutePattern)
          ) {
            warnUnsafeDependency(
              `Ignoring unsafe config dependency glob pattern ${JSON.stringify(
                pattern,
              )}: config dependency must stay within the checkout or config directory`,
            );
            return [];
          }
          safePatterns.push(pattern);
          return glob.sync(absolutePattern, {
            nodir: true,
            braceExpandMax: MAX_GLOB_BRACE_EXPANSIONS,
            windowsPathsNoEscape,
          });
        });
        const globDependencyRoots = getResolvedDependencyRoots();
        for (const match of matches) {
          const absoluteMatch = path.resolve(match);
          try {
            const resolvedMatch = fs.realpathSync(absoluteMatch);
            if (
              isSafeDependency(absoluteMatch) &&
              globDependencyRoots.some((root) =>
                isPathInside(root, resolvedMatch),
              )
            ) {
              dependencies.add(absoluteMatch);
              continue;
            }
            throw new UnsafeConfigDependencyError(
              'An existing config dependency resolves outside an allowed dependency root.',
            );
          } catch (error) {
            if (error instanceof UnsafeConfigDependencyError) {
              throw error;
            }
            warnUnsafeDependency(
              'Unable to resolve a config dependency glob match. Ignoring this match.',
            );
          }
        }

        // Also add the base directory for watching
        // Extract the non-glob part of the path
        for (const pattern of safePatterns) {
          const filePathRoot = path.parse(pattern).root;
          const pathParts = pattern.slice(filePathRoot.length).split(/[\\/]/);
          let basePath = filePathRoot;
          let foundMagic = false;
          for (const part of pathParts) {
            if (
              glob.hasMagic(part, {
                magicalBraces,
                windowsPathsNoEscape,
              })
            ) {
              foundMagic = true;
              break;
            }
            basePath = basePath ? path.join(basePath, part) : part;
          }
          if (!foundMagic) {
            basePath = path.dirname(pattern);
          }
          if (!basePath) {
            basePath = '.';
          }
          const absoluteBase = path.resolve(configDir, basePath);
          dependencies.add(
            absoluteBase.endsWith(path.sep)
              ? absoluteBase
              : `${absoluteBase}${path.sep}`,
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
    const processProviderFileUrl = (fileUrl: string): void => {
      const selectorSeparator = fileUrl.lastIndexOf(':');
      const candidateFileUrl = fileUrl.slice(0, selectorSeparator);
      const hasSelector =
        selectorSeparator > 'file://'.length &&
        /\.(?:py|go|rb)$/.test(candidateFileUrl);
      const providerFileUrl = hasSelector ? candidateFileUrl : fileUrl;
      processFileUrl(providerFileUrl, false, hasGlobSyntax(providerFileUrl));
    };

    const processProviderReference = (
      provider: unknown,
      baseDir = configDir,
    ): void => {
      let providerPath =
        typeof provider === 'string'
          ? provider
          : provider !== null &&
              typeof provider === 'object' &&
              'id' in provider &&
              typeof provider.id === 'string'
            ? provider.id
            : undefined;
      if (
        !providerPath &&
        provider !== null &&
        typeof provider === 'object' &&
        Object.keys(provider).length === 1
      ) {
        const [mapPath, mapProvider] = Object.entries(provider)[0];
        if (mapProvider !== null && typeof mapProvider === 'object') {
          providerPath = mapPath;
        }
      }
      if (
        providerPath &&
        (providerPath.includes('{{') || providerPath.includes('{%'))
      ) {
        watchDynamicDependency = true;
        return;
      }
      const filePath = providerPath?.startsWith('file://')
        ? providerPath.slice('file://'.length)
        : providerPath?.match(/^(?:python|golang|ruby):([\s\S]*)$/)?.[1];
      if (!filePath) {
        return;
      }
      const rebasedPath =
        baseDir === configDir ||
        path.isAbsolute(filePath) ||
        path.win32.isAbsolute(filePath)
          ? filePath
          : path.resolve(baseDir, filePath);
      processProviderFileUrl(`file://${rebasedPath}`);
    };

    const providers = [config.providers, config.targets].flatMap((value) =>
      Array.isArray(value) ? value : value == null ? [] : [value],
    );
    for (const provider of providers) {
      let providerPath: string | undefined;
      let providerConfig: unknown;
      if (typeof provider === 'string') {
        providerPath = provider;
      } else if (provider !== null && typeof provider === 'object') {
        if (provider.id) {
          providerPath = provider.id;
          providerConfig = provider.config;
        } else {
          const mapEntries = Object.entries(provider);
          if (mapEntries.length === 1) {
            const [mapPath, mapProvider] = mapEntries[0];
            if (mapProvider !== null && typeof mapProvider === 'object') {
              providerPath = mapPath;
              providerConfig = (mapProvider as { config?: unknown }).config;
            }
          }
        }
      }

      processProviderReference(providerPath);
      if (
        !providerPath ||
        (!/^https?(?::|$)/.test(providerPath) &&
          !providerPath.includes('{{') &&
          !providerPath.includes('{%')) ||
        providerConfig === null ||
        typeof providerConfig !== 'object'
      ) {
        continue;
      }

      const session =
        'session' in providerConfig &&
        providerConfig.session !== null &&
        typeof providerConfig.session === 'object'
          ? providerConfig.session
          : undefined;
      const auth =
        'auth' in providerConfig &&
        providerConfig.auth !== null &&
        typeof providerConfig.auth === 'object'
          ? providerConfig.auth
          : undefined;
      const multipart =
        'multipart' in providerConfig &&
        providerConfig.multipart !== null &&
        typeof providerConfig.multipart === 'object'
          ? providerConfig.multipart
          : undefined;
      const tls =
        'tls' in providerConfig &&
        providerConfig.tls !== null &&
        typeof providerConfig.tls === 'object'
          ? providerConfig.tls
          : undefined;
      const signatureAuth =
        'signatureAuth' in providerConfig &&
        providerConfig.signatureAuth !== null &&
        typeof providerConfig.signatureAuth === 'object'
          ? providerConfig.signatureAuth
          : undefined;
      const multipartPaths =
        multipart && 'parts' in multipart && Array.isArray(multipart.parts)
          ? multipart.parts.flatMap((part) => {
              if (
                part === null ||
                typeof part !== 'object' ||
                !('source' in part) ||
                part.source === null ||
                typeof part.source !== 'object' ||
                !('path' in part.source)
              ) {
                return [];
              }
              return [part.source.path];
            })
          : [];
      const httpFileReferences: Array<{
        value: unknown;
        kind: 'transform' | 'auth' | 'file' | 'multipart';
      }> = [
        {
          value:
            'request' in providerConfig ? providerConfig.request : undefined,
          kind: 'transform',
        },
        {
          value:
            'validateStatus' in providerConfig
              ? providerConfig.validateStatus
              : undefined,
          kind: 'transform',
        },
        {
          value:
            'transformRequest' in providerConfig
              ? providerConfig.transformRequest
              : undefined,
          kind: 'transform',
        },
        {
          value:
            'transformResponse' in providerConfig
              ? providerConfig.transformResponse
              : undefined,
          kind: 'transform',
        },
        {
          value:
            'responseParser' in providerConfig
              ? providerConfig.responseParser
              : undefined,
          kind: 'transform',
        },
        {
          value:
            'sessionParser' in providerConfig
              ? providerConfig.sessionParser
              : undefined,
          kind: 'transform',
        },
        {
          value:
            session && 'responseParser' in session
              ? session.responseParser
              : undefined,
          kind: 'transform',
        },
        { value: auth && 'path' in auth ? auth.path : undefined, kind: 'auth' },
        ...['caPath', 'certPath', 'keyPath', 'pfxPath'].map((key) => ({
          value: tls && key in tls ? tls[key as keyof typeof tls] : undefined,
          kind: 'file' as const,
        })),
        ...[
          'privateKeyPath',
          'keystorePath',
          'pfxPath',
          'certPath',
          'keyPath',
        ].map((key) => ({
          value:
            signatureAuth && key in signatureAuth
              ? signatureAuth[key as keyof typeof signatureAuth]
              : undefined,
          kind: 'file' as const,
        })),
        ...multipartPaths.map((value) => ({
          value,
          kind: 'multipart' as const,
        })),
      ];
      for (const { value, kind } of httpFileReferences) {
        if (
          typeof value !== 'string' ||
          (kind === 'transform' && !value.startsWith('file://'))
        ) {
          continue;
        }
        if (value.includes('{{') || value.includes('{%')) {
          watchDynamicDependency = true;
          continue;
        }
        const fileUrl = value.startsWith('file://')
          ? value
          : 'file://'.concat(value);
        const selectorSeparator = fileUrl.lastIndexOf(':');
        const candidateFileUrl = fileUrl.slice(0, selectorSeparator);
        const hasJavascriptSelector = /\.(?:[cm]?js|[cm]?ts)$/i.test(
          candidateFileUrl,
        );
        const hasSelector =
          selectorSeparator > 'file://'.length &&
          selectorSeparator < fileUrl.length - 1 &&
          (hasJavascriptSelector ||
            (kind === 'auth' && candidateFileUrl.endsWith('.py')));
        processFileUrl(
          hasSelector ? candidateFileUrl : fileUrl,
          kind === 'multipart',
          false,
          false,
        );
        if (
          hasSelector &&
          hasJavascriptSelector &&
          !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
        ) {
          processFileUrl(fileUrl, kind === 'multipart', false, false);
        }
      }
    }

    // Extract prompt files
    const prompts = Array.isArray(config.prompts)
      ? config.prompts
      : typeof config.prompts === 'string'
        ? [config.prompts]
        : config.prompts !== null && typeof config.prompts === 'object'
          ? Object.keys(config.prompts)
          : [];
    for (const configuredPrompt of prompts) {
      if (
        configuredPrompt !== null &&
        typeof configuredPrompt === 'object' &&
        'file' in configuredPrompt &&
        typeof configuredPrompt.file === 'string'
      ) {
        const absolutePath = resolveConfigDependency(
          configuredPrompt.file,
          'prompt file dependency',
        );
        if (absolutePath) {
          dependencies.add(absolutePath);
        }
        continue;
      }

      const prompt =
        typeof configuredPrompt === 'string'
          ? configuredPrompt
          : configuredPrompt !== null &&
              typeof configuredPrompt === 'object' &&
              'raw' in configuredPrompt &&
              typeof configuredPrompt.raw === 'string'
            ? configuredPrompt.raw
            : configuredPrompt !== null &&
                typeof configuredPrompt === 'object' &&
                'id' in configuredPrompt &&
                typeof configuredPrompt.id === 'string'
              ? configuredPrompt.id
              : undefined;
      if (typeof prompt === 'string' && !prompt.includes('\n')) {
        const promptPath = (
          prompt.startsWith('exec:') ? prompt.slice('exec:'.length) : prompt
        ).replace(/^file:\/\//, '');
        const isPromptPath =
          prompt.startsWith('file://') ||
          prompt.startsWith('exec:') ||
          /[\\/]/.test(promptPath) ||
          /\.\{(?:[cm]?js|[cm]?ts|j2|jsonl?|md|py|rb|txt|ya?ml)(?:,(?:[cm]?js|[cm]?ts|j2|jsonl?|md|py|rb|txt|ya?ml))*\}$/i.test(
            promptPath,
          ) ||
          /\.(?:[cm]?js|[cm]?ts|j2|jsonl?|md|py|rb|txt|ya?ml)(?::[^:]*)?$/i.test(
            promptPath,
          );
        if (!isPromptPath) {
          continue;
        }
        if (prompt.includes('{{') || prompt.includes('{%')) {
          watchDynamicDependency = true;
          continue;
        }
        const fileUrl = `file://${promptPath}`;
        const selectorSeparator = fileUrl.lastIndexOf(':');
        const candidateFileUrl = fileUrl.slice(0, selectorSeparator);
        const hasJavascriptSelector = /\.(?:[cm]?js|[cm]?ts)$/i.test(
          candidateFileUrl,
        );
        const hasSelector =
          selectorSeparator > 'file://'.length &&
          (hasJavascriptSelector || /\.(?:py|rb)$/.test(candidateFileUrl));
        const promptFileUrl = hasSelector ? candidateFileUrl : fileUrl;
        const promptHasGlobSyntax = hasGlobSyntax(promptFileUrl);
        processFileUrl(
          promptFileUrl,
          false,
          promptHasGlobSyntax,
          promptHasGlobSyntax,
        );
        if (
          hasSelector &&
          hasJavascriptSelector &&
          !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
        ) {
          const alternatePromptHasGlobSyntax = hasGlobSyntax(fileUrl);
          processFileUrl(
            fileUrl,
            false,
            alternatePromptHasGlobSyntax,
            alternatePromptHasGlobSyntax,
          );
        }
      }
    }

    const processAssertionFileUrl = (fileUrl: string): void => {
      const selectorSeparator = fileUrl.indexOf(':', 'file://'.length);
      const candidateFileUrl = fileUrl.slice(0, selectorSeparator);
      const hasJavascriptSelector = /\.(?:[cm]?js|[cm]?ts)$/i.test(
        candidateFileUrl,
      );
      const hasSelector =
        selectorSeparator > 'file://'.length &&
        (hasJavascriptSelector || /\.(?:py|rb)$/.test(candidateFileUrl));
      const assertionFileUrl = hasSelector ? candidateFileUrl : fileUrl;
      const assertionHasGlobSyntax = hasGlobSyntax(assertionFileUrl);
      processFileUrl(
        assertionFileUrl,
        false,
        assertionHasGlobSyntax,
        assertionHasGlobSyntax,
      );
      if (
        hasSelector &&
        hasJavascriptSelector &&
        !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
      ) {
        const alternateAssertionHasGlobSyntax = hasGlobSyntax(fileUrl);
        processFileUrl(
          fileUrl,
          false,
          alternateAssertionHasGlobSyntax,
          alternateAssertionHasGlobSyntax,
        );
      }
    };

    const processTestFilePath = (
      testPath: string,
      windowsPathsNoEscape = true,
    ): void => {
      if (
        testPath.length > MAX_GLOB_PATTERN_LENGTH ||
        testPath.includes('\0') ||
        testPath.includes('\r') ||
        testPath.includes('\n')
      ) {
        watchDynamicDependency = true;
        return;
      }
      if (/^(?:https?:|az:|huggingface:)/.test(testPath)) {
        return;
      }
      const sheetSeparator = testPath.indexOf('#');
      const pathWithoutSheet =
        sheetSeparator === -1 ? testPath : testPath.slice(0, sheetSeparator);
      const extension = path.extname(path.basename(pathWithoutSheet));
      const normalizedTestPath =
        extension === '.xls' || extension === '.xlsx'
          ? pathWithoutSheet
          : testPath;
      const fileUrl = normalizedTestPath.startsWith('file://')
        ? normalizedTestPath
        : `file://${normalizedTestPath}`;
      const selectorSeparator = fileUrl.lastIndexOf(':');
      const candidateFileUrl = fileUrl.slice(0, selectorSeparator);
      const hasJavascriptSelector = /\.(?:[cm]?js|[cm]?ts)$/i.test(
        candidateFileUrl,
      );
      const hasSelector =
        selectorSeparator > 'file://'.length &&
        (hasJavascriptSelector || candidateFileUrl.endsWith('.py'));
      processFileUrl(
        hasSelector ? candidateFileUrl : fileUrl,
        false,
        windowsPathsNoEscape,
        windowsPathsNoEscape,
      );
      if (
        hasSelector &&
        hasJavascriptSelector &&
        !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
      ) {
        processFileUrl(
          fileUrl,
          false,
          windowsPathsNoEscape,
          windowsPathsNoEscape,
        );
      }
    };

    // Extract test variable files
    const extractVarFiles = (vars?: unknown, baseDir = configDir): void => {
      if (!vars) return;
      if (typeof vars === 'string' || Array.isArray(vars)) {
        for (const varPath of Array.isArray(vars) ? vars : [vars]) {
          if (typeof varPath === 'string') {
            const filePath = varPath.replace(/^file:\/\//, '');
            const rebasedPath =
              baseDir === configDir ||
              path.isAbsolute(filePath) ||
              path.win32.isAbsolute(filePath)
                ? filePath
                : path.resolve(baseDir, filePath);
            processFileUrl(`file://${rebasedPath}`, false, true);
          }
        }
        return;
      }
      if (typeof vars !== 'object') return;
      for (const value of Object.values(vars)) {
        if (typeof value === 'string' && value.startsWith('file://')) {
          processFileUrl(value, false, true);
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
    const visitedAssertArrays = new WeakSet<object>();
    const visitedAssertions = new WeakSet<object>();
    const extractAssertFiles = (
      asserts?: unknown,
      baseDir = configDir,
    ): void => {
      if (!Array.isArray(asserts) || visitedAssertArrays.has(asserts)) return;
      visitedAssertArrays.add(asserts);
      for (const assert of asserts) {
        if (
          assert === null ||
          typeof assert !== 'object' ||
          visitedAssertions.has(assert)
        ) {
          continue;
        }
        visitedAssertions.add(assert);
        processProviderReference(
          'provider' in assert ? assert.provider : undefined,
          baseDir,
        );
        for (const key of ['contextTransform', 'transform']) {
          const transform = key in assert ? assert[key] : undefined;
          if (
            typeof transform === 'string' &&
            (transform.startsWith('file://') ||
              transform.includes('{{') ||
              transform.includes('{%'))
          ) {
            watchDynamicDependency = true;
          }
        }
        if (
          typeof assert.value === 'string' &&
          assert.value.startsWith('file://')
        ) {
          processAssertionFileUrl(assert.value);
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
        if ('assert' in assert) {
          extractAssertFiles(assert.assert, baseDir);
        }
      }
    };

    const processTestRuntimeDependencies = (
      test: object,
      baseDir = configDir,
    ): void => {
      const testProvider = 'provider' in test ? test.provider : undefined;
      processProviderReference(testProvider, baseDir);
      const options =
        'options' in test &&
        test.options !== null &&
        typeof test.options === 'object'
          ? test.options
          : undefined;
      const gradingProvider =
        options && 'provider' in options ? options.provider : undefined;
      processProviderReference(gradingProvider, baseDir);
      const runtimeFiles = [
        'assertScoringFunction' in test
          ? test.assertScoringFunction
          : undefined,
        ...[
          'contextTransform',
          'transform',
          'postprocess',
          'transformVars',
          'rubricPrompt',
        ].map((key) =>
          key in test ? test[key as keyof typeof test] : undefined,
        ),
        ...['transform', 'postprocess', 'transformVars', 'rubricPrompt'].map(
          (key) =>
            options && key in options
              ? options[key as keyof typeof options]
              : undefined,
        ),
      ];
      if (
        runtimeFiles.some(
          (value) =>
            typeof value === 'string' &&
            (value.startsWith('file://') ||
              value.includes('{{') ||
              value.includes('{%')),
        ) ||
        [testProvider, gradingProvider].some((provider) => {
          if (provider === null || typeof provider !== 'object') {
            return false;
          }
          if ('config' in provider) {
            return true;
          }
          const entries = Object.entries(provider);
          return (
            entries.length === 1 &&
            entries[0][1] !== null &&
            typeof entries[0][1] === 'object' &&
            'config' in entries[0][1]
          );
        })
      ) {
        watchDynamicDependency = true;
      }
    };

    const extractGeneratorConfigFiles = (config: unknown): void => {
      const values: unknown[] = [config];
      const visited = new WeakSet<object>();
      for (const value of values) {
        if (typeof value === 'string') {
          if (value.includes('{{') || value.includes('{%')) {
            watchDynamicDependency = true;
          } else if (value.startsWith('file://')) {
            processTestFilePath(value, hasGlobSyntax(value));
          }
          continue;
        }
        if (value === null || typeof value !== 'object' || visited.has(value)) {
          continue;
        }
        visited.add(value);
        values.push(...Object.values(value));
      }
    };

    // Process defaultTest
    if (typeof config.defaultTest === 'string') {
      processTestFilePath(config.defaultTest, false);
      watchDynamicDependency = true;
    } else if (
      config.defaultTest !== null &&
      typeof config.defaultTest === 'object'
    ) {
      extractVarFiles(
        'vars' in config.defaultTest ? config.defaultTest.vars : undefined,
      );
      extractAssertFiles(
        'assert' in config.defaultTest ? config.defaultTest.assert : undefined,
      );
      processTestRuntimeDependencies(config.defaultTest);
    }

    // Process tests
    const tests = Array.isArray(config.tests)
      ? config.tests
      : config.tests == null
        ? []
        : [config.tests];
    for (const test of tests) {
      if (typeof test === 'string') {
        processTestFilePath(test);
      } else if (test !== null && typeof test === 'object') {
        processTestRuntimeDependencies(test);
        if ('path' in test && typeof test.path === 'string') {
          processTestFilePath(test.path);
          if ('config' in test) {
            extractGeneratorConfigFiles(test.config);
          }
        } else {
          extractVarFiles('vars' in test ? test.vars : undefined);
          extractAssertFiles('assert' in test ? test.assert : undefined);
        }
      }
    }

    // Process extension hook files
    const extensions: unknown[] = [];
    const commandLineOptions =
      config.commandLineOptions != null &&
      typeof config.commandLineOptions === 'object'
        ? config.commandLineOptions
        : undefined;
    const commandLineVars =
      commandLineOptions && 'vars' in commandLineOptions
        ? commandLineOptions.vars
        : undefined;
    for (const varsPath of Array.isArray(commandLineVars)
      ? commandLineVars
      : [commandLineVars]) {
      if (typeof varsPath === 'string') {
        processTestFilePath(varsPath);
      }
    }
    let watchWorkspace =
      watchDynamicDependency ||
      (typeof config === 'object' && '$ref' in config) ||
      (commandLineOptions != null && '$ref' in commandLineOptions) ||
      (config.scenarios != null &&
        (!Array.isArray(config.scenarios) || config.scenarios.length > 0));
    for (const extensionList of [
      config.extensions,
      commandLineOptions != null && 'extension' in commandLineOptions
        ? commandLineOptions.extension
        : undefined,
    ]) {
      if (extensionList == null) {
        continue;
      }
      if (!Array.isArray(extensionList)) {
        watchWorkspace = true;
        continue;
      }
      extensions.push(...extensionList);
    }

    if (
      config.nunjucksFilters !== null &&
      typeof config.nunjucksFilters === 'object'
    ) {
      for (const filterPath of Object.values(config.nunjucksFilters)) {
        if (typeof filterPath === 'string') {
          processFileUrl(`file://${filterPath}`, false, true);
        }
      }
    }

    const fileSchemeLength = 'file://'.length;
    for (const extension of extensions) {
      if (typeof extension !== 'string') {
        if (
          extension !== null &&
          typeof extension === 'object' &&
          '$ref' in extension
        ) {
          watchWorkspace = true;
        }
        continue;
      }
      if (extension.includes('{{') || extension.includes('{%')) {
        watchWorkspace = true;
        continue;
      }
      if (!extension.startsWith('file://')) {
        continue;
      }

      const hookSeparator = extension.lastIndexOf(':');
      const windowsDrive = /^file:\/\/\/?[A-Za-z]:[\\/]/.test(extension);
      const windowsDriveSeparator = windowsDrive
        ? extension.indexOf(':', fileSchemeLength)
        : -1;
      const candidateFileUrl = extension.slice(0, hookSeparator);
      const hasJavascriptHook = /\.(?:[cm]?js|[cm]?ts)$/i.test(
        candidateFileUrl,
      );
      const hasHookSuffix =
        hookSeparator > fileSchemeLength &&
        hookSeparator !== windowsDriveSeparator &&
        (hasJavascriptHook || candidateFileUrl.endsWith('.py'));
      processFileUrl(
        hasHookSuffix ? candidateFileUrl : extension,
        false,
        false,
      );
      if (
        hasHookSuffix &&
        hasJavascriptHook &&
        !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
      ) {
        processFileUrl(extension, false, false);
      }
    }

    const scannedStructuredDependencies = new Set<string>();
    for (const dependency of dependencies) {
      if (
        scannedStructuredDependencies.has(dependency) ||
        !['.csv', '.json', '.jsonl', '.yaml', '.yml'].includes(
          path.extname(dependency).toLowerCase(),
        )
      ) {
        continue;
      }
      scannedStructuredDependencies.add(dependency);

      let dependencySize: number | undefined;
      try {
        dependencySize = fs.statSync(dependency).size;
      } catch {
        watchWorkspace = true;
        continue;
      }
      if (typeof dependencySize !== 'number') {
        continue;
      }
      if (dependencySize > MAX_STRUCTURED_DEPENDENCY_SIZE) {
        watchWorkspace = true;
        continue;
      }

      let structuredConfig: unknown;
      try {
        const structuredContent = fs.readFileSync(dependency, 'utf8');
        const extension = path.extname(dependency).toLowerCase();
        structuredConfig =
          extension === '.csv'
            ? parseCsv(structuredContent, { skip_empty_lines: true })
            : extension === '.jsonl'
              ? structuredContent
                  .split(/\r?\n/)
                  .filter((line) => line.trim())
                  .map((line) => JSON.parse(line) as unknown)
              : loadYaml(structuredContent, {
                  schema: CORE_SCHEMA.withTags(mergeTag),
                });
      } catch {
        watchWorkspace = true;
        continue;
      }

      const structuredValues: unknown[] = [structuredConfig];
      const visitedStructuredValues = new WeakSet<object>();
      for (const value of structuredValues) {
        if (typeof value === 'string') {
          if (!value.startsWith('file://')) {
            continue;
          }
          if (value.includes('{{') || value.includes('{%')) {
            watchWorkspace = true;
            continue;
          }
          processTestFilePath(value, hasGlobSyntax(value));
          continue;
        }
        if (
          value === null ||
          typeof value !== 'object' ||
          visitedStructuredValues.has(value)
        ) {
          continue;
        }
        visitedStructuredValues.add(value);
        if (Array.isArray(value)) {
          structuredValues.push(...value);
          continue;
        }

        const record = value as Record<string, unknown>;
        const runtimeFileKeys = new Set([
          'assertScoringFunction',
          'contextTransform',
          'transform',
          'postprocess',
          'transformVars',
          'rubricPrompt',
        ]);
        const authConfig =
          record.auth !== null && typeof record.auth === 'object'
            ? (record.auth as Record<string, unknown>)
            : undefined;
        const tlsConfig =
          record.tls !== null && typeof record.tls === 'object'
            ? (record.tls as Record<string, unknown>)
            : undefined;
        const signatureConfig =
          record.signatureAuth !== null &&
          typeof record.signatureAuth === 'object'
            ? (record.signatureAuth as Record<string, unknown>)
            : undefined;
        const multipartConfig =
          record.multipart !== null && typeof record.multipart === 'object'
            ? (record.multipart as Record<string, unknown>)
            : undefined;
        const rawPaths: Array<{ value: unknown; decodeFileUrl: boolean }> = [
          ...['caPath', 'certPath', 'keyPath', 'pfxPath'].map((key) => ({
            value: tlsConfig?.[key],
            decodeFileUrl: false,
          })),
          ...[
            'privateKeyPath',
            'keystorePath',
            'pfxPath',
            'certPath',
            'keyPath',
          ].map((key) => ({
            value: signatureConfig?.[key],
            decodeFileUrl: false,
          })),
          ...(Array.isArray(multipartConfig?.parts)
            ? multipartConfig.parts.map((part) => ({
                value:
                  part !== null &&
                  typeof part === 'object' &&
                  'source' in part &&
                  part.source !== null &&
                  typeof part.source === 'object' &&
                  'path' in part.source
                    ? part.source.path
                    : undefined,
                decodeFileUrl: true,
              }))
            : []),
        ];
        const authPath = authConfig?.path;
        if (typeof authPath === 'string') {
          if (authPath.includes('{{') || authPath.includes('{%')) {
            watchWorkspace = true;
          } else {
            const authFileUrl = authPath.startsWith('file://')
              ? authPath
              : `file://${authPath}`;
            const selectorSeparator = authFileUrl.lastIndexOf(':');
            const candidateFileUrl = authFileUrl.slice(0, selectorSeparator);
            const hasJavascriptSelector = /\.(?:[cm]?js|[cm]?ts)$/i.test(
              candidateFileUrl,
            );
            const hasSelector =
              selectorSeparator > 'file://'.length &&
              selectorSeparator < authFileUrl.length - 1 &&
              (hasJavascriptSelector || candidateFileUrl.endsWith('.py'));
            processFileUrl(
              hasSelector ? candidateFileUrl : authFileUrl,
              false,
              false,
              false,
            );
            if (
              hasSelector &&
              hasJavascriptSelector &&
              !/\.(?:[cm]?js|[cm]?ts)$/.test(candidateFileUrl)
            ) {
              processFileUrl(authFileUrl, false, false, false);
            }
          }
        }
        for (const { value: rawPath, decodeFileUrl } of rawPaths) {
          if (typeof rawPath !== 'string') {
            continue;
          }
          if (rawPath.includes('{{') || rawPath.includes('{%')) {
            watchWorkspace = true;
            continue;
          }
          processFileUrl(
            rawPath.startsWith('file://') ? rawPath : `file://${rawPath}`,
            decodeFileUrl,
            false,
            false,
          );
        }
        if ('vars' in record) {
          extractVarFiles(record.vars, path.dirname(dependency));
        }
        if ('assert' in record) {
          extractAssertFiles(record.assert);
        }
        processTestRuntimeDependencies(record, path.dirname(dependency));
        const unprocessedMultipartValues = Array.isArray(multipartConfig?.parts)
          ? [
              ...Object.entries(multipartConfig)
                .filter(([key]) => key !== 'parts')
                .map(([, childValue]) => childValue),
              ...multipartConfig.parts.flatMap((part): unknown[] => {
                if (part === null || typeof part !== 'object') {
                  return [part];
                }
                const source =
                  'source' in part &&
                  part.source !== null &&
                  typeof part.source === 'object'
                    ? part.source
                    : undefined;
                return [
                  ...Object.entries(part)
                    .filter(([key]) => key !== 'source')
                    .map(([, childValue]) => childValue),
                  ...(source
                    ? Object.entries(source)
                        .filter(([key]) => key !== 'path')
                        .map(([, childValue]) => childValue)
                    : []),
                ];
              }),
            ]
          : [];
        structuredValues.push(
          ...unprocessedMultipartValues,
          ...Object.entries(record)
            .filter(
              ([key, childValue]) =>
                key !== 'provider' &&
                key !== 'assert' &&
                key !== 'auth' &&
                key !== 'tls' &&
                key !== 'signatureAuth' &&
                (key !== 'multipart' ||
                  !Array.isArray(multipartConfig?.parts)) &&
                !runtimeFileKeys.has(key) &&
                (key !== 'vars' ||
                  (typeof childValue !== 'string' &&
                    !Array.isArray(childValue))),
            )
            .map(([, childValue]) => childValue),
        );
      }
    }

    if (watchWorkspace || watchDynamicDependency) {
      dependencies.add(cwd);
      core.warning(
        'Unable to statically resolve all config file dependencies. Watching the repository workspace for changes.',
      );
    }

    // Convert absolute paths back to relative paths from working directory
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
    if (error instanceof UnsafeConfigDependencyError) {
      throw error;
    }
    if (configParsed) {
      core.warning(
        'Failed to extract dependencies from a parsed config. Watching the repository workspace for changes.',
      );
      return ['./'];
    }
    core.warning(
      'Failed to read or parse the config while extracting dependencies.',
    );
    return [];
  }
}
