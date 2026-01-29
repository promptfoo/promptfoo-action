import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
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
      // Use path.resolve for robust alias resolution regardless of cwd
      '@actions/core': path.resolve(__dirname, '__mocks__/@actions/core.ts'),
      '@actions/exec': path.resolve(__dirname, '__mocks__/@actions/exec.ts'),
      '@actions/github': path.resolve(
        __dirname,
        '__mocks__/@actions/github.ts',
      ),
    },
  },
});
