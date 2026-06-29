#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p secrets
write(){ local file="$1" value="$2"; if [[ -e "secrets/$file" ]]; then echo "Keeping existing secrets/$file"; else printf '%s\n' "$value" > "secrets/$file"; fi; }
write mongodb_root_username email_backup_root
write mongodb_root_password "$(openssl rand -base64 36)"
write mongodb_app_username email_backup_app
write mongodb_app_password "$(openssl rand -base64 36)"
if [[ ! -e secrets/mongodb_replica_key ]]; then openssl rand -base64 756 | tr -d '\n' > secrets/mongodb_replica_key; fi
write redis_password "$(openssl rand -base64 36)"
write jwt_access_secret "$(openssl rand -base64 64)"
write jwt_refresh_secret "$(openssl rand -base64 64)"
write credential_encryption_key "$(openssl rand -base64 32)"
write admin_initial_password "$(openssl rand -base64 24)"
write grafana_admin_password "$(openssl rand -base64 32)"
write backup_encryption_key "$(openssl rand -base64 32)"
chmod 600 secrets/*
echo 'Secrets are ready.'
