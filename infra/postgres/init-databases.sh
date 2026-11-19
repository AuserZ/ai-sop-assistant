#!/bin/sh
(
  set -eu
  APP_RUNTIME_PASSWORD="$(cat /run/secrets/app-runtime)"
  APP_MIGRATOR_PASSWORD="$(cat /run/secrets/app-migrator)"
  N8N_DB_PASSWORD="$(cat /run/secrets/n8n-db)"
  test -n "$APP_RUNTIME_PASSWORD"
  test -n "$APP_MIGRATOR_PASSWORD"
  test -n "$N8N_DB_PASSWORD"
  export APP_RUNTIME_PASSWORD APP_MIGRATOR_PASSWORD N8N_DB_PASSWORD
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --file /opt/sop/bootstrap.sql
)
