import type { DocSection } from '../types.js'

export const chaosFaultsDbDocs: DocSection = {
  id: 'chaos-faults-db',
  label: 'Chaos: database, partner, storage and process faults',
  content: [
    {
      type: 'h1',
      id: 'chaos-faults-db',
      text: 'Chaos: database, partner, storage and process faults'
    },
    {
      type: 'p',
      text: 'These faults are started from the Chaos console like every other drill. Each one is time-boxed, ends by itself, and stops at once with Stop all. They are refused in cloud mode and on production unless CHAOS_ENABLED=true. On the shared development database keep pool and error drills small and short: the faults run in your API process, but the database server is shared.'
    },
    { type: 'h2', id: 'chaos-faults-db-list', text: 'The faults' },
    {
      type: 'table',
      head: ['Fault', 'What it does', 'Targets', 'Caps'],
      rows: [
        [
          'Slow database (db_latency)',
          'Adds a delay to every statement that reaches the database. Configuration reads the metadata cache answers are not slowed.',
          'everything, one table, a route pattern, one person, a share of statements; main pool, background pool or both',
          '5,000 ms per statement; 5 minutes'
        ],
        [
          'Database errors (db_errors)',
          'Fails a share of statements with a deadlock victim (1205), a request timeout (ETIMEOUT) or a connection reset (ESOCKET), shaped like the errors the SQL Server driver throws. An optional wait comes first, so a timeout can take as long as a real one. Sign-in reads (users, roles, API keys, settings) and the Stop paths are never touched, so a drill can always be stopped.',
          'as above',
          '100% of statements, 15 s wait; 3 minutes'
        ],
        [
          'Pool exhaustion (pool_hold)',
          'Holds N connections of the main or the background pool for the window. No statement runs on them.',
          'everything or one replica',
          '5 connections and 60 s off production; 10 connections on production'
        ],
        [
          'Partner failing (partner_faults)',
          'Answers instead of an external API: added latency, a 500, a 429 with Retry-After, a 200 whose body says ERROR, malformed JSON, or a TLS failure. Works the same whether the API is live or in mock mode; the saved API is never changed. ERP pushes go through the same call.',
          'every API or one (name or id); everything or a share of calls',
          '30 s added; 10 minutes'
        ],
        [
          'Storage failing (storage_faults)',
          'A slow driver, a full disk (ENOSPC) or a read-only volume (EROFS) on file uploads, downloads and deletes, plus help-video upload parts and render scratch. A full disk still allows deletes.',
          'everything or a share of calls',
          '30 s added per call; 10 minutes'
        ],
        [
          'Event-loop block (event_loop_block)',
          'Blocks the replica for N ms every M seconds.',
          'one replica or every replica',
          '2,000 ms per block; 3 minutes'
        ],
        [
          'Memory pressure (memory_pressure)',
          'Grows the heap in steps toward a share of its limit, then holds it. The memory is dropped when the fault ends.',
          'one replica or every replica',
          '75% of the heap limit; 5 minutes'
        ],
        [
          'Clock skew (clock_skew)',
          'Moves the application clock of one replica by minutes or hours. SLA timers, maintenance windows and the cron run slot follow it. Sign-in and expiry checks (sessions, API keys, public dashboard links, help-video media tickets, delegations) only ever get stricter: a clock set back is ignored for them, and session stamps stay on real time. Log timestamps do not move.',
          'one replica',
          '±24 hours; 10 minutes'
        ]
      ]
    },
    { type: 'h2', id: 'chaos-faults-db-record', text: 'What a run records' },
    {
      type: 'ul',
      items: [
        'Readiness: the replica that started the run takes the readiness scorecard at the start, at the midpoint (windows of 30 s or more) and at the end. Each reading is a readiness event on the run with the score, the failing and warning checks, and what changed since the start.',
        'Alerts: log alert rules, metric alerts (Traffic Map alerts included) and monitors that turn failing while a fault is armed add an alert event to the run, once per alert per minute.',
        'Synthetic partner answers carry the header x-nivaro-chaos: 1 in the call log, so they can be told apart from real failures.'
      ]
    },
    {
      type: 'note',
      text: 'The event-loop and memory drills prove what exists today: event-loop lag, request times and /api/ready. There is no event-loop watchdog or heap guard yet; when they land, the same drills prove them.'
    }
  ]
}
