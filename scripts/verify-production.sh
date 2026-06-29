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
