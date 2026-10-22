import type { DocSection } from '../types.js'

export const chaosCiDocs: DocSection = {
  id: 'chaos-ci',
  label: 'Chaos Drills Outside the App',
  content: [
    { type: 'h1', id: 'chaos-ci', text: 'Chaos Drills Outside the App' },
    {
      type: 'p',
      text: 'Four scripts in `scripts/chaos/` prove recovery behaviour that cannot be tested from inside a running API: booting without the database, a lock left by a dead migration, links that slow down or drop, screens that meet a failing API, and a deploy that runs while people are using the system. Each one prints PASS or FAIL per check, always writes a JSON result file, and with `--record <base-url>` (and an admin token in `CHAOS_RECORD_TOKEN`) posts the run to the chaos console.'
    },
    {
      type: 'warn',
      text: 'None of these may be pointed at production or at the shared development database. They start their own throwaway API or database, or (the deploy drill) measure a staging deploy you start yourself.'
    },
    { type: 'h2', id: 'chaos-ci-boot', text: 'Boot and migration recovery' },
    {
      type: 'p',
      text: '`pnpm chaos:boot` starts a throwaway API twice, once with the database unreachable and once with Redis unreachable (closed local ports) and a short `BOOT_DEPS_WAIT_MS`. A pass means the process logged its retries with backoff and exited 1 inside the window, which is what lets the orchestrator restart it cleanly. It also runs the unit test that proves a migration lock held past `MIGRATION_LOCK_STALE_MS` is freed and the migrations then run.'
    },
    {
      type: 'p',
      text: 'With `CHAOS_SCRATCH_DB=<database>` set to a scratch database (never an EFP_ database) the script also holds knex\'s lock row there, boots with migrations and `MIGRATION_LOCK_STALE_MS=15000`, and expects the "Freeing the stale lock" line and a live API. Run it before every release that touches the boot path.'
    },
    { type: 'h2', id: 'chaos-ci-toxiproxy', text: 'Resilience tests with toxiproxy' },
    {
      type: 'p',
      text: '`deploy/chaos-ci/docker-compose.yml` runs SQL Server, Redis, the API image and toxiproxy; the API reaches the database and Redis through toxiproxy and the test runner reaches the API through it too. `pnpm chaos:toxiproxy` adds latency, resets, timeouts and outages and checks: boot under database latency, concurrent reads under latency all answer, a database outage turns `/api/ready` to 503 and recovers without a restart, a session survives a Redis blip, and a socket reconnects and signs in again after its connection is reset.'
    },
    {
      type: 'ul',
      items: [
        'CI: `.github/workflows/chaos-ci.yml` runs it on pull requests that touch the database layer, plugins, `server.ts`, boot code or realtime.',
        'Locally: `docker compose -f deploy/chaos-ci/docker-compose.yml up -d --build --wait api`, then `node scripts/chaos/toxiproxy-suite.mjs`. `--mode host` runs the API from your checkout instead of the image; `--only db-outage,socket` runs chosen cases.',
        'SQL Server does not run under emulation on Apple silicon. Run the suite in CI or on an x86 host.'
      ]
    },
    { type: 'h2', id: 'chaos-ci-gallery', text: 'Error-state gallery' },
    {
      type: 'p',
      text: '`pnpm chaos:gallery` opens admin screens in a browser at 1440 px, light and dark, while every `/api` call is answered by a mock: a 500 with a realistic error body, a request that never answers, or no network at all. It screenshots each one and writes `reports/error-gallery/<date>/index.html` (not committed) with a filterable grid and `summary.json`. `--sample 15` (default) picks evenly spaced routes, `--all` walks every route, `--routes /a,/b` picks some. `--start-admin` starts a throwaway admin dev server for you.'
    },
    {
      type: 'table',
      head: ['Flag', 'Meaning'],
      rows: [
        ['blank', 'The main area has no text at all.'],
        ['raw-error', 'Stack, axios or "[object Object]" text is visible.'],
        ['stuck-loading', 'A spinner or skeleton is still showing 10 seconds in.'],
        [
          'no-error-shown',
          'A request failed and the screen shows content or an empty state without saying so.'
        ],
        ['page-error', 'An uncaught exception reached the page.'],
        ['error-boundary', 'The crash screen appeared.']
      ]
    },
    {
      type: 'p',
      text: 'A pass is a gallery with no flags. The point is a list to work through, and a re-run per release to see it shrink.'
    },
    { type: 'h2', id: 'chaos-ci-deploy-load', text: 'Rolling deploy under load' },
    {
      type: 'p',
      text: '`pnpm chaos:deploy-load` measures a deploy; it never starts one. Staging only. Run it with `--target <staging url> --token <bearer> --caller <k12|u<uuid>>`, then start the deploy the usual way. It replays a slice of recorded traffic (`traffic:replay`, which keeps its own refusals) while polling `/api/version` and `/api/ready` every 250 ms, and once the version changes it keeps measuring for `--after-s` seconds. `--load builtin --rps 20` uses a simple generator instead of a recorded slice.'
    },
    {
      type: 'p',
      text: 'It reports "this deploy dropped N of M requests", how many more answered 5xx, how long two versions answered together, the longest stretch with nothing ready, and how long one socket took to reconnect. A pass is nothing dropped and nothing errored. `--dry-run` proves the counting on a throwaway API that restarts itself, so it is expected to show drops.'
    }
  ]
}
