#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${1:-.}"
cd "$ROOT"

mkdir -p 'docker/backup'
cat > 'docker/backup/Dockerfile' <<'__EMAIL_BACKUP_FILE_0__'
FROM mongo:7.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends cron openssl ca-certificates awscli && rm -rf /var/lib/apt/lists/*
COPY docker/backup/entrypoint.sh /scripts/entrypoint.sh
COPY docker/backup/backup.sh /scripts/backup.sh
COPY docker/backup/restore.sh /scripts/restore.sh
RUN chmod 755 /scripts/*.sh
ENTRYPOINT ["/scripts/entrypoint.sh"]
__EMAIL_BACKUP_FILE_0__

mkdir -p 'docker/backup'
cat > 'docker/backup/backup.sh' <<'__EMAIL_BACKUP_FILE_1__'
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
__EMAIL_BACKUP_FILE_1__
chmod +x 'docker/backup/backup.sh'

mkdir -p 'docker/backup'
cat > 'docker/backup/entrypoint.sh' <<'__EMAIL_BACKUP_FILE_2__'
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
__EMAIL_BACKUP_FILE_2__
chmod +x 'docker/backup/entrypoint.sh'

mkdir -p 'docker/backup'
cat > 'docker/backup/restore.sh' <<'__EMAIL_BACKUP_FILE_3__'
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
__EMAIL_BACKUP_FILE_3__
chmod +x 'docker/backup/restore.sh'

mkdir -p 'docker/grafana/dashboards'
cat > 'docker/grafana/dashboards/email-backup.json' <<'__EMAIL_BACKUP_FILE_4__'
{
  "annotations": {"list": []},
  "editable": true,
  "panels": [
    {"type":"stat","title":"API Up","targets":[{"expr":"up{job=\"email-backup-api\"}"}],"gridPos":{"h":8,"w":8,"x":0,"y":0}},
    {"type":"stat","title":"Worker Heartbeat","targets":[{"expr":"worker_heartbeat_timestamp"}],"gridPos":{"h":8,"w":8,"x":8,"y":0}},
    {"type":"timeseries","title":"HTTP Requests","targets":[{"expr":"rate(http_requests_total[5m])"}],"gridPos":{"h":9,"w":24,"x":0,"y":8}}
  ],
  "schemaVersion": 41,
  "tags": ["email-backup"],
  "templating": {"list": []},
  "time": {"from":"now-6h","to":"now"},
  "title": "Email Backup Platform",
  "uid": "email-backup-platform",
  "version": 1
}
__EMAIL_BACKUP_FILE_4__

mkdir -p 'docker/grafana/provisioning/dashboards'
cat > 'docker/grafana/provisioning/dashboards/dashboard.yml' <<'__EMAIL_BACKUP_FILE_5__'
apiVersion: 1
providers:
  - name: Email Backup
    orgId: 1
    folder: Email Backup
    type: file
    disableDeletion: true
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
__EMAIL_BACKUP_FILE_5__

mkdir -p 'docker/grafana/provisioning/datasources'
cat > 'docker/grafana/provisioning/datasources/prometheus.yml' <<'__EMAIL_BACKUP_FILE_6__'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
__EMAIL_BACKUP_FILE_6__

mkdir -p 'docker/mongodb'
cat > 'docker/mongodb/init-replica-set.sh' <<'__EMAIL_BACKUP_FILE_7__'
#!/usr/bin/env bash
set -Eeuo pipefail

host="${MONGODB_HOST:-mongodb}"
port="${MONGODB_PORT:-27017}"
database="${MONGODB_DATABASE:-email_backup}"
root_user="$(cat /run/secrets/mongodb_root_username)"
root_password="$(cat /run/secrets/mongodb_root_password)"
app_user="$(cat /run/secrets/mongodb_app_username)"
app_password="$(cat /run/secrets/mongodb_app_password)"

mongo() {
  mongosh --quiet --host "$host" --port "$port" -u "$root_user" -p "$root_password" --authenticationDatabase admin "$@"
}

for _ in $(seq 1 60); do
  if mongo --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then break; fi
  sleep 2
done

if ! mongo --eval 'rs.status().ok' >/dev/null 2>&1; then
  mongo --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'${host}:${port}'}]})"
fi

for _ in $(seq 1 60); do
  state="$(mongo --eval 'db.hello().isWritablePrimary' 2>/dev/null || true)"
  if [[ "$state" == "true" ]]; then break; fi
  sleep 2
done

mongo --eval "const a=db.getSiblingDB('admin'); if (!a.getUser('${app_user}')) { a.createUser({user:'${app_user}',pwd:'${app_password}',roles:[{role:'readWrite',db:'${database}'}]}); }"
echo "MongoDB replica set and application user are ready."
__EMAIL_BACKUP_FILE_7__
chmod +x 'docker/mongodb/init-replica-set.sh'

mkdir -p 'docker/prometheus'
cat > 'docker/prometheus/prometheus.yml' <<'__EMAIL_BACKUP_FILE_8__'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: email-backup-api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:3000"]
  - job_name: email-backup-worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:3002"]
  - job_name: email-backup-scheduler
    metrics_path: /metrics
    static_configs:
      - targets: ["scheduler:3003"]
__EMAIL_BACKUP_FILE_8__

mkdir -p '.github/workflows'
cat > '.github/workflows/ci.yml' <<'__EMAIL_BACKUP_FILE_9__'
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
__EMAIL_BACKUP_FILE_9__

mkdir -p 'secrets'
cat > 'secrets/.gitkeep' <<'__EMAIL_BACKUP_FILE_10__'

__EMAIL_BACKUP_FILE_10__

mkdir -p 'secrets'
cat > 'secrets/README.md' <<'__EMAIL_BACKUP_FILE_11__'
# Docker secrets

Create every file below before starting the production stack. Each file must contain only the secret value and a trailing newline is acceptable.

```bash
mkdir -p secrets
printf 'email_backup_root\n' > secrets/mongodb_root_username
openssl rand -base64 36 > secrets/mongodb_root_password
printf 'email_backup_app\n' > secrets/mongodb_app_username
openssl rand -base64 36 > secrets/mongodb_app_password
openssl rand -base64 756 | tr -d '\n' > secrets/mongodb_replica_key
openssl rand -base64 36 > secrets/redis_password
openssl rand -base64 64 > secrets/jwt_access_secret
openssl rand -base64 64 > secrets/jwt_refresh_secret
openssl rand -base64 32 > secrets/credential_encryption_key
openssl rand -base64 24 > secrets/admin_initial_password
openssl rand -base64 32 > secrets/grafana_admin_password
openssl rand -base64 32 > secrets/backup_encryption_key
chmod 600 secrets/*
```

`credential_encryption_key` must decode to exactly 32 bytes. The generated command above satisfies that requirement. Never commit these files.
__EMAIL_BACKUP_FILE_11__

mkdir -p 'scripts'
cat > 'scripts/generate-secrets.sh' <<'__EMAIL_BACKUP_FILE_12__'
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
__EMAIL_BACKUP_FILE_12__
chmod +x 'scripts/generate-secrets.sh'

mkdir -p 'scripts'
cat > 'scripts/verify-production.sh' <<'__EMAIL_BACKUP_FILE_13__'
#!/usr/bin/env bash
set -Eeuo pipefail
base="${1:-http://127.0.0.1:3000}"
curl --fail --silent "$base/health" >/dev/null
curl --fail --silent "$base/ready" >/dev/null
for path in /api/docs /api/docs/ /api/docs-json /api/openapi.json /swagger /swagger-ui; do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$base$path")"
  [[ "$status" == "404" ]] || { echo "$path returned $status, expected 404" >&2; exit 1; }
done
echo 'Production health and Swagger route checks passed.'
__EMAIL_BACKUP_FILE_13__
chmod +x 'scripts/verify-production.sh'

echo 'Materialized project files.'
