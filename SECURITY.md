# Security Policy

## Reporting a vulnerability

Please do **not** file public GitHub issues for security vulnerabilities.

Email **security@facet.llc** with:

- A description of the vulnerability
- Steps to reproduce (proof-of-concept if possible)
- Your assessment of impact (data exposure, privilege escalation, etc.)
- Your name / handle for credit (optional)

We will acknowledge receipt within 2 business days and aim to provide an initial assessment within 5 business days.

## Scope

In scope:

- All packages published under `@facet-llc/*` from this repository
- The reference implementations of payment-rail adapters and origination verifiers

Out of scope:

- The hosted Terminal at `api.facet.llc` — see https://facet.llc/security for that
- Third-party dependencies (report to the upstream project; we'll patch on their release)
- Issues that require physical access to the user's device

## Supported versions

We provide security fixes for the **current major** of each `@facet-llc/*` package on npm. Older majors receive security backports for 6 months after a new major ships.

## Coordinated disclosure

We follow a 90-day coordinated disclosure window. Once a fix is shipped, we publish a GitHub Security Advisory crediting the reporter (unless they request anonymity).
