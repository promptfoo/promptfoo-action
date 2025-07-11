import * as core from '@actions/core';

export class Logger {
  private debugMode: boolean;

  constructor(debugMode = false) {
    this.debugMode = debugMode;
  }

  debug(message: string, data?: unknown): void {
    if (this.debugMode) {
      core.debug(`[DEBUG] ${message}`);
      if (data !== undefined) {
        core.debug(`[DEBUG] Data: ${JSON.stringify(data, null, 2)}`);
      }
    }
  }

  info(message: string): void {
    core.info(message);
  }

  warning(message: string): void {
    core.warning(message);
  }

  error(message: string): void {
    core.error(message);
  }

  async group(name: string, fn: () => void | Promise<void>): Promise<void> {
    if (this.debugMode) {
      return core.group(`[DEBUG] ${name}`, async () => {
        await fn();
      });
    }
    await fn();
  }
}
