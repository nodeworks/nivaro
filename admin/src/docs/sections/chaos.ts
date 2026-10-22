import type { DocSection } from '../types.js'

export const chaosDocs: DocSection = {
  id: 'chaos',
  label: 'Chaos engineering',
  content: [
    { type: 'h1', id: 'chaos', text: 'Chaos engineering' },
    {
      type: 'p',
      text: 'The Chaos page at /chaos (Operations → Health, administrators) runs controlled fault drills: arm one fault for a few minutes, state what should stay true, watch the live figures, and stop everything with one button. Every fault is time-boxed and heals itself when its window ends. A run records what happened and ends with a verdict — held, broke or aborted — so a claim like “Redis fails open” is proven by a dated drill, not asserted.'
    },
    {
      type: 'warn',
      text: 'Chaos is dangerous by design. It never runs in cloud mode, and on a production instance only when the process was started with `CHAOS_ENABLED=true` on purpose. The page still opens where it is refused — the strip under the header says why — so past runs and the catalog stay readable.'
    },

    { type: 'h2', id: 'chaos-gate', text: 'The gate and CHAOS_ENABLED' },
    {
      type: 'p',
      text: 'One rule decides whether a fault may run in this process: refused in cloud mode (`CLOUD_META_DB_URL` set), refused when `NODE_ENV=production` unless `CHAOS_ENABLED=true`, allowed everywhere else (development, test, staging). Every chaos route answers the refusal with its reason instead of a 404; the socket drills on the Realtime page and the older `POST /api/chaos/run` follow the same rule. Arming, stopping and recording runs needs an administrator (a chaos-operator permission is planned).'
    },

    { type: 'h2', id: 'chaos-faults', text: 'Faults' },
    {
      type: 'p',
      text: 'The Faults tab lists the catalog: each fault says what it proves, where it acts (its fault points, such as `http.request` or `mail.send`), how far it can reach (everything, routes matching a pattern, one table, one person, a share of traffic, one replica, a socket room) and how long it may run at most. The server clamps every parameter and the duration to the catalog’s caps whatever the form sends.'
    },
    {
      type: 'table',
      head: ['Fault', 'Proves', 'Acts at', 'Cap'],
      rows: [
        [
          'Slow requests',
          'Slow answers stay honest: loading states show, traces and the Traffic Map see the latency.',
          '`http.request` (100–5000 ms)',
          '300 s'
        ],
        [
          'Mail transport down',
          'Mail fails cleanly: sends land in the mail log and the outbox retries.',
          '`mail.send`',
          '300 s'
        ],
        [
          'Redis unreachable',
          'Redis fails open: requests keep answering, sessions hold, caches miss, crons pause.',
          'disconnects this process’s Redis client',
          '300 s'
        ],
        [
          'Socket drill',
          'Sockets reconnect and catch up after drops, latency or forced disconnects.',
          'the Realtime page’s own drill form (/realtime?tab=verify)',
          '600 s'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Run opens a small form under the row: the target, the strength within the caps, the duration, the note, and the limits that should hold (pre-filled from the fault’s defaults). The pre-flight checklist sits beside it. A fault that is armed right now shows an “Armed now” mark that opens its run.'
    },

    { type: 'h2', id: 'chaos-runs', text: 'Runs and verdicts' },
    {
      type: 'p',
      text: 'Every run is a row with a timeline: armed, each sample, alerts and readiness changes, notes, the stop or abort. While it runs the Runs tab shows the cockpit; afterwards a summary with the verdict, what was armed on what, how long it ran, which limits held and the timeline. Every run is also a job run (kind `chaos`) on the Background Jobs console. Runs made outside the registry — a CI job with toxiproxy, a game-day step measured by hand — are posted to `POST /api/chaos/runs/record` and appear in the same list.'
    },
    {
      type: 'ul',
      items: [
        '**held** — every limit stayed inside its bound for the whole window.',
        '**broke** — a limit was crossed while the fault ran, but not far enough or long enough to stop it.',
        '**aborted** — a limit was crossed past its tolerance three samples in a row and the fault was stopped by itself; or an operator stopped it after a breach.',
        '**refused** — pre-flight failed; nothing was armed and the failed checks are kept on the run.'
      ]
    },
    {
      type: 'note',
      text: 'Runs are stored in the `nivaro_chaos_runs` and `nivaro_chaos_run_events` tables (migration 497). On a database that does not have them yet they live in Redis for 7 days, so the console works there too.'
    },

    { type: 'h2', id: 'chaos-hypothesis', text: 'Steady-state hypothesis and auto-abort' },
    {
      type: 'p',
      text: 'Before a run starts it states what should stay true as a list of limits: a sampler, a comparison, a limit and a tolerance — “request p95 < 2000 ms ± 200”, “server errors < 1 % ± 0.5”. Samplers read figures the process already measures: request p95, server-error share, request rate and failed record saves (from the request funnel the Traffic Map uses), main and background pool wait, event-loop lag, heavy reads waiting at the read gate, socket reconnects. The baseline is the five minutes before arm. While the run is armed, the replica that started it samples every 5 seconds and writes a compact sample event; crossing a limit past its tolerance three samples in a row stops the fault by itself and the run ends aborted. A run with no limits never aborts on its own — it just records.'
    },

    { type: 'h2', id: 'chaos-preflight', text: 'Pre-flight checklist' },
    {
      type: 'p',
      text: 'Green ticks gate the Run button and the server runs the same checks again when the run starts: chaos is allowed here; this is not a production instance (an environment named Production in the Environments registry with a component answering on this host); no deploy or migration is running (one API version on the instance roster, the migration table not locked); no maintenance window; no open incident on the Ops Console; inside working hours (Monday–Friday 08:00–18:00 Eastern); the main pool and event loop are healthy; no other drill is armed. Each failed tick says why. An administrator may run outside working hours by ticking the override; the run records it. No other check can be overridden.'
    },

    { type: 'h2', id: 'chaos-console', text: 'The console' },
    {
      type: 'p',
      text: 'The header carries the one red control, Stop all: it clears every fault on every replica at once, socket drills included, and closes every open run. It works even when Redis is down — each process clears itself first and tells the others afterwards. The Faults tab is the catalog; the Runs tab lists every run with the running ones first and opens the selected one on the right. `?tab=runs&run=<id>` deep-links a run.'
    },

    { type: 'h2', id: 'chaos-cockpit', text: 'Live run cockpit' },
    {
      type: 'p',
      text: 'While a run is armed its page shows a countdown ring emptying as the window runs out, a large red Stop this run beside Stop all, one sparkline per sampler drawn against the baseline (dashed) with the abort limit (red) and its tolerance band, and the timeline of events as they happen. Hypothesis samplers come first; the others are watched for context. The page is live over the socket and polls every 5 seconds as a net.'
    },

    { type: 'h2', id: 'chaos-banner', text: 'The “Drill running” banner' },
    {
      type: 'p',
      text: 'While any fault is armed on this instance, every app — the admin and headless frontends built on @nivaro/react — shows a striped red strip at the top: which fault, on what, who started it, when it ends, and the note “this is a planned test, not an outage”. Administrators get a Stop link to the console. The strip shows labels and names only, never the targeted people or the parameters, and it asks the server nothing more once the gate has said chaos is refused here.'
    }
  ]
}
