# Current implementation status

The `dev` branch now contains an operational multi-mailbox backup path, not only architecture scaffolding.

## Implemented

- Encrypted multi-mailbox configuration and Hostinger-compatible IMAP testing
- Folder discovery and Sent-folder detection
- Resumable UID-based initial and incremental synchronization
- Per-folder distributed locks
- UIDVALIDITY change detection and controlled location rebuilding
- Raw RFC 5322 message persistence in GridFS
- MIME parsing and searchable MongoDB metadata
- Attachment extraction, filename sanitization, hashing, and GridFS persistence
- Source-deletion reconciliation while retaining backup copies
- Scheduled polling and a controlled IMAP IDLE watcher implementation
- Authorized message browsing, full-text filtering, raw EML downloads, and attachment downloads
- Queue-backed EML, MBOX, ZIP, JSON, and CSV exports
- Export manifests, checksums, progress, cancellation, retry, expiration, and authenticated downloads
- Queue-backed IMAP APPEND restore with duplicate-restoration checks
- JWT access tokens, rotating refresh tokens, Argon2id, roles, CSRF validation, and optional TOTP MFA
- User, folder, queue-job, and audit-log administration APIs
- Responsive dashboard pages for mailboxes, messages, exports, queues, and audit activity
- MongoDB replica set, Redis persistence, Prometheus, Grafana, backups, and Docker secrets
- Production Swagger/OpenAPI rejection and route removal
- Separate API, scheduler, connection worker, message worker, export worker, and restore worker processes

## Compose deployment

The default `compose.yaml` starts the API, dashboard, connection worker, message synchronization worker, export worker, restore worker, scheduler, MongoDB, Redis, Prometheus, Grafana, and backup service. No bundled Nginx is included; public traffic is expected to pass through the host's existing web server.

## Validation

GitHub Actions currently performs dependency installation, strict TypeScript checking, unit tests, production builds, and `docker compose config --quiet`. The most recent completed workflow passed all of those steps.

## Remaining production validation

The codebase still needs real-server acceptance testing before it should be treated as the sole copy of important mail. In particular, execute the documented Docker smoke test against disposable IMAP accounts, verify large-message behavior, perform an encrypted backup/restore drill, and test failure recovery by restarting MongoDB, Redis, and workers during synchronization.

The requested exhaustive Testcontainers-based integration matrix and provider-specific acceptance suite are not yet complete. These are validation gaps, not hidden placeholders in the runtime implementation.
