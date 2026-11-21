#!/bin/sh
set -eu
REDISCLI_AUTH=$(cat /run/secrets/redis-password)
export REDISCLI_AUTH
[ "$(redis-cli --no-auth-warning ping)" = 'PONG' ]
