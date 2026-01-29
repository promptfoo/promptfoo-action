// Manual mock for @actions/github (has ESM-only dependencies)
import { vi } from 'vitest';

export const context = {
  eventName: 'pull_request',
  payload: {
    pull_request: {
      number: 123,
      base: { ref: 'main' },
      head: { ref: 'feature-branch' },
    },
  },
  repo: {
    owner: 'test-owner',
    repo: 'test-repo',
  },
  sha: '',
};

export const getOctokit = vi.fn(() => ({
  rest: {
    issues: {
      createComment: vi.fn(() => Promise.resolve({})),
    },
  },
}));
