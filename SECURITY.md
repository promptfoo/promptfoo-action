# Security Policy

## Supported Versions

Security fixes are provided for the latest published release of
`promptfoo-action`. The `main` branch may contain unreleased fixes and is
supported on a best-effort basis. We do not backport security fixes to older
releases.

| Version | Supported |
| --- | --- |
| Latest published release | Yes |
| `main` | Best effort |
| Older releases | No |

## Reporting a Vulnerability

Do not open a public GitHub issue, discussion, or pull request for a suspected
vulnerability.

Report vulnerabilities through the repository's private
[GitHub security advisory form](https://github.com/promptfoo/promptfoo-action/security/advisories/new).

Include enough information for maintainers to reproduce and assess the issue:

- The action version or ref and its resolved commit SHA.
- The event type, such as `pull_request`, `pull_request_target`, `push`, or
  `workflow_dispatch`.
- Whether the workflow ran for a fork or same-repository change, the checked-out
  ref, and the job's permissions.
- A sanitized workflow step and relevant action inputs. List environment
  variable names only; do not include their values.
- The Promptfoo version, runner type, operating system, and whether the runner
  is GitHub-hosted or self-hosted.
- Minimal reproduction steps, the security impact, and any known mitigation.
- Redacted logs or output that demonstrate the issue without exposing real
  credentials or private data.

Use canary values instead of real API keys, tokens, or other secrets. Keep the
report and supporting material private until disclosure is coordinated with the
maintainers. Maintainers may ask you to reproduce the issue on the latest
published release or `main`.

## Scope

This repository owns the GitHub Action wrapper around Promptfoo. Relevant
security boundaries include:

- Validation and handling of Git revisions, action inputs, command arguments,
  changed-file data, and configuration paths.
- Reads, writes, cleanup, and containment involving configuration, environment,
  cache, prompt, and result files.
- Masking, forwarding, and use of provider credentials, the GitHub token, and
  the Promptfoo API key.
- Result-sharing consent, authentication destinations, and `no-share`
  enforcement.
- Pull request comments, workflow summaries, and other output produced with
  GitHub permissions.
- Integrity of the bundled `dist/` action, release tags, and Promptfoo
  invocation.

When reporting an input-validation or filesystem issue, identify the
attacker-controlled value and explain how the attacker controls it. When
reporting secret exposure, use a canary value and identify the unintended
destination without sending a real credential.

Promptfoo configurations and referenced provider code are executed as part of
the selected evaluation. Deliberately selecting an untrusted configuration,
Promptfoo version, remote endpoint, or filesystem path in trusted workflow YAML
is not by itself a vulnerability. A report should show how untrusted input
crosses an action-owned boundary without the workflow maintainer's informed
choice.

Running attacker-controlled pull request code through `pull_request_target`
with privileged credentials is an unsafe workflow configuration. Reports about
this setup should demonstrate a bypass of a documented safe checkout or
permission boundary in the action itself.

If an issue reproduces in the Promptfoo CLI without this action, report it to
the [Promptfoo project](https://github.com/promptfoo/promptfoo/security/advisories/new).
Report GitHub platform vulnerabilities and third-party dependency
vulnerabilities to their respective maintainers unless this action introduces
or materially amplifies the impact.

## Safe Testing

Test only in repositories and accounts you control. Avoid real secrets,
production systems, destructive tests on persistent self-hosted runners, and
unnecessary access to third-party services. Stop after establishing the
minimum proof needed to explain the impact.
