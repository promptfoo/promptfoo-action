export type GlobRangeError = 'invalid' | 'too-many';

export function normalizeGlobPattern(
  globPattern: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return globPattern.replace(/\\/g, '/');
  let normalized = '';
  for (let index = 0; index < globPattern.length; index++) {
    if (globPattern[index] !== '\\') {
      normalized += globPattern[index];
      continue;
    }
    let end = index + 1;
    while (globPattern[end] === '\\') end++;
    const slashCount = end - index;
    normalized += '{}[]()'.includes(globPattern[end] ?? '\0')
      ? '\\'.repeat(slashCount)
      : '/'.repeat(slashCount);
    index = end - 1;
  }
  return normalized;
}

function removePosixEscapes(globPattern: string): string {
  const characters = globPattern.split('');
  for (let index = 0; index < characters.length; index++) {
    if (characters[index] !== '\\') continue;
    characters[index] = ' ';
    if (index + 1 < characters.length) characters[++index] = ' ';
  }
  return characters.join('');
}

export function getGlobRangeError(
  globPattern: string,
  maxExpansions: number,
  platform: NodeJS.Platform = process.platform,
): GlobRangeError | undefined {
  const rangeSource =
    platform === 'win32'
      ? normalizeGlobPattern(globPattern, platform)
      : removePosixEscapes(globPattern);
  const rangePattern = /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g;
  for (const range of rangeSource.matchAll(rangePattern)) {
    const startText = range[1];
    const endText = range[2];
    const stepText = range[3] ?? '1';
    if (startText.length > 16 || endText.length > 16 || stepText.length > 16) {
      return 'invalid';
    }
    const start = Number(startText);
    const end = Number(endText);
    const step = Math.abs(Number(stepText));
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(step) ||
      step === 0
    ) {
      return 'invalid';
    }
    if (Math.floor(Math.abs(end - start) / step) + 1 > maxExpansions) {
      return 'too-many';
    }
  }
  if (/\{[A-Za-z]\.\.[A-Za-z]\.\.-?0+\}/.test(rangeSource)) {
    return 'invalid';
  }
  return undefined;
}

export function hasBalancedGlobDelimiters(
  globPattern: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const expectedClosers: string[] = [];
  for (let index = 0; index < globPattern.length; index++) {
    const character = globPattern[index];
    if (platform !== 'win32' && character === '\\') {
      index++;
      continue;
    }
    if (expectedClosers[expectedClosers.length - 1] === ']') {
      if (character === ']') expectedClosers.pop();
      continue;
    }
    if (character === '{') {
      expectedClosers.push('}');
    } else if (character === '[') {
      expectedClosers.push(']');
    } else if (
      character === '(' &&
      index > 0 &&
      ['!', '?', '+', '*', '@'].includes(globPattern[index - 1])
    ) {
      expectedClosers.push(')');
    } else if (character === '}' || character === ']' || character === ')') {
      const expected = expectedClosers[expectedClosers.length - 1];
      if (expected && expected !== character) return false;
      if (expected === character) expectedClosers.pop();
    }
  }
  return expectedClosers.length === 0;
}
