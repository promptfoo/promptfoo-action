export function isSafeGlobPattern(
  pattern: string,
  maxPatternLength: number,
  maxBraceExpansions: number,
  windowsPathsNoEscape = false,
): boolean {
  if (pattern.length > maxPatternLength || pattern.includes('\0')) {
    return false;
  }

  for (const range of pattern.matchAll(
    /\{(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?\}/g,
  )) {
    let escapes = 0;
    if (!windowsPathsNoEscape) {
      for (
        let index = range.index - 1;
        index >= 0 && pattern[index] === '\\';
        index--
      ) {
        escapes++;
      }
    }
    if (escapes % 2 === 1) {
      continue;
    }

    const start = Number(range[1]);
    const end = Number(range[2]);
    const step = Math.abs(Number(range[3] ?? 1));
    const span = Math.abs(end - start);
    const expansionCount = Math.floor(span / step) + 1;
    const endpointWidth = Math.max(range[1].length, range[2].length);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(step) ||
      step === 0 ||
      !Number.isSafeInteger(span) ||
      expansionCount > maxBraceExpansions ||
      expansionCount * endpointWidth > maxPatternLength
    ) {
      return false;
    }
  }
  return true;
}
