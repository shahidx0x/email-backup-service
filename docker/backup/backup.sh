#!/usr/bin/env bash
set -Eeuo pipefail
host="${MONGODB_HOST:-mongodb}"; port="${MONGODB_PORT:-27017}"; database="${MONGODB_DATABASE:-email_backup}"; auth_source="${MONGODB_AUTH_SOURCE:-admin}"; retention_days="${BACKUP_RETENTION_DAYS:-30}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"; archive="/backups/${database}-${timestamp}.archive.gz"; final="$archive"
user="$(cat /run/secrets/mongodb_app_username)"; password="$(cat /run/secrets/mongodb_app_password)"
status_file="/backups/last-status.json"
fail(){ code=$?; printf '{"status":"failed","timestamp":"%s","exitCode":%d}\n' "$(date -u +%FT%TZ)" "$code" > "$status_file"; exit "$code"; }; trap fail ERR
mongodump --host "$host" --port "$port" --username "$user" --password "$password" --authenticationDatabase "$auth_source" --db "$database" --archive="$archive" --gzip
sha256sum "$archive" > "${archive}.sha256"
if [[ "${BACKUP_ENCRYPTION_ENABLED:-false}" == "true" ]]; then
  final="${archive}.enc"; openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:/run/secrets/backup_encryption_key -in "$archive" -out "$final"; rm -f "$archive" "${archive}.sha256"; sha256sum "$final" > "${final}.sha256"
fi
if [[ "${S3_BACKUP_ENABLED:-false}" == "true" ]]; then
  export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}" AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
  args=(); [[ -n "${S3_ENDPOINT:-}" ]] && args+=(--endpoint-url "$S3_ENDPOINT")
  aws "${args[@]}" s3 cp "$final" "s3://${S3_BUCKET:?S3_BUCKET is required}/$(basename "$final")"
  aws "${args[@]}" s3 cp "${final}.sha256" "s3://${S3_BUCKET}/$(basename "${final}.sha256")"
fi
find /backups -type f -mtime "+${retention_days}" ! -name 'last-status.json' -delete
printf '{"status":"success","timestamp":"%s","file":"%s"}\n' "$(date -u +%FT%TZ)" "$(basename "$final")" > "$status_file"
