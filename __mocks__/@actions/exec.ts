// Manual mock for @actions/exec (ESM-only package)
export const exec = jest.fn().mockResolvedValue(0);
export const getExecOutput = jest.fn().mockResolvedValue({
  exitCode: 0,
  stdout: '',
  stderr: '',
});
