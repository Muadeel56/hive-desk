#!/bin/sh
# Waits for Postgres to accept connections, applies pending migrations, then
# execs the container's CMD (or compose's `command:` override) as PID 1 so
# signals (SIGTERM from `docker compose down`/`stop`) reach the Node process
# directly for graceful shutdown.
#
# Never runs `prisma migrate dev` — only `migrate deploy`, which applies
# existing migrations and never generates new ones from inside a container.
set -e

DB_HOST=$(node -e "console.log(new URL(process.env.DATABASE_URL).hostname)")
DB_PORT=$(node -e "const u = new URL(process.env.DATABASE_URL); console.log(u.port || 5432)")

echo "docker-entrypoint: waiting for Postgres at ${DB_HOST}:${DB_PORT}..."
attempt=0
max_attempts=30
until nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "docker-entrypoint: Postgres unreachable at ${DB_HOST}:${DB_PORT} after ${max_attempts} attempts, giving up." >&2
    exit 1
  fi
  sleep 2
done
echo "docker-entrypoint: Postgres is reachable."

echo "docker-entrypoint: running prisma migrate deploy..."
if ! npx prisma migrate deploy; then
  echo "docker-entrypoint: migration failed, aborting startup." >&2
  exit 1
fi
echo "docker-entrypoint: migrations applied."

exec "$@"
