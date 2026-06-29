#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: restore.sh /backups/file.archive.gz[.enc]" >&2
  exit 64
fi

source_file="$1"
tmp_file=""
if [[ "$source_file" == *.enc ]]; then
  tmp_file="$(mktemp /tmp/email-backup-restore.XXXXXX.archive.gz)"
  trap 'rm -f "$tmp_file"' EXIT
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/run/secrets/backup_encryption_key -in "$source_file" -out "$tmp_file"
  source_file="$tmp_file"
fi

user="$(cat /run/secrets/mongodb_app_username)"
password="$(cat /run/secrets/mongodb_app_password)"
mongorestore --host "${MONGODB_HOST:-mongodb}" --port "${MONGODB_PORT:-27017}" --username "$user" --password "$password" --authenticationDatabase "${MONGODB_AUTH_SOURCE:-admin}" --archive="$source_file" --gzip --drop
