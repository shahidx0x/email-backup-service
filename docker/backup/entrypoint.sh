#!/usr/bin/env bash
set -Eeuo pipefail
schedule="${BACKUP_SCHEDULE:-0 1 * * *}"
{
  echo 'SHELL=/bin/bash'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  printf '%s root ' "$schedule"
  printf 'MONGODB_HOST=%q MONGODB_PORT=%q MONGODB_DATABASE=%q MONGODB_AUTH_SOURCE=%q BACKUP_RETENTION_DAYS=%q BACKUP_ENCRYPTION_ENABLED=%q S3_BACKUP_ENABLED=%q S3_ENDPOINT=%q S3_REGION=%q S3_BUCKET=%q S3_FORCE_PATH_STYLE=%q /scripts/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2\n' \
    "${MONGODB_HOST:-mongodb}" "${MONGODB_PORT:-27017}" "${MONGODB_DATABASE:-email_backup}" "${MONGODB_AUTH_SOURCE:-admin}" \
    "${BACKUP_RETENTION_DAYS:-30}" "${BACKUP_ENCRYPTION_ENABLED:-false}" "${S3_BACKUP_ENABLED:-false}" "${S3_ENDPOINT:-}" "${S3_REGION:-}" "${S3_BUCKET:-}" "${S3_FORCE_PATH_STYLE:-false}"
} > /etc/cron.d/email-backup
chmod 0644 /etc/cron.d/email-backup
/scripts/backup.sh
exec cron -f
