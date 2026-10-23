# Realtime tier (NIVARO_ROLE=realtime)

A realtime process holds the live connections and nothing else, so connections scale apart
from request handling and delivery never waits behind a busy request thread. The web processes
turn sockets off (`SOCKETS=off`); what they emit reaches people through Redis (the Socket.io
Redis adapter and the record-event stream). `docker-compose.yml` here runs web x4, realtime x2
and worker x1 behind Traefik.

Nothing set = one process does everything, sockets included. The tier is self-hosted only: a
realtime process refuses to boot in cloud mode, and cloud mode ignores `SOCKETS`.

## Roles

| Role | Env | Serves |
|---|---|---|
| web | `NIVARO_ROLE=web SOCKETS=off` | REST, GraphQL queries, the admin build, `/api/events/ticket`, the admin `/api/stream`, MCP |
| realtime | `NIVARO_ROLE=realtime` | Socket.io, graphql-ws, the SSE streams, `/api/version`, `/api/ready`, `/api/health`, `/api/metrics` |
| worker | `NIVARO_ROLE=worker SOCKETS=off CRON_TICKS=on` | scheduled jobs, imports, media work; not routed |

A realtime process runs no migrations, crons, hooks, extensions, event flows or media work,
and answers every other path with a 404 that says to route it to web. It needs the same
`REDIS_URL`, `REDIS_CHANNEL_PREFIX`, `SESSION_SECRET`, `COOKIE_*`, `CORS_ORIGINS` and `DB_*`
as web: sockets sign in with the one-shot ws token web mints into Redis, and streams read the
session cookie, a Bearer token or a stream ticket. `DB_POOL_MAX=10` and
`DB_POOL_BACKGROUND_MAX=0` are enough (sign-in, room checks, presence writes, pushed widgets,
GraphQL live queries).

## Routing

Send these to the realtime service, everything else to web:

| Path | What |
|---|---|
| `/socket.io/` (prefix) | Socket.io: websocket, and the long-polling fallback |
| `/api/graphql-ws` | GraphQL subscriptions over websocket |
| `/api/graphql/stream` | GraphQL subscriptions and live queries over SSE (GET and POST) |
| `/api/events/stream` | record changes over SSE |
| `/api/events/views/<id>/stream` | saved-view change stream over SSE |

Stay on web: `/api/events/ticket` (either works, tickets live in Redis), `/api/auth/ws-token`,
the admin `/api/stream` (it reports the writes of the process it runs on), MCP live sessions
(`/api/mcp?live=1`), the shared-worker script `/api/realtime/worker.js`.

Traefik v3 rule (give it a priority above the web catch-all):

```
Host(`nivaro.example.com`) && (PathPrefix(`/socket.io/`) || Path(`/api/graphql-ws`)
  || Path(`/api/graphql/stream`) || Path(`/api/events/stream`)
  || PathRegexp(`^/api/events/views/[^/]+/stream$`))
```

Traefik v2 has no `PathRegexp`: use ``Path(`/api/events/views/{id:[^/]+}/stream`)``.

Keep long-lived connections open: no read timeout on the entrypoint (Traefik
`respondingTimeouts.readTimeout=0`), and for nginx `proxy_read_timeout 1h`,
`proxy_buffering off` on the SSE paths, `proxy_http_version 1.1` with the
`Upgrade`/`Connection` headers on `/socket.io/` and `/api/graphql-ws`.

## Sticky sessions

Socket.io's long-polling fallback sends a session's requests as separate HTTP requests; every
one must reach the realtime task that holds that session, or the task answers `400 Session ID
unknown` and the client reconnects in a loop. Websockets and SSE are one connection each and do
not care. So:

- **Traefik**: a sticky cookie on the realtime service only —
  `loadbalancer.sticky.cookie=true`, `.cookie.name=nvr_rt` (any name), `.cookie.httponly=true`,
  `.cookie.secure=true`, `.cookie.samesite=lax`. The first polling request gets the cookie; the
  browser sends it on the rest (same origin).
- **nginx (open source)**: no cookie stickiness — `ip_hash;` (or `hash $remote_addr consistent;`)
  on the realtime upstream. People behind one corporate NAT then land on one task; that is fine
  for polling, which only the clients that cannot open a websocket use.
- **No stickiness needed** when long-polling is off (`SOCKET_POLLING=off` on the realtime
  processes): every client must then reach the API over websockets.
- When a sticky task goes away its cookie points nowhere; Traefik picks a live task and resets
  the cookie, and the client reconnects (the event journal replays what it missed).

## Readiness

- `/api/ready` on a realtime process checks boot, database and Redis. On web it is unchanged
  and does not depend on the realtime tier (a realtime restart must not pull REST out of the
  proxy).
- `/api/preflight` check `realtime` and the readiness check `realtime-tier`: a web or worker
  process with `SOCKETS=off` **fails** when no realtime process of its deployment is in the
  instance roster, **warns** with one (a restart drops every connection), passes with two. A
  deploy canary (`NIVARO_ROLE=canary`) only warns.
- The instance roster (Database → Overview, and the mixed-version readiness check) shows the
  role, e.g. "4 web, 2 realtime, 1 worker"; entries carry `sockets: false` with `SOCKETS=off`.
- `/api/metrics` on every process has `nivaro_sockets_connected`; scrape each realtime task
  directly (`METRICS_TOKEN`) for it and `nodejs_eventloop_lag_max_seconds`.

Deploy order: realtime first (it needs no migrations, but the web/worker roll runs them), then
web and worker with `SOCKETS=off`. To switch back, unset `SOCKETS` on web and drop the realtime
router; clients reconnect to web.

## Sizing: 200-250 people online

About 400 sockets with extra tabs (fewer where browsers share one socket per app through the
shared worker, `REALTIME_SHARED_WORKER`).

| | Count | Why |
|---|---|---|
| realtime | **2** | ~200 sockets each; either one must carry all ~400 alone through a rolling restart or a crash |
| web | 4 | request handling (the 2026-10-23 load was HTTP handler CPU, not connections) |
| worker | 1 | crons, imports, media |

Per realtime task: one core; memory limit 768 MB with `--max-old-space-size=512`. Measured on a
development build (2026-10-23, 400 websocket connections that had not signed in): ~185 MB heap
at rest, +~120 KB heap and external memory per socket. Signed-in sockets also carry rooms,
presence, pushed widgets and send buffers (`SOCKET_BUFFER_SOFT_BYTES` 1 MB / hard 8 MB per slow
consumer): budget ~250 KB each, about 100 MB at 400 sockets, so ~300-350 MB per task with
headroom for a reconnect storm. Watch `nivaro_sockets_connected`, event-loop lag (keep p99
under 100 ms) and the delivery SLO (Realtime console, 95% under 2 s).

Database connections: realtime 2 x 10, web 4 x (25 + 5), worker 15 + 10 = 165 at most; check
that against the server's connection limit and lower web's pool before raising replicas.

## Load-test baseline: one tier vs two

`scripts/realtime-load.mjs` drives N signed-in sessions (sockets, presence pings, refetches)
and reports delivery latency, missed events and server lag per step. Same build, same staging
host, same tokens, run each layout twice:

1. One tier — web x4 with sockets (no `SOCKETS`, no realtime router):

   ```
   node scripts/realtime-load.mjs --target https://<staging> --tokens-file ~/load-tokens.txt \
     --admin-token "$ADMIN_BEARER" --people 250 --two-tab-share 0.6 \
     --ramp-minutes 10 --steps 5 --hold-minutes 5 --out /tmp/rt-one-tier.json
   ```

2. Two tiers — realtime x2 up, the realtime router on, web and worker with `SOCKETS=off`;
   the same command with `--out /tmp/rt-two-tier.json`.

Compare per step: delivery p95/p99 and the share within 2 s, missed events, `/presence/online`
p95, and event-loop lag. The script's server samples come from `/api/ops-runtime/runtime`, which
the proxy sends to web; read the realtime tasks' lag and socket counts from their `/api/metrics`
during the run (or the Traffic Map, whose role panel lists the realtime processes).
