#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${WG_DB_CONTAINER:-supabase-db}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! podman container exists "$CONTAINER"; then
    echo "ERROR: container '$CONTAINER' does not exist." >&2
    exit 1
fi

if [[ "$(podman inspect -f '{{.State.Status}}' "$CONTAINER")" != "running" ]]; then
    echo "ERROR: container '$CONTAINER' is not running." >&2
    exit 1
fi

run_psql_quiet() {
    podman exec -i "$CONTAINER" \
        psql -U "$DB_USER" -d "$DB_NAME" \
        -v ON_ERROR_STOP=1 -q
}

run_psql() {
    podman exec -i "$CONTAINER" \
        psql -U "$DB_USER" -d "$DB_NAME" \
        -v ON_ERROR_STOP=1
}

echo "==> Using PostgreSQL container: $CONTAINER"

echo "==> Ensuring 'github' role exists"
run_psql <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'github'
  ) THEN
    CREATE ROLE github;
  END IF;
END $$;
SQL

echo "==> Dropping + recreating public schema"
run_psql <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "==> Ensuring pg_trgm extension in schema public"
run_psql <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

DO $$
BEGIN
  IF (
    SELECT n.nspname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm'
  ) <> 'public' THEN
    ALTER EXTENSION pg_trgm SET SCHEMA public;
  END IF;
END $$;
SQL

echo "==> Loading schema.sql"
sed \
    -e '/^\\restrict /d' \
    -e '/^\\unrestrict /d' \
    -e '/^CREATE TRIGGER /d' \
    "$SCRIPT_DIR/schema.sql" \
    | run_psql_quiet

echo "==> Loading data.sql (~45 MB)"
sed \
    -e '/^\\restrict /d' \
    -e '/^\\unrestrict /d' \
    "$SCRIPT_DIR/data.sql" \
    | run_psql_quiet

echo "==> Granting access to Supabase roles"
run_psql <<'SQL'
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLES
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT
  ON SEQUENCES
  TO anon, authenticated, service_role;
SQL

echo "==> Installing auth -> public_user trigger"
run_psql < "$SCRIPT_DIR/auth-trigger.sql"

echo "==> Applying WG migrations"

shopt -s nullglob
migrations=("$SCRIPT_DIR"/../supabase/migrations/*.sql)

for migration in "${migrations[@]}"; do
    echo "    -> $(basename "$migration")"
    run_psql_quiet < "$migration"
done

echo "==> Done."
