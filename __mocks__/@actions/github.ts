// Manual mock for @actions/github (has ESM-only dependencies)
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

export const getOctokit = jest.fn(() => ({
  rest: {
    issues: {
      createComment: jest.fn(() => Promise.resolve({})),
    },
  },
}));
