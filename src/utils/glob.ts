export const MAX_BRACE_EXPANSIONS = 1024;
export const MAX_GLOB_PATTERN_LENGTH = 4096;
const MAX_NUMERIC_BRACE_ENDPOINT_WIDTH = 256;

const NUMERIC_BRACE_RANGE_PATTERN = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g;
const ZERO = BigInt(0);
const ONE = BigInt(1);

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
  const escapedOpeningClosers: string[] = [];
  let inCharacterClass = false;
  let escaped = false;

  for (const character of pattern) {
    if (escaped) {
      if (character in closers) {
        escapedOpeningClosers.push(closers[character]);
      }
      escaped = false;
      continue;
    }
    if (process.platform !== 'win32' && character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
      }
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
    } else if (character in closers) {
      expectedClosers.push(closers[character]);
    } else if (character === '}' || character === ')' || character === ']') {
      if (expectedClosers[expectedClosers.length - 1] === character) {
        expectedClosers.pop();
      } else if (escapedOpeningClosers.includes(character)) {
        escapedOpeningClosers.splice(
          escapedOpeningClosers.lastIndexOf(character),
          1,
        );
      } else {
        return false;
      }
    }
  }

  return expectedClosers.length === 0 && !inCharacterClass;
}
