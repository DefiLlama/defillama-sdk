// JEST_VERBOSE=true restores the default reporter and console output (used by `npm run test-debug`)
const verbose = process.env.JEST_VERBOSE === 'true'

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  setupFilesAfterEnv: ['./jest.setup.js'],
  silent: !verbose,
  reporters: verbose ? ['default'] : ['<rootDir>/scripts/jestSummaryReporter.js'],
};
