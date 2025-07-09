// Jest setup file for global test configuration

// Set test timeout
jest.setTimeout(10000);

// Add custom matchers if needed
expect.extend({
  toBeWithinRange(received, floor, ceiling) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

// Global test utilities
global.testUtils = {
  // Add any global test utilities here
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Mock console methods to avoid noise in tests
  mockConsole: () => {
    const originalConsole = { ...console };
    beforeAll(() => {
      console.log = jest.fn();
      console.warn = jest.fn();
      console.error = jest.fn();
    });
    afterAll(() => {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    });
  }
};

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

// Ensure unhandled promise rejections fail tests
process.on('unhandledRejection', (reason) => {
  throw reason;
});

// Add performance tracking
if (process.env.JEST_PERFORMANCE_TRACKING) {
  let testStartTime;
  
  beforeEach(() => {
    testStartTime = Date.now();
  });
  
  afterEach(() => {
    const testEndTime = Date.now();
    const duration = testEndTime - testStartTime;
    if (duration > 1000) {
      console.warn(`Test took ${duration}ms to complete`);
    }
  });
}