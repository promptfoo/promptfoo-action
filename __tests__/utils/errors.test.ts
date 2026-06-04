import { describe, expect, test } from 'vitest';
import {
  ErrorCodes,
  formatErrorMessage,
  PromptfooActionError,
} from '../../src/utils/errors';

describe('PromptfooActionError', () => {
  test('preserves structured error details', () => {
    const error = new PromptfooActionError(
      'Invalid configuration',
      ErrorCodes.INVALID_CONFIGURATION,
      'Check the action inputs',
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PromptfooActionError');
    expect(error.message).toBe('Invalid configuration');
    expect(error.code).toBe(ErrorCodes.INVALID_CONFIGURATION);
    expect(error.helpText).toBe('Check the action inputs');
  });
});

describe('formatErrorMessage', () => {
  test('includes help text for action errors', () => {
    const error = new PromptfooActionError(
      'Evaluation failed',
      ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
      'Inspect the evaluation logs',
    );

    expect(formatErrorMessage(error)).toBe(
      'Error: Evaluation failed\n\nHelp: Inspect the evaluation logs',
    );
  });

  test('omits the help section when no help text is provided', () => {
    const error = new PromptfooActionError(
      'Evaluation failed',
      ErrorCodes.PROMPTFOO_EXECUTION_FAILED,
    );

    expect(formatErrorMessage(error)).toBe('Error: Evaluation failed');
  });

  test('formats standard errors', () => {
    expect(formatErrorMessage(new TypeError('Bad value'))).toBe(
      'Error: Bad value',
    );
  });

  test.each([
    ['string values', 'failure', 'Error: failure'],
    ['numeric values', 42, 'Error: 42'],
    ['null', null, 'Error: null'],
  ])('formats non-error %s', (_label, value, expected) => {
    expect(formatErrorMessage(value)).toBe(expected);
  });
});
