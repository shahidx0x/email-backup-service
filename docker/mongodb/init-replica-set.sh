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
