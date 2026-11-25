/**
 * Nivaro Hub tools (Hub enhancement 25) — registered only when the instance is a Nivaro Hub
 * (the `hub` option: the hosted endpoint passes it with HUB=on, the stdio server when
 * GET /api/mcp/capabilities says `hub`). They READ the Hub and PLAN: apps, environments, status,
 * the fleet, deploy history, and the plan of a promote / rollback, a move or a shared upgrade.
 * Nothing here starts, cancels or changes anything: every run stays a person's action in the
 * Hub, and each plan answer carries the link to the page where that person starts it.
 *
 * Every call is an ordinary API request as the connection's user, so the Hub's own REST rules
 * decide what it sees, exactly as in the browser: an administrator sees every app; an app owner
 * only the apps they own (another app answers 404, as the route does); moves, shared deployments
 * and shared upgrades are administrators' (those three tools are registered only with
 * `adminTools`, and the routes refuse anyone else anyway).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Command, NivaroClient } from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { fail, ok, refuse } from '../result.js'

type Row = Record<string, unknown>

/** Hub tools every signed-in person on a Hub gets (the routes scope them to their apps). */
export const HUB_TOOL_NAMES = [
  'hub_list_apps',
  'hub_read_app',
  'hub_app_status',
  'hub_fleet_status',
  'hub_deploy_history',
  'hub_plan_promote'
] as const

/** Hub tools for administrators only (registered with `adminTools`). */
export const HUB_ADMIN_TOOL_NAMES = [
  'hub_list_shared',
  'hub_plan_move',
  'hub_plan_upgrade'
] as const

export interface HubToolOptions {
  /** Origin of the Hub's admin UI, for the links plans answer with. Default: the API url. */
  adminUrl?: string | null
}

/** The one line every plan answer carries. */
export const PLAN_ONLY_NOTE =
  'Planned only: nothing was started. Starting it is a person’s action in the Hub — open the link, check the plan there and start it.'

const id = (what: string) => z.number().int().positive().describe(`The ${what} id.`)

const get = <T>(path: string, params?: Row): Command<T> => ({
  _method: 'GET',
  _path: path,
  ...(params && Object.keys(params).length ? { _params: params } : {})
})

const post = <T>(path: string, body: Row): Command<T> => ({
  _method: 'POST',
  _path: path,
  _body: body
})

function pick(row: unknown, keys: string[]): Row {
  const r = (row ?? {}) as Row
  const out: Row = {}
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k]
  return out
}

const APP_KEYS = ['id', 'key', 'name', 'signin_mode', 'adopted', 'extensions']
const ENV_KEYS = [
  'id',
  'key',
  'position',
  'status',
  'base_url',
  'hostnames',
  'on_shared',
  'version'
]

/** Keys a plan answer never carries to a model (review L7): run tokens, hashes, image digests. */
const DROP_KEY = /(^|_)(hash|confirm|token|secret|digest|nonce|ticket)s?($|_)/i

/**
 * Pure: a plan as an assistant sees it: blockers, warnings, steps, versions, apps. Never anything
 * that would let a later call start the run (plan_hash, confirm text) or that is noise to it
 * (image digests). Lists capped at 50, depth at 6.
 */
export function planForModel(v: unknown, depth = 0): unknown {
  if (depth > 6) return null
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => planForModel(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Row = {}
    for (const [k, x] of Object.entries(v as Row)) {
      if (DROP_KEY.test(k)) continue
      out[k] = planForModel(x, depth + 1)
    }
    return out
  }
  return v
}

export function hubLinks(base: string) {
  const b = base.replace(/\/+$/, '')
  return {
    apps: `${b}/hub`,
    app: (appId: number) => `${b}/hub?app=${appId}`,
    shared: (sharedId: number) => `${b}/hub/shared?shared=${sharedId}`
  }
}

export function registerHubTools(
  server: McpServer,
  client: NivaroClient,
  opts: { url: string; adminUrl?: string | null; admin: boolean }
) {
  const links = hubLinks(opts.adminUrl || opts.url)

  /** The app's environments when `envId` is one of them, else null (wrong app or no access). */
  async function envOfApp(appId: number, envId: number): Promise<Row | null> {
    const res = await client.request(get<{ data: Row }>(`/hub/apps/${appId}`))
    const envs = (res.data?.environments as Row[] | undefined) ?? []
    return envs.find((e) => Number(e.id) === envId) ?? null
  }

  server.registerTool(
    'hub_list_apps',
    {
      title: 'Hub apps',
      description:
        'The apps this Nivaro Hub looks after that you may see (administrators: all; an app owner: their own): id, key and name. Use hub_read_app for an app’s environments.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const res = await client.request(get<{ data: Row[] }>('/hub/apps'))
        const apps = (res.data ?? []).map((a) => pick(a, APP_KEYS))
        return ok({ count: apps.length, apps, link: links.apps })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_read_app',
    {
      title: 'Hub app and its environments',
      description:
        'One Hub app: its environments (id, key, status, address, on a shared deployment or not) in promotion order, and its owners. An app you may not see answers not found.',
      inputSchema: { app_id: id('app') },
      annotations: READ
    },
    async (args: { app_id: number }) => {
      try {
        const res = await client.request(get<{ data: Row }>(`/hub/apps/${args.app_id}`))
        const a = res.data ?? {}
        return ok({
          app: pick(a, APP_KEYS),
          environments: ((a.environments as Row[] | undefined) ?? []).map((e) => pick(e, ENV_KEYS)),
          owners: ((a.owners as Row[] | undefined) ?? []).map((o) => pick(o, ['user_id', 'name'])),
          link: links.app(args.app_id)
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_app_status',
    {
      title: 'Hub app status',
      description:
        'Whether each environment of one app is up: state (ok / degraded / unreachable …), version, preflight and readiness from its Hub link. fresh: true asks the apps now instead of the last minute’s answer.',
      inputSchema: {
        app_id: id('app'),
        fresh: z.boolean().optional().describe('Ask the apps now (slower).')
      },
      annotations: READ
    },
    async (args: { app_id: number; fresh?: boolean }) => {
      try {
        const res = await client.request(
          get<{ data: unknown }>(`/hub/apps/${args.app_id}/status`, args.fresh ? { fresh: 1 } : {})
        )
        return ok({ status: res.data, link: links.app(args.app_id) })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_fleet_status',
    {
      title: 'Hub fleet status',
      description:
        'Every app you may see with each environment’s state and version (the Hub’s last answer, never a fresh probe), and the environments that are not ok listed first. Start here for "is anything down?" on a Hub.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Apps to read, 25 by default (alphabetical).')
      },
      annotations: READ
    },
    async (args: { limit?: number }) => {
      try {
        const res = await client.request(get<{ data: Row[] }>('/hub/apps'))
        const all = res.data ?? []
        const apps = all.slice(0, args.limit ?? 25)
        const out: Row[] = []
        const attention: Row[] = []
        for (let i = 0; i < apps.length; i += 4) {
          const chunk = apps.slice(i, i + 4)
          const answers = await Promise.all(
            chunk.map(async (a) => {
              try {
                const s = await client.request(get<{ data: unknown }>(`/hub/apps/${a.id}/status`))
                return { app: a, status: s.data, error: null as string | null }
              } catch (err) {
                return { app: a, status: null, error: (err as Error).message || 'failed' }
              }
            })
          )
          for (const { app, status, error } of answers) {
            const envs = statusRows(status)
            out.push({ ...pick(app, ['id', 'key', 'name']), environments: envs, error })
            for (const e of envs)
              if (e.state !== 'ok')
                attention.push({
                  app: app.key,
                  app_id: app.id,
                  ...e,
                  link: links.app(Number(app.id))
                })
          }
        }
        return ok({
          apps: out,
          attention,
          ...(all.length > apps.length ? { more: all.length - apps.length } : {}),
          link: links.apps
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_deploy_history',
    {
      title: 'Hub deploy history',
      description:
        'What was deployed to one environment, newest first. source "hub" (default): the Hub’s own promotions and rollbacks with who started them and how they ended; source "gitlab": the deploy pipelines its driver shows.',
      inputSchema: {
        environment_id: id('environment'),
        source: z.enum(['hub', 'gitlab']).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Rows, 20 by default.')
      },
      annotations: READ
    },
    async (args: { environment_id: number; source?: 'hub' | 'gitlab'; limit?: number }) => {
      try {
        const path =
          args.source === 'gitlab'
            ? `/hub/environments/${args.environment_id}/deploys`
            : `/hub/environments/${args.environment_id}/deploys/hub`
        const res = await client.request(get<{ data: unknown }>(path, { limit: args.limit ?? 20 }))
        return ok({ source: args.source ?? 'hub', deploys: res.data })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_plan_promote',
    {
      title: 'Plan a promotion or rollback',
      description:
        'Plans (never runs) a promotion or rollback of one environment: without version it lists the versions on offer; with one it answers the Hub’s plan (what deploys, in which order, blockers) and the link to the app page where a person starts it. Owners of the app and administrators.',
      inputSchema: {
        app_id: id('app'),
        environment_id: id('environment'),
        kind: z.enum(['promote', 'rollback']).optional().describe('promote (default) or rollback.'),
        version: z.string().min(1).max(64).optional().describe('The version to plan, e.g. 0.3.215.')
      },
      annotations: READ
    },
    async (args: {
      app_id: number
      environment_id: number
      kind?: 'promote' | 'rollback'
      version?: string
    }) => {
      try {
        const env = await envOfApp(args.app_id, args.environment_id)
        if (!env) return refuse('That environment is not one of this app’s.', 'NOT_FOUND')
        const link = links.app(args.app_id)
        if (!args.version) {
          const res = await client.request(
            get<{ data: unknown }>(`/hub/environments/${args.environment_id}/promotable`)
          )
          return ok({ environment: pick(env, ['id', 'key']), offered: res.data, link })
        }
        const res = await client.request(
          post<{ data: unknown }>(`/hub/environments/${args.environment_id}/promote/plan`, {
            kind: args.kind ?? 'promote',
            version: args.version
          })
        )
        return ok({
          environment: pick(env, ['id', 'key']),
          plan: planForModel(res.data),
          link,
          note: PLAN_ONLY_NOTE
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  if (!opts.admin) return

  server.registerTool(
    'hub_list_shared',
    {
      title: 'Hub shared deployments',
      description:
        'The shared deployments this Hub runs (one process serving many apps): id, key, name, mode, version and status. Administrators only.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const res = await client.request(get<{ data: Row[] }>('/hub/shared'))
        return ok({
          shared: (res.data ?? []).map((s) =>
            pick(s, ['id', 'key', 'name', 'mode', 'version_pin', 'status', 'last_seen_at'])
          ),
          link: `${links.apps}/shared`
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_plan_move',
    {
      title: 'Plan a move',
      description:
        'Plans (never runs) moving one environment between its dedicated stack and a shared deployment (to: {kind:"shared", shared_id} or {kind:"dedicated", placement_id}): the steps, file copy, route changes, blockers and warnings, with the link where an administrator starts it. Administrators only.',
      inputSchema: {
        app_id: id('app'),
        environment_id: id('environment'),
        to: z
          .union([
            z.object({
              kind: z.literal('shared'),
              shared_id: z.number().int().positive(),
              pool_max: z.number().int().positive().optional()
            }),
            z.object({ kind: z.literal('dedicated'), placement_id: z.number().int().positive() })
          ])
          .describe('Where the environment would go.')
      },
      annotations: READ
    },
    async (args: { app_id: number; environment_id: number; to: Row }) => {
      try {
        const env = await envOfApp(args.app_id, args.environment_id)
        if (!env) return refuse('That environment is not one of this app’s.', 'NOT_FOUND')
        const res = await client.request(
          post<{ data: unknown }>(`/hub/environments/${args.environment_id}/move/plan`, {
            to: args.to
          })
        )
        return ok({
          environment: pick(env, ['id', 'key']),
          plan: planForModel(res.data),
          link: links.app(args.app_id),
          note: PLAN_ONLY_NOTE
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'hub_plan_upgrade',
    {
      title: 'Plan a shared upgrade',
      description:
        'Plans (never runs) upgrading or rolling back a shared deployment to a version: the order its apps are migrated in, preflight, blockers, with the link where an administrator starts it. Administrators only.',
      inputSchema: {
        shared_id: id('shared deployment'),
        version: z.string().min(1).max(64).describe('The Nivaro release, e.g. 0.3.215.'),
        kind: z.enum(['upgrade', 'rollback']).optional()
      },
      annotations: READ
    },
    async (args: { shared_id: number; version: string; kind?: 'upgrade' | 'rollback' }) => {
      try {
        const res = await client.request(
          post<{ data: unknown }>(`/hub/shared/${args.shared_id}/upgrade/plan`, {
            version: args.version,
            kind: args.kind ?? 'upgrade'
          })
        )
        return ok({
          plan: planForModel(res.data),
          link: links.shared(args.shared_id),
          note: PLAN_ONLY_NOTE
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}

/** Pure: an app status answer → one row per environment {environment, state, version}. */
export function statusRows(status: unknown): Array<{
  environment: unknown
  environment_id: unknown
  state: unknown
  version: unknown
}> {
  const s = status as Row | Row[] | null
  const list: Row[] = Array.isArray(s)
    ? s
    : Array.isArray((s as Row | null)?.environments)
      ? ((s as Row).environments as Row[])
      : []
  return list.map((e) => {
    // GET /hub/apps/:id/status answers [{id, key, status: {state, version, …}}].
    const st = (e.status && typeof e.status === 'object' ? e.status : e) as Row
    return {
      environment: e.key ?? null,
      environment_id: e.id ?? null,
      state: st.state ?? null,
      version: st.version ?? null
    }
  })
}
