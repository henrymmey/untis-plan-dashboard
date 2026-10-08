# untis-plan-dashboard

[![CI](https://github.com/henrymmey/untis-plan-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/henrymmey/untis-plan-dashboard/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/henrymmey/untis-plan-dashboard)](LICENSE)

**untis-plan-dashboard** turns IServ/Untis substitution-plan emails into structured data and serves it through an authenticated JSON API and a web dashboard.

The application is built for Cloudflare Workers and uses Cloudflare D1 for structured data and Cloudflare R2 for the original PDF files.

> **Note:** This repository contains a reusable implementation, but the parser is tailored to the Untis PDF layout used by the target school. Different schools may require parser changes.

## Features

- IServ email forwarding directly into a Cloudflare Worker
- Trusted-sender validation
- Automatic PDF attachment detection
- Untis PDF text extraction with `unpdf`
- Extraction of plan date and revision/version number from the PDF itself
- Support for multiple corrected plan versions
- Extraction of multiple classes from one plan
- Cloudflare D1 storage for structured plan data
- Cloudflare R2 storage for original PDFs
- Authenticated JSON API using a Bearer API key
- Multi-user web dashboard
- Email-code authentication
- Optional MeyerAuth / OIDC authentication for configured users
- Configurable dashboard access control
- School-day navigation in the dashboard
- GitHub Actions CI for type generation and TypeScript checking
- Manual production deployment

## Architecture

```text
IServ
  │
  │ automatic forwarding
  ▼
Cloudflare Email Routing
  │
  ▼
Cloudflare Worker
  ├── validate sender
  ├── parse MIME message
  ├── find PDF attachment
  ├── extract PDF text
  ├── detect plan date + version
  ├── parse supported classes
  │
  ├──► Cloudflare D1
  │      structured plan data
  │
  └──► Cloudflare R2
         original PDF

                 ┌─────────────────────┐
                 │   JSON API           │
                 │   authenticated      │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │   Web Dashboard      │
                 │   session auth       │
                 └─────────────────────┘
```

## Why the plan date comes from the PDF

The email reception date is not necessarily the date for which the substitution plan applies.

For example, a PDF may contain:

```text
8.10.2026 (2)
Vertretungsplan Klassen 9.10. / Freitag
```

The parser therefore stores:

```text
planDate = 2026-10-09
version  = 2
```

This also allows corrected versions of the same plan to coexist.

## Repository structure

```text
.
├── .github/
│   ├── dependabot.yml
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       └── ci.yml
├── migrations/
│   ├── 0001_initial.sql
│   ├── 0002_auth.sql
│   ├── 0003_oidc.sql
│   ├── 0004_login_challenges.sql
│   └── 0005_access_control.sql
├── src/
│   ├── access.ts
│   ├── auth.ts
│   ├── dashboard.ts
│   ├── index.ts
│   ├── oidc.ts
│   ├── parser.ts
│   ├── smtp.ts
│   └── types.ts
├── CODE_OF_CONDUCT.md
├── .env.example
├── LICENSE
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```

## Requirements

- Node.js 22 or newer
- npm
- A Cloudflare account
- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- A domain managed through Cloudflare
- An IServ installation capable of forwarding the substitution-plan emails
- An SMTP account for dashboard login codes
- An OIDC provider if MeyerAuth login is enabled

The production configuration is Cloudflare-specific, but the parser and application structure can be adapted to other environments.

## Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/henrymmey/untis-plan-dashboard.git
cd untis-plan-dashboard
npm ci
```

Generate the Cloudflare Worker types:

```bash
npm run types
```

Check the TypeScript project:

```bash
npm run typecheck
```

Start the local development server:

```bash
npm run dev
```

## Cloudflare configuration

The production Worker is configured through `wrangler.jsonc`.

At minimum, the deployment requires:

- a D1 database;
- an R2 bucket;
- a Worker custom domain or route;
- the required public configuration values;
- the required Worker secrets.

Create a D1 database with Wrangler:

```bash
npx wrangler d1 create untis_to_api --location weur --jurisdiction eu
```

Create the R2 bucket:

```bash
npx wrangler r2 bucket create untis-to-api-pdfs
```

Update the D1 database ID and other environment-specific values in `wrangler.jsonc`.

Do not copy production credentials into the repository.

## Environment variables and secrets

Non-sensitive configuration can be defined in `wrangler.jsonc`.

Sensitive values must be stored as Cloudflare Worker secrets.

### Worker secrets

The application uses secrets including:

```text
API_KEY
SMTP_PASSWORD
TURNSTILE_SECRET
OIDC_CLIENT_SECRET
```

Set a secret with Wrangler:

```bash
npx wrangler secret put API_KEY
```

Repeat this for the other required secrets.

### Public configuration

Depending on the deployment, `wrangler.jsonc` can contain values such as:

```text
ALLOWED_SENDER
ISERV_DOMAIN
EMAIL_FROM
SMTP_HOST
SMTP_PORT
SMTP_SECURITY
SMTP_USERNAME
TURNSTILE_SITEKEY
OIDC_ISSUER
OIDC_CLIENT_ID
OIDC_REDIRECT_URI
DEFAULT_CLASS
```

Only values that are safe to expose should be placed in `vars`.

## Database migrations

Apply migrations locally:

```bash
npm run db:migrate:local
```

Apply migrations to production:

```bash
npm run db:migrate:remote
```

List production migrations:

```bash
npx wrangler d1 migrations list untis_to_api --remote
```

Production migrations are intentionally **not** applied automatically by GitHub Actions.

## Email ingestion

The Worker expects the substitution plan to arrive through an email route.

A typical flow is:

```text
IServ
  │
  ▼
vertretung@api.example.com
  │
  ▼
Cloudflare Email Worker
  │
  ├── sender validation
  ├── MIME parsing
  ├── PDF detection
  └── PDF parsing
```

The configured trusted senders are controlled through `ALLOWED_SENDER`.

The Worker should reject mail from untrusted senders before processing the attachment.

## PDF parsing

The parser in `src/parser.ts` is designed around the Untis substitution-plan format used by the target deployment.

It recognizes information such as:

- plan date;
- plan version;
- class sections;
- substitutions;
- cancellations;
- releases;
- supervision;
- room substitutions;
- room notes;
- replacement substitutions.

The parser deliberately extracts the plan date from the PDF rather than trusting the email timestamp.

If the school changes its Untis PDF layout, the parser may need to be updated.

## Storage

### D1

Cloudflare D1 stores the structured representation of the plans, authentication state, sessions, login challenges, OIDC state, and dashboard access configuration.

### R2

Cloudflare R2 stores the original PDF files.

The original PDFs should not be made publicly accessible unless the deployment explicitly requires it.

Keeping the original PDFs separate from the API data means API requests do not need to parse the source PDF again.

## API

The API is protected by a Bearer API key.

### Latest version

```http
GET /vertretung/plan/2026-10-09
Authorization: Bearer YOUR_API_KEY
```

Without an explicit version, the API returns the highest available version for the requested date.

### Specific version

```http
GET /vertretung/plan/2026-10-09/2
Authorization: Bearer YOUR_API_KEY
```

### Specific class

```http
GET /vertretung/plan/2026-10-09/2/9-G1
Authorization: Bearer YOUR_API_KEY
```

Example with curl:

```bash
curl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.example.com/vertretung/plan/2026-10-09
```

Requests without the correct API key receive HTTP 401.

API responses use `Cache-Control: no-store` so authenticated plan data is not publicly cached.

## Web dashboard

The project also includes a web dashboard.

The dashboard provides:

- login via one-time email code;
- optional OIDC/MeyerAuth login;
- class selection;
- access control;
- previous/next school-day navigation;
- a direct `Heute` action;
- settings and logout;
- class-specific substitution-plan display.

The login flow accepts an IServ username and derives the corresponding IServ email address from the configured `ISERV_DOMAIN`.

### Email-code authentication

The Worker generates a short-lived one-time code and sends it through the configured SMTP server.

Codes and sessions are stored server-side in D1. Login attempts are rate-limited.

### OIDC / MeyerAuth

OIDC is optional and intended for specifically configured accounts.

The callback uses authorization code flow with PKCE. The OIDC provider, client ID, client secret, and redirect URI are configured through Worker variables/secrets.

## Dashboard access control

The dashboard can be configured to:

- allow everyone with a valid account; or
- allow only explicitly configured usernames.

The administrator can manage this setting through the dashboard's admin interface.

The administrator account is handled separately from the configurable allowlist.

## SMTP

Login codes are sent through an external SMTP server.

Supported modes are:

- TLS on port 465;
- STARTTLS on port 587.

The SMTP password must never be committed to Git.

Configure the connection through:

```text
SMTP_HOST
SMTP_PORT
SMTP_SECURITY
SMTP_USERNAME
SMTP_PASSWORD
EMAIL_FROM
```

## Turnstile

The login page can use Cloudflare Turnstile to reduce automated abuse.

The site key is public configuration. The Turnstile secret must be stored as a Worker secret.

The server validates the token, hostname, and configured action before creating a login challenge.

## Local development

Run:

```bash
npm ci
npm run types
npm run typecheck
npm run db:migrate:local
npm run dev
```

Local D1 storage is separate from the production database.

Avoid using real school, student, staff, authentication, or production email data during local development.

## Continuous integration

GitHub Actions runs CI for pushes to `main` and for pull requests.

The CI workflow:

1. checks out the repository;
2. installs the exact locked dependency versions with `npm ci`;
3. generates Cloudflare Worker types;
4. runs the TypeScript type checker.

CI does **not**:

- deploy the Worker;
- modify production D1;
- access production secrets;
- send emails;
- modify the production R2 bucket.

## Production deployment

Production deployment is intentionally **manual**.

After reviewing a change, run the checks locally:

```bash
npm ci
npm run types
npm run typecheck
```

Apply any required production database migrations:

```bash
npm run db:migrate:remote
```

Then deploy the Worker:

```bash
npm run deploy
```

A typical manual deployment sequence is:

```bash
git pull
npm ci
npm run types
npm run typecheck
npm run db:migrate:remote
npm run deploy
```

Do not run production migrations blindly. Review the migration files and deployment impact first.

## Monitoring

For live Worker logs:

```bash
npx wrangler tail untis-to-api
```

When troubleshooting email ingestion, check:

- Cloudflare Email Routing;
- the Worker logs;
- sender validation;
- the presence of a PDF attachment;
- PDF text extraction;
- the detected plan date and version;
- D1 records;
- R2 objects.

## Privacy

Substitution plans may contain information relating to students, teachers, classes, rooms, and schedules.

Before deploying or publicly exposing this application, verify that the intended publication and retention of this information is permitted by the relevant school and organizational policies.

Recommended practices:

- keep original PDFs private in R2;
- do not commit real PDFs to Git;
- do not include real authentication data in issues or pull requests;
- use Worker secrets for credentials;
- avoid unnecessary logging of personal information;
- restrict dashboard access when public access is not required.

## Security

Please read [SECURITY.md](SECURITY.md) before reporting a security issue.

Never commit credentials or production secrets to this repository.

## Contributing

Contributions are welcome.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

GitHub issue forms are provided for bug reports and feature requests.

## License

This project is licensed under the [MIT License](LICENSE).

Copyright © 2026 Henry Meyer.
