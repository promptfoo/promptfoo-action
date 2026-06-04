import * as core from '@actions/core';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Logger } from '../../src/utils/logger';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  group: vi.fn(
    async (_name: string, fn: () => void | Promise<void>) => await fn(),
  ),
  info: vi.fn(),
  warning: vi.fn(),
}));

const mockCore = core as unknown as {
  debug: Mock;
  error: Mock;
  group: Mock;
  info: Mock;
  warning: Mock;
};

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('suppresses debug output when debug mode is disabled', () => {
    const logger = new Logger();

    logger.debug('hidden', { value: 1 });

    expect(mockCore.debug).not.toHaveBeenCalled();
  });

  test('logs debug messages and structured data in debug mode', () => {
    const logger = new Logger(true);

    logger.debug('details', { value: 1 });

    expect(mockCore.debug).toHaveBeenNthCalledWith(1, '[DEBUG] details');
    expect(mockCore.debug).toHaveBeenNthCalledWith(
      2,
      '[DEBUG] Data: {\n  "value": 1\n}',
    );
  });

  test('does not add a data log when data is undefined', () => {
    const logger = new Logger(true);

    logger.debug('details');

    expect(mockCore.debug).toHaveBeenCalledTimes(1);
  });

  test('forwards standard log levels', () => {
    const logger = new Logger();

    logger.info('info');
    logger.warning('warning');
    logger.error('error');

    expect(mockCore.info).toHaveBeenCalledWith('info');
    expect(mockCore.warning).toHaveBeenCalledWith('warning');
    expect(mockCore.error).toHaveBeenCalledWith('error');
  });

  test('uses an actions group in debug mode', async () => {
    const logger = new Logger(true);
    const callback = vi.fn();

    await logger.group('evaluation', callback);

    expect(mockCore.group).toHaveBeenCalledWith(
      '[DEBUG] evaluation',
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledOnce();
  });

  test('runs the callback directly when debug mode is disabled', async () => {
    const logger = new Logger();
    const callback = vi.fn().mockResolvedValue(undefined);

    await logger.group('evaluation', callback);

    expect(mockCore.group).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
  });
});
