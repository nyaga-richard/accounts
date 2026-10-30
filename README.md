# Ledgerway Accounting (work in progress)

A self-hosted accounting-system foundation built around a PostgreSQL transaction register. This repository is an implementation in progress—not yet a complete or production-ready accounting system. Do not use it as the system of record for live finances until the outstanding controls and workflows in `PROJECT_PROGRESS.md` are complete and reviewed.

## Current implementation

- Next.js 16 / React / TypeScript dashboard shell with responsive navigation.
- Express + TypeScript REST API with Better Auth email/password sessions, session-backed role/permission checks, Knex configuration and Zod request validation.
- PostgreSQL migration covering core master data, transaction configuration, transactions and postings, ledger views, opening balances, weekly close/reconciliation, cheques, bank imports/matches, audit and accounting period tables.
- Supplier opening-balance import from previewed `.xlsx`/`.csv` files using `Name`, `Code`, and `Opening Balance` columns, with audited pending batches and explicit balanced GL counterpart lines.
- Transaction creation derives a debit/credit pair from one explicit configured rule, runs inside a PostgreSQL transaction, allocates transaction numbers from a sequence under a posting lock, freezes applied balance multipliers, and snapshots operational balances.
- Independent weekly operational formula helper/tests:
  - Current = bank + CHQ B − CHQ A
  - Net = bank + CHQ B − CHQ C − supplier balances
- Docker Compose setup with a profiled Cloudflare Tunnel connector, first-install and source-update scripts, plus paired PostgreSQL/upload-volume backup and restore scripts.

## One-command Ubuntu deployment

From a reviewed Git checkout on an Ubuntu server, first configure a remotely-managed Cloudflare Tunnel Public Hostname to route to `http://web:3000`, then run:

```sh
sudo ./deploy/install-ubuntu.sh
```

The script installs Docker Engine/Compose if needed, prompts for the tunnel token, public HTTPS origin and first administrator, generates secrets, builds the images, applies migrations, seeds the initial administrator and starts the stack. For later source updates from a clean Git branch with an upstream configured:

```sh
sudo ./deploy/update-ubuntu.sh
```

Updates fast-forward source, make database and upload backups, build images, apply migrations, and health-check services. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for prerequisites, Cloudflare setup, backup/restore, and important verification limits. This automates deployment but does not make Ledgerway production-certified.

## Run locally

Requirements: Node.js 20+, PostgreSQL 16+.

```sh
cp .env.example .env
# Set DATABASE_URL and a secure BETTER_AUTH_SECRET
npm install
npm run migrate -w @ledgerway/api
npm run dev
```

The dashboard is served on port 3000 and API on port 4000. The local web server proxies `/api/*` to the API (`API_INTERNAL_URL`, default `http://127.0.0.1:4000`). Better Auth handles sessions; application roles and permissions are checked on protected API routes. Create the initial administrator with `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed -w @ledgerway/api` after migrations (password must be at least 12 characters). API access still requires a configured database.

## Verification so far

- `npm run build`: passed for API and web at the current revision.
- PostgreSQL-backed `npm test`: 32/32 tests across 9 files passed on the configured local database.
- HTTP reachability and anonymous-auth rejection checks passed for representative API routes.
- Docker image builds, Ubuntu install/update scripts, Cloudflare Tunnel routing, and containerized backup/restore are authored but have **not** been executed here because Docker is unavailable in this environment.

See `PROJECT_PROGRESS.md` and `docs/DEPLOYMENT.md` for known gaps and deployment notes.
