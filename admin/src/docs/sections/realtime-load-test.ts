import type { DocSection } from '../types.js'

export const realtimeLoadTest: DocSection = {
  id: 'realtime-load-test',
  label: 'Realtime Load Test',
  content: [
    { type: 'h1', id: 'realtime-load-test', text: 'Realtime Load Test' },
    {
      type: 'p',
      text: '`scripts/realtime-load-test.mts` opens N simulated Socket.io clients, writes to a throwaway table at a steady rate and reports how long events took to arrive, what each socket costs the server in memory, how much Redis traffic the run caused and how the event stream behaved. Use it before a release that touches the socket layer, or to size an environment.'
    },
    { type: 'h2', id: 'realtime-load-test-what', text: 'What it does' },
    {
      type: 'ul',
      items: [
        'Creates a throwaway table `zz_loadtest_<random>` (registered as a hidden collection) and a throwaway active user with an admin role and a static token. Every client signs in with a one-time `ws-token` minted for that user.',
        'Splits the clients across rooms by `--mix record/collection/chat` (default 20/70/10): collection clients join `collection:<table>`, record clients sit in one record room, chat clients join a room the user cannot see (it measures the join gate; no chat message is written, because chat tables are real data). Half the clients (`--coalesce-share`) opt in to merged bursts.',
        'Writes alternate creates and updates through `/api/items`. Delivery latency is the time from sending the request to the `collection:update` arriving, in two groups (clients that receive every change, and clients that receive merged bursts, whose latency includes the one-second merge window), plus the arrival time relative to the write response. One record client sends a `record:signal` per second; its latency is reported apart.',
        'Memory is the RSS change of the target process (`--api-pid`) between before the clients connect and after they have joined, divided by the sockets. Redis traffic is the `INFO stats` delta of commands and bytes over the run. Stream lag is read from `/api/realtime/pipeline` every two seconds.',
        'In `finally`, and on Ctrl-C, it deletes the rows the API wrote about the table (activity, revisions, journal), the metadata rows, the table, the user and the rows that name the user, then checks and prints that they are gone.'
      ]
    },
    { type: 'h2', id: 'realtime-load-test-smoke', text: 'Smoke run (shared development database)' },
    {
      type: 'p',
      text: 'The development database is shared with staging, so the default mode refuses anything but `127.0.0.1:3132` and caps a run at 200 sockets, 5 writes per second and 60 seconds. Start a throwaway API on that port with its own Redis channel prefix, and no migrations or crons:'
    },
    {
      type: 'pre',
      code: `cd api
SKIP_BOOT_MIGRATIONS=1 CRON_TICKS=off PORT=3132 REDIS_CHANNEL_PREFIX=lt: npx tsx src/index.ts
# in another shell (use the pid of the node process that listens on 3132)
cd api && npx tsx ../scripts/realtime-load-test.mts --api-pid <pid> \\
  --sockets 200 --ramp 8 --rate 5 --duration 40 --out /tmp/rt-load.json`
    },
    { type: 'h2', id: 'realtime-load-test-full', text: 'Full scale (dedicated environment only)' },
    {
      type: 'p',
      text: 'A real capacity test needs thousands of sockets and a sustained write rate, which belongs on an environment with its own database and Redis, never the shared one and never a deployed host. Run the API there with the production settings you want to size, run the script from a separate machine (one Node process holds a few thousand sockets: raise `ulimit -n`, and run several copies at once if you need more, adding their results), and lift the smoke limits explicitly:'
    },
    {
      type: 'pre',
      code: `npx tsx scripts/realtime-load-test.mts --target https://loadtest.internal:3055 \\
  --full-scale --confirm-dedicated loadtest.internal:3055 \\
  --sockets 5000 --ramp 120 --rate 50 --duration 600 --out rt-5000.json`
    },
    {
      type: 'ul',
      items: [
        '`--confirm-dedicated` must equal the target host and port; it is the only thing between the script and a database that real people use.',
        '`--api-pid` only works against a process on the same machine; against a remote API read the process memory from your monitoring and divide by the connected sockets (`server_socket_count` in the report).',
        'Redis figures are whole-server deltas: run on a Redis nothing else uses. On two or more API nodes, `stream.delivery_lag_ms` fills in (a single node reads back its own entries and reports `own_skipped_delta` instead).',
        'Watch for: `collection_loss_pct` above zero (events not delivered), a rising `delivery_lag_ms` or `stream_len_after` over the run, connect times growing with the ramp, and RSS that does not level off after the clients disconnect.'
      ]
    },
    { type: 'h2', id: 'realtime-load-test-report', text: 'Reading the report' },
    {
      type: 'table',
      head: ['Field', 'Meaning'],
      rows: [
        [
          'connections',
          'Clients that signed in, connect time p50/p95/p99, drops and connect errors'
        ],
        ['writes', 'Writes sent and failed, HTTP time of the write itself'],
        [
          'delivery',
          'Updates received against expected (clients in the collection room times writes), latency per client group, record-signal latency'
        ],
        ['memory', 'RSS before and after connecting, in KB per socket'],
        ['redis', 'Commands and bytes during the run, stream length before and after'],
        ['stream', 'Entries published and delivered, publish failures, delivery lag samples'],
        ['cleanup', 'Whether the throwaway table, metadata rows and user are gone']
      ]
    }
  ]
}
