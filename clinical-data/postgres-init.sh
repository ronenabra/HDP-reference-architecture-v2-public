#!/bin/sh
set -eu

for letter in A B C; do
  case "$letter" in
    A) database=$PCM_A_DB_NAME; owner=$PCM_A_DB_USER; password=$PCM_A_DB_PASSWORD ;;
    B) database=$PCM_B_DB_NAME; owner=$PCM_B_DB_USER; password=$PCM_B_DB_PASSWORD ;;
    C) database=$PCM_C_DB_NAME; owner=$PCM_C_DB_USER; password=$PCM_C_DB_PASSWORD ;;
  esac
  case "$database:$owner" in
    *[!a-z0-9_:]*) echo "Unsafe PostgreSQL tenant name" >&2; exit 1 ;;
  esac
  escaped_password=$(printf '%s' "$password" | sed "s/'/''/g")
  psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE $owner LOGIN PASSWORD '$escaped_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE $database OWNER $owner;
REVOKE CONNECT ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $owner;
SQL
done
