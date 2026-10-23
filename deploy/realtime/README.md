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
session cookie, a Bearer token or a stream ticket. Give it `DB_POOL_MAX=20` and
`DB_POOL_BACKGROUND_MAX=0`: after a restart moves every socket to the surviving task, sign-ins,
room gates, presence writes, journeys, replays, pushed widgets and GraphQL live re-runs all land
at once. Live re-runs share the heavy-read gate on a realtime process (`HEAVY_READ_CONCURRENCY`),
and pushed widgets their own cap (3 at a time, `WIDGET_LIVE_MAX_PER_MIN`).

GraphQL over the subscription transports (graphql-ws, `/api/graphql/stream`) only reads, on
every process: a mutation there is refused with "Send mutations to POST /api/graphql".

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
  `loadbalancer.sticky.cookie=true`, `.cookie.name=nvr_rt` (any name: the EFP stack's own
  deploy config uses `efp_rt_srv`; the two are separate configs), `.cookie.httponly=true`,
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

- `/api/ready` on a realtime process requires boot and Redis; the database only warns (a slow
  database during a reconnect storm must not pull the last realtime task out of the proxy). On
  web it is unchanged and does not depend on the realtime tier.
- `/api/preflight` check `realtime` and the readiness check `realtime-tier`: a web or worker
  process with `SOCKETS=off` **fails** when no realtime process of its own deployment slot beat
  in the last 45 s, when `REALTIME_EVENT_STREAM=off` (realtime streams hear record changes on
  the stream), or when an unauthenticated `GET PUBLIC_URL/api/events/stream` is answered by a
  process without the `X-Nivaro-Role: realtime` header (the proxy route is missing); it **warns**
  with one realtime process and passes with two. A deploy canary (`NIVARO_ROLE=canary`) only
  warns.
- `/api/health` on a realtime process shows its socket count to administrators only.
- The instance roster (Database → Overview, and the mixed-version readiness check) shows the
  role, e.g. "4 web, 2 realtime, 1 worker"; entries carry `sockets: false` with `SOCKETS=off`.
- `/api/metrics` on every process has `nivaro_sockets_connected`; scrape each realtime task
  directly (`METRICS_TOKEN`) for it and `nodejs_eventloop_lag_max_seconds`.

## Who is viewing what, and extensions

- Several answers come from the sockets: who is viewing a record (the "N viewing" chip,
  now-editing, skipping an in-app notification for someone looking at the record), who is on a
  page, the socket list and room sizes (Realtime console, Traffic Map, chaos steady state), the
  concurrency sample, and "is anyone watching?" before the traffic feed, AI call feed, flow
  firehose and similar emits. Each realtime process publishes its share to Redis — the
  **realtime board**, `nvr:rt:board:<slot>:<process>:live` every 2 s (10 s TTL) and `:stats`
  every 10 s — and every `SOCKETS=off` process reads it back into memory, so these answers are
  at most ~4 s old (the socket list ~20 s) and no request waits on another process. A process
  that serves sockets answers from its own, as before.
- A `SOCKETS=off` process publishes through the Redis adapter but leaves its broadcast feed and
  request channel: it decodes no broadcasts and never sits in another process's `fetchSockets`
  quorum.
- Record changes reach the realtime processes on the event stream; if an entry goes out by the
  adapter instead (stream append failed), it is also relayed to the other processes' saved-view
  and SSE streams. Batched-mode collections reach SSE consumers on every process too.
- A reconnecting client re-sends its joins and then asks to catch up at once; the server now
  waits (up to 3 s) for those joins to land before replaying, so events written during the
  reconnect are no longer lost.
- A realtime process loads no extensions. A web or worker process with `SOCKETS=off` therefore
  **refuses to start** when an extension registers a Socket.io connection handler
  (`app.io.on('connection')`, any namespace): the handler would never run. Move that work to an
  event the API emits, or keep sockets on.

Deploy order: realtime first (it needs no migrations, but the web/worker roll runs them), then
web and worker with `SOCKETS=off`. Roll realtime one task at a time, the new one started first
(swarm `update_config: {parallelism: 1, order: start-first}`, in the compose file): plain
`docker compose up -d` recreates both replicas at once and drops every connection. To switch
back, unset `SOCKETS` on web and drop the realtime router; clients reconnect to web.

`/api/events/stream` on a deployment with several processes now hears record changes written on
any of them (before, only the writes of the process the stream connected to).

## Sizing: 200-250 people online

About 400 sockets with extra tabs (fewer where browsers share one socket per app through the
shared worker, `REALTIME_SHARED_WORKER`).

| | Count | Why |
|---|---|---|
| realtime | **2** | ~200 sockets each; either one must carry all ~400 alone through a rolling restart or a crash |
| web | 4 | request handling (the 2026-10-23 load was HTTP handler CPU, not connections) |
| worker | 1 | crons, imports, media |

Per realtime task: one core; memory limit **1280 MB** with `--max-old-space-size=768`
(provisional). Measured on a development build (2026-10-23, 400 websocket connections that had
not signed in and received nothing): ~185 MB heap at rest, +~120 KB heap and external memory per
socket. Signed-in sockets receiving traffic cost more: rooms, presence, pushed widgets, send
buffers (`SOCKET_BUFFER_SOFT_BYTES` 1 MB / hard 8 MB per slow consumer) and, with
`SOCKET_COMPRESSION` on (the default), per-message-deflate zlib state outside the heap (a few
hundred KB per socket that has sent a compressed frame). Set the final limit from a measurement
with 400 signed-in sockets under traffic (the realtime CI stack); `SOCKET_COMPRESSION=off` trades
that memory for bandwidth. Watch `nivaro_sockets_connected`, event-loop lag (keep p99
under 100 ms) and the delivery SLO (Realtime console, 95% under 2 s).

Database connections: realtime 2 x 20, web 4 x (25 + 5), worker 15 + 10 = 185 at most; check
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
