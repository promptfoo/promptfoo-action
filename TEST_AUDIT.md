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

After the cache regression pass:

| Metric | Coverage |
| --- | ---: |
| Statements | 92.57% |
| Branches | 83.67% |
| Functions | 95.77% |
| Lines | 92.43% |

All 170 tests passed.

After the authentication hardening pass:

| Metric | Coverage |
| --- | ---: |
| Statements | 92.86% |
| Branches | 84.07% |
| Functions | 97.18% |
| Lines | 92.73% |

All 174 tests passed.

## Findings

| ID | Type | Status | Finding |
| --- | --- | --- | --- |
| BUG-001 | Bug | Resolved | `generateCacheKey` sorted `promptFiles` in place. It now sorts a copy, with a regression test preserving caller order. |
| BUG-002 | Bug | Resolved | Authentication only recognized `AbortError`, but `AbortSignal.timeout()` produces `TimeoutError` on Node 20. Both are now handled as timeouts. |
| BUG-003 | Bug | Resolved | Authentication accepted incomplete user/organization objects and logged undefined identity fields. Response fields are now validated. |
| GAP-001 | Coverage | Resolved | Added direct tests for every `Logger` method and both group modes. |
| GAP-002 | Coverage | Resolved | Added direct tests for error formatting and filesystem fallback paths. |
| GAP-003 | Quality | Open | Coverage is reported but no minimum threshold prevents regressions. |
| GAP-004 | Documentation | Open | `AGENTS.md` says Jest, but the repository uses Vitest. |
| GAP-005 | Coverage | Open | `src/main.ts` has untested event, cache, malformed-output, and summary branches. |
| GAP-006 | Quality | Resolved | Authentication error tests now capture one rejection and assert one request per case. |

## Work Log

- Established the baseline and mapped uncovered source lines.
- Added 16 direct utility tests; coverage increased to 90.93% statements and
  83.11% branches.
- Confirmed `generateCacheKey` reordered its caller's array, fixed the mutation,
  and added cache metrics and failure-path coverage.
- Fixed Node timeout classification and malformed authentication response
  acceptance; expanded auth failure tests without duplicate network calls.
