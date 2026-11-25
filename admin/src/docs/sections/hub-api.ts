import type { DocSection } from '../types.js'

/** The Hub's own API surfaces: REST + API-key scopes, GraphQL, SDK, MCP (Hub mode only). */
export const hubApiDocs: DocSection = {
  id: 'hub-api',
  label: 'Hub API (REST, GraphQL, SDK, MCP)',
  content: [
    { type: 'h1', id: 'hub-api', text: 'Hub API — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it: `/api/hub/*` answers 404, GraphQL has no `hub` field or Hub types, the API-key page offers no Hub scope and the MCP server lists no Hub tools.'
    },
    {
      type: 'p',
      text: 'The Hub offers its own data — apps, environments, owners, drivers, placements, shared deployments, databases and every promotion, move, upgrade and creation run — through the same four surfaces a Nivaro offers for records: REST, GraphQL, the TypeScript SDK and MCP. All four reach the same routes, so who may see or change what is decided once, by the REST route.'
    },

    { type: 'h2', id: 'hub-api-rest', text: 'REST' },
    {
      type: 'p',
      text: 'Every Hub route is under `/api/hub` and listed in the instance’s OpenAPI document (`GET /api/dev-tools/openapi.json`, Developer → API docs) — only on a Hub. The public reference (`www/openapi.json`) lists them too, each in its own “Hub mode only” group. Secrets (driver and target tokens, hub tokens, app keys, database passwords, client secrets, `REDIS_URL`) are write-only: reads answer them masked (`••••••`) or as `set`, never the value.'
    },
    {
      type: 'table',
      head: ['Who', 'Reads', 'Plans', 'Changes'],
      rows: [
        [
          'A person on their browser session',
          'Admins: everything. App owners: their apps (another app answers 404)',
          'As reads (admins; owners plan promotions of their apps)',
          'Admins; owners where a route says so (promotions, stack, database login, sign-in client)'
        ],
        [
          'A named API key (`nvk_…`)',
          'Needs `hub:read`',
          'Needs `hub:read` (a plan writes nothing)',
          'Needs `hub:write`. Acts as the key’s owner: an owner’s key never reaches admin routes'
        ],
        [
          'A connected app (OAuth) or an MCP tool call',
          'Yes',
          'Yes',
          'Never (403 `HUB_WRITE_NOT_FOR_AGENTS`)'
        ],
        [
          'View-as (`nvm_`) or run-as-key (`nvq_`)',
          'Yes (a run-as-key also needs the key’s Hub scope)',
          'Yes',
          'Never (403 `NOT_WHILE_MASQUERADING`)'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Plans are the POST routes ending in `/plan`: `environments/:envId/promote/plan`, `environments/:envId/move/plan`, `shared/:id/upgrade/plan` and `apps/create/plan`. Starting the run they describe sends the plan’s `plan_hash` and a typed confirmation to the start route, which needs `hub:write`.'
    },

    { type: 'h2', id: 'hub-api-scopes', text: 'API-key scopes: hub:read and hub:write' },
    {
      type: 'p',
      text: 'On a Hub, API Keys shows a **Hub API** switch: Off, `hub:read` or `hub:write`. It is stored as one scope entry on the key, `{ "collection": "$hub", "actions": ["read"] }` or `["read", "write"]`. `*` (every collection) never includes the Hub: a key reaches `/api/hub` only when it was given Hub access on purpose, and a key without it gets 403 `HUB_SCOPE_MISSING`. The API refuses a `$hub` scope on an install that is not a Hub (400 `HUB_SCOPE_NOT_HERE`). Giving a key Hub access raises the usual “API key widened” security alert.'
    },
    {
      type: 'pre',
      code: `curl -H "Authorization: Bearer nvk_…" https://hub.example.com/api/hub/apps
curl -X POST -H "Authorization: Bearer nvk_…" -H "Content-Type: application/json" \\
  -d '{"kind":"promote","version":"0.3.215"}' \\
  https://hub.example.com/api/hub/environments/12/promote/plan`
    },

    { type: 'h2', id: 'hub-api-graphql', text: 'GraphQL' },
    {
      type: 'p',
      text: 'On a Hub the schema has a `hub` field on Query and on Mutation. Each field answers by calling its REST route as you, so the access, the masking and the refusals are the REST route’s: a refusal is a GraphQL error whose `extensions` carry the REST `status` (403, 404, 409 …) and `code`. Hub fields are answered over HTTP (`POST /api/graphql`), not over the subscription socket.'
    },
    {
      type: 'table',
      head: ['Field', 'What'],
      rows: [
        [
          '`hub { apps app(id) }`',
          'Apps (`HubApp`: id, key, name, signinMode, extensions, environments, owners)'
        ],
        [
          '`HubEnvironment`',
          'key, status, baseUrl, hostnames, placementId, versionPin, `live` (status and version), `deploys`, `promotions`, `moves`'
        ],
        [
          '`hub { environmentStatus(environmentId) promotable(environmentId) }`',
          'Live status; releases that can be promoted'
        ],
        ['`hub { drivers }`', 'Drivers (no secrets)'],
        ['`hub { sharedDeployments sharedDeployment(id) }`', 'Shared deployments, with `upgrades`'],
        [
          '`hub { databases database(id) databaseServers targets }`',
          'Databases and servers (no credentials), GitLab targets'
        ],
        [
          '`hub { promotion(id) move(id) sharedUpgrade(id) creation(environmentId) }`',
          'Runs (`HubRun`: id, kind, status, times, `data` = the full REST answer with plan and log)'
        ],
        [
          '`mutation { hub { planPromotion planMove planSharedUpgrade planAppCreation } }`',
          'Plans — nothing is written'
        ],
        [
          '`mutation { hub { setAppOwners updateApp setEnvironmentPosition } }`',
          'Safe metadata writes: owners, an app’s name and extensions, environment order'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Starting a promotion, move, shared upgrade or creation, deleting, and rotating keys or tokens stay REST-only: they need a reviewed plan hash and a typed confirmation. There are no Hub subscriptions; poll `promotion(id)` / `move(id)` while a run is going.'
    },
    {
      type: 'pre',
      code: `query {
  hub {
    apps {
      key
      environments { key versionPin live { state version } }
    }
  }
}`
    },

    { type: 'h2', id: 'hub-api-sdk', text: 'SDK' },
    {
      type: 'p',
      text: '`@nivaro/sdk` has `nivaro.hub.*`: typed calls for apps, environments, promotions, moves, shared deployments and upgrades, databases, drivers and targets (see SDK → Hub client). The methods ship in every copy of the SDK but only work against a Hub: the first call asks `GET /api/app-info` once whether the server lists the `hub` feature, and on any other server every call fails with code `HUB_MODE_OFF`.'
    },

    { type: 'h2', id: 'hub-api-mcp', text: 'MCP' },
    {
      type: 'p',
      text: 'On a Hub, the MCP server (`/api/mcp`, and `@nivaro/mcp`) adds read and plan tools: `hub_list_apps`, `hub_read_app`, `hub_app_status`, `hub_fleet_status`, `hub_deploy_history`, `hub_list_shared`, `hub_plan_promote`, `hub_plan_move` and `hub_plan_upgrade`. They call the routes above as the connected person, so an app owner’s assistant sees only that owner’s apps. They never start a run or change anything: the Hub refuses every write from a connected app. Elsewhere the tools are not listed.'
    }
  ]
}

/** SDK README section (SDK nav group): nivaro.hub — Hub mode only. */
export const sdkHubDocs: DocSection = {
  id: 'sdk-hub',
  label: 'Hub client (Hub mode only)',
  content: [
    { type: 'h1', id: 'sdk-hub', text: 'SDK — Hub client (Hub mode only)' },
    {
      type: 'warn',
      text: '`nivaro.hub.*` works only against a Nivaro Hub (a deployment with `HUB=on`). Against any other Nivaro every call fails with a `NivaroError` coded `HUB_MODE_OFF` (the client asks `GET /api/app-info` once per client), never a bare 404.'
    },
    {
      type: 'p',
      text: 'Access is the Hub’s: administrators see every app, app owners their own. An API key needs the `hub:read` scope (reads and plans) or `hub:write` (changes); `*` does not include the Hub. Calls answer the route’s `data`.'
    },
    {
      type: 'pre',
      code: `import { createNivaro, isNivaroError } from '@nivaro/sdk'

const nivaro = createNivaro('https://hub.example.com', { token: process.env.HUB_KEY })

if (await nivaro.hub.isHub()) {
  const apps = await nivaro.hub.listApps()
  const app = await nivaro.hub.readApp(apps[0].id)
  const prod = app.environments.find((e) => e.key === 'production')
  if (prod) {
    console.log(await nivaro.hub.environmentStatus(prod.id))   // { state, version, preflight, … }
    const plan = await nivaro.hub.planPromotion(prod.id, { kind: 'promote', version: '0.3.215' })
    // Needs hub:write; confirm = the environment key, typed.
    await nivaro.hub.startPromotion(prod.id, {
      kind: 'promote',
      version: '0.3.215',
      plan_hash: String(plan.plan_hash),
      confirm: 'production'
    })
  }
}

try {
  await nivaro.hub.listApps()
} catch (err) {
  if (isNivaroError(err) && err.code === 'HUB_MODE_OFF') console.log('Not a Hub')
}`
    },
    {
      type: 'table',
      head: ['Area', 'Methods'],
      rows: [
        [
          'Apps',
          '`listApps` `readApp` `createApp` `updateApp` `deleteApp` `setAppOwners` `appStatus`'
        ],
        [
          'Environments',
          '`addEnvironment` `updateEnvironment` `deleteEnvironment` `environmentStatus` `environmentDeploys` `promotable` `creation`'
        ],
        [
          'Promotions',
          '`planPromotion` `startPromotion` `listPromotions` `readPromotion` `cancelPromotion`'
        ],
        [
          'Moves',
          '`planMove` `startMove` `listMoves` `readMove` `cancelMove` `resumeMove` `confirmMoveRoute` `finishMoveStopSource` `tickMoveChecklist`'
        ],
        [
          'Shared deployments',
          '`listShared` `readShared` `createShared` `updateShared` `rotateSharedToken` `deleteShared` `sharedStatus` `sharedVersions` `planSharedUpgrade` `startSharedUpgrade` `listSharedUpgrades` `readSharedUpgrade` `cancelSharedUpgrade`'
        ],
        ['Databases', '`listDatabases` `readDatabase` `checkDatabase` `listDatabaseServers`'],
        [
          'Drivers and targets',
          '`listDrivers` `createDriver` `updateDriver` `deleteDriver` `driverAgent` `listTargets`'
        ],
        ['Creating apps', '`planAppCreation`'],
        ['Mode', '`isHub()`']
      ]
    },
    {
      type: 'p',
      text: 'Each method is also a command builder in `hubCommands` (e.g. `nivaro.request(hubCommands.listApps())`) for callers that batch or wrap requests.'
    }
  ]
}
