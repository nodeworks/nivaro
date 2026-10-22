import type { DocSection } from '../types.js'

export const chaosFaultsRedisDocs: DocSection = {
  id: 'chaos-faults-redis',
  label: 'Chaos: Redis, scheduler, partition and outbound faults',
  content: [
    {
      type: 'h1',
      id: 'chaos-faults-redis',
      text: 'Chaos: Redis, scheduler, partition and outbound faults'
    },
    {
      type: 'p',
      text: 'These faults start from the Chaos console like every other drill. Each one is time-boxed, ends by itself and stops at once with Stop all, which reaches every replica even while Redis is the thing failing: the chaos channel and the nvr:chaos:* keys are never touched by these faults. They are refused in cloud mode and on production unless CHAOS_ENABLED=true.'
    },
    { type: 'h2', id: 'chaos-faults-redis-list', text: 'The faults' },
    {
      type: 'table',
      head: ['Fault', 'What it does', 'Targets', 'Caps'],
      rows: [
        [
          'Slow Redis (redis_latency)',
          'Every Redis command waits the added delay, plus or minus the jitter, before it is sent. Commands sent together keep their order.',
          'everything or one replica',
          '2,000 ms; 5 minutes'
        ],
        [
          'Redis read-only (redis_readonly)',
          'Every write answers the READONLY error a replica gives during a failover; reads still answer. Redis itself sends the error, so a group of commands sent together fails as a whole, as it would for real.',
          'everything or one replica',
          '2 minutes'
        ],
        [
          'Redis keys lost (redis_key_loss)',
          'Deletes one family of keys: sessions, the custom-query cache, the shared metadata cache, the scheduler lease and job locks, the realtime journal, idempotency keys, or every nvr:* key. With "Bring old keys back" on, the keys are copied first and put back when the window ends, wherever nothing newer was written, the way a lagging replica brings old keys back after a failover.',
          'everything (runs once, on the replica that started it)',
          '20,000 keys; 5 minutes'
        ],
        [
          'Redis evicting keys (redis_evict)',
          'Every few seconds, deletes a share of the nvr:* keys, the way Redis evicts keys when it runs out of memory.',
          'everything (runs on the replica that started it)',
          '100% and 5,000 keys per sweep; 5 minutes'
        ],
        [
          'Scheduler lease split (cron_lease_split)',
          'The scheduler lease on the chosen replica lapses (expire), is dropped (drop), or is dropped while that replica goes on believing it leads (split). Another replica takes the lease in the middle of whatever is running.',
          'one replica or every replica',
          '5 minutes'
        ],
        [
          'Replica cut off from Redis pub/sub (redis_partition)',
          'The chosen replica stops hearing and sending pub/sub messages: the socket adapter and the record-event channel. Its database connection is untouched. Its event-stream reader pauses and keeps its place, so record events written meanwhile reach its sockets when the window ends.',
          'one replica',
          '5 minutes'
        ],
        [
          'AI gateway failing (ai_gateway_fault)',
          'AI calls fail with a 5xx, time out, are slow, or the pinned model is refused (the next model in the fallback chain answers).',
          'everything or a share of calls',
          '60 s wait; 10 minutes'
        ],
        [
          'Sign-in provider down (oidc_down)',
          'The identity provider cannot be reached, or answers slowly, at discovery, at the token exchange or both. Discovery fails even when it was cached, as on a replica that just started.',
          'everything',
          '30 s wait; 10 minutes'
        ],
        [
          'Microsoft Graph down (graph_down)',
          'Directory lookups, their token and the sign-in profile and photo cannot reach Graph, or reach it slowly. A delay past a call’s own timeout fails it the way the timeout would.',
          'everything',
          '30 s wait; 10 minutes'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'On development, Redis keys lost and Redis evicting keys run only on a Redis database other than 0: a shared development Redis keeps every instance’s sessions, caches, scheduler lease and event stream in database 0, and REDIS_CHANNEL_PREFIX separates channels, not keys. On a deployed stack with its own Redis they run on database 0 too, except the sessions family, which also needs REDIS_CHANNEL_PREFIX there. A refused run says so in its timeline.'
    },
    { type: 'h2', id: 'chaos-faults-redis-checks', text: 'Checking the result' },
    {
      type: 'ul',
      items: [
        'Sign-out holds: run Redis keys lost on the sessions family with "Bring old keys back" on, sign out during the window, and check the session is still signed out after the old keys return. The sign-out marker wins over the returned session.',
        'Scheduler: GET /api/chaos/checks/cron-overlap?since=<time> lists every job that ran twice at once, runs left running past their budget, and the jobs not declared safe to run twice. A lease-split drill writes the same check into its timeline when the window ends.',
        'Partition: before cutting a replica off, start POST /api/chaos/partition/probe on another replica with the socket id of a test client connected to the replica you will cut. Then GET /api/chaos/checks/partition?probe=<id> on the cut replica lists events lost and events delivered twice. The drill notes how many messages were dropped and how many stream events were caught up.',
        'Redis counters: GET /api/chaos/checks/redis shows this replica’s fault counters, its Redis database and whether keys (and sessions) may be dropped here.',
        'Steady state: two figures can be used in a drill’s hypothesis: Redis errors per minute (redis.errors_per_min) and the metadata cache hit rate (cache.metadata_hit_pct).'
      ]
    },
    { type: 'h2', id: 'chaos-faults-redis-test-job', text: 'A safe job for the lease drill' },
    {
      type: 'p',
      text: 'CHAOS_TEST_CRON=1 starts a separate test scheduler on that process with one job, chaos-test-overlap, which only sleeps (CHAOS_TEST_CRON_MS, default 12 s) every 10 seconds. It competes for its own lease key and ticks even where scheduled jobs are off, so a lease-split drill can be proven on two development replicas without any real job running. It never starts on production or where the chaos gate refuses.'
    },
    { type: 'h2', id: 'chaos-faults-redis-signin', text: 'Sign-in while the provider is down' },
    {
      type: 'p',
      text: 'People already signed in keep working: a session never calls the identity provider. Someone signing in is sent back to the sign-in page, which says the provider is not answering. It never shows a raw error, and it never sends them back to the provider in a loop.'
    }
  ]
}
