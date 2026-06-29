# Verification Checklist

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
./scripts/generate-secrets.sh
cp .env.example .env
docker compose config --quiet
docker compose up -d --build
./scripts/verify-production.sh
```

Expected production behavior:

- Dashboard health responds on the configured loopback frontend port.
- API `/health`, `/ready`, and `/metrics` respond.
- MongoDB replica set elects a primary and the application user is created idempotently.
- Redis requires authentication and reports healthy.
- Worker and scheduler heartbeat endpoints report healthy.
- Swagger and OpenAPI routes return 404 in production.
- Prometheus can scrape API, worker, and scheduler metrics.
- Grafana starts with the provisioned Prometheus data source.
- The backup service creates a compressed archive and SHA-256 checksum.
