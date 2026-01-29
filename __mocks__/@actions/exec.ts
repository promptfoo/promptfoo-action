// Manual mock for @actions/exec (ESM-only package)
import { vi } from 'vitest';

export const exec = vi.fn().mockResolvedValue(0);
export const getExecOutput = vi.fn().mockResolvedValue({
  exitCode: 0,
  stdout: '',
  stderr: '',
});
