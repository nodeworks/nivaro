import type { DocSection } from '../types.js'

export const realtimeTransport: DocSection = {
  id: 'realtime-transport',
  label: 'Live Updates',
  content: [
    { type: 'h1', id: 'realtime-transport', text: 'Live Updates' },
    {
      type: 'p',
      text: 'Open lists, records, queues and chat update as other people work, over one Socket.io connection per browser (the leader tab carries the collection feed for every tab). The Realtime console (Operations → Realtime) shows who is connected, how, and what it costs.'
    },
    { type: 'h2', id: 'realtime-fallback', text: 'When websockets are blocked' },
    {
      type: 'p',
      text: 'Every client tries the websocket first. When a proxy strips the upgrade, the same connect attempt falls through to HTTP long-polling; when the server refuses polling too, the leader tab reads collection changes from the read-only `GET /api/events/stream` (SSE) and relays them to the other tabs. Chat, presence and watch rooms wait for a socket.'
    },
    {
      type: 'ul',
      items: [
        'Long-polling needs **sticky sessions** behind a load balancer: every poll must reach the process holding that connection. Where the balancer is not sticky, set `SOCKET_POLLING=off` and blocked clients use the SSE stream instead.',
        "The Sockets tab shows each socket's transport (`websocket` or `polling`) and counts the SSE fallback streams apart.",
        'The SDK realtime client and every admin socket use the same order: websocket, then polling.'
      ]
    },
    { type: 'h2', id: 'realtime-payload', text: 'Compression and payload size' },
    {
      type: 'p',
      text: 'Frames over 1 KB are compressed (per-message deflate; `SOCKET_COMPRESSION=off` turns it off — it costs CPU per socket). The **Payload size** tab counts messages and bytes written to sockets on this API process, by event type and by room kind (every record room of a collection is one row), heaviest first, so a heavy broadcast can be found and trimmed. Bytes are counted before compression; a broadcast counts once per socket that received it. **Reset counters** starts over, to see the effect of a change.'
    },
    { type: 'h2', id: 'realtime-coalesce', text: 'Bursts are merged' },
    {
      type: 'p',
      text: "An import or bulk action writing thousands of rows used to send thousands of `collection:update` messages to every watching tab. The server now coalesces per socket: the first change to a collection goes out at once, and the rest of each one-second window collapse into ONE message listing the ids (`coalesced: true`, `items: [...]`, or `many: true` past 200 ids), so each tab refreshes once. Only clients that say they understand it (`features: ['coalesce']` in `client:hello`) receive merged messages; others keep one message per change. Shared components read them through `updateItemIds()` / `updateTouches()`."
    },
    { type: 'h2', id: 'realtime-session-end', text: 'Sockets close when the sign-in ends' },
    {
      type: 'p',
      text: "A socket is bound to what signed it in: the session, a View-as (masquerade) token, a static token or a named API key — never to the account alone. Logout, a revoked session (Security → Sessions, \"sign out everywhere else\"), a session past the session policy, an ended View-as, a rotated token, a switched-off or expired API key and a suspended account all close that sign-in's sockets on every API process (through the Redis adapter, and a 30-second sweep on each process catches anything nothing announced). The tab is told why (`session:ended`) and returns to sign-in — unless the browser already holds a newer sign-in, in which case it simply reconnects. The SSE stream ends the same way at its next heartbeat. A socket or stream opened through an API key carries that key's scopes and row restrictions. A View-as tab never falls back to the SSE stream (it could only open on the administrator's own cookie)."
    },
    { type: 'h2', id: 'realtime-access-recheck', text: 'Room access follows permission changes' },
    {
      type: 'p',
      text: 'Rooms used to be checked only when joined. Now a change to a person (role, status, user scopes, offboarding) or to access everywhere (roles and policies, teams, scope dimensions, channel membership, tree permissions) re-checks the rooms their open sockets hold — collections by read permission, records by the same row filter and scope gate as `GET /items`, chat rooms by the chat visibility rule, watch and presence rooms by admin access — and leaves the ones that no longer pass. The client hears `access:changed { rooms_left }` (room names only) and re-reads what is on screen.'
    },
    { type: 'h2', id: 'realtime-reconnect', text: 'Reconnect banner and stale marks' },
    {
      type: 'p',
      text: 'When the connection drops for more than a few seconds, a strip says "Live updates paused, reconnecting" and collection lists and queue worklists show a **May be stale** mark. After the reconnect and the missed-event catch-up the strip says live updates resumed, and when the gap was too long to replay it says the page\'s lists and records were reloaded. Hosts give shared components this state through the optional `status()` / `onStatus()` on their RealtimeAdapter; `RealtimeStatusBanner` and `RealtimeStaleMark` render it.'
    },
    { type: 'h2', id: 'realtime-time-sync', text: 'Server time' },
    {
      type: 'p',
      text: 'When the socket signs in, the client times three `time:sync` round trips and takes its clock offset from the fastest one. Relative labels ("2m ago"), due-in countdowns and retry times then use `serverNow()`, so two machines with drifting clocks agree. Offsets under a second are ignored.'
    },
    { type: 'h2', id: 'realtime-tenants', text: 'Per tenant (cloud)' },
    {
      type: 'p',
      text: "In cloud mode sockets, events and bytes are also kept per tenant. A tenant's Realtime console shows only its own event and room figures; the operator reads every tenant, noisiest first (bytes and events in the last whole minute, then open sockets), from `GET /admin/realtime-tenants` with the provisioning secret — per API process, like `/admin/traffic-tenants`."
    },
    {
      type: 'p',
      text: "One process serves several tenants, so every live feed stays inside its tenant: record, item, chat, pulse, presence and watch rooms are named `t:<tenant>:<room>` (self-hosted names are unchanged; presence sessions are kept per tenant too), an SSE stream delivers only writes made in the tenant it was opened under, and GraphQL subscriptions (`itemMutated`, `workflowStateChanged`, `pipelineStateChanged`) listen on per-tenant topics — the tenant rides each event across replicas. A graphql-ws connection resolves its tenant from its host like a socket does and signs in against that tenant's database; one with no tenant hears nothing. Workflow and pipeline state subscriptions need read access to the record, and each subscriber receives the instance as they would read it (events carry ids only). A socket may only watch a real collection: `collection:join` refuses names such as `orders:5`."
    }
  ]
}
