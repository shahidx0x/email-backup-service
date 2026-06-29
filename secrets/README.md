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
