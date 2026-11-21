#!/bin/sh
set -eu
umask 077
queue_password=$(cat /run/secrets/redis-password)
case "$queue_password" in
  ''|*[!0-9a-f]*) exit 1 ;;
esac
[ "${#queue_password}" -eq 64 ]
mkdir -p /tmp/sop-redis
printf '%s\n' \
  'bind 0.0.0.0' \
  'protected-mode yes' \
  'port 6379' \
  'save ""' \
  'appendonly no' \
  'maxmemory 128mb' \
  'maxmemory-policy noeviction' \
  "requirepass $queue_password" > /tmp/sop-redis/redis.conf
unset queue_password
exec redis-server /tmp/sop-redis/redis.conf
