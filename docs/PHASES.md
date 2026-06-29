# Implementation Phases

## Completed foundation

- pnpm monorepo and strict TypeScript configuration
- NestJS Fastify API process
- BullMQ worker and scheduler processes
- Next.js dashboard foundation
- Zod environment and Docker-secret validation
- Pino redaction and Prometheus metrics
- MongoDB 7 replica set and idempotent application-user initialization
- Redis 7 persistence and authentication
- Grafana provisioning and backup container
- Docker Compose deployment without bundled Nginx
- Development-only Swagger/OpenAPI and production startup rejection
- Authentication, roles, encrypted mailbox credentials, mailbox management, folder discovery, and initial queue wiring

## Next implementation slices

1. Complete raw MIME and attachment GridFS synchronization.
2. Add incremental IDLE/polling reconciliation and UIDVALIDITY recovery.
3. Complete message browsing and authorized multi-mailbox search.
4. Implement streaming EML, MBOX, ZIP, JSON, and CSV exports.
5. Implement IMAP APPEND restore and duplicate prevention.
6. Expand integrity verification, operational dashboards, and automated integration tests.
