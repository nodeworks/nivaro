#!/bin/sh
# Release image HEALTHCHECK (#2787) — liveness only: does this process answer
# HTTP? /api/version reads nothing (no database, no Redis), so a database
# outage never marks the container unhealthy and gets it restarted for
# nothing. busybox wget (alpine) — no curl in the image.
#
# A multi-tenant process (cloud: CLOUD_META_DB_URL; a Nivaro Hub shared
# deployment: a non-blank HUB_SHARED_DEPLOYMENT, the same rule as
# isMultiTenant()) resolves an app from the Host header before routing, and a
# request to 127.0.0.1 names none (cloud redirects it to the marketing site, a
# shared deployment answers 503/404 "no app here"), so there the tenant-free
# /api/ready answers instead. NIVARO_HEALTHCHECK_PATH overrides either.
shared=$(printf '%s' "${HUB_SHARED_DEPLOYMENT:-}" | tr -d ' \t\n\r')
if [ -n "${NIVARO_HEALTHCHECK_PATH:-}" ]; then
  path="$NIVARO_HEALTHCHECK_PATH"
elif [ -n "${CLOUD_META_DB_URL:-}" ] || [ -n "$shared" ]; then
  path=/api/ready
else
  path=/api/version
fi
exec wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT:-3055}${path}"
