import * as core from '@actions/core';
import type { EvaluateResult } from 'promptfoo';

export interface TestGroup {
  successes: number;
  total: number;
  label: string;
}

export interface TestFailure {
  label: string;
  passed: number;
  total: number;
}

export interface GroupingError {
  label: string;
  actual: number;
  expected: number;
  kind: 'partial' | 'ambiguous';
}

export interface RepeatSummary {
  totalGroups: number;
  failures: TestFailure[];
  groupingErrors: GroupingError[];
  minPass: number;
  repeatCount: number;
}

export function groupResultsByTest(
  results: EvaluateResult[],
): Map<string, TestGroup> {
  const groups = new Map<string, TestGroup>();
  for (const result of results) {
    const desc = result.description || result.testCase?.description;
    // Include provider in the key so multi-provider evals don't collide
    const providerId = result.provider?.id || '';
    let key: string;
    let label: string;
    if (desc) {
      key = `desc:${desc}:${result.promptIdx}:${providerId}`;
      label = providerId ? `${desc} [${providerId}]` : desc;
    } else {
      const varsStr = JSON.stringify(result.vars || {});
      key = `vars:${varsStr}:${result.promptIdx}:${providerId}`;
      label = providerId
        ? `test(${varsStr}) [${providerId}]`
        : `test(${varsStr})`;
    }
    const group = groups.get(key) || { successes: 0, total: 0, label };
    group.total++;
    if (result.success) {
      group.successes++;
    }
    groups.set(key, group);
  }
  return groups;
}

export function validateGroups(
  groups: Map<string, TestGroup>,
  repeatCount: number,
): GroupingError[] {
  const errors: GroupingError[] = [];
  for (const [, group] of groups) {
    if (group.total > repeatCount) {
      errors.push({
        label: group.label,
        actual: group.total,
        expected: repeatCount,
        kind: 'ambiguous',
      });
    } else if (group.total < repeatCount) {
      errors.push({
        label: group.label,
        actual: group.total,
        expected: repeatCount,
        kind: 'partial',
      });
    }
  }
  return errors;
}

export function evaluateRepeatThreshold(
  results: EvaluateResult[],
  minPass: number,
  repeatCount: number,
): { passed: boolean; summary: RepeatSummary } {
  const groups = groupResultsByTest(results);
  const groupingErrors = validateGroups(groups, repeatCount);

  // If any group has the wrong number of results, the threshold check
  // is unreliable. Fail hard so the user knows something is wrong.
  if (groupingErrors.length > 0) {
    for (const ge of groupingErrors) {
      const reason =
        ge.kind === 'ambiguous'
          ? 'multiple tests may share the same description'
          : 'some repeat runs may not have produced output';
      core.warning(
        `Test "${ge.label}" has ${ge.actual} results but expected ${ge.expected} (${reason}).`,
      );
    }
    return {
      passed: false,
      summary: {
        totalGroups: groups.size,
        failures: [],
        groupingErrors,
        minPass,
        repeatCount,
      },
    };
  }

  const failures: TestFailure[] = [];
  for (const [, group] of groups) {
    if (group.successes < minPass) {
      failures.push({
        label: group.label,
        passed: group.successes,
        total: group.total,
      });
    }
  }

  return {
    passed: failures.length === 0,
    summary: {
      totalGroups: groups.size,
      failures,
      groupingErrors: [],
      minPass,
      repeatCount,
    },
  };
}

export function formatRepeatFailureMessage(summary: RepeatSummary): string {
  if (summary.groupingErrors.length > 0) {
    const lines = [
      `Repeat check failed: ${summary.groupingErrors.length} test group(s) have unexpected result counts (expected ${summary.repeatCount} each):`,
      ...summary.groupingErrors.map(
        (ge) =>
          `  ${ge.label}: ${ge.actual} results (${ge.kind === 'ambiguous' ? 'possible description collision' : 'missing repeat runs'})`,
      ),
    ];
    return lines.join('\n');
  }
  const lines = [
    `${summary.failures.length} test(s) failed the repeat check (min ${summary.minPass} of ${summary.repeatCount} required):`,
    ...summary.failures.map(
      (f) => `  ${f.label}: passed ${f.passed}/${f.total} runs`,
    ),
  ];
  return lines.join('\n');
}

export function formatRepeatCommentMarkdown(summary: RepeatSummary): string {
  if (summary.groupingErrors.length > 0) {
    let md = `**Repeat check**: **failed** — ${summary.groupingErrors.length} test group(s) have unexpected result counts\n\n`;
    md += '> Ensure each test case has a unique description.\n';
    for (const ge of summary.groupingErrors) {
      md += `> - ${ge.label}: ${ge.actual} results, expected ${ge.expected}\n`;
    }
    return md;
  }

  const passed = summary.totalGroups - summary.failures.length;
  if (summary.failures.length === 0) {
    return `**Repeat check**: all ${summary.totalGroups} test(s) passed (min ${summary.minPass} of ${summary.repeatCount} runs)\n`;
  }
  let md = `**Repeat check** (each test run ${summary.repeatCount} times, min ${summary.minPass} passes required): **${passed}/${summary.totalGroups} tests passed**\n\n`;
  md += '> Tests below minimum:\n';
  for (const f of summary.failures) {
    md += `> - ${f.label}: ${f.passed}/${f.total}\n`;
  }
  return md;
}
