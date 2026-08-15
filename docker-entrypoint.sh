#!/bin/sh
set -eu

database_dir=$(dirname "${DATABASE_PATH:-/app/data/app.db}")
mkdir -p "$database_dir"
chown -R node:node "$database_dir"

exec gosu node "$@"
