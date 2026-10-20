import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 3,
    testTimeout: 30000,
  },
});
