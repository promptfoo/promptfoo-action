# Unit Test Audit

This document tracks the ongoing unit-test and coverage audit.

## Baseline

Measured on June 4, 2026 with `npm test`:

| Metric | Coverage |
| --- | ---: |
| Statements | 88.85% |
| Branches | 81.42% |
| Functions | 85.91% |
| Lines | 88.65% |

All 149 tests passed.

After the first utility-test pass:

| Metric | Coverage |
| --- | ---: |
| Statements | 90.93% |
| Branches | 83.11% |
| Functions | 95.77% |
| Lines | 90.77% |

All 165 tests passed.

## Findings

| ID | Type | Status | Finding |
| --- | --- | --- | --- |
| BUG-001 | Bug | Open | `generateCacheKey` sorts `promptFiles` in place, mutating caller-owned input. |
| GAP-001 | Coverage | Resolved | Added direct tests for every `Logger` method and both group modes. |
| GAP-002 | Coverage | Resolved | Added direct tests for error formatting and filesystem fallback paths. |
| GAP-003 | Quality | Open | Coverage is reported but no minimum threshold prevents regressions. |
| GAP-004 | Documentation | Open | `AGENTS.md` says Jest, but the repository uses Vitest. |
| GAP-005 | Coverage | Open | `src/main.ts` has untested event, cache, malformed-output, and summary branches. |
| GAP-006 | Quality | Open | Authentication error tests invoke the function twice for one assertion path. |

## Work Log

- Established the baseline and mapped uncovered source lines.
- Added 16 direct utility tests; coverage increased to 90.93% statements and
  83.11% branches.
