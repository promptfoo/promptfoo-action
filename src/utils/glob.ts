export const MAX_BRACE_EXPANSIONS = 1024;
export const MAX_GLOB_PATTERN_LENGTH = 4096;
const MAX_NUMERIC_BRACE_ENDPOINT_WIDTH = 256;

const NUMERIC_BRACE_RANGE_PATTERN = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g;
const ZERO = BigInt(0);
const ONE = BigInt(1);

export function normalizeRuntimeGlobPattern(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

export function hasGlobCharacterClass(pattern: string): boolean {
  const openingBracket = pattern.indexOf('[');
  return (
    openingBracket !== -1 && pattern.indexOf(']', openingBracket + 1) !== -1
  );
}

export function hasUnsafeNumericGlobRange(pattern: string): boolean {
  for (const match of pattern.matchAll(NUMERIC_BRACE_RANGE_PATTERN)) {
    if (process.platform !== 'win32') {
      let escapeCount = 0;
      for (
        let index = match.index - 1;
        index >= 0 && pattern[index] === '\\';
        index--
      ) {
        escapeCount++;
      }
      if (escapeCount % 2 === 1) continue;
    }
    if (
      match[1].length > MAX_NUMERIC_BRACE_ENDPOINT_WIDTH ||
      match[2].length > MAX_NUMERIC_BRACE_ENDPOINT_WIDTH
    ) {
      return true;
    }
    const start = BigInt(match[1]);
    const end = BigInt(match[2]);
    const rawStep = match[3] ? BigInt(match[3]) : ONE;
    if (rawStep === ZERO) return true;
    const step = rawStep < ZERO ? -rawStep : rawStep;
    const distance = start > end ? start - end : end - start;
    if (distance / step >= BigInt(MAX_BRACE_EXPANSIONS)) {
      return true;
    }
  }

  return false;
}

export function hasBalancedGlobDelimiters(pattern: string): boolean {
  const expectedClosers: string[] = [];
  const closers: Record<string, string> = {
    '{': '}',
    '(': ')',
    '[': ']',
  };
  const escapedOpeningClosers: Record<string, number> = {
    '}': 0,
    ')': 0,
    ']': 0,
  };
  let inCharacterClass = false;
  let inPosixCharacterClass = false;
  let escaped = false;
  let openExtglobClosers = 0;

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (escaped) {
      if (character in closers) {
        escapedOpeningClosers[closers[character]]++;
      }
      escaped = false;
      continue;
    }
    if (process.platform !== 'win32' && character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (
        !inPosixCharacterClass &&
        character === '[' &&
        pattern[index + 1] === ':'
      ) {
        inPosixCharacterClass = true;
        index++;
        continue;
      }
      if (inPosixCharacterClass) {
        if (character === ':' && pattern[index + 1] === ']') {
          inPosixCharacterClass = false;
          index++;
        }
        continue;
      }
      if (character === ']') {
        inCharacterClass = false;
      }
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
    } else if (character in closers) {
      let isExtglob = /[?*+@!]/.test(pattern[index - 1] ?? '');
      if (character === '(' && isExtglob && process.platform !== 'win32') {
        let escapeIndex = index - 2;
        while (pattern[escapeIndex] === '\\') {
          escapeIndex--;
        }
        isExtglob = (index - 2 - escapeIndex) % 2 === 0;
      }
      if (character !== '(' || isExtglob) {
        expectedClosers.push(closers[character]);
        if (character === '(') {
          openExtglobClosers++;
        }
      }
    } else if (character === '}' || character === ')' || character === ']') {
      if (expectedClosers[expectedClosers.length - 1] === character) {
        expectedClosers.pop();
        if (character === ')') {
          openExtglobClosers--;
        }
      } else if (escapedOpeningClosers[character] > 0) {
        escapedOpeningClosers[character]--;
      } else if (character !== ')' || openExtglobClosers > 0) {
        return false;
      }
    }
  }

  return (
    expectedClosers.length === 0 && !inCharacterClass && !inPosixCharacterClass
  );
}
