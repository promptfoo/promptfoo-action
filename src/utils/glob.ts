import type { Dirent } from 'node:fs';
import { Minimatch } from 'minimatch';
import * as path from 'path';

type GlobPathEntry = {
  fullpath: () => string;
  isSymbolicLink: () => boolean;
};

type GlobDirectory = {
  closeSync: () => void;
  readSync: () => Dirent | null;
};

export type GlobTraversalBudget = {
  entries: number;
  exhausted: boolean;
};

type GlobPreflightOptions = {
  maxLength: number;
  maxBraceExpansions: number;
  windowsPathsNoEscape?: boolean;
};

export type GlobPreflightResult = 'safe' | 'invalid' | 'too-many-braces';
const MAX_GLOB_DELIMITER_DEPTH = 128;
const MAX_EXTGLOB_TOKENS = 1024;
const MAX_EXTGLOB_DEPTH = 64;
const MAX_GLOB_TRAVERSAL_ENTRIES = 4096;

export function createBoundedGlobFs(
  openDirectory: (filePath: string) => GlobDirectory,
  traversal: GlobTraversalBudget,
  physicalRoots: string[],
  realpath: (filePath: string) => string,
): { readdirSync: (filePath: string) => Dirent[] } {
  return {
    readdirSync: (filePath) => {
      if (traversal.exhausted) return [];
      let physicalPath: string;
      try {
        physicalPath = realpath(filePath);
        if (
          !physicalRoots.some((root) => {
            const relativePath = path.relative(root, physicalPath);
            return (
              relativePath === '' ||
              (relativePath !== '..' &&
                !relativePath.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativePath))
            );
          })
        ) {
          traversal.exhausted = true;
          return [];
        }
      } catch {
        traversal.exhausted = true;
        return [];
      }
      const directory = openDirectory(physicalPath);
      const entries: Dirent[] = [];
      try {
        while (true) {
          const entry = directory.readSync();
          if (!entry) return entries;
          if (++traversal.entries > MAX_GLOB_TRAVERSAL_ENTRIES) {
            traversal.exhausted = true;
            return [];
          }
          entries.push(entry);
        }
      } finally {
        directory.closeSync();
      }
    },
  };
}

export function createContainedGlobIgnore(
  physicalRoots: string[],
  realpath: (filePath: string) => string,
  traversal?: GlobTraversalBudget,
): { childrenIgnored: (entry: GlobPathEntry) => boolean } {
  return {
    childrenIgnored: (entry) => {
      if (traversal && ++traversal.entries > MAX_GLOB_TRAVERSAL_ENTRIES) {
        traversal.exhausted = true;
        return true;
      }
      if (!entry.isSymbolicLink()) return false;
      try {
        const physicalPath = realpath(entry.fullpath());
        return !physicalRoots.some((root) => {
          const relativePath = path.relative(root, physicalPath);
          return (
            relativePath === '' ||
            (relativePath !== '..' &&
              !relativePath.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relativePath))
          );
        });
      } catch {
        return true;
      }
    },
  };
}

export function normalizeGlobSeparators(
  value: string,
  windowsPathsNoEscape = false,
): string {
  const normalizedParts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (character !== '\\') {
      normalizedParts.push(character);
      continue;
    }
    let end = index + 1;
    while (value.charAt(end) === '\\') end++;
    const next = value.charAt(end);
    if (!windowsPathsNoEscape && '{}[]()'.includes(next)) {
      normalizedParts.push(value.slice(index, end), next);
      index = end;
      continue;
    }
    normalizedParts.push('/'.repeat(end - index));
    index = end - 1;
  }
  const normalized = normalizedParts.join('');
  if (windowsPathsNoEscape && /^\/[A-Za-z]:\//.test(normalized)) {
    return normalized.slice(1);
  }
  return normalized;
}

export function hasUnsafeGlobTraversal(
  value: string,
  windowsPathsNoEscape = false,
): boolean {
  let sawMagic = false;
  const traversalPattern = windowsPathsNoEscape
    ? normalizeGlobSeparators(value, true)
    : value;
  for (const segment of traversalPattern.split('/')) {
    const segmentHasMagic = /[*?[\]{}()!+@]/.test(segment);
    if (
      (sawMagic || segmentHasMagic) &&
      new Minimatch(segment, {
        dot: true,
        nobrace: true,
        nonegate: true,
      }).match('..')
    ) {
      return true;
    }
    sawMagic ||= segmentHasMagic;
  }
  return false;
}

/**
 * Checks untrusted glob syntax without invoking minimatch's brace parser.
 * Numeric ranges need special handling because some brace-expansion versions
 * materialize the entire range before applying their configured limit.
 */
export function preflightGlob(
  value: string,
  {
    maxLength,
    maxBraceExpansions,
    windowsPathsNoEscape = false,
  }: GlobPreflightOptions,
): GlobPreflightResult {
  if (
    value.length > maxLength ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    return 'invalid';
  }

  const expectedClosers: Array<{ closer: string; opener: number }> = [];
  let extglobTokens = 0;
  let extglobDepth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (!windowsPathsNoEscape && character === '\\') {
      index++;
      continue;
    }
    if (character === ']') {
      let classIndex = expectedClosers.length - 1;
      while (classIndex >= 0 && expectedClosers[classIndex].closer === '}') {
        classIndex--;
      }
      if (classIndex >= 0 && expectedClosers[classIndex].closer === ']') {
        expectedClosers.length = classIndex;
        continue;
      }
    }
    if (expectedClosers[expectedClosers.length - 1]?.closer === ']') {
      if (character === '{') {
        if (expectedClosers.length >= MAX_GLOB_DELIMITER_DEPTH)
          return 'invalid';
        expectedClosers.push({ closer: '}', opener: index });
        continue;
      }
      continue;
    }
    if (character === '{' || character === '[') {
      if (expectedClosers.length >= MAX_GLOB_DELIMITER_DEPTH) return 'invalid';
      expectedClosers.push({
        closer: character === '{' ? '}' : ']',
        opener: index,
      });
      continue;
    }
    if (
      character === '(' &&
      index > 0 &&
      '*+?@!'.includes(value.charAt(index - 1))
    ) {
      if (
        expectedClosers.length >= MAX_GLOB_DELIMITER_DEPTH ||
        extglobTokens >= MAX_EXTGLOB_TOKENS ||
        extglobDepth >= MAX_EXTGLOB_DEPTH
      ) {
        return 'invalid';
      }
      extglobTokens++;
      extglobDepth++;
      expectedClosers.push({ closer: ')', opener: index });
      continue;
    }
    if (!'}])'.includes(character) || expectedClosers.length === 0) continue;

    const opener = expectedClosers.pop();
    if (!opener || opener.closer !== character) return 'invalid';
    if (character === ')') extglobDepth--;
    if (character !== '}') continue;

    const body = value.slice(opener.opener + 1, index);
    if (!/^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(body)) continue;
    const numericParts = body.split('..');
    if (numericParts.some((part) => part.replace(/^-/, '').length > 15)) {
      return 'too-many-braces';
    }
    const start = Number(numericParts[0]);
    const end = Number(numericParts[1]);
    const step = Math.max(Math.abs(Number(numericParts[2] ?? '1')), 1);
    if (Math.floor(Math.abs(end - start) / step) + 1 > maxBraceExpansions) {
      return 'too-many-braces';
    }
  }

  return expectedClosers.length === 0 ? 'safe' : 'invalid';
}
