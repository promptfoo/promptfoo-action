import { braceExpand } from 'minimatch';

export const MAX_GLOB_PATTERN_LENGTH = 64 * 1_024;
export const MAX_BRACE_EXPANSIONS = 1_024;
const MAX_BRACE_DEPTH = 64;
const MAX_NUMERIC_RANGE_WIDTH = 64;

export function canSafelyInspectGlob(pattern: string): boolean {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH || pattern.includes('\0')) {
    return false;
  }

  let braceDepth = 0;
  let inCharacterClass = false;
  let classBraceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && process.platform !== 'win32') {
      index += 1;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      classBraceDepth = 0;
      continue;
    }
    if (character === ']') {
      inCharacterClass = false;
      classBraceDepth = 0;
      continue;
    }
    if (inCharacterClass) {
      if (character === '{') {
        classBraceDepth += 1;
        if (classBraceDepth > MAX_BRACE_DEPTH) return false;
      } else if (character === '}' && classBraceDepth > 0) {
        classBraceDepth -= 1;
      }
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      if (braceDepth > MAX_BRACE_DEPTH) return false;
    } else if (character === '}') {
      if (braceDepth === 0) return false;
      braceDepth -= 1;
    }
  }
  if (braceDepth !== 0) return false;

  const numericRange = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g;
  for (
    let match = numericRange.exec(pattern);
    match !== null;
    match = numericRange.exec(pattern)
  ) {
    let precedingSlashes = 0;
    for (let index = match.index - 1; pattern[index] === '\\'; index -= 1) {
      precedingSlashes += 1;
    }
    if (process.platform !== 'win32' && precedingSlashes % 2 === 1) continue;

    if (
      (match[1]?.length ?? 0) > MAX_NUMERIC_RANGE_WIDTH ||
      (match[2]?.length ?? 0) > MAX_NUMERIC_RANGE_WIDTH ||
      (match[3]?.length ?? 0) > MAX_NUMERIC_RANGE_WIDTH
    ) {
      return false;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const step = Math.abs(Number(match[3] ?? 1));
    const span = Math.abs(end - start);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(step) ||
      !Number.isSafeInteger(span) ||
      step === 0 ||
      Math.floor(span / step) + 1 > MAX_BRACE_EXPANSIONS
    ) {
      return false;
    }
  }

  return true;
}

export function safelyExpandGlob(pattern: string): string[] | undefined {
  if (!canSafelyInspectGlob(pattern)) return undefined;

  const expandedPatterns = braceExpand(pattern, {
    braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
  });
  return expandedPatterns.length > MAX_BRACE_EXPANSIONS
    ? undefined
    : expandedPatterns;
}
