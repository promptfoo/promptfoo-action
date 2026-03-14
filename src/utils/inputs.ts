import { ErrorCodes, PromptfooActionError } from './errors';

export function parseStrictPositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || String(n) !== value) {
    throw new PromptfooActionError(
      `${name} must be a positive integer, got "${value}"`,
      ErrorCodes.INVALID_CONFIGURATION,
      `Provide a whole number like 2 or 3, not "${value}"`,
    );
  }
  return n;
}

export function parseOptionalPositiveInt(
  raw: string,
  name: string,
): number | undefined {
  if (!raw) return undefined;
  return parseStrictPositiveInt(raw, name);
}

export function parseOptionalPercentage(
  raw: string,
  name: string,
): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0 || n > 100) {
    throw new PromptfooActionError(
      `${name} must be a number between 0 and 100, got "${raw}"`,
      ErrorCodes.INVALID_CONFIGURATION,
      `Provide a percentage like 80, not "${raw}"`,
    );
  }
  return n;
}
