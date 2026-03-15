import type { EvaluateResult } from 'promptfoo';
import { describe, expect, test, vi } from 'vitest';
import {
  evaluateRepeatThreshold,
  formatRepeatCommentMarkdown,
  formatRepeatFailureMessage,
  groupResultsByTest,
  validateGroups,
} from '../../src/utils/thresholds';

// Minimal EvaluateResult factory for testing
function makeResult(
  overrides: Partial<EvaluateResult> & { promptIdx: number; success: boolean },
): EvaluateResult {
  return {
    testIdx: 0,
    promptIdx: overrides.promptIdx,
    success: overrides.success,
    score: overrides.success ? 1 : 0,
    latencyMs: 0,
    provider: { id: 'test' },
    prompt: { raw: 'test', label: 'test', display: 'test' },
    failureReason: overrides.success ? 0 : 1,
    namedScores: {},
    vars: overrides.vars || {},
    ...overrides,
  } as EvaluateResult;
}

describe('groupResultsByTest', () => {
  test('groups by description + promptIdx + provider', () => {
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: false, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test B' }),
    ];

    const groups = groupResultsByTest(results);
    expect(groups.size).toBe(2);

    const groupA = groups.get('desc:Test A:0:test');
    expect(groupA).toEqual({ successes: 1, total: 2, label: 'Test A [test]' });

    const groupB = groups.get('desc:Test B:0:test');
    expect(groupB).toEqual({ successes: 1, total: 1, label: 'Test B [test]' });
  });

  test('falls back to vars + promptIdx when no description', () => {
    const results = [
      makeResult({
        promptIdx: 0,
        success: true,
        vars: { q: 'hello' },
      }),
      makeResult({
        promptIdx: 0,
        success: false,
        vars: { q: 'hello' },
      }),
    ];

    const groups = groupResultsByTest(results);
    expect(groups.size).toBe(1);

    const key = 'vars:{"q":"hello"}:0:test';
    expect(groups.get(key)).toEqual({
      successes: 1,
      total: 2,
      label: 'test({"q":"hello"}) [test]',
    });
  });

  test('separates results by promptIdx', () => {
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 1, success: false, description: 'Test A' }),
    ];

    const groups = groupResultsByTest(results);
    expect(groups.size).toBe(2);
  });

  test('separates results by provider', () => {
    const results = [
      makeResult({
        promptIdx: 0,
        success: true,
        description: 'Test A',
        provider: { id: 'openai:gpt-4' },
      }),
      makeResult({
        promptIdx: 0,
        success: false,
        description: 'Test A',
        provider: { id: 'anthropic:claude' },
      }),
    ];

    const groups = groupResultsByTest(results);
    expect(groups.size).toBe(2);
    expect(groups.get('desc:Test A:0:openai:gpt-4')?.label).toBe(
      'Test A [openai:gpt-4]',
    );
    expect(groups.get('desc:Test A:0:anthropic:claude')?.label).toBe(
      'Test A [anthropic:claude]',
    );
  });

  test('includes promptIdx in labels for multi-prompt configs', () => {
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 1, success: false, description: 'Test A' }),
    ];

    const groups = groupResultsByTest(results);
    expect(groups.size).toBe(2);
    // Both labels should include prompt index since there are multiple prompts
    for (const [, group] of groups) {
      expect(group.label).toContain('prompt');
    }
  });
});

describe('validateGroups', () => {
  test('returns empty array when all groups have expected count', () => {
    const groups = new Map([
      ['a', { successes: 2, total: 3, label: 'Test A' }],
      ['b', { successes: 1, total: 3, label: 'Test B' }],
    ]);
    expect(validateGroups(groups, 3)).toEqual([]);
  });

  test('detects ambiguous groups (too many results)', () => {
    const groups = new Map([
      ['a', { successes: 4, total: 4, label: 'Test A' }],
    ]);
    const errors = validateGroups(groups, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      label: 'Test A',
      actual: 4,
      expected: 3,
      kind: 'ambiguous',
    });
  });

  test('detects partial groups (too few results)', () => {
    const groups = new Map([
      ['a', { successes: 2, total: 2, label: 'Test A' }],
    ]);
    const errors = validateGroups(groups, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      label: 'Test A',
      actual: 2,
      expected: 3,
      kind: 'partial',
    });
  });
});

describe('evaluateRepeatThreshold', () => {
  test('passes when all tests meet minimum', () => {
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: false, description: 'Test A' }),
    ];

    const { passed, summary } = evaluateRepeatThreshold(results, 2, 3);
    expect(passed).toBe(true);
    expect(summary.failures).toHaveLength(0);
    expect(summary.groupingErrors).toHaveLength(0);
    expect(summary.totalGroups).toBe(1);
  });

  test('fails when a test is below minimum', () => {
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: false, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: false, description: 'Test A' }),
    ];

    const { passed, summary } = evaluateRepeatThreshold(results, 2, 3);
    expect(passed).toBe(false);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toEqual({
      label: 'Test A [test]',
      passed: 1,
      total: 3,
    });
  });

  test('handles empty results', () => {
    const { passed, summary } = evaluateRepeatThreshold([], 2, 3);
    expect(passed).toBe(true);
    expect(summary.totalGroups).toBe(0);
  });

  test('fails hard on ambiguous groups instead of just warning', async () => {
    const core = await import('@actions/core');
    const warnSpy = vi.spyOn(core, 'warning');

    // 4 results with same description but repeat=3 — collision
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
    ];

    const { passed, summary } = evaluateRepeatThreshold(results, 2, 3);

    expect(passed).toBe(false);
    expect(summary.groupingErrors).toHaveLength(1);
    expect(summary.groupingErrors[0].kind).toBe('ambiguous');
    // Should still warn for logging
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has 4 results but expected 3'),
    );

    warnSpy.mockRestore();
  });

  test('fails hard on partial groups', async () => {
    const core = await import('@actions/core');
    const warnSpy = vi.spyOn(core, 'warning');

    // Only 2 results but repeat=3 — partial group
    const results = [
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
      makeResult({ promptIdx: 0, success: true, description: 'Test A' }),
    ];

    const { passed, summary } = evaluateRepeatThreshold(results, 2, 3);

    expect(passed).toBe(false);
    expect(summary.groupingErrors).toHaveLength(1);
    expect(summary.groupingErrors[0].kind).toBe('partial');

    warnSpy.mockRestore();
  });
});

describe('formatRepeatFailureMessage', () => {
  test('formats test failure message correctly', () => {
    const msg = formatRepeatFailureMessage({
      totalGroups: 3,
      failures: [
        { label: 'Test B', passed: 1, total: 3 },
        { label: 'Test C', passed: 0, total: 3 },
      ],
      groupingErrors: [],
      minPass: 2,
      repeatCount: 3,
    });

    expect(msg).toContain('2 test(s) failed the repeat check');
    expect(msg).toContain('min 2 of 3 required');
    expect(msg).toContain('Test B: passed 1/3 runs');
    expect(msg).toContain('Test C: passed 0/3 runs');
  });

  test('formats grouping error message correctly', () => {
    const msg = formatRepeatFailureMessage({
      totalGroups: 1,
      failures: [],
      groupingErrors: [
        { label: 'Test A', actual: 4, expected: 3, kind: 'ambiguous' },
      ],
      minPass: 2,
      repeatCount: 3,
    });

    expect(msg).toContain('unexpected result counts');
    expect(msg).toContain('Test A: 4 results');
    expect(msg).toContain('description collision');
  });
});

describe('formatRepeatCommentMarkdown', () => {
  test('formats success markdown', () => {
    const md = formatRepeatCommentMarkdown({
      totalGroups: 5,
      failures: [],
      groupingErrors: [],
      minPass: 2,
      repeatCount: 3,
    });

    expect(md).toContain('all 5 test(s) passed');
    expect(md).toContain('min 2 of 3 runs');
  });

  test('formats failure markdown', () => {
    const md = formatRepeatCommentMarkdown({
      totalGroups: 5,
      failures: [{ label: 'Test B', passed: 1, total: 3 }],
      groupingErrors: [],
      minPass: 2,
      repeatCount: 3,
    });

    expect(md).toContain('4/5 tests passed');
    expect(md).toContain('Test B: 1/3');
  });

  test('formats grouping error markdown', () => {
    const md = formatRepeatCommentMarkdown({
      totalGroups: 1,
      failures: [],
      groupingErrors: [
        { label: 'Test A', actual: 4, expected: 3, kind: 'ambiguous' },
      ],
      minPass: 2,
      repeatCount: 3,
    });

    expect(md).toContain('failed');
    expect(md).toContain('unique description');
    expect(md).toContain('Test A: 4 results');
  });

  test('formats partial-group markdown with correct guidance', () => {
    const md = formatRepeatCommentMarkdown({
      totalGroups: 1,
      failures: [],
      groupingErrors: [
        { label: 'Test A', actual: 2, expected: 3, kind: 'partial' },
      ],
      minPass: 2,
      repeatCount: 3,
    });

    expect(md).toContain('failed');
    expect(md).toContain('did not produce output');
    expect(md).not.toContain('unique description');
  });

  test('formats mixed ambiguous+partial markdown', () => {
    const md = formatRepeatCommentMarkdown({
      totalGroups: 2,
      failures: [],
      groupingErrors: [
        { label: 'Test A', actual: 4, expected: 3, kind: 'ambiguous' },
        { label: 'Test B', actual: 2, expected: 3, kind: 'partial' },
      ],
      minPass: 2,
      repeatCount: 3,
    });

    expect(md).toContain('duplicate descriptions');
    expect(md).toContain('did not produce output');
  });
});
