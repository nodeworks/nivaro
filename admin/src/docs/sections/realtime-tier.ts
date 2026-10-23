import type { DocSection } from '../types.js'

export const realtimeTierDocs: DocSection = {
  id: 'realtime-tier',
  label: 'Realtime tier',
  content: [
    { type: 'h1', id: 'realtime-tier', text: 'Realtime tier' },
    {
      type: 'p',
      text: 'A process started with `NIVARO_ROLE=realtime` holds the live connections and nothing else: Socket.io, GraphQL subscriptions and the server-sent event streams. Connections then scale apart from request handling, and delivery never waits behind a request thread that is busy. The web processes turn sockets off with `SOCKETS=off`; what they emit still reaches people, through Redis (the Socket.io Redis adapter and the record-event stream). With nothing set, one process does everything, sockets included.'
    },
    {
      type: 'note',
      text: 'Self-hosted only. A realtime process refuses to start in cloud mode, and cloud mode ignores `SOCKETS`.'
    },
    { type: 'h2', id: 'realtime-tier-roles', text: 'Roles and settings' },
    {
      type: 'table',
      head: ['Setting', 'Values', 'What it does'],
      rows: [
        [
          '`NIVARO_ROLE`',
          '`web`, `worker`, `realtime` (also `canary`)',
          '`realtime` starts the realtime server: no REST routes, scheduled jobs, hooks, extensions, migrations or media work. The role shows on the instance roster and in the version check ("4 web, 2 realtime, 1 worker").'
        ],
        [
          '`SOCKETS`',
          '`on` (default) or `off`',
          '`off` on a web or worker process: it serves no `/socket.io`. Its emits reach the realtime processes through Redis. Ignored on a realtime process (always on) and in cloud mode.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'A realtime process needs the same `REDIS_URL`, `REDIS_CHANNEL_PREFIX`, `SESSION_SECRET`, cookie settings, `CORS_ORIGINS` and database settings as web. Sockets sign in exactly as before: the browser gets a one-time token from a web process (`GET /api/auth/ws-token`), which lives in Redis, and any process redeems it. Streams take the session cookie, a Bearer token or a one-time stream ticket. A small database pool is enough (`DB_POOL_MAX=10`, `DB_POOL_BACKGROUND_MAX=0`).'
    },
    { type: 'h2', id: 'realtime-tier-routes', text: 'What a realtime process answers' },
    {
      type: 'table',
      head: ['Path', 'What'],
      rows: [
        ['`/socket.io/`', 'Socket.io: websocket, and the long-polling fallback'],
        ['`/api/graphql-ws`', 'GraphQL subscriptions over websocket'],
        ['`GET`/`POST /api/graphql/stream`', 'GraphQL subscriptions and live queries over SSE'],
        ['`GET /api/events/stream`', 'Record changes over SSE'],
        ['`GET /api/events/views/:id/stream`', 'A saved view’s change stream over SSE'],
        ['`GET /api/events/ticket`', 'One-time stream ticket (web answers it too)'],
        [
          '`GET /api/version`, `/api/ready`, `/api/health`, `/api/metrics`',
          'Health; `/api/ready` checks boot, database and Redis'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Anything else answers 404 with a message that says to route it to the web processes. The admin `/api/stream` and MCP live sessions (`/api/mcp?live=1`) stay on web: the first reports the writes of the process it runs on, the second calls the API in-process.'
    },
    {
      type: 'p',
      text: '`/api/events/stream` now also hears record changes written on other processes (read from the record-event stream), on every process. A collection set to batched live updates sends no per-record entry, so a stream on another process does not see those writes.'
    },
    { type: 'h2', id: 'realtime-tier-routing', text: 'Proxy routing and sticky sessions' },
    {
      type: 'p',
      text: 'Send the five realtime paths to the realtime service with a higher priority than the web catch-all. Traefik v3:'
    },
    {
      type: 'pre',
      code: 'Host(`nivaro.example.com`) && (PathPrefix(`/socket.io/`) || Path(`/api/graphql-ws`)\n  || Path(`/api/graphql/stream`) || Path(`/api/events/stream`)\n  || PathRegexp(`^/api/events/views/[^/]+/stream$`))'
    },
    {
      type: 'p',
      text: 'Socket.io’s long-polling fallback sends one session as many HTTP requests, and each must reach the realtime process that holds the session. Put a sticky cookie on the realtime service (Traefik: `loadbalancer.sticky.cookie=true`, any cookie name, `httponly`, `secure`, `samesite=lax`); on nginx open source use `ip_hash` on the realtime upstream. Websockets and SSE streams are one connection each and need no stickiness; with `SOCKET_POLLING=off` none is needed at all. Turn off read timeouts on the paths that stay open.'
    },
    {
      type: 'p',
      text: '`deploy/realtime/` in the repository has a compose example (web ×4, realtime ×2, worker ×1 behind Traefik) and a README with the same rules.'
    },
    { type: 'h2', id: 'realtime-tier-readiness', text: 'Readiness' },
    {
      type: 'ul',
      items: [
        'Preflight check `realtime` and readiness check `realtime-tier`: a process with `SOCKETS=off` fails when its deployment has no realtime process in the instance roster, warns with one (a restart drops every connection until it is back), and passes with two or more. A deploy canary only warns.',
        '`/api/ready` on web does not depend on the realtime tier, so a realtime restart never takes the REST tier out of the proxy.',
        'Roster entries carry `sockets: false` on a process with `SOCKETS=off`; the Database page’s instance roster shows the role.',
        '`/api/metrics` reports `nivaro_sockets_connected` on every process.'
      ]
    },
    { type: 'h2', id: 'realtime-tier-sizing', text: 'Sizing for 200–250 people' },
    {
      type: 'p',
      text: 'About 400 sockets with extra tabs. Run two realtime processes, about 200 sockets each, so either can carry all of them through a restart; four web and one worker. Give each realtime process one core and a 768 MB limit with `--max-old-space-size=512`: at rest it holds about 185 MB of heap, and a signed-in socket costs roughly 250 KB with its rooms, presence and send buffer (about 100 MB at 400). Keep event-loop lag p99 under 100 ms and the delivery target (95% under 2 s) green.'
    },
    { type: 'h2', id: 'realtime-tier-limits', text: 'Limits' },
    {
      type: 'ul',
      items: [
        'What a process knows about its own sockets stays with the process that holds them. With `SOCKETS=off` the web processes hold none, so notifications are no longer skipped for someone who is looking at the record, and "who is on this page" lists read only the processes that hold sockets.',
        "Extension code that listens for `app.io.on('connection')` runs only where sockets are served, and a realtime process loads no extensions.",
        'The GraphQL schema is built when a process starts; a realtime process picks up a schema change at its next restart, as every web process does today.'
      ]
    }
  ]
}
