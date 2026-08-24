#!/bin/sh
# Tantalar container entrypoint.
#   tantalar-entrypoint server  — run the server (default CMD)
#   tantalar-entrypoint backup  — dump the SQLite database to /data/backups
#   tantalar-entrypoint restore <file> — restore a backup made with `backup`
set -eu

CONFIG="${TANTALAR_CONFIG_FILE:-/config/tantalar.yaml}"
PORT="${TANTALAR_PORT:-8790}"
DATA_DIR="${TANTALAR_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" "$(dirname "$CONFIG")"

# Durability decision (wave 1): the host config layer is a STARTER file.
# It is written only when absent so operator edits survive container
# restarts. Set TANTALAR_RESET_CONFIG=1 to regenerate it deliberately.
write_config() {
  [ -f "$CONFIG" ] && [ "${TANTALAR_RESET_CONFIG:-0}" != "1" ] && return 0
  # Host config layer: bind all interfaces; dialect from TANTALAR_DB_DIALECT
  # ("sqlite" default | "postgres" with TANTALAR_SECRET_DATABASE_POSTGRES_URL).
  DIALECT="${TANTALAR_DB_DIALECT:-sqlite}"
  {
    echo "server:"
    echo "  host: 0.0.0.0"
    echo "  port: $PORT"
    echo "database:"
    echo "  dialect: $DIALECT"
    if [ "$DIALECT" = "sqlite" ]; then
      echo "  sqlite:"
      echo "    path: $DATA_DIR/tantalar.db"
    fi
  } > "$CONFIG"
}

case "${1:-server}" in
  server)
    write_config
    exec node apps/server/dist/main.js
    ;;
  backup)
    STAMP="$(date +%Y%m%d-%H%M%S)"
    OUT="${2:-$DATA_DIR/backups/tantalar-$STAMP.db}"
    mkdir -p "$(dirname "$OUT")"
    node --input-type=module -e "
import { DatabaseSync, backup } from 'node:sqlite';
const src = new DatabaseSync('$DATA_DIR/tantalar.db');
await backup(src, '$OUT');
src.close();
console.log('backup written: $OUT');
"
    ;;
  restore)
    FILE="${2:?usage: tantalar-entrypoint restore <backup-file>}"
    [ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
    node --input-type=module -e "
import { DatabaseSync, backup } from 'node:sqlite';
import { rmSync } from 'node:fs';
const src = new DatabaseSync('$FILE');
await backup(src, '$DATA_DIR/tantalar.db');
src.close();
// Stale WAL/SHM would replay pre-restore pages over the restored file.
rmSync('$DATA_DIR/tantalar.db-wal', { force: true });
rmSync('$DATA_DIR/tantalar.db-shm', { force: true });
console.log('restored $FILE -> $DATA_DIR/tantalar.db');
"
    ;;
  *)
    write_config
    exec node apps/server/dist/main.js
    ;;
esac
