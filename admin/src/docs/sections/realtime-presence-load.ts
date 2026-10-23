import type { DocSection } from '../types.js'

export const realtimePresenceLoad: DocSection = {
  id: 'realtime-presence-load',
  label: 'Presence Load & Stall Alerts',
  content: [
    { type: 'h1', id: 'realtime-presence-load', text: 'Presence Load & Stall Alerts' },
    {
      type: 'p',
      text: "A busy morning can stall the API without a single error: every open tab refetching the online list on every presence event keeps each process's JavaScript thread at 100%, the event loop lags by seconds, socket events arrive late and requests queue. Two tools cover it: a repeatable load script shaped like real signed-in browsers, and three monitors that fire while it happens."
    },
    { type: 'h2', id: 'presence-load-script', text: 'The presence load script' },
    {
      type: 'p',
      text: '`scripts/realtime-load.mjs` opens N signed-in browser sessions against a target API. Each person keeps one tab, or two (`--two-tab-share`, default 0.6: 250 people ≈ 400 sockets), and each tab behaves like the app today: its own socket (signed in with a one-time `ws-token`, in the `user_presence` collection room), a presence ping every 15 s, a presence-row heartbeat every 25 s, an idle flip now and then, an occasional reconnect, and a refetch of `/api/presence/online` on every presence event (joining a fetch already in flight). It never creates users or business data: sessions sign in with the tokens you give it, and the only writes are the ones an open tab makes about itself.'
    },
    {
      type: 'pre',
      code: `node scripts/realtime-load.mjs --target https://staging.example.com \\
  --allow-shared-host staging.example.com \\
  --tokens-file ~/load-tokens.txt --admin-token "$ADMIN_BEARER" \\
  --people 250 --ramp-minutes 10 --steps 5 --hold-minutes 5 --out rt-250.json

# what it would do, without opening anything
node scripts/realtime-load.mjs --target http://127.0.0.1:3099 --people 250 --dry-run`
    },
    {
      type: 'ul',
      items: [
        '**Tokens**: `--tokens a,b`, `--tokens-file` (one per line), `REALTIME_LOAD_TOKENS`, or one `--api-key`. View-as tokens (`nvm_…`) make every session a different person; one API key looks like one person with many tabs. Tokens are reused round-robin when there are fewer than people.',
        "**Ramp**: `--start 0 --people 250 --ramp-minutes 10 --steps 5` adds people in five steps and prints one row per step (people, sockets, req/s, online-list p95, delivery p95 and share within 2 s, missed events, server event-loop lag, pool used and waiting, the generator's own lag), then holds the full load for `--hold-minutes`. The row where lag climbs is the capacity edge.",
        '**Server figures** come from `GET /api/ops-runtime/runtime` (administrator bearer: `--admin-token`), sampled twice every 5 s so a load balancer spreads them across processes; each process is reported by host.',
        '**Delivery latency** is measured from each presence write (idle flip, heartbeat) to every tab that receives its event; a coalesced event delivers several writes at once. Sampled events are acknowledged like real clients, so the delivery SLO sees the run too.',
        '**Client fixes**: `--refetch-debounce-ms 2000` models a debounced online list, `--refetch off` none; compare runs to size a fix before shipping it.',
        "**Refusals**: no default target; a host whose name says prod or production is always refused; this checkout's `PUBLIC_URL` / `ADMIN_URL` / `DB_HOST` and `TRAFFIC_REPLAY_SHARED_HOSTS` need `--allow-shared-host <host>` naming them exactly; over 300 people needs `--confirm-scale <host>`.",
        'One machine holds 400 sockets comfortably. If the generator lag column passes ~200 ms, its own latency figures are suspect: lower `--max-inflight` or split the run across two machines.'
      ]
    },
    {
      type: 'h2',
      id: 'presence-load-alerts',
      text: 'Stall, rate-jump and per-node delivery monitors'
    },
    {
      type: 'p',
      text: 'Three monitor types on Health → Monitors (**New monitor**). They are off until an administrator creates one, run every 5 minutes with the other monitors, and a failing flip raises an issue and notifies the creator and subscribers. Every API process publishes its own figures to Redis every 30 seconds, so the process that runs the monitors judges all of them — including the web processes that serve the traffic.'
    },
    {
      type: 'table',
      head: ['Monitor', 'Fails when', 'Defaults'],
      rows: [
        [
          'Event-loop stall',
          'Any API process peaked above the lag limit in that many of 5 consecutive minutes (searched over the last 9 minutes, so a stall between two runs is caught). A lone GC pause never fires.',
          '1000 ms, 3 of 5 minutes'
        ],
        [
          'Route rate jump',
          'A route (all processes together) runs at that many times its own trailing hour and above the floor for 2 minutes in a row, while its share of all requests at least doubles. The share rule keeps a morning sign-in wave quiet: everything grows together. An optional ceiling fails any route above it.',
          '5×, 20 req/s, share ×2 — sized for ~250 people (≈120 req/s in total)'
        ],
        [
          'Delivery by node',
          "Any process delivers fewer than the target share of realtime events within the SLO time over the last 15 minutes (probe and real browsers' acknowledgements). The overall SLO can look fine while one process lags.",
          'The SLO targets (95% within 2 s), 20 samples minimum'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Config keys: event-loop `threshold_ms`, `breach_minutes`, `window_minutes`; route jump `factor`, `min_rps`, `sustain_minutes`, `share_factor` (0 = off), `min_history_minutes` (processes younger than this stay out of the comparison), `ceiling_rps`; delivery `window_minutes`, `min_samples`, `target_ms`, `good_pct`.',
        'Route templates come from the route definition (`GET /api/items/:collection`), never raw ids.',
        'Cloud mode: all three answer "unknown" — process figures are shared by every tenant on a process and are not kept per tenant.'
      ]
    }
  ]
}
