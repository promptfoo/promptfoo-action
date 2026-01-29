// Manual mock for @actions/core (ESM-only in v3)
import { vi } from 'vitest';

export const getInput = vi.fn();
export const getBooleanInput = vi.fn();
export const setOutput = vi.fn();
export const setFailed = vi.fn();
export const setSecret = vi.fn();
export const info = vi.fn();
export const debug = vi.fn();
export const warning = vi.fn();
export const error = vi.fn();
export const startGroup = vi.fn();
export const endGroup = vi.fn();

// Make summary a mutable object that can be reset in tests
export let summary = {
  addHeading: vi.fn().mockReturnThis(),
  addTable: vi.fn().mockReturnThis(),
  addList: vi.fn().mockReturnThis(),
  addLink: vi.fn().mockReturnThis(),
  addRaw: vi.fn().mockReturnThis(),
  write: vi.fn().mockResolvedValue(undefined),
};

// Helper to reset summary mock
export const resetSummary = () => {
  summary = {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  };
};
