import * as path from 'path';

export const MAX_GLOB_PATTERN_LENGTH = 64 * 1024;
export const MAX_GLOB_BRACE_EXPANSIONS = 1024;
const MAX_GLOB_BRACE_DEPTH = 32;
const MAX_GLOB_NUMERIC_RANGE_WIDTH = 64;
const MAX_GLOB_EXPANDED_BYTES = 4 * 1024 * 1024;

export function validateGlobPattern(
  globPattern: string,
  description: string,
): void {
  if (globPattern.length > MAX_GLOB_PATTERN_LENGTH) {
    throw new Error(`${description} is too long.`);
  }
  if (globPattern.includes('\0')) {
    throw new Error(`${description} contains an invalid null byte.`);
  }

  const usesWindowsSeparators =
    path.sep === '\\' ||
    (!path.isAbsolute(globPattern) && path.win32.isAbsolute(globPattern));
  let braceDepth = 0;
  let escapedOpeningBraces = 0;
  let inCharacterClass = false;
  let braceExpansionCount = 1;
  const braceAlternativeCounts: number[] = [];
  const bracesStartedInCharacterClass: boolean[] = [];
  for (let index = 0; index < globPattern.length; index++) {
    const character = globPattern[index];
    if (character === '\\' && !usesWindowsSeparators) {
      if (globPattern[index + 1] === '{') {
        escapedOpeningBraces++;
      }
      index++;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (character === '{') {
      braceDepth++;
      braceAlternativeCounts.push(1);
      bracesStartedInCharacterClass.push(inCharacterClass);
      if (braceDepth > MAX_GLOB_BRACE_DEPTH) {
        throw new Error(`${description} is malformed.`);
      }
    } else if (character === ',' && braceDepth > 0) {
      braceAlternativeCounts[braceDepth - 1]++;
    } else if (character === '}') {
      if (braceDepth === 0 && inCharacterClass) {
        continue;
      }
      if (braceDepth === 0 && escapedOpeningBraces > 0) {
        escapedOpeningBraces--;
        continue;
      }
      braceDepth--;
      if (braceDepth < 0) {
        throw new Error(`${description} is malformed.`);
      }
      braceExpansionCount *= braceAlternativeCounts[braceDepth];
      braceAlternativeCounts.length = braceDepth;
      bracesStartedInCharacterClass.length = braceDepth;
    }
  }
  if (
    inCharacterClass ||
    bracesStartedInCharacterClass.some((startedInClass) => !startedInClass)
  ) {
    throw new Error(`${description} is malformed.`);
  }
  if (globPattern.length * braceExpansionCount > MAX_GLOB_EXPANDED_BYTES) {
    throw new Error(`${description} exceeds the safe expansion size.`);
  }

  let numericExpansionCount = braceExpansionCount;
  for (const match of globPattern.matchAll(
    /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g,
  )) {
    let openingEscapes = 0;
    for (
      let index = match.index - 1;
      index >= 0 && globPattern[index] === '\\';
      index--
    ) {
      openingEscapes++;
    }
    if (!usesWindowsSeparators && openingEscapes % 2 === 1) {
      continue;
    }
    if (
      Math.max(match[1].length, match[2].length, match[3]?.length ?? 0) >
      MAX_GLOB_NUMERIC_RANGE_WIDTH
    ) {
      throw new Error(`${description} exceeds the safe expansion size.`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const increment = Math.max(Math.abs(Number(match[3] ?? 1)), 1);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(increment)
    ) {
      throw new Error(
        `${description} expands to more than ${MAX_GLOB_BRACE_EXPANSIONS} alternatives.`,
      );
    }
    numericExpansionCount *= Math.floor(Math.abs(end - start) / increment) + 1;
    if (numericExpansionCount > MAX_GLOB_BRACE_EXPANSIONS) {
      throw new Error(
        `${description} expands to more than ${MAX_GLOB_BRACE_EXPANSIONS} alternatives.`,
      );
    }
    if (globPattern.length * numericExpansionCount > MAX_GLOB_EXPANDED_BYTES) {
      throw new Error(`${description} exceeds the safe expansion size.`);
    }
  }
}
