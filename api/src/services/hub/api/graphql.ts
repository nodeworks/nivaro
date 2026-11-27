import type { FastifyRequest } from 'fastify'
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString
} from 'graphql'
import { GraphQLJSON } from '../../../graphql/scalars.js'
import { partHeaders } from '../../batch-get.js'
import { MCP_INNER_HEADER, mcpInnerHeaderValue } from '../../mcp-config.js'
import { hubModeEnabled } from '../mode.js'

/**
 * The `hub` namespace of the GraphQL schema (Hub mode only: buildGraphQLSchema adds it only when
 * hubModeEnabled(), so a regular install has no `hub` field and no Hub types in introspection).
 *
 * Every resolver answers by calling its REST twin in-process as the caller (app.inject with the
 * caller's own headers, like POST /api/batch-get): the same route, the same gate (admin / owner,
 * API-key hub scope, connected apps read-only), the same 403/404 and the same masking of
 * secrets. A refused call becomes a GraphQL error whose extensions carry the REST `status` and
 * `code`. Mutations are limited to plans (nothing is written) and safe metadata writes (owners,
 * app name and extensions, environment order); starting promotions, moves, upgrades and creations
 * stays REST (plan_hash + typed confirm).
 *
 * No subscriptions: Hub runs publish no events today (the admin UI and SDK poll the run reads).
 */

interface Ctx {
  req?: FastifyRequest
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

function codeFor(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'INTERNAL_SERVER_ERROR'
  return 'BAD_REQUEST'
}

/** Inner Hub requests one GraphQL operation may make; past it QUERY_TOO_COSTLY. */
export const HUB_GQL_MAX_CALLS = 200
/** Inner Hub requests in flight at once for one operation (like BATCH_GET_CONCURRENCY). */
export const HUB_GQL_CONCURRENCY = 8

interface OperationState {
  /** GET path → its answer, shared by every field of the operation that reads it. */
  memo: Map<string, Promise<unknown>>
  calls: number
  active: number
  waiting: Array<() => void>
}

/** Kept on the request itself (one per GraphQL operation), never in module state. */
const STATE = Symbol('hub-graphql-state')

function stateOf(req: FastifyRequest): OperationState {
  const holder = req as unknown as { [STATE]?: OperationState }
  holder[STATE] ??= { memo: new Map(), calls: 0, active: 0, waiting: [] }
  return holder[STATE]
}

async function slot<T>(s: OperationState, run: () => Promise<T>): Promise<T> {
  if (s.active >= HUB_GQL_CONCURRENCY) await new Promise<void>((go) => s.waiting.push(go))
  else s.active++
  try {
    return await run()
  } finally {
    const next = s.waiting.shift()
    if (next) next()
    else s.active--
  }
}

/**
 * Calls /api/hub<path> as the caller; the answer's `data`, or a GraphQL error with its status.
 * Within one operation a GET is made once (every field reading the same path shares it), at most
 * HUB_GQL_CONCURRENCY run at once, and past HUB_GQL_MAX_CALLS the operation is refused
 * (QUERY_TOO_COSTLY) — a deep query over many apps cannot take the request pool.
 */
export async function hubRest(
  ctx: Ctx,
  method: Method,
  path: string,
  body?: unknown
): Promise<unknown> {
  const req = ctx.req
  if (!req)
    throw new GraphQLError('Hub fields are answered over HTTP (POST /api/graphql) only.', {
      extensions: { code: 'HUB_NEEDS_HTTP', status: 400 }
    })
  const s = stateOf(req)
  if (method === 'GET') {
    const hit = s.memo.get(path)
    if (hit) return hit
  } else s.memo.clear() // a write: later reads in the operation see its result
  if (s.calls >= HUB_GQL_MAX_CALLS)
    throw new GraphQLError(
      `This query asks the Hub for more than ${HUB_GQL_MAX_CALLS} things at once. Ask for fewer apps or fields.`,
      { extensions: { code: 'QUERY_TOO_COSTLY', status: 400 } }
    )
  s.calls++
  const answer = slot(s, () => innerCall(req, method, path, body))
  if (method === 'GET') {
    s.memo.set(path, answer)
    answer.catch(() => s.memo.delete(path))
  }
  return answer
}

async function innerCall(
  req: FastifyRequest,
  method: Method,
  path: string,
  body: unknown
): Promise<unknown> {
  const headers = partHeaders(req)
  if (body !== undefined) headers['content-type'] = 'application/json'
  // An operation that is itself an MCP tool call stays one inside (the Hub gate's "MCP never
  // writes" rule): the marker was taken off the outer request when it was checked.
  if (req.mcpInner === true) headers[MCP_INNER_HEADER] = mcpInnerHeaderValue()
  const res = await req.server.inject({
    method,
    url: `/api/hub${path}`,
    headers,
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    remoteAddress: req.socket?.remoteAddress ?? req.ip
  })
  let json: Record<string, unknown> | null = null
  try {
    json = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null
  } catch {
    json = null
  }
  if (res.statusCode >= 400) {
    const message =
      (typeof json?.error === 'string' && json.error !== 'Forbidden' && json.error) ||
      (typeof json?.message === 'string' && json.message) ||
      (typeof json?.error === 'string' && json.error) ||
      'The Hub refused this request'
    throw new GraphQLError(message, {
      extensions: {
        code: typeof json?.code === 'string' ? json.code : codeFor(res.statusCode),
        status: res.statusCode
      }
    })
  }
  return json && 'data' in json ? json.data : json
}

const id = (v: number | string) => encodeURIComponent(String(v))
const pick = (key: string) => ({
  resolve: (p: Record<string, unknown>) => (p[key] === undefined ? null : p[key])
})
const str = (key: string) => ({ type: GraphQLString, ...pick(key) })
const int = (key: string) => ({ type: GraphQLInt, ...pick(key) })
const bool = (key: string) => ({ type: GraphQLBoolean, ...pick(key) })
const strList = (key: string) => ({ type: new GraphQLList(GraphQLString), ...pick(key) })
const raw = { type: GraphQLJSON, description: 'The REST answer as is', resolve: (p: unknown) => p }
const asList = (v: unknown) => (Array.isArray(v) ? v : [])
/** `?a=1&b=x` from the arguments that were given (none = ''). Values are always encoded. */
export function queryString(q: Record<string, string | number | boolean | null | undefined>) {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

function build() {
  const HubEnvStatus = new GraphQLObjectType({
    name: 'HubEnvStatus',
    fields: {
      state: str('state'),
      version: str('version'),
      preflight: str('preflight'),
      checkedAt: str('checked_at'),
      source: str('source'),
      error: str('error'),
      failing: strList('failing')
    }
  })

  const HubDeploy = new GraphQLObjectType({
    name: 'HubDeploy',
    description: 'A deploy pipeline from the environment’s GitLab project',
    fields: {
      pipelineId: int('pipeline_id'),
      ref: str('ref'),
      sha: str('sha'),
      status: str('status'),
      startedAt: str('started_at'),
      finishedAt: str('finished_at'),
      webUrl: str('web_url'),
      version: str('version')
    }
  })

  const HubRun = new GraphQLObjectType({
    name: 'HubRun',
    description: 'A promotion, move, shared upgrade or app creation run',
    fields: {
      id: int('id'),
      status: str('status'),
      kind: str('kind'),
      createdAt: str('created_at'),
      startedAt: str('started_at'),
      finishedAt: str('finished_at'),
      data: raw
    }
  })

  const HubOwner = new GraphQLObjectType({
    name: 'HubOwner',
    fields: { userId: str('user_id'), name: str('name') }
  })

  const HubEnvironment: GraphQLObjectType = new GraphQLObjectType({
    name: 'HubEnvironment',
    fields: () => ({
      id: int('id'),
      appId: int('app_id'),
      key: str('key'),
      position: int('position'),
      status: str('status'),
      baseUrl: str('base_url'),
      hostnames: strList('hostnames'),
      placementId: int('placement_id'),
      versionPin: str('version_pin'),
      hubManaged: bool('hub_managed'),
      onShared: bool('on_shared'),
      live: {
        type: HubEnvStatus,
        description: 'Live status (version, preflight), read through the hub link',
        resolve: (p: { id: number }, _a: unknown, ctx: Ctx) =>
          hubRest(ctx, 'GET', `/environments/${id(p.id)}/status`)
      },
      deploys: {
        type: new GraphQLList(HubDeploy),
        args: { limit: { type: GraphQLInt } },
        resolve: async (p: { id: number }, a: { limit?: number }, ctx: Ctx) =>
          asList(
            await hubRest(
              ctx,
              'GET',
              `/environments/${id(p.id)}/deploys${a.limit ? `?limit=${a.limit}` : ''}`
            )
          )
      },
      promotions: {
        type: new GraphQLList(HubRun),
        description: 'Hub promotion and rollback runs',
        args: { limit: { type: GraphQLInt } },
        resolve: async (p: { id: number }, a: { limit?: number }, ctx: Ctx) =>
          asList(
            await hubRest(
              ctx,
              'GET',
              `/environments/${id(p.id)}/deploys/hub${a.limit ? `?limit=${a.limit}` : ''}`
            )
          ).map((r) => ({ kind: 'promotion', ...(r as object) }))
      },
      moves: {
        type: new GraphQLList(HubRun),
        description: 'Moves (administrators)',
        resolve: async (p: { id: number }, _a: unknown, ctx: Ctx) =>
          asList(await hubRest(ctx, 'GET', `/environments/${id(p.id)}/moves`)).map((r) => ({
            kind: 'move',
            ...(r as object)
          }))
      },
      data: raw
    })
  })

  const HubApp = new GraphQLObjectType({
    name: 'HubApp',
    fields: () => ({
      id: int('id'),
      key: str('key'),
      name: str('name'),
      signinMode: str('signin_mode'),
      adopted: bool('adopted'),
      extensions: strList('extensions'),
      environments: {
        type: new GraphQLList(HubEnvironment),
        resolve: async (p: { id: number; environments?: unknown[] }, _a: unknown, ctx: Ctx) =>
          p.environments ??
          asList(
            ((await hubRest(ctx, 'GET', `/apps/${id(p.id)}`)) as { environments?: unknown[] })
              ?.environments
          )
      },
      owners: {
        type: new GraphQLList(HubOwner),
        resolve: async (p: { id: number; owners?: unknown[] }, _a: unknown, ctx: Ctx) =>
          p.owners ??
          asList(
            ((await hubRest(ctx, 'GET', `/apps/${id(p.id)}`)) as { owners?: unknown[] })?.owners
          )
      },
      data: raw
    })
  })

  const HubDriver = new GraphQLObjectType({
    name: 'HubDriver',
    description: 'A GitLab or Docker driver; its token is never answered',
    fields: {
      id: int('id'),
      kind: str('kind'),
      name: str('name'),
      config: { type: GraphQLJSON, ...pick('config') }
    }
  })

  const HubSharedDeployment = new GraphQLObjectType({
    name: 'HubSharedDeployment',
    fields: () => ({
      id: int('id'),
      key: str('key'),
      mode: str('mode'),
      status: str('status'),
      apps: int('apps'),
      liveReplicas: int('live_replicas'),
      upgrades: {
        type: new GraphQLList(HubRun),
        resolve: async (p: { id: number }, _a: unknown, ctx: Ctx) =>
          asList(await hubRest(ctx, 'GET', `/shared/${id(p.id)}/deploys`)).map((r) => ({
            kind: 'upgrade',
            ...(r as object)
          }))
      },
      data: raw
    })
  })

  const HubDatabase = new GraphQLObjectType({
    name: 'HubDatabase',
    description: 'A database the Hub made or adopted; never its credentials',
    fields: {
      id: int('id'),
      name: str('name'),
      engine: str('engine'),
      status: str('status'),
      data: raw
    }
  })

  const nn = <T extends import('graphql').GraphQLType>(t: T) => new GraphQLNonNull(t)
  const runOf = (kind: string) => async (v: Promise<unknown>) => ({
    kind,
    ...((await v) as object)
  })

  const HubQuery = new GraphQLObjectType<unknown, Ctx>({
    name: 'HubQuery',
    description: 'The Nivaro Hub (Hub mode only). Same access as the REST routes under /api/hub.',
    fields: {
      apps: {
        type: new GraphQLList(HubApp),
        resolve: async (_r, _a, ctx) => asList(await hubRest(ctx, 'GET', '/apps'))
      },
      app: {
        type: HubApp,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) => hubRest(ctx, 'GET', `/apps/${id(a.id)}`)
      },
      environmentStatus: {
        type: HubEnvStatus,
        args: { environmentId: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { environmentId: number }, ctx) =>
          hubRest(ctx, 'GET', `/environments/${id(a.environmentId)}/status`)
      },
      promotable: {
        type: GraphQLJSON,
        args: { environmentId: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { environmentId: number }, ctx) =>
          hubRest(ctx, 'GET', `/environments/${id(a.environmentId)}/promotable`)
      },
      drivers: {
        type: new GraphQLList(HubDriver),
        resolve: async (_r, _a, ctx) => asList(await hubRest(ctx, 'GET', '/drivers'))
      },
      sharedDeployments: {
        type: new GraphQLList(HubSharedDeployment),
        resolve: async (_r, _a, ctx) => asList(await hubRest(ctx, 'GET', '/shared'))
      },
      sharedDeployment: {
        type: HubSharedDeployment,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: async (_r, a: { id: number }, ctx) => {
          const d = (await hubRest(ctx, 'GET', `/shared/${id(a.id)}`)) as { row?: object }
          return { ...(d?.row ?? {}), detail: d }
        }
      },
      databases: {
        type: new GraphQLList(HubDatabase),
        resolve: async (_r, _a, ctx) => asList(await hubRest(ctx, 'GET', '/databases'))
      },
      database: {
        type: HubDatabase,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) => hubRest(ctx, 'GET', `/databases/${id(a.id)}`)
      },
      databaseServers: {
        type: GraphQLJSON,
        description:
          'Database servers (no credentials); resource_id = the aws.rds_instance a server is (Task 11)',
        resolve: (_r, _a, ctx) => hubRest(ctx, 'GET', '/db-servers')
      },
      targets: {
        type: GraphQLJSON,
        description:
          'Targets for new apps: GitLab (token masked) and GitHub (kind github, connection_id; no token of its own)',
        args: { kind: { type: GraphQLString, description: 'gitlab or github; omitted = both' } },
        resolve: async (_r, a: { kind?: string }, ctx) => {
          const rows = asList(await hubRest(ctx, 'GET', '/targets'))
          return a.kind
            ? rows.filter((t) => ((t as { kind?: string }).kind ?? 'gitlab') === a.kind)
            : rows
        }
      },
      components: {
        type: GraphQLJSON,
        description:
          'Components of a placement; provider kinds (github_actions, vercel, eas_update) carry resource_id, and github_actions its mode in deploy_job (null = run the workflow, approve[:<GitHub environment>] = approve the waiting run)',
        args: { placementId: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { placementId: number }, ctx) =>
          hubRest(ctx, 'GET', `/placements/${id(a.placementId)}/components`)
      },
      promotion: {
        type: HubRun,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) =>
          runOf('promotion')(hubRest(ctx, 'GET', `/promotions/${id(a.id)}`))
      },
      move: {
        type: HubRun,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) =>
          runOf('move')(hubRest(ctx, 'GET', `/moves/${id(a.id)}`))
      },
      sharedUpgrade: {
        type: HubRun,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) =>
          runOf('upgrade')(hubRest(ctx, 'GET', `/shared-deploys/${id(a.id)}`))
      },
      creation: {
        type: HubRun,
        args: { environmentId: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { environmentId: number }, ctx) =>
          runOf('creation')(hubRest(ctx, 'GET', `/environments/${id(a.environmentId)}/creation`))
      },
      // Third-party providers: the REST answers as they are (secret fields come back masked).
      providerTypes: {
        type: GraphQLJSON,
        description: 'Registered providers, their resource types, fields and the risk vocabulary',
        resolve: (_r, _a, ctx) => hubRest(ctx, 'GET', '/provider-types')
      },
      connections: {
        type: GraphQLJSON,
        description: 'Provider connections the caller may see (secrets masked)',
        args: { provider: { type: GraphQLString } },
        resolve: (_r, a: { provider?: string }, ctx) =>
          hubRest(ctx, 'GET', `/connections${queryString({ provider: a.provider })}`)
      },
      connection: {
        type: GraphQLJSON,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) => hubRest(ctx, 'GET', `/connections/${id(a.id)}`)
      },
      connectionUnmanaged: {
        type: GraphQLJSON,
        description: 'What a connection can see that the Hub does not manage yet (administrators)',
        args: {
          id: { type: nn(GraphQLInt) },
          type: { type: nn(GraphQLString) },
          cursor: { type: GraphQLString }
        },
        resolve: (_r, a: { id: number; type: string; cursor?: string }, ctx) =>
          hubRest(
            ctx,
            'GET',
            `/connections/${id(a.id)}/unmanaged${queryString({ type: a.type, cursor: a.cursor })}`
          )
      },
      appConnections: {
        type: GraphQLJSON,
        description: 'The connections allowed for an app',
        args: { appId: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { appId: number }, ctx) =>
          hubRest(ctx, 'GET', `/apps/${id(a.appId)}/connections`)
      },
      resources: {
        type: GraphQLJSON,
        description: 'Managed provider resources the caller may see',
        args: {
          app: { type: GraphQLInt },
          environment: { type: GraphQLInt },
          provider: { type: GraphQLString },
          connection: { type: GraphQLInt },
          type: { type: GraphQLString },
          drift: { type: GraphQLBoolean, description: 'true = only resources that drifted' },
          scope: { type: GraphQLString, description: 'app or shared' }
        },
        resolve: (
          _r,
          a: {
            app?: number
            environment?: number
            provider?: string
            connection?: number
            type?: string
            drift?: boolean
            scope?: string
          },
          ctx
        ) =>
          hubRest(ctx, 'GET', `/resources${queryString({ ...a, drift: a.drift ? 1 : undefined })}`)
      },
      resource: {
        type: GraphQLJSON,
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) => hubRest(ctx, 'GET', `/resources/${id(a.id)}`)
      },
      resourceChanges: {
        type: GraphQLJSON,
        description: 'Resource changes the caller may see, newest first',
        args: {
          app: { type: GraphQLInt },
          environment: { type: GraphQLInt },
          connection: { type: GraphQLInt },
          status: { type: GraphQLString, description: 'One status, or a comma list' },
          limit: { type: GraphQLInt },
          before: { type: GraphQLInt }
        },
        resolve: (
          _r,
          a: {
            app?: number
            environment?: number
            connection?: number
            status?: string
            limit?: number
            before?: number
          },
          ctx
        ) => hubRest(ctx, 'GET', `/resource-changes${queryString(a)}`)
      },
      resourceChange: {
        type: GraphQLJSON,
        description: 'One resource change, step by step',
        args: { id: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { id: number }, ctx) =>
          hubRest(ctx, 'GET', `/resource-changes/${id(a.id)}`)
      }
    }
  })

  const HubMutation = new GraphQLObjectType<unknown, Ctx>({
    name: 'HubMutation',
    description:
      'Plans (nothing is written) and safe metadata writes. Starting a promotion, move, upgrade or creation is REST only (plan_hash + typed confirm).',
    fields: {
      planPromotion: {
        type: GraphQLJSON,
        args: {
          environmentId: { type: nn(GraphQLInt) },
          kind: { type: nn(GraphQLString), description: 'promote or rollback' },
          version: { type: GraphQLString }
        },
        resolve: (_r, a: { environmentId: number; kind: string; version?: string }, ctx) =>
          hubRest(ctx, 'POST', `/environments/${id(a.environmentId)}/promote/plan`, {
            kind: a.kind,
            ...(a.version ? { version: a.version } : {})
          })
      },
      planMove: {
        type: GraphQLJSON,
        args: { environmentId: { type: nn(GraphQLInt) }, to: { type: nn(GraphQLJSON) } },
        resolve: (_r, a: { environmentId: number; to: unknown }, ctx) =>
          hubRest(ctx, 'POST', `/environments/${id(a.environmentId)}/move/plan`, { to: a.to })
      },
      planSharedUpgrade: {
        type: GraphQLJSON,
        args: {
          sharedDeploymentId: { type: nn(GraphQLInt) },
          kind: { type: nn(GraphQLString), description: 'upgrade or rollback' },
          version: { type: nn(GraphQLString) }
        },
        resolve: (_r, a: { sharedDeploymentId: number; kind: string; version: string }, ctx) =>
          hubRest(ctx, 'POST', `/shared/${id(a.sharedDeploymentId)}/upgrade/plan`, {
            kind: a.kind,
            version: a.version
          })
      },
      planResourceChanges: {
        type: GraphQLJSON,
        description:
          'Plans changes to managed provider resources (nothing is written at the provider). Starting, cancelling, resuming, undoing, approving or declining a change, and connection or adopt writes, are REST only. Never pass secret values here: a plan keeps them sealed and a person sends them from the Hub.',
        args: {
          input: {
            type: nn(GraphQLJSON),
            description:
              '{connectionId, scope, appId?, environmentId?, ops: [...]} as POST /resources/plan'
          }
        },
        resolve: (_r, a: { input: unknown }, ctx) =>
          hubRest(ctx, 'POST', '/resources/plan', a.input)
      },
      planAppCreation: {
        type: GraphQLJSON,
        args: { input: { type: nn(GraphQLJSON) } },
        resolve: (_r, a: { input: unknown }, ctx) =>
          hubRest(ctx, 'POST', '/apps/create/plan', a.input)
      },
      setAppOwners: {
        type: HubApp,
        args: {
          appId: { type: nn(GraphQLInt) },
          userIds: { type: nn(new GraphQLList(nn(GraphQLString))) }
        },
        resolve: async (_r, a: { appId: number; userIds: string[] }, ctx) => {
          await hubRest(ctx, 'PUT', `/apps/${id(a.appId)}/owners`, { user_ids: a.userIds })
          return hubRest(ctx, 'GET', `/apps/${id(a.appId)}`)
        }
      },
      updateApp: {
        type: HubApp,
        description: 'Name and extensions only (key and sign-in mode stay REST)',
        args: {
          id: { type: nn(GraphQLInt) },
          name: { type: GraphQLString },
          extensions: { type: new GraphQLList(nn(GraphQLString)) }
        },
        resolve: async (_r, a: { id: number; name?: string; extensions?: string[] }, ctx) => {
          const patch: Record<string, unknown> = {}
          if (a.name != null) patch.name = a.name
          if (a.extensions != null) patch.extensions = a.extensions
          await hubRest(ctx, 'PATCH', `/apps/${id(a.id)}`, patch)
          return hubRest(ctx, 'GET', `/apps/${id(a.id)}`)
        }
      },
      setEnvironmentPosition: {
        type: HubEnvironment,
        args: { environmentId: { type: nn(GraphQLInt) }, position: { type: nn(GraphQLInt) } },
        resolve: (_r, a: { environmentId: number; position: number }, ctx) =>
          hubRest(ctx, 'PATCH', `/environments/${id(a.environmentId)}`, { position: a.position })
      }
    }
  })

  return {
    query: {
      type: nn(HubQuery),
      description: 'The Nivaro Hub (Hub mode only)',
      resolve: () => ({})
    } as GraphQLFieldConfig<unknown, Ctx>,
    mutation: {
      type: nn(HubMutation),
      description: 'The Nivaro Hub (Hub mode only): plans and safe metadata writes',
      resolve: () => ({})
    } as GraphQLFieldConfig<unknown, Ctx>
  }
}

/**
 * The root `hub` fields, or null on anything but a Hub. Built fresh for each schema build (each
 * schema holds its own type objects; nothing is kept between builds).
 */
export function hubGraphQLFields(
  env: NodeJS.ProcessEnv = process.env
): { query: GraphQLFieldConfig<unknown, Ctx>; mutation: GraphQLFieldConfig<unknown, Ctx> } | null {
  if (!hubModeEnabled(env)) return null
  return build()
}
