#!/usr/bin/env bash
# Runs all tests. Integration tests need a throw-away Postgres + Redis, e.g.:
#   docker run -d --name sqtest-pg -e POSTGRES_PASSWORD=squeak -e POSTGRES_USER=squeak -e POSTGRES_DB=squeak_test -p 55432:5432 postgres:16-alpine
#   docker run -d --name sqtest-redis -p 56379:6379 redis:7-alpine
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://squeak:squeak@localhost:55432/squeak_test}
export TEST_REDIS_URL=${TEST_REDIS_URL:-redis://localhost:56379}
exec node --test test/*.test.js
