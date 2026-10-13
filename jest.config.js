/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { warnOnly: false } }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests/unit'],
      transform: { '^.+\\.ts$': tsJest },
      setupFiles: ['<rootDir>/tests/setupEnv.ts'],
    },
    {
      // Requires a migrated + seeded PostgreSQL database (see README "Testing").
      displayName: 'e2e',
      testEnvironment: 'node',
      testTimeout: 60_000,
      roots: ['<rootDir>/tests/e2e'],
      transform: { '^.+\\.ts$': tsJest },
      setupFiles: ['<rootDir>/tests/setupEnv.ts'],
    },
  ],
};
