FROM mongo:7.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends cron openssl ca-certificates awscli && rm -rf /var/lib/apt/lists/*
COPY docker/backup/entrypoint.sh /scripts/entrypoint.sh
COPY docker/backup/backup.sh /scripts/backup.sh
COPY docker/backup/restore.sh /scripts/restore.sh
RUN chmod 755 /scripts/*.sh
ENTRYPOINT ["/scripts/entrypoint.sh"]
