type GlobPreflightOptions = {
  maxLength: number;
  maxBraceExpansions: number;
  windowsPathsNoEscape?: boolean;
};

export type GlobPreflightResult = 'safe' | 'invalid' | 'too-many-braces';
const MAX_GLOB_DELIMITER_DEPTH = 128;

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
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (!windowsPathsNoEscape && character === '\\') {
      index++;
      continue;
    }
    if (expectedClosers[expectedClosers.length - 1]?.closer === ']') {
      if (character === '{') {
        if (expectedClosers.length >= MAX_GLOB_DELIMITER_DEPTH)
          return 'invalid';
        expectedClosers.push({ closer: '}', opener: index });
        continue;
      }
      if (character === ']') expectedClosers.pop();
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
      if (expectedClosers.length >= MAX_GLOB_DELIMITER_DEPTH) return 'invalid';
      expectedClosers.push({ closer: ')', opener: index });
      continue;
    }
    if (!'}])'.includes(character) || expectedClosers.length === 0) continue;

    const opener = expectedClosers.pop();
    if (!opener || opener.closer !== character) return 'invalid';
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
