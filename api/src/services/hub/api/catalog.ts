/**
 * The Hub's own API surface, one entry per route under /api/hub (Hub mode only).
 *
 * This list is the single description the credential gate (gate.ts: which API-key scope a route
 * needs, which callers may never write) and the OpenAPI output (openapi.ts) read. A guard test
 * (hub-api-catalog.guard.test.ts) compares it with the routes the hub*.ts route files register,
 * so a new Hub route without an entry fails the build instead of silently being reachable by
 * keys or missing from the reference.
 *
 *   access  read  = a GET (and the heals a status read does), needs `hub:read` on an API key
 *           plan  = a POST that only plans (promote/move/upgrade/create plan), needs `hub:read`;
 *                   connected apps (OAuth / MCP) may call it
 *           write = everything else, needs `hub:write`; never for connected apps, View-as or
 *                   run-as-key
 *   auth    admin = Hub administrators; owner = administrators, or the app's owners (an app the
 *           caller does not own answers 404, never 403); machine = a bearer the route checks
 *           itself (no person, no API key); public = an OpenID endpoint
 *   sensitive = promotes, moves, deletes, key/secret/token rotation, retiring: listed in the
 *           reference; the gate refuses every write to connected apps anyway.
 */

export type HubAccess = 'read' | 'plan' | 'write'
export type HubAuth = 'admin' | 'owner' | 'machine' | 'public'
export type HubMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HubField {
  type: 'string' | 'integer' | 'boolean' | 'object' | 'array'
  description?: string
  items?: 'string' | 'integer' | 'object'
  required?: boolean
  /** Write-only: never answered back (reads show it masked as •••••• or `set`). */
  secret?: boolean
  enum?: string[]
}

export interface HubRoute {
  method: HubMethod
  /** Path under /api/hub, in the route's own template (`:id`, `:envId`). */
  path: string
  /** Reference group. */
  group: string
  summary: string
  auth: HubAuth
  access: HubAccess
  sensitive?: boolean
  /** Request body fields (JSON). */
  body?: Record<string, HubField>
  /** Query parameters. */
  query?: Record<string, HubField>
  /** Components schema the `data` of a 2xx answer follows (openapi.ts). */
  response?: string
  /** The answer is 202 (a run started in the background). */
  accepted?: boolean
  /** Extra sentence for the reference. */
  notes?: string
}

const s = (description?: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...extra
})
const n = (description?: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'integer',
  ...(description ? { description } : {}),
  ...extra
})
const b = (description?: string): HubField => ({
  type: 'boolean',
  ...(description ? { description } : {})
})
const o = (description?: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'object',
  ...(description ? { description } : {}),
  ...extra
})
const list = (items: HubField['items'], description?: string): HubField => ({
  type: 'array',
  items,
  ...(description ? { description } : {})
})
const secret = (description: string): HubField => s(description, { secret: true })

const PROMOTE_BODY = {
  kind: s('promote or rollback', { enum: ['promote', 'rollback'], required: true }),
  version: s('The release (x.y.z) to deploy; empty = newest promotable'),
  component: s('Optional: one component (api, frontend)')
}

const ENV_BODY = {
  key: s('Environment key (lowercase letters, digits, dashes)'),
  base_url: s('https origin the environment serves on'),
  hostnames: list('string', 'Names the environment answers on'),
  placement_id: n('Dedicated placement (null = none)'),
  position: n('Order on the app page'),
  version_pin: s('Pinned release, null = follow promotions'),
  hub_managed: b('The Hub created and manages this environment'),
  hub_token: secret('The environment’s HUB_TOKEN (≥ 32 characters); answered masked')
}

const r = (
  method: HubMethod,
  path: string,
  group: string,
  auth: HubAuth,
  access: HubAccess,
  summary: string,
  extra: Partial<HubRoute> = {}
): HubRoute => ({ method, path, group, auth, access, summary, ...extra })

/** A status or run read that also heals: a run whose server stopped is marked interrupted. */
const HEALS = 'This read also heals: a run whose server stopped is marked interrupted (idempotent).'

/** Every route the Hub serves under /api/hub (prefix not included). */
export const HUB_ROUTES: HubRoute[] = [
  // ─── Apps, owners, environments ─────────────────────────────────────────────
  r('GET', '/apps', 'Apps', 'owner', 'read', 'Apps the caller may see (admins: all)', {
    response: 'HubApp[]'
  }),
  r('GET', '/apps/:id', 'Apps', 'owner', 'read', 'One app with its environments and owners', {
    response: 'HubAppDetail'
  }),
  r('POST', '/apps', 'Apps', 'admin', 'write', 'Register an app', {
    body: {
      key: s('App key', { required: true }),
      name: s('Display name', { required: true }),
      signin_mode: s('direct or hub', { enum: ['direct', 'hub'] }),
      adopted: b('An existing app the Hub adopted'),
      extensions: list('string', 'Extension ids the app runs')
    },
    response: 'HubApp'
  }),
  r(
    'PATCH',
    '/apps/:id',
    'Apps',
    'admin',
    'write',
    'Change an app (key, name, sign-in, extensions)',
    {
      body: {
        key: s('App key (refused while a stack runs)'),
        name: s('Display name'),
        signin_mode: s('direct or hub', { enum: ['direct', 'hub'] }),
        adopted: b(),
        extensions: list('string')
      },
      response: 'HubApp'
    }
  ),
  r('DELETE', '/apps/:id', 'Apps', 'admin', 'write', 'Delete an app without environments', {
    sensitive: true
  }),
  r('PUT', '/apps/:id/owners', 'Apps', 'admin', 'write', 'Replace the app’s owners', {
    body: { user_ids: list('string', 'User ids (uuid)') }
  }),
  r('POST', '/apps/:id/environments', 'Environments', 'admin', 'write', 'Add an environment', {
    body: ENV_BODY,
    response: 'HubEnvironment'
  }),
  r('PATCH', '/environments/:envId', 'Environments', 'admin', 'write', 'Change an environment', {
    body: ENV_BODY,
    response: 'HubEnvironment'
  }),
  r('DELETE', '/environments/:envId', 'Environments', 'admin', 'write', 'Remove an environment', {
    sensitive: true
  }),

  // ─── Drivers, placements, components ────────────────────────────────────────
  r('GET', '/drivers', 'Drivers', 'admin', 'read', 'GitLab and Docker drivers (secrets masked)', {
    response: 'HubDriver[]'
  }),
  r('POST', '/drivers', 'Drivers', 'admin', 'write', 'Add a driver', {
    body: {
      kind: s('gitlab or docker', { enum: ['gitlab', 'docker'], required: true }),
      name: s('Name', { required: true }),
      config: o('GitLab: api, project, branch, pin_file, deploy_job. Docker: agent url and hosts'),
      secret: secret('GitLab token or Docker agent token')
    },
    response: 'HubDriver'
  }),
  r('PATCH', '/drivers/:id', 'Drivers', 'admin', 'write', 'Change a driver', {
    body: { name: s(), config: o(), secret: secret('New token; •••••• keeps the stored one') },
    sensitive: true,
    response: 'HubDriver'
  }),
  r('DELETE', '/drivers/:id', 'Drivers', 'admin', 'write', 'Delete an unused driver', {
    sensitive: true
  }),
  r('GET', '/drivers/:id/agent', 'Drivers', 'admin', 'read', 'Check a Docker driver’s agent'),
  r('POST', '/placements', 'Placements', 'admin', 'write', 'Add a placement', {
    body: {
      kind: s('dedicated or shared', { enum: ['dedicated', 'shared'] }),
      driver_id: n('Driver (dedicated)'),
      shared_deployment_id: n('Shared deployment (shared)'),
      target: o('Branch / stack (dedicated) or pool_max (shared)')
    }
  }),
  r('GET', '/placements/:id', 'Placements', 'admin', 'read', 'One placement'),
  r('PATCH', '/placements/:id', 'Placements', 'admin', 'write', 'Change a placement', {
    body: { driver_id: n(), target: o() }
  }),
  r('DELETE', '/placements/:id', 'Placements', 'admin', 'write', 'Delete a placement', {
    sensitive: true
  }),
  r('POST', '/placements/:id/forget-stack', 'Placements', 'admin', 'write', 'Forget a stack', {
    sensitive: true
  }),
  r(
    'GET',
    '/placements/:id/components',
    'Placements',
    'owner',
    'read',
    'Components of a placement'
  ),
  r('POST', '/placements/:id/components', 'Placements', 'admin', 'write', 'Add a component', {
    body: { kind: s('api or frontend'), config: o() }
  }),
  r('PATCH', '/components/:id', 'Placements', 'admin', 'write', 'Change a component', {
    body: { config: o() }
  }),
  r('DELETE', '/components/:id', 'Placements', 'admin', 'write', 'Delete a component', {
    sensitive: true
  }),

  // ─── Status and deploy history ──────────────────────────────────────────────
  r(
    'GET',
    '/environments/:envId/status',
    'Status',
    'owner',
    'read',
    'Live status of one environment',
    {
      response: 'HubEnvStatus'
    }
  ),
  r('GET', '/apps/:id/status', 'Status', 'owner', 'read', 'Live status of every environment'),
  r(
    'GET',
    '/environments/:envId/deploys',
    'Status',
    'owner',
    'read',
    'Deploy history from GitLab',
    {
      query: { limit: n('1–50'), fresh: s('1 = skip the 60 s cache') },
      response: 'HubDeploy[]'
    }
  ),

  // ─── Promotions ─────────────────────────────────────────────────────────────
  r(
    'GET',
    '/environments/:envId/promotable',
    'Promotions',
    'owner',
    'read',
    'Releases that can be promoted'
  ),
  r(
    'POST',
    '/environments/:envId/promote/plan',
    'Promotions',
    'owner',
    'plan',
    'Plan a promotion or rollback',
    {
      body: PROMOTE_BODY,
      response: 'HubPlan'
    }
  ),
  r(
    'POST',
    '/environments/:envId/promote',
    'Promotions',
    'owner',
    'write',
    'Start a promotion or rollback',
    {
      body: {
        ...PROMOTE_BODY,
        plan_hash: s('The plan’s hash (the plan you reviewed)', { required: true }),
        confirm: s('The environment key, typed', { required: true })
      },
      sensitive: true,
      accepted: true
    }
  ),
  r(
    'GET',
    '/environments/:envId/deploys/hub',
    'Promotions',
    'owner',
    'read',
    'Hub promotion runs of an environment',
    {
      notes: HEALS,
      query: { limit: n() },
      response: 'HubRun[]'
    }
  ),
  r(
    'GET',
    '/promotions/:id',
    'Promotions',
    'owner',
    'read',
    'One promotion run with plan and log',
    {
      notes: HEALS,
      response: 'HubRun'
    }
  ),
  r(
    'POST',
    '/promotions/:id/cancel',
    'Promotions',
    'owner',
    'write',
    'Cancel a running promotion',
    {
      accepted: true
    }
  ),

  // ─── Docker stacks ──────────────────────────────────────────────────────────
  r(
    'GET',
    '/environments/:envId/stack',
    'Stacks',
    'owner',
    'read',
    'The environment’s Docker stack'
  ),
  r(
    'GET',
    '/environments/:envId/stack/settings',
    'Stacks',
    'owner',
    'read',
    'Stack settings (secrets shown as set)'
  ),
  r(
    'PUT',
    '/environments/:envId/stack/settings',
    'Stacks',
    'owner',
    'write',
    'Change stack settings',
    {
      body: {
        size: s('Stack size'),
        redis: s('Redis mode'),
        settings: o('Plain settings'),
        secrets: o('Sealed settings (write-only; omit or send •••••• to keep)', { secret: true })
      }
    }
  ),
  r('POST', '/environments/:envId/stack/restart', 'Stacks', 'owner', 'write', 'Restart the stack'),
  r('POST', '/environments/:envId/stack/apply', 'Stacks', 'owner', 'write', 'Apply the stack now', {
    sensitive: true
  }),
  r('POST', '/environments/:envId/stack/remove', 'Stacks', 'owner', 'write', 'Remove the stack', {
    sensitive: true
  }),
  r(
    'POST',
    '/environments/:envId/stack/check-name',
    'Stacks',
    'owner',
    'write',
    'Check whether the name serves'
  ),

  // ─── Database servers, databases, targets ───────────────────────────────────
  r('GET', '/db-servers', 'Databases', 'admin', 'read', 'Database servers (no credentials)'),
  r('POST', '/db-servers', 'Databases', 'admin', 'write', 'Add a database server', {
    body: {
      name: s(),
      engine: s('mssql, pg, mysql, mariadb'),
      host: s(),
      port: n(),
      provision_mode: s('manual or admin', { enum: ['manual', 'admin'] }),
      admin_login: s(),
      admin_secret: secret('Admin password (admin mode)')
    }
  }),
  r('PATCH', '/db-servers/:id', 'Databases', 'admin', 'write', 'Change a database server', {
    body: { name: s(), host: s(), port: n(), admin_secret: secret('New admin password') },
    sensitive: true
  }),
  r('DELETE', '/db-servers/:id', 'Databases', 'admin', 'write', 'Delete a database server', {
    sensitive: true
  }),
  r('POST', '/db-servers/:id/test', 'Databases', 'admin', 'write', 'Test the server login'),
  r(
    'GET',
    '/databases',
    'Databases',
    'admin',
    'read',
    'Databases the Hub made or adopted (no credentials)'
  ),
  r('GET', '/databases/:id', 'Databases', 'owner', 'read', 'One database (no credentials)'),
  r('POST', '/databases/adopt', 'Databases', 'admin', 'write', 'Adopt an existing database', {
    body: {
      server_id: n(),
      database_name: s(),
      environment_id: n(),
      connection: o('Login', { secret: true })
    }
  }),
  r('POST', '/databases/sqlite', 'Databases', 'admin', 'write', 'Record a new SQLite database'),
  r('PUT', '/databases/:id/connection', 'Databases', 'owner', 'write', 'Store the database login', {
    body: { login: s(), password: secret('Password') },
    sensitive: true
  }),
  r('POST', '/databases/:id/check', 'Databases', 'owner', 'write', 'Check the database now'),
  r('DELETE', '/databases/:id', 'Databases', 'admin', 'write', 'Forget a database record', {
    sensitive: true
  }),
  r(
    'PUT',
    '/environments/:envId/database',
    'Databases',
    'admin',
    'write',
    'Attach a database record',
    {
      body: { database_id: n(undefined, { required: true }) }
    }
  ),
  r(
    'DELETE',
    '/environments/:envId/database',
    'Databases',
    'admin',
    'write',
    'Detach the database record'
  ),
  r('GET', '/targets', 'Targets', 'admin', 'read', 'GitLab targets for new apps (tokens masked)'),
  r('POST', '/targets', 'Targets', 'admin', 'write', 'Add a GitLab target', {
    body: { name: s(), api: s('GitLab API url'), group: s(), token: secret('GitLab token') }
  }),
  r('PATCH', '/targets/:id', 'Targets', 'admin', 'write', 'Change a target', {
    body: { name: s(), token: secret('New token (re-syncs created apps)') },
    sensitive: true
  }),
  r('DELETE', '/targets/:id', 'Targets', 'admin', 'write', 'Delete a target', { sensitive: true }),
  r('POST', '/targets/:id/test', 'Targets', 'admin', 'write', 'Test the target token'),

  // ─── Creating apps ──────────────────────────────────────────────────────────
  r(
    'POST',
    '/apps/create/plan',
    'Creating apps',
    'admin',
    'plan',
    'Plan a new app (nothing is written)',
    {
      body: {
        key: s(undefined, { required: true }),
        name: s(undefined, { required: true }),
        owners: list('string'),
        first_admin: o('{ email, first_name?, last_name? }'),
        target_id: n(),
        version: s(),
        extensions: list('string'),
        signin: o('{ issuer, client_id, client_secret } — client_secret is write-only', {
          secret: true
        }),
        environments: list(
          'object',
          '{ key, hostname?, database: { server_id … } | { database_id } }'
        )
      },
      response: 'HubPlan'
    }
  ),
  r(
    'POST',
    '/apps/create',
    'Creating apps',
    'admin',
    'write',
    'Create the app (runs in the background)',
    {
      body: { plan_hash: s(), confirm: s() },
      sensitive: true,
      accepted: true
    }
  ),
  r(
    'GET',
    '/environments/:envId/creation',
    'Creating apps',
    'owner',
    'read',
    'The environment’s creation run',
    {
      response: 'HubRun'
    }
  ),
  r(
    'POST',
    '/environments/:envId/creation/retry',
    'Creating apps',
    'admin',
    'write',
    'Retry a failed creation',
    {
      accepted: true
    }
  ),
  r(
    'POST',
    '/environments/:envId/creation/check',
    'Creating apps',
    'owner',
    'write',
    'Check what the creation waits for'
  ),
  r(
    'POST',
    '/environments/:envId/creation/installed',
    'Creating apps',
    'owner',
    'write',
    'Say the deploy key is installed',
    {
      accepted: true
    }
  ),
  r(
    'POST',
    '/environments/:envId/creation/cancel',
    'Creating apps',
    'admin',
    'write',
    'Cancel a creation',
    {
      sensitive: true,
      accepted: true
    }
  ),

  // ─── Shared deployments and upgrades ────────────────────────────────────────
  r('GET', '/shared', 'Shared deployments', 'admin', 'read', 'Shared deployments', {
    response: 'HubShared[]'
  }),
  r(
    'GET',
    '/shared/:id',
    'Shared deployments',
    'admin',
    'read',
    'One shared deployment (secrets shown as set)'
  ),
  r(
    'POST',
    '/shared',
    'Shared deployments',
    'admin',
    'write',
    'Add a shared deployment (token answered once)',
    {
      body: {
        key: s(),
        name: s(),
        mode: s('docker or registered', { enum: ['docker', 'registered'] }),
        pool_budget: n()
      },
      sensitive: true
    }
  ),
  r('PATCH', '/shared/:id', 'Shared deployments', 'admin', 'write', 'Change a shared deployment', {
    body: { name: s(), pool_budget: n(), secrets: o('{ REDIS_URL } write-only', { secret: true }) }
  }),
  r(
    'POST',
    '/shared/:id/token',
    'Shared deployments',
    'admin',
    'write',
    'Rotate the deployment token (answered once)',
    {
      sensitive: true
    }
  ),
  r('DELETE', '/shared/:id', 'Shared deployments', 'admin', 'write', 'Delete a shared deployment', {
    sensitive: true
  }),
  r(
    'GET',
    '/shared/:id/upgrade/versions',
    'Shared deployments',
    'admin',
    'read',
    'Releases it can move to'
  ),
  r(
    'GET',
    '/shared/:id/status',
    'Shared deployments',
    'admin',
    'read',
    'Live status of the deployment'
  ),
  r(
    'GET',
    '/environments/:envId/app-key',
    'Shared deployments',
    'admin',
    'read',
    'The app key (mask + fingerprint only)'
  ),
  r(
    'PUT',
    '/environments/:envId/app-key',
    'Shared deployments',
    'admin',
    'write',
    'Store the app key',
    {
      body: { key: secret('ENCRYPTION_KEY, 64 hex characters') },
      sensitive: true
    }
  ),
  r(
    'POST',
    '/environments/:envId/place-shared',
    'Shared deployments',
    'admin',
    'write',
    'Place a new environment on a shared deployment',
    {
      body: { shared_deployment_id: n(undefined, { required: true }) },
      accepted: true
    }
  ),
  r(
    'POST',
    '/shared/:id/upgrade/plan',
    'Shared deployments',
    'admin',
    'plan',
    'Plan an upgrade or rollback',
    {
      body: {
        kind: s('upgrade or rollback', { enum: ['upgrade', 'rollback'], required: true }),
        version: s('x.y.z', { required: true })
      },
      response: 'HubPlan',
      notes: HEALS
    }
  ),
  r(
    'POST',
    '/shared/:id/upgrade',
    'Shared deployments',
    'admin',
    'write',
    'Start an upgrade or rollback',
    {
      body: { kind: s(), version: s(), plan_hash: s(), confirm: s(), overrides: list('string') },
      sensitive: true,
      accepted: true
    }
  ),
  r('GET', '/shared/:id/deploys', 'Shared deployments', 'admin', 'read', 'Upgrade runs', {
    notes: HEALS,
    response: 'HubRun[]'
  }),
  r('GET', '/shared-deploys/:id', 'Shared deployments', 'admin', 'read', 'One upgrade run', {
    notes: HEALS,
    response: 'HubRun'
  }),
  r(
    'POST',
    '/shared-deploys/:id/cancel',
    'Shared deployments',
    'admin',
    'write',
    'Cancel an upgrade run',
    {
      accepted: true
    }
  ),
  r(
    'GET',
    '/shared/:key/tenants',
    'Shared deployments',
    'machine',
    'read',
    'The tenant list a shared deployment reads (deployment bearer)'
  ),

  // ─── Moves ──────────────────────────────────────────────────────────────────
  r('POST', '/environments/:envId/move/plan', 'Moves', 'admin', 'plan', 'Plan a move', {
    body: {
      to: o('{ kind: shared, shared_deployment_id } or { kind: dedicated, placement_id }', {
        required: true
      })
    },
    response: 'HubPlan'
  }),
  r('POST', '/environments/:envId/move', 'Moves', 'admin', 'write', 'Start a move', {
    body: {
      to: o(undefined, { required: true }),
      plan_hash: s(undefined, { required: true }),
      confirm: s('The environment key, typed', { required: true }),
      checklist: o(),
      overrides: list('string')
    },
    sensitive: true,
    accepted: true
  }),
  r('GET', '/moves/:id', 'Moves', 'admin', 'read', 'One move run', {
    notes: HEALS,
    response: 'HubRun'
  }),
  r('GET', '/environments/:envId/moves', 'Moves', 'admin', 'read', 'Moves of an environment', {
    notes: HEALS,
    response: 'HubRun[]'
  }),
  r('POST', '/moves/:id/cancel', 'Moves', 'admin', 'write', 'Cancel (roll back) a move', {
    sensitive: true
  }),
  r('POST', '/moves/:id/resume', 'Moves', 'admin', 'write', 'Resume an interrupted move', {
    sensitive: true
  }),
  r(
    'POST',
    '/moves/:id/finish-stop-source',
    'Moves',
    'admin',
    'write',
    'Stop the source and finish',
    {
      sensitive: true
    }
  ),
  r(
    'POST',
    '/moves/:id/confirm-route',
    'Moves',
    'admin',
    'write',
    'Confirm a manual route change',
    {
      sensitive: true
    }
  ),
  r('POST', '/moves/:id/checklist', 'Moves', 'admin', 'write', 'Tick checklist items'),

  // ─── Sign-in through the Hub (/api/hub/signin) ──────────────────────────────
  r('GET', '/signin/settings', 'Sign-in', 'owner', 'read', 'Hub sign-in settings'),
  r('GET', '/signin/overview', 'Sign-in', 'owner', 'read', 'Who signed in where'),
  r(
    'POST',
    '/signin/keys/rotate',
    'Sign-in',
    'admin',
    'write',
    'Rotate the signing key (own browser session only)',
    {
      sensitive: true
    }
  ),
  r(
    'DELETE',
    '/signin/keys/:kid',
    'Sign-in',
    'admin',
    'write',
    'Remove a signing key (own browser session only)',
    {
      sensitive: true
    }
  ),
  r('PATCH', '/signin/apps/:id/mode', 'Sign-in', 'owner', 'write', 'Via Hub or direct', {
    body: { signin_mode: s(undefined, { enum: ['direct', 'hub'] }) }
  }),
  r(
    'GET',
    '/signin/environments/:envId/client',
    'Sign-in',
    'owner',
    'read',
    'The environment’s OpenID client (no secret)'
  ),
  r(
    'POST',
    '/signin/environments/:envId/client',
    'Sign-in',
    'owner',
    'write',
    'Make the client (secret answered once; browser session only)',
    {
      sensitive: true
    }
  ),
  r(
    'POST',
    '/signin/environments/:envId/client/rotate',
    'Sign-in',
    'owner',
    'write',
    'Rotate the client secret (answered once; browser session only)',
    {
      sensitive: true
    }
  ),
  r(
    'PATCH',
    '/signin/environments/:envId/client',
    'Sign-in',
    'owner',
    'write',
    'Change the client (redirect URIs)',
    {
      body: { redirect_uris: list('string') }
    }
  ),

  // ─── The Hub as OpenID provider (/api/hub/oidc) and app reports (/api/hub/app-link) ─────
  // Protocol routes: an app's server or a person's browser, never an API key or MCP.
  r(
    'GET',
    '/oidc/.well-known/openid-configuration',
    'OpenID provider',
    'public',
    'read',
    'OpenID discovery document'
  ),
  r('GET', '/oidc/jwks', 'OpenID provider', 'public', 'read', 'Published signing keys'),
  r(
    'GET',
    '/oidc/ping',
    'OpenID provider',
    'machine',
    'read',
    'Client credential probe (HTTP Basic)'
  ),
  r(
    'GET',
    '/oidc/authorize',
    'OpenID provider',
    'public',
    'read',
    'Authorization endpoint (the person’s browser)'
  ),
  r(
    'POST',
    '/oidc/token',
    'OpenID provider',
    'machine',
    'write',
    'Token endpoint (client credentials)'
  ),
  r('GET', '/oidc/logout', 'OpenID provider', 'public', 'read', 'End the Hub session'),
  r('POST', '/oidc/logout', 'OpenID provider', 'public', 'write', 'End the Hub session'),
  r(
    'POST',
    '/app-link/signins',
    'App link',
    'machine',
    'write',
    'An app reports who signed in (environment hub token)'
  ),
  r(
    'POST',
    '/app-link/switcher',
    'App link',
    'machine',
    'read',
    'An app asks for the person’s other apps (environment hub token)'
  ),
  // Fleet, uptime + SLO, drift alerts, audit timeline (routes/hub-fleet.ts).
  r('GET', '/fleet', 'Fleet', 'owner', 'read', 'Every app × environment the caller may see', {
    notes: 'Built from the Hub’s own tables (never calls an app); kept 30 s per viewer.'
  }),
  r(
    'GET',
    '/fleet/environments/:envId/uptime',
    'Fleet',
    'owner',
    'read',
    'One environment’s hourly uptime, recent failed probes and monthly reports',
    { query: { days: n('1–30, default 7') } }
  ),
  r('GET', '/fleet/alerts', 'Fleet', 'owner', 'read', 'Version drift alerts', {
    query: { state: s('open (default) or all', { enum: ['open', 'all'] }) }
  }),
  r('GET', '/fleet/reports', 'Fleet', 'owner', 'read', 'Stored monthly uptime reports'),
  r(
    'GET',
    '/fleet/settings',
    'Fleet',
    'admin',
    'read',
    'Drift rules, uptime targets, report switch'
  ),
  r(
    'PUT',
    '/fleet/settings',
    'Fleet',
    'admin',
    'write',
    'Save the drift rules and uptime targets',
    {
      body: {
        rules: list(
          'object',
          'Rules (id, kind behind_newest|pair_apart|stale_deploy, enabled, n, env_keys, from_key, to_key)'
        ),
        slo: o('{default_target, targets: {<environment id>: percent}}'),
        report_enabled: b('Send the monthly uptime report')
      }
    }
  ),
  r('GET', '/fleet/check', 'Fleet', 'admin', 'read', 'The last Check now: running, done or failed'),
  r(
    'POST',
    '/fleet/check',
    'Fleet',
    'admin',
    'write',
    'Probe every environment and evaluate the drift rules now',
    {
      accepted: true,
      notes: '409 CHECK_RUNNING while a check runs; poll GET /fleet/check.'
    }
  ),
  r('GET', '/audit', 'Audit', 'admin', 'read', 'The Hub audit timeline', {
    query: {
      app: n('App id'),
      environment: n('Environment id'),
      user: s('Person (user id)'),
      action: s(
        'A kind (promote, rollback, move, stack, keys, upgrade, creation, signin, database, config) or an exact action id'
      ),
      from: s('Date or ISO time'),
      to: s('Date (that whole day) or ISO time'),
      offset: n(),
      limit: n('1–200, default 50')
    }
  }),
  r('GET', '/audit.csv', 'Audit', 'admin', 'read', 'The Hub audit timeline as CSV (same filters)'),
  // ─── People and offboarding (routes/hub-people.ts) ──────────────────────────
  r('GET', '/people', 'People', 'admin', 'read', 'The people directory (who signed in where)', {
    query: { q: s('Name, email or app'), limit: n('1–200, default 50'), offset: n() },
    notes: 'Keys are opaque (u:<hub user id> | k:<sign-in row id>): an email never goes in a URL.'
  }),
  r(
    'GET',
    '/people/:key',
    'People',
    'admin',
    'read',
    'One person: where seen, exactly what the apps would be asked to suspend, offboard runs',
    { notes: 'identity_hash binds the offboard confirm.' }
  ),
  r(
    'GET',
    '/people/:key/access',
    'People',
    'admin',
    'read',
    'Ask every environment now which account and role the person holds there',
    { notes: 'By proven email and Entra id only; logged on the Hub and in each app.' }
  ),
  r('POST', '/people/:key/offboard', 'People', 'admin', 'write', 'Offboard everywhere', {
    sensitive: true,
    accepted: true,
    body: {
      confirm: s('The person’s first proven email (or the key)', { required: true }),
      identity_hash: s('The hash GET /people/:key answered', { required: true })
    },
    notes:
      '409 IDENTITY_CHANGED, OFFBOARD_RUNNING, OFFBOARD_SELF, IDENTITY_SHARED, LAST_HUB_ADMIN, NO_IDENTITY.'
  }),
  r('GET', '/offboards', 'People', 'admin', 'read', 'Offboard runs, newest first', {
    query: { limit: n('1–200, default 50') }
  }),
  r('GET', '/offboards/:id', 'People', 'admin', 'read', 'One offboard run with its results'),
  r(
    'POST',
    '/offboards/:id/retry',
    'People',
    'admin',
    'write',
    'Ask again the environments that did not finish',
    { sensitive: true, accepted: true }
  ),
  r(
    'POST',
    '/offboards/:id/lift',
    'People',
    'admin',
    'write',
    'Lift this run’s Hub sign-in block (reactivates the Hub account only if this run’s suspension is still the current one)',
    {
      sensitive: true,
      body: { confirm: s('The person’s first email (or the key)', { required: true }) }
    }
  ),
  // ─── Owner self-service (routes/hub-people.ts) ──────────────────────────────
  r(
    'GET',
    '/apps/:id/access',
    'Apps',
    'owner',
    'read',
    'What the caller may deploy on each environment (production rule, flags, switch)'
  ),
  r(
    'PUT',
    '/apps/:id/owner-policy',
    'Apps',
    'admin',
    'write',
    'Let the app’s owners deploy production too',
    { body: { owners_deploy_production: b('true = owners deploy production') } }
  ),
  r(
    'PUT',
    '/environments/:envId/production',
    'Apps',
    'admin',
    'write',
    'Mark an environment production, not production, or auto',
    { body: { production: b('true | false | null (auto)') } }
  ),
  // ─── Phone app (routes/hub-people.ts) ───────────────────────────────────────
  r('GET', '/mobile/summary', 'Phone', 'owner', 'read', 'Fleet at a glance (last known status)'),
  r('GET', '/mobile/runs', 'Phone', 'owner', 'read', 'Recent promotions, rollbacks and applies', {
    query: { limit: n('1–100, default 20') }
  })
]

/** Fastify's template for a request (`/api/hub/apps/:id`) → its catalog entry, else null. */
export function hubRouteFor(method: string, url: string | undefined | null): HubRoute | null {
  if (!url) return null
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const path = url.replace(/^\/api\/hub(?=\/|$)/, '')
  return HUB_ROUTES.find((e) => e.method === m && e.path === path) ?? null
}

/**
 * The access a request needs when the catalog has no entry (a route added without one): GET
 * reads, anything else is a write — never weaker than the catalog would say.
 */
export function accessFor(method: string, url: string | undefined | null): HubAccess {
  const hit = hubRouteFor(method, url)
  if (hit) return hit.access
  const m = method.toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write'
}
