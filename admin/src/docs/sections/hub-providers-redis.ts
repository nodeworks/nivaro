import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: Upstash and Redis Cloud (Task 17). Facts are from the merged
// code: api/src/services/hub/providers/{upstash,redis-cloud}/. Nothing here ran against a live
// account yet: each section says what still needs one live check.

export const hubProvidersUpstashDocs: DocSection = {
  id: 'hub-providers-upstash',
  label: 'Provider: Upstash',
  content: [
    { type: 'h1', id: 'hub-providers-upstash', text: 'Provider: Upstash — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Connection fields: the account `email` and a secret `apiKey` (HTTP Basic). The only host is `api.upstash.com`. An Upstash API key is account-wide, so the connection is the pin and Test can only say whether the key reads databases. Upstash has no resource tags.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`upstash.redis_database`',
          'database id',
          'Name, primary region (set at create; changing it is a `replace`: the data is deleted and a new, empty database is made), eviction on or off. TLS is always on. Delete and replace are `destructive` + `data_loss` (typed confirm). The cost class is monthly, so an owner’s change waits for a Hub admin to approve it.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Output `redis_url` (secret): `rediss://default:<password>@<endpoint>:<port>`. The Hub seals it at create and never shows it. Bind it to the stack secret `REDIS_URL`; a bound `REDIS_URL` switches the environment’s Redis mode to external on the next stack apply (the create plan says so, and the stack shows it needs Apply now: the Hub never applies by itself). Upstash shows the password again, so the output is not once-only and can be re-read.',
        'A create whose name already exists on the account stops with `ALREADY_EXISTS`: adopt that database instead. A deleted database counts as gone.',
        'Cost estimate: pay as you go has no fixed price, so the figure is a known zero plus usage, with the dated unit prices ($0.20 per 100,000 commands, $0.25 per GB stored, after the free allowance) in the note. A free database is free; a fixed plan the account chose in the console is "No estimate".',
        'Needs a live check: endpoint paths (`/v2/redis/database`, `rename`, `enable-eviction`, `disable-eviction`) and the create body (`primary_region`, `platform`) were written from the Upstash management API documentation and not run. Confirm them, and the bundled prices, on a throwaway account.'
      ]
    }
  ]
}

export const hubProvidersRedisCloudDocs: DocSection = {
  id: 'hub-providers-redis-cloud',
  label: 'Provider: Redis Cloud',
  content: [
    { type: 'h1', id: 'hub-providers-redis-cloud', text: 'Provider: Redis Cloud — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Connection fields: the pinned `accountId` and two secrets, the API `accountKey` (sent as `x-api-key`) and the `userKey` (`x-api-secret-key`). The only host is `api.redislabs.com`. Test reads the account and refuses keys that belong to another account than the pinned one; every read and write re-checks it (every few minutes per connection), so a mixed-up key can never touch another account (`REDIS_CLOUD_OUT_OF_ACCOUNT`).'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`redis-cloud.subscription`',
          '`fixed:<id>` or `pro:<id>`',
          'Shared (Hub admins only). An Essentials (fixed plan) subscription is created on a plan id, renamed, moved to another plan and deleted; delete is `destructive` and refused while it still holds databases. A Pro subscription can only be read and adopted (`PRO_ADOPT_ONLY` for any change). Cost class monthly; the estimate is the plan’s price read from `GET /fixed/plans/:id`.'
        ],
        [
          '`redis-cloud.database`',
          '`fixed:<subId>/<dbId>` or `pro:<subId>/<dbId>`',
          'Name, eviction policy, replication, data persistence, protocol (set at create). The memory limit comes from the plan and is read-only. Created only in an Essentials subscription; a database on a Pro subscription can be adopted, changed and deleted, never created. Moving to another subscription is a `replace`. Delete and replace are `destructive` + `data_loss`. It costs nothing on top of its subscription.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Writes are asynchronous tasks. `apply` polls the task until it completes, for up to four minutes; a task still running then fails the step with a retryable `TASK_PENDING` that names the task. The task id is kept in memory for the connection, so a resume in the same process polls it instead of posting a second create. After a Hub restart a half-made database is found by name and the create stops with `ALREADY_EXISTS`: adopt it.',
        'A create into a subscription that is not active yet fails with a retryable `SUBSCRIPTION_NOT_READY`.',
        'Output `redis_url` (secret) of a database: `redis://default:<password>@<host>:<port>` (`rediss://` when TLS is on). The Hub generates the default user’s password at create, seals the URL and never shows it. Bind it to the stack secret `REDIS_URL`; the environment’s Redis mode then switches to external on the next stack apply. The API shows the password again, so the output is not once-only.',
        'Needs a live check: paths and bodies (`/fixed/subscriptions`, `/fixed/subscriptions/:id/databases`, `/tasks/:id`, the Pro `/subscriptions/...` twins and the shape of each list answer) were written from the Redis Cloud API documentation and not run. Confirm the Essentials create body, that the plan list prices in `GET /fixed/plans/:id` match the bill, and the Pro database update body on a throwaway account. The type keys use the provider key (`redis-cloud.`), not `redis_cloud.`, because the registry requires the key as the prefix.'
      ]
    }
  ]
}
