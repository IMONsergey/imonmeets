#!/usr/bin/env bash
# Runs only on an empty Postgres volume. The API never receives the bootstrap password.
set -euo pipefail
[[ "${APP_DATABASE_PASSWORD:-}" =~ ^[a-f0-9]{64}$ ]] || { echo 'APP_DATABASE_PASSWORD must be 64 hex characters'; exit 1; }
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE imonmeets_app LOGIN PASSWORD '$APP_DATABASE_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT, CREATE ON DATABASE imonmeets TO imonmeets_app;
GRANT USAGE, CREATE ON SCHEMA public TO imonmeets_app;
SQL
