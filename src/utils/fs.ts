import * as fs from 'fs';
import * as path from 'path';
import { ErrorCodes, PromptfooActionError } from './errors';

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function rejectUnsafePath(inputPath: string, inputName: string): never {
  throw new PromptfooActionError(
    `Invalid ${inputName} "${inputPath}"`,
    ErrorCodes.INVALID_CONFIGURATION,
    `${inputName} must stay within the repository workspace and cannot contain directory traversal`,
  );
}

export function resolvePathWithin(
  baseDir: string,
  inputPath: string,
  inputName: string,
  options: { allowAbsolute?: boolean; allowEmpty?: boolean } = {},
): string {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    if (options.allowEmpty) {
      return path.resolve(baseDir);
    }
    return rejectUnsafePath(inputPath, inputName);
  }

  if (trimmedPath.includes('\0')) {
    return rejectUnsafePath(inputPath, inputName);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedPath =
    options.allowAbsolute && path.isAbsolute(trimmedPath)
      ? path.resolve(trimmedPath)
      : path.resolve(path.join(resolvedBase, trimmedPath));

  if (
    !(options.allowAbsolute && path.isAbsolute(trimmedPath)) &&
    !isPathInside(resolvedBase, resolvedPath)
  ) {
    return rejectUnsafePath(inputPath, inputName);
  }

  return resolvedPath;
}

export function normalizePathWithin(
  baseDir: string,
  inputPath: string,
  inputName: string,
): string {
  const resolvedPath = resolvePathWithin(baseDir, inputPath, inputName);
  const relativePath = path.relative(path.resolve(baseDir), resolvedPath);
  return relativePath.split(path.sep).join('/') || '.';
}

export function normalizeSafeGlobPattern(
  pattern: string,
  inputName: string,
): string {
  const trimmedPattern = pattern.trim();
  if (
    !trimmedPattern ||
    trimmedPattern.includes('\0') ||
    path.isAbsolute(trimmedPattern) ||
    trimmedPattern.split(/[\\/]+/).includes('..')
  ) {
    return rejectUnsafePath(pattern, inputName);
  }

  return trimmedPattern;
}
