#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${1:-.}"
cd "$ROOT"

mkdir -p '.'
cat > '.dockerignore' <<'__PROJECT_0_0__'
node_modules
**/node_modules
dist
**/dist
.next
**/.next
.git
.env
.env.*
secrets/*
!secrets/.gitkeep
!secrets/README.md
coverage
__PROJECT_0_0__

mkdir -p '.'
cat > '.env.example' <<'__PROJECT_0_1__'
NODE_ENV=production

API_PORT=3000
API_BIND_ADDRESS=127.0.0.1
FRONTEND_PORT=3001
FRONTEND_BIND_ADDRESS=127.0.0.1
GRAFANA_PORT=3002
PROMETHEUS_PORT=9090

PUBLIC_BASE_URL=https://backup.example.com
API_INTERNAL_URL=http://api:3000
NEXT_PUBLIC_API_BASE_URL=/api
CORS_ORIGINS=https://backup.example.com
TRUST_PROXY=true

MONGODB_HOST=mongodb
MONGODB_PORT=27017
MONGODB_DATABASE=email_backup
MONGODB_REPLICA_SET=rs0
MONGODB_AUTH_SOURCE=admin

REDIS_HOST=redis
REDIS_PORT=6379

ADMIN_INITIAL_EMAIL=dev.imshahid@gmail.com

IMAP_DEFAULT_HOST=imap.hostinger.com
IMAP_DEFAULT_PORT=993
IMAP_DEFAULT_TLS=true
IMAP_IDLE_ENABLED=true
IMAP_POLL_INTERVAL_SECONDS=300
IMAP_CONNECTION_TIMEOUT_SECONDS=30
IMAP_MAX_GLOBAL_CONNECTIONS=20
IMAP_MAX_CONNECTIONS_PER_MAILBOX=2

SYNC_BATCH_SIZE=100
SYNC_FOLDER_CONCURRENCY=2
SYNC_MESSAGE_CONCURRENCY=5

FOLDER_DISCOVERY_CRON=0 */6 * * *
RECONCILIATION_CRON=0 2 * * *
INTEGRITY_SAMPLE_CRON=0 3 * * *
FULL_INTEGRITY_CRON=0 4 * * 0
EXPORT_CLEANUP_CRON=0 * * * *
STATISTICS_REFRESH_CRON=*/15 * * * *
CONNECTIVITY_CHECK_CRON=0 * * * *
STALE_LOCK_CLEANUP_CRON=*/10 * * * *

MAX_MESSAGE_SIZE_BYTES=104857600
MAX_ATTACHMENT_SIZE_BYTES=104857600
MAX_EXPORT_SIZE_BYTES=107374182400

EXPORT_DIRECTORY=/data/exports
EXPORT_EXPIRATION_HOURS=24
DEFAULT_RESTORE_FOLDER=Recovered Email Backup
DEFAULT_RETENTION_DAYS=0

JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=2592000

SWAGGER_ENABLED=false
SWAGGER_PATH=api/docs
OPENAPI_JSON_ENABLED=false
OPENAPI_JSON_PATH=api/openapi.json
SWAGGER_BASIC_AUTH_ENABLED=false
SWAGGER_BASIC_AUTH_USERNAME=
SWAGGER_BASIC_AUTH_PASSWORD=

LOG_LEVEL=info
METRICS_ENABLED=true
PROMETHEUS_RETENTION_TIME=30d

BACKUP_SCHEDULE=0 1 * * *
BACKUP_RETENTION_DAYS=30
BACKUP_ENCRYPTION_ENABLED=false

S3_BACKUP_ENABLED=false
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
__PROJECT_0_1__

mkdir -p '.github/workflows'
cat > '.github/workflows/ci.yml' <<'__PROJECT_0_2__'
name: CI
on:
  push:
    branches: [main, dev]
  pull_request:
permissions:
  contents: read
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.12.4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install --no-frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: docker compose config --quiet
__PROJECT_0_2__

mkdir -p '.'
cat > '.gitignore' <<'__PROJECT_0_3__'
node_modules/
dist/
.next/
coverage/
.env
.env.*
!.env.example
secrets/*
!secrets/.gitkeep
!secrets/README.md
/data/
*.log
.DS_Store
__PROJECT_0_3__

mkdir -p '.'
cat > 'Dockerfile' <<'__PROJECT_0_4__'
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /workspace

FROM base AS development
COPY . .
RUN pnpm install --no-frozen-lockfile
CMD ["pnpm", "dev"]

FROM base AS build
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --no-frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter @email-backup/api --prod /out/api \
 && pnpm deploy --filter @email-backup/worker --prod /out/worker \
 && pnpm deploy --filter @email-backup/scheduler --prod /out/scheduler

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home /app app
COPY --from=build --chown=app:app /out/api /services/api
COPY --from=build --chown=app:app /out/worker /services/worker
COPY --from=build --chown=app:app /out/scheduler /services/scheduler
RUN mkdir -p /data/exports && chown -R app:app /data
USER app
WORKDIR /services/api
CMD ["node", "dist/main.js"]
__PROJECT_0_4__

mkdir -p '.'
cat > 'Dockerfile.frontend' <<'__PROJECT_0_5__'
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /workspace

FROM base AS development
COPY . .
RUN pnpm install --no-frozen-lockfile
CMD ["pnpm", "--filter", "@email-backup/web", "dev", "--hostname", "0.0.0.0", "--port", "3001"]

FROM base AS build
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @email-backup/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 10001 nextjs && useradd --system --uid 10001 --gid nextjs --home /app nextjs
COPY --from=build --chown=nextjs:nextjs /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nextjs /workspace/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3001
CMD ["node", "apps/web/server.js"]
__PROJECT_0_5__

echo 'Materialized chunk 00.'
