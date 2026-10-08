# Contributing

Thank you for your interest in contributing to **untis-to-api**.

This project is an open-source Cloudflare Workers application that receives IServ/Untis substitution-plan emails, extracts structured data from PDF attachments, stores the results in Cloudflare D1 and the original PDFs in R2, and exposes the plans through an authenticated JSON API and web dashboard.

## Before you start

Please read the [README](README.md) to understand the architecture and local development workflow.

For security vulnerabilities, do **not** open a public issue. Please follow the process in [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- A Cloudflare account for production-related development
- Wrangler CLI access

Install dependencies:

```bash
npm ci
```

Generate Cloudflare Worker types:

```bash
npm run types
```

Run the TypeScript type checker:

```bash
npm run typecheck
```

Start the local Worker:

```bash
npm run dev
```

Local development uses a separate local D1 database. Production resources must not be used for routine local development.

## Making changes

Please keep changes focused and consistent with the existing architecture.

Good contributions generally:

- solve one problem at a time;
- preserve existing API behavior unless a breaking change is intentional;
- avoid unnecessary dependencies;
- keep secrets and private infrastructure details out of the repository;
- update documentation when behavior or configuration changes;
- use clear, descriptive commit messages.

Do not commit:

- API keys;
- SMTP passwords;
- OIDC client secrets;
- Cloudflare API tokens;
- private PDFs containing school or student data;
- local environment files containing credentials.

## Pull requests

Before opening a pull request:

```bash
npm ci
npm run types
npm run typecheck
```

Please make sure the CI workflow passes.

A pull request should include:

- a concise description of the change;
- the reason for the change;
- relevant implementation details;
- documentation updates when applicable;
- any known limitations or follow-up work.

Keep pull requests reasonably small. If a change contains multiple independent improvements, consider splitting it into separate pull requests.

## Commit messages

Use concise, descriptive commit messages. Conventional Commits are welcome but not required.

Examples:

```text
fix: handle corrected substitution plan versions
feat: add class-specific API endpoint
docs: update deployment instructions
refactor: simplify plan date parsing
```

## Issues

Use the available issue templates when reporting bugs or requesting features.

For parser-related issues, include a sanitized example of the relevant PDF text whenever possible. Do not upload real student or staff data unless it is explicitly necessary and appropriate.

## Deployment

Production deployment is intentionally **manual**.

The GitHub Actions workflow performs CI checks only. It does not deploy to Cloudflare or apply production database migrations.

After reviewing and merging changes, the maintainer can deploy manually using the instructions in the README.

## Maintainer discretion

Not every feature request or pull request will be accepted. The maintainer may prioritize reliability, security, simplicity, privacy, and compatibility over feature breadth.

Thank you for helping improve the project.
