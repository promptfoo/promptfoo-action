import * as core from '@actions/core';
import type { EvaluateResult } from 'promptfoo';

export interface TestGroup {
  successes: number;
  total: number;
  label: string;
  disambiguator?: string;
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

interface PendingResult {
  result: EvaluateResult;
  label: string;
  disambiguator?: string;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entryValue]) => [key, normalizeValue(entryValue)]),
    );
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

function formatSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatValueSummary(value: unknown, maxLength = 80): string {
  const singleLine = formatSingleLine(stableStringify(value));
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function getTestCaseIdentifier(result: EvaluateResult): string | undefined {
  const testCase = result.testCase as
    | {
        id?: unknown;
        metadata?: { testCaseId?: unknown };
      }
    | undefined;

  if (typeof testCase?.id === 'string') {
    return testCase.id;
  }

  if (typeof testCase?.metadata?.testCaseId === 'string') {
    return testCase.metadata.testCaseId;
  }

  return undefined;
}

function buildGroupKey(result: EvaluateResult): string {
  const providerId = result.provider?.id || '';
  const fingerprint = stableStringify(
    result.testCase || {
      description: result.description,
      vars: result.vars || {},
    },
  );

  return `test:${fingerprint}:prompt:${result.promptIdx}:provider:${providerId}`;
}

function buildGroupLabel(
  result: EvaluateResult,
  hasMultiplePrompts: boolean,
): { label: string; disambiguator?: string } {
  const providerId = result.provider?.id || '';
  const desc = result.description || result.testCase?.description;
  const testCaseIdentifier = getTestCaseIdentifier(result);
  const testCaseId = testCaseIdentifier
    ? formatSingleLine(testCaseIdentifier)
    : undefined;
  const varsSummary = formatValueSummary(
    result.vars || result.testCase?.vars || {},
  );

  const baseLabel = desc ? formatSingleLine(desc) : `test(${varsSummary})`;

  const suffixes: string[] = [];
  if (hasMultiplePrompts) {
    suffixes.push(`prompt ${result.promptIdx}`);
  }
  if (providerId) {
    suffixes.push(providerId);
  }

  const label =
    suffixes.length > 0 ? `${baseLabel} [${suffixes.join(', ')}]` : baseLabel;

  if (!desc) {
    return { label };
  }

  if (testCaseId) {
    return { label, disambiguator: `id=${testCaseId}` };
  }

  if (varsSummary !== '{}') {
    return { label, disambiguator: `vars=${varsSummary}` };
  }

  return { label };
}

function disambiguateLabels(groups: Map<string, TestGroup>): void {
  const labelCounts = new Map<string, number>();
  for (const group of groups.values()) {
    labelCounts.set(group.label, (labelCounts.get(group.label) || 0) + 1);
  }

  for (const group of groups.values()) {
    if ((labelCounts.get(group.label) || 0) > 1 && group.disambiguator) {
      group.label = `${group.label} (${group.disambiguator})`;
    }
  }
}

export function groupResultsByTest(
  results: EvaluateResult[],
  repeatCount?: number,
): Map<string, TestGroup> {
  // Detect multi-prompt configs so we can include promptIdx in labels
  const hasMultiplePrompts = new Set(results.map((r) => r.promptIdx)).size > 1;

  const pendingGroups = new Map<string, PendingResult[]>();
  for (const result of results) {
    const key = buildGroupKey(result);
    const { label, disambiguator } = buildGroupLabel(
      result,
      hasMultiplePrompts,
    );
    const pending = pendingGroups.get(key) || [];
    pending.push({
      result,
      label,
      ...(disambiguator ? { disambiguator } : {}),
    });
    pendingGroups.set(key, pending);
  }

  const groups = new Map<string, TestGroup>();
  for (const [key, pending] of pendingGroups) {
    const splitCount = getIndistinguishableProviderSplitCount(
      pending,
      repeatCount,
    );

    if (splitCount === undefined) {
      for (const item of pending) {
        addPendingResult(groups, key, item);
      }
      continue;
    }

    // Promptfoo does not include provider config/index in EvaluateResult. When
    // same-id providers collapse into one key, split by per-repeat occurrence.
    const occurrencesByTestIdx = new Map<number, number>();
    for (const item of pending) {
      const occurrence = occurrencesByTestIdx.get(item.result.testIdx) || 0;
      occurrencesByTestIdx.set(item.result.testIdx, occurrence + 1);
      addPendingResult(groups, `${key}:provider-occurrence:${occurrence}`, {
        ...item,
        label: `${item.label} (provider occurrence ${occurrence + 1})`,
      });
    }
  }

  disambiguateLabels(groups);

  return groups;
}

function getIndistinguishableProviderSplitCount(
  pending: PendingResult[],
  repeatCount: number | undefined,
): number | undefined {
  if (
    repeatCount === undefined ||
    pending.length <= repeatCount ||
    pending.length % repeatCount !== 0
  ) {
    return undefined;
  }

  const splitCount = pending.length / repeatCount;
  const countsByTestIdx = new Map<number, number>();
  for (const item of pending) {
    countsByTestIdx.set(
      item.result.testIdx,
      (countsByTestIdx.get(item.result.testIdx) || 0) + 1,
    );
  }

  if (countsByTestIdx.size !== repeatCount) {
    return undefined;
  }

  return Array.from(countsByTestIdx.values()).every(
    (count) => count === splitCount,
  )
    ? splitCount
    : undefined;
}

function addPendingResult(
  groups: Map<string, TestGroup>,
  key: string,
  item: PendingResult,
): void {
  const group = groups.get(key) || {
    successes: 0,
    total: 0,
    label: item.label,
    ...(item.disambiguator ? { disambiguator: item.disambiguator } : {}),
  };
  group.total++;
  if (item.result.success) {
    group.successes++;
  }
  groups.set(key, group);
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
  const groups = groupResultsByTest(results, repeatCount);
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
    const hasAmbiguous = summary.groupingErrors.some(
      (ge) => ge.kind === 'ambiguous',
    );
    const hasPartial = summary.groupingErrors.some(
      (ge) => ge.kind === 'partial',
    );
    let md = `**Repeat check**: **failed** — ${summary.groupingErrors.length} test group(s) have unexpected result counts\n\n`;
    if (hasAmbiguous && hasPartial) {
      md +=
        '> Some tests have duplicate descriptions and some repeat runs did not produce output.\n';
    } else if (hasAmbiguous) {
      md += '> Ensure each test case has a unique description.\n';
    } else {
      md +=
        '> Some repeat runs did not produce output. Check for timeouts or errors in the eval logs.\n';
    }
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
