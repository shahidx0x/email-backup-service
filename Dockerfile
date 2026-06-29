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
