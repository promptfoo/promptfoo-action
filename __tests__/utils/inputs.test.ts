import { describe, expect, test } from 'vitest';
import {
  parseOptionalPercentage,
  parseOptionalPositiveInt,
  parseStrictPositiveInt,
} from '../../src/utils/inputs';

describe('parseStrictPositiveInt', () => {
  test('accepts valid positive integers', () => {
    expect(parseStrictPositiveInt('1', 'test')).toBe(1);
    expect(parseStrictPositiveInt('2', 'test')).toBe(2);
    expect(parseStrictPositiveInt('100', 'test')).toBe(100);
  });

  test('rejects zero', () => {
    expect(() => parseStrictPositiveInt('0', 'test')).toThrow(
      'test must be a positive integer',
    );
  });

  test('rejects negative numbers', () => {
    expect(() => parseStrictPositiveInt('-1', 'test')).toThrow(
      'test must be a positive integer',
    );
  });

  test('rejects floats', () => {
    expect(() => parseStrictPositiveInt('2.5', 'test')).toThrow(
      'test must be a positive integer',
    );
    expect(() => parseStrictPositiveInt('2.0', 'test')).toThrow(
      'test must be a positive integer',
    );
  });

  test('rejects non-numeric strings', () => {
    expect(() => parseStrictPositiveInt('abc', 'test')).toThrow(
      'test must be a positive integer',
    );
    expect(() => parseStrictPositiveInt('2abc', 'test')).toThrow(
      'test must be a positive integer',
    );
  });

  test('rejects leading zeros', () => {
    expect(() => parseStrictPositiveInt('02', 'test')).toThrow(
      'test must be a positive integer',
    );
  });
});

describe('parseOptionalPositiveInt', () => {
  test('returns undefined for empty string', () => {
    expect(parseOptionalPositiveInt('', 'test')).toBeUndefined();
  });

  test('parses valid values', () => {
    expect(parseOptionalPositiveInt('3', 'test')).toBe(3);
  });

  test('rejects invalid values', () => {
    expect(() => parseOptionalPositiveInt('0', 'test')).toThrow();
  });
});

describe('parseOptionalPercentage', () => {
  test('returns undefined for empty string', () => {
    expect(parseOptionalPercentage('', 'test')).toBeUndefined();
  });

  test('accepts valid percentages', () => {
    expect(parseOptionalPercentage('0', 'test')).toBe(0);
    expect(parseOptionalPercentage('50', 'test')).toBe(50);
    expect(parseOptionalPercentage('100', 'test')).toBe(100);
    expect(parseOptionalPercentage('66.7', 'test')).toBe(66.7);
  });

  test('rejects out-of-range values', () => {
    expect(() => parseOptionalPercentage('-1', 'test')).toThrow(
      'test must be a number between 0 and 100',
    );
    expect(() => parseOptionalPercentage('101', 'test')).toThrow(
      'test must be a number between 0 and 100',
    );
  });

  test('rejects non-numeric strings', () => {
    expect(() => parseOptionalPercentage('abc', 'test')).toThrow(
      'test must be a number between 0 and 100',
    );
  });
});
