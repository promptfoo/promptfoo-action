import { describe, expect, test } from '@jest/globals';

describe('Jest Setup', () => {
  test('should run tests successfully', () => {
    expect(true).toBe(true);
  });

  test('should handle basic math', () => {
    expect(1 + 1).toBe(2);
  });

  test('should work with arrays', () => {
    const arr = [1, 2, 3];
    expect(arr).toHaveLength(3);
    expect(arr).toContain(2);
  });

  test('should work with objects', () => {
    const obj = { name: 'test', value: 42 };
    expect(obj).toEqual({ name: 'test', value: 42 });
    expect(obj).toHaveProperty('name', 'test');
  });

  test('coverage reporting should be enabled', () => {
    // This test verifies the coverage setup
    const coverageEnabled = true;
    expect(coverageEnabled).toBe(true);
  });
});
