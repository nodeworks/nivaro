import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { ActivityActor } from './activity-sentence.js'
import { mcpWriteStampOf } from './mcp-attribution.js'

/**
 * Bursts and real actors for the audit trail (migration 516).
 *
 *  - group_key: every activity row one bulk action, batch request, import run, flow run,
 *    cron tick or MCP request writes shares one key, so the Activity page folds them into one
 *    expandable line ("Pat updated 40 workflows: Status → On Hold").
 *  - actor: who really did it when that is not simply the signed-in person — the admin
 *    viewing as someone, the API key, the MCP connection, the import definition, the flow,
 *    the scheduled job.
 *
 * Two carriers. A request route marks itself (`markActivityBurst(req, 'bulk')`): a request
 * property, never `enterWith` (that store would outlive the request on a keep-alive socket).
 * Background runners wrap their work (`withActivityScope`), a fresh als.run store per scope
 * (never mutate the current one — two Promise.all branches would overwrite each other).
 * logActivity reads both (services/activity.ts), so the item hooks need no change.
 */

export interface ActivityScope {
  group_key?: string | null
  actor?: ActivityActor | null
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by a bulk / batch route: every activity row the request writes shares it. */
    activityScope?: ActivityScope
  }
}

const GROUP_KEY_MAX = 64
const NAME_MAX = 120

const als = new AsyncLocalStorage<ActivityScope>()

/** `${kind}:${id}` capped to the column (nvarchar(64)). */
export function activityGroupKey(kind: string, id?: string | number | null): string {
  return `${kind}:${id ?? randomUUID()}`.slice(0, GROUP_KEY_MAX)
}

/** The scope the current async context carries (background runners), else null. */
export function currentActivityScope(): ActivityScope | null {
  return als.getStore() ?? null
}

/** Run `fn` with this burst / actor. Unset fields keep the enclosing scope's. */
export function withActivityScope<T>(scope: ActivityScope, fn: () => T): T {
  const cur = als.getStore()
  return als.run(
    {
      group_key: scope.group_key ?? cur?.group_key ?? null,
      actor: scope.actor ?? cur?.actor ?? null
    },
    fn
  )
}

/** Marks a bulk / batch request: its activity rows share one group key. */
export function markActivityBurst(req: FastifyRequest, kind: string): string {
  const existing = req.activityScope?.group_key
  if (existing) return existing
  const key = activityGroupKey(kind, req.requestId ?? null)
  req.activityScope = { ...(req.activityScope ?? {}), group_key: key }
  return key
}

type ActorSource = Parameters<typeof mcpWriteStampOf>[0] & {
  masqueradeAdminId?: string
  activityScope?: ActivityScope
}

/** The request's own actor: an assistant over MCP, View-as, an API key; else null (a person). */
export function requestActor(
  req: ActorSource | null | undefined,
  userId: string | null | undefined
): ActivityActor | null {
  if (!req) return null
  const behalf = userId ?? null
  const stamp = mcpWriteStampOf(req)
  if (stamp) return { kind: 'mcp', id: stamp.mcp_conn, name: stamp.via_app, on_behalf_of: behalf }
  if (req.masqueradeAdminId)
    return { kind: 'view_as', id: String(req.masqueradeAdminId), name: null, on_behalf_of: behalf }
  if (req.authMethod === 'api_key' && req.apiKeyId != null)
    return {
      kind: 'api_key',
      id: String(req.apiKeyId),
      name: req.apiKeyName ? String(req.apiKeyName) : null,
      on_behalf_of: behalf
    }
  return null
}

/** The actor JSON for the column (≤400 chars), or null. */
export function actorJson(actor: ActivityActor | null | undefined): string | null {
  if (!actor) return null
  const out: Record<string, string> = { kind: actor.kind }
  if (actor.id) out.id = String(actor.id).slice(0, 80)
  if (actor.name) out.name = String(actor.name).slice(0, NAME_MAX)
  if (actor.on_behalf_of) out.on_behalf_of = String(actor.on_behalf_of).slice(0, 40)
  const s = JSON.stringify(out)
  return s.length <= 400 ? s : JSON.stringify({ kind: actor.kind, id: out.id ?? null })
}

/**
 * The group key + actor an activity insert carries. Explicit options win; then the
 * request's mark (bulk routes); then the background scope (cron / import / flow). The
 * background actor beats the request's own (a flow run inline in a request is the flow's
 * write, for the person who set it off).
 */
export function resolveActivityStamp(opts: {
  req?: ActorSource | null
  user?: string | null
  group_key?: string | null
  actor?: ActivityActor | null
}): { group_key: string | null; actor: ActivityActor | null } {
  const scope = currentActivityScope()
  const req = opts.req ?? null
  const group = opts.group_key ?? req?.activityScope?.group_key ?? scope?.group_key ?? null
  let actor = opts.actor ?? req?.activityScope?.actor ?? scope?.actor ?? null
  if (actor && !actor.on_behalf_of && opts.user) actor = { ...actor, on_behalf_of: opts.user }
  if (!actor) actor = requestActor(req, opts.user)
  return { group_key: group ? group.slice(0, GROUP_KEY_MAX) : null, actor }
}
