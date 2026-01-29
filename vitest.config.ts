import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'promptfoo'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**', 'src/**/index.ts'],
    },
    alias: {
      '@actions/core': './__mocks__/@actions/core.ts',
      '@actions/exec': './__mocks__/@actions/exec.ts',
      '@actions/github': './__mocks__/@actions/github.ts',
    },
  },
});
