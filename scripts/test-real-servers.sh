#!/bin/sh
# Run the adapter test suites against REAL database servers in Docker, then remove them.
# Covers what could not be tested in development: MongoDB, the Firestore emulator, MySQL 8, MariaDB, PostgreSQL 16.
# Needs: docker, pnpm, and the repositories built (sh scripts/build-all.sh). Takes a few minutes the first time.
#
# Status: written but NOT run (the machine it was written on had no Docker). If a step fails, the
# message above it says which server; fix the script rather than skipping the server.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ADAPTERS="$(dirname "$ROOT")/sethucms-adapters"
[ -d "$ADAPTERS" ] || { echo "Missing $ADAPTERS" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed" >&2; exit 1; }

PW=testpw-$$
NAMES="sethu-t-mongo sethu-t-mysql sethu-t-maria sethu-t-pg sethu-t-fs"
cleanup() { for n in $NAMES; do docker rm -f "$n" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT INT TERM
cleanup

wait_for() { # name, command run inside the container
  i=0; until docker exec "$1" sh -c "$2" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -gt 60 ] && { echo "$1 did not become ready" >&2; docker logs "$1" | tail -20 >&2; exit 1; }; sleep 2; done
}

echo "==> starting servers"
docker run -d --name sethu-t-mongo -p 127.0.0.1:27018:27017 -e MONGO_INITDB_ROOT_USERNAME=sethu -e MONGO_INITDB_ROOT_PASSWORD=$PW mongo:7 >/dev/null
docker run -d --name sethu-t-mysql -p 127.0.0.1:3308:3306 -e MYSQL_ROOT_PASSWORD=$PW mysql:8 >/dev/null
docker run -d --name sethu-t-maria -p 127.0.0.1:3309:3306 -e MARIADB_ROOT_PASSWORD=$PW mariadb:11 >/dev/null
docker run -d --name sethu-t-pg -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD=$PW postgres:16 >/dev/null
docker run -d --name sethu-t-fs -p 127.0.0.1:8081:8080 google/cloud-sdk:emulators \
  gcloud emulators firestore start --host-port=0.0.0.0:8080 >/dev/null

wait_for sethu-t-mongo "mongosh --quiet -u sethu -p $PW --authenticationDatabase admin --eval 'db.runCommand({ping:1})'"
wait_for sethu-t-mysql "mysqladmin ping -uroot -p$PW"
wait_for sethu-t-maria "mariadb-admin ping -uroot -p$PW || mysqladmin ping -uroot -p$PW"
wait_for sethu-t-pg "pg_isready -U postgres"
sleep 15   # the Firestore emulator has no simple in-container check

status=0
run() { # label, directory, then env assignments and the command
  label=$1; dir=$2; shift 2
  echo; echo "==> $label"
  if (cd "$dir" && env "$@"); then echo "PASS $label"; else echo "FAIL $label"; status=1; fi
}

run "MongoDB 7"          "$ADAPTERS/packages/mongodb"   SETHUCMS_TEST_MONGO_URL="mongodb://sethu:$PW@127.0.0.1:27018" pnpm test
run "Firestore emulator" "$ADAPTERS/packages/firestore" SETHUCMS_TEST_FIRESTORE_EMULATOR="127.0.0.1:8081" pnpm test
run "MySQL 8"            "$ADAPTERS/packages/mysql"     SETHUCMS_TEST_MYSQL_URL="mysql://root:$PW@127.0.0.1:3308" pnpm test
run "MariaDB 11"         "$ADAPTERS/packages/mysql"     SETHUCMS_TEST_MYSQL_URL="mysql://root:$PW@127.0.0.1:3309" pnpm test
run "PostgreSQL 16"      "$ADAPTERS/packages/postgres"  SETHUCMS_TEST_PG_URL="postgres://postgres:$PW@127.0.0.1:5433/postgres" SETHUCMS_TEST_PG_HOST=127.0.0.1 SETHUCMS_TEST_PG_PORT=5433 SETHUCMS_TEST_PG_USER=postgres SETHUCMS_TEST_PG_PASSWORD="$PW" SETHUCMS_TEST_PG_DB=postgres pnpm test
run "Migration across databases" "$ROOT/apps/api" \
  SETHUCMS_TEST_MONGO_URL="mongodb://sethu:$PW@127.0.0.1:27018" SETHUCMS_TEST_MYSQL_URL="mysql://root:$PW@127.0.0.1:3308" \
  SETHUCMS_TEST_PG_URL="postgres://postgres:$PW@127.0.0.1:5433/postgres" \
  node --test dist/tests/migration-cross.test.js

echo; [ $status -eq 0 ] && echo "All real-server suites passed." || echo "Some suites FAILED (see above)."
exit $status
