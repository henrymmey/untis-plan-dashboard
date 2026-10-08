# Security Policy

## Supported versions

Security fixes are applied to the current development version of **untis-to-api**. Older releases may not receive security fixes.

Because this project is deployed as a Cloudflare Worker, security also depends on the configuration of the surrounding Cloudflare account, D1 database, R2 bucket, email routing, SMTP provider, and authentication provider.

## Reporting a vulnerability

Please **do not report security vulnerabilities through public GitHub issues, pull requests, or discussions**.

Use GitHub's private vulnerability reporting / Security Advisories for this repository when available. If private reporting is not available, contact the maintainer privately through the maintainer's GitHub profile before disclosing the issue publicly.

Please include:

- a clear description of the vulnerability;
- affected component(s);
- steps to reproduce the issue;
- the potential security impact;
- any suggested mitigation, if known.

Please avoid including real student, teacher, authentication, or production infrastructure data in a report unless it is strictly necessary.

## What should be reported privately?

Examples include:

- authentication or authorization bypasses;
- session or login-code vulnerabilities;
- API-key or secret exposure;
- OIDC security issues;
- SMTP credential exposure;
- SQL injection or unsafe database access;
- unintended access to private R2 objects;
- sensitive information disclosure;
- request forgery or other vulnerabilities that could affect production infrastructure.

## What is not a security vulnerability?

General bugs, parser errors, feature requests, documentation issues, and deployment problems should normally be reported through the appropriate GitHub issue template.

## Disclosure

Please allow reasonable time for investigation and remediation before publicly disclosing a security vulnerability.

The maintainer may coordinate a fix, prepare a release, and publish an advisory when appropriate.

## Security-sensitive configuration

Never commit production secrets to Git.

The application uses Cloudflare Worker secrets for sensitive values such as:

- `API_KEY`
- `SMTP_PASSWORD`
- `OIDC_CLIENT_SECRET`
- `TURNSTILE_SECRET`

Configuration values that are safe to publish may remain in `wrangler.jsonc`, but secrets must always be stored through Wrangler/GitHub secret management as appropriate.
