import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // node:sqlite still prints an ExperimentalWarning on Node 22 and 24.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/cli/**'],
      reporter: ['text', 'text-summary', 'lcov'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 75 },
    },
  },
});
