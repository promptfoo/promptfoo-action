// Manual mock for @actions/core (ESM-only in v3)
export const getInput = jest.fn();
export const getBooleanInput = jest.fn();
export const setOutput = jest.fn();
export const setFailed = jest.fn();
export const setSecret = jest.fn();
export const info = jest.fn();
export const debug = jest.fn();
export const warning = jest.fn();
export const error = jest.fn();
export const startGroup = jest.fn();
export const endGroup = jest.fn();
export const summary = {
  addHeading: jest.fn().mockReturnThis(),
  addTable: jest.fn().mockReturnThis(),
  addList: jest.fn().mockReturnThis(),
  addLink: jest.fn().mockReturnThis(),
  addRaw: jest.fn().mockReturnThis(),
  write: jest.fn().mockResolvedValue(undefined),
};
