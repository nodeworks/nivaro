#!/bin/sh
# Release image HEALTHCHECK (#2787) — liveness only: does this process answer
# HTTP? /api/version reads nothing (no database, no Redis), so a database
# outage never marks the container unhealthy and gets it restarted for
# nothing. busybox wget (alpine) — no curl in the image.
#
# Cloud mode resolves a tenant from the Host header before routing, and a
# request to 127.0.0.1 has none (it would be redirected to the marketing
# site), so there the tenant-free /api/ready answers instead.
# NIVARO_HEALTHCHECK_PATH overrides either.
if [ -n "${NIVARO_HEALTHCHECK_PATH:-}" ]; then
  path="$NIVARO_HEALTHCHECK_PATH"
elif [ -n "${CLOUD_META_DB_URL:-}" ]; then
  path=/api/ready
else
  path=/api/version
fi
exec wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT:-3055}${path}"
