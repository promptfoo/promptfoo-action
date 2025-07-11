module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/__tests__/**/*.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/promptfoo/'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  verbose: true,
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
