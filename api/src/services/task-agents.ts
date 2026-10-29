import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { getGrant, listAllGrants, listGrants } from './oauth-store.js'

/**
 * Agents as task assignees (#3223). A task can be handed to an agent CONNECTION — an OAuth
 * grant (`o<grant id>`: Claude, ChatGPT, Codex connected through /api/mcp) or an API key
 * (`k<id>`: the npm stdio server, a script). The connection acts as its person, so the task's
 * `assignee` stays that person and every existing task gate (assignee may update/complete it)
 * keeps working; `agent_assignee` says which connection picks it up through my_work.
 *
 * A person may hand tasks to their own connections; an administrator to anyone's.
 */

export interface AgentConnection {
  conn: string
  kind: 'oauth' | 'api_key'
  name: string
  user_id: string
  user_name: string | null
}

const OAUTH_CONN = /^o([0-9a-f-]{36})$/i
const KEY_CONN = /^k(\d{1,12})$/

export class TaskAgentError extends Error {
  statusCode = 400
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

interface KeyRow {
  id: number | string
  name: string
  user: string
  expires_at: Date | string | null
  is_active: boolean | number | null
}

const keyLive = (k: KeyRow) =>
  k.is_active !== false &&
  k.is_active !== 0 &&
  (!k.expires_at || new Date(k.expires_at).getTime() > Date.now())

async function peopleNames(ids: string[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter(Boolean).map((i) => i.toLowerCase()))]
  if (!uniq.length) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq)
    .select('id', 'first_name', 'last_name', 'email', 'status')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return new Map(
    rows.map((r) => [
      String(r.id).toLowerCase(),
      [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null
    ])
  )
}

/** One connection by key, or null when it does not exist (any more). */
export async function agentConnectionOf(
  redis: Redis | null | undefined,
  conn: string
): Promise<AgentConnection | null> {
  const o = OAUTH_CONN.exec(conn)
  if (o) {
    if (!redis) return null
    const g = await getGrant(redis, o[1]).catch(() => null)
    if (!g) return null
    const n = await peopleNames([g.user_id])
    return {
      conn: `o${g.id.toLowerCase()}`,
      kind: 'oauth',
      name: g.client_name || 'Connected app',
      user_id: g.user_id,
      user_name: n.get(g.user_id.toLowerCase()) ?? null
    }
  }
  const k = KEY_CONN.exec(conn)
  if (k) {
    const key = (await db('nivaro_api_keys')
      .where({ id: Number(k[1]) })
      .first('id', 'name', 'user', 'expires_at', 'is_active')
      .catch(() => undefined)) as KeyRow | undefined
    if (!key?.user || !keyLive(key)) return null
    const n = await peopleNames([String(key.user)])
    return {
      conn: `k${key.id}`,
      kind: 'api_key',
      name: key.name || `API key ${key.id}`,
      user_id: String(key.user),
      user_name: n.get(String(key.user).toLowerCase()) ?? null
    }
  }
  return null
}

/**
 * The connections this person may hand a task to: their own, or (admin, `all`) everyone's.
 * Each acts as an active person.
 */
export async function listAssignableAgents(
  redis: Redis | null | undefined,
  actor: { id: string; isAdmin: boolean },
  opts: { all?: boolean } = {}
): Promise<AgentConnection[]> {
  const everyone = opts.all === true && actor.isAdmin
  const grants = redis
    ? await (everyone ? listAllGrants(redis, 2000) : listGrants(redis, actor.id)).catch(() => [])
    : []
  const kq = db('nivaro_api_keys').select('id', 'name', 'user', 'expires_at', 'is_active')
  if (!everyone) kq.where('user', actor.id)
  const keys = ((await kq.limit(500).catch(() => [])) as KeyRow[]).filter(
    (k) => k.user && keyLive(k)
  )
  const owners = [...grants.map((g) => g.user_id), ...keys.map((k) => String(k.user))]
  const active = new Set(
    (
      (await (owners.length
        ? db('nivaro_users')
            .whereIn('id', [...new Set(owners)].slice(0, 2000))
            .where('status', 'active')
            .select('id')
        : Promise.resolve([]))) as Array<{ id: string }>
    ).map((r) => String(r.id).toLowerCase())
  )
  const n = await peopleNames(owners)
  const out: AgentConnection[] = []
  for (const g of grants) {
    if (!active.has(g.user_id.toLowerCase())) continue
    out.push({
      conn: `o${g.id.toLowerCase()}`,
      kind: 'oauth',
      name: g.client_name || 'Connected app',
      user_id: g.user_id,
      user_name: n.get(g.user_id.toLowerCase()) ?? null
    })
  }
  for (const k of keys) {
    if (!active.has(String(k.user).toLowerCase())) continue
    out.push({
      conn: `k${k.id}`,
      kind: 'api_key',
      name: k.name || `API key ${k.id}`,
      user_id: String(k.user),
      user_name: n.get(String(k.user).toLowerCase()) ?? null
    })
  }
  return out.sort(
    (a, b) =>
      Number(!same(a.user_id, actor.id)) - Number(!same(b.user_id, actor.id)) ||
      a.name.localeCompare(b.name)
  )
}

/**
 * The connection a task is being handed to, checked: it exists, acts as an active person, and
 * the actor may use it (their own, or any for an administrator).
 */
export async function resolveTaskAgent(
  redis: Redis | null | undefined,
  conn: unknown,
  actor: { id: string; isAdmin: boolean }
): Promise<AgentConnection> {
  const key = String(conn ?? '').trim()
  if (!OAUTH_CONN.test(key) && !KEY_CONN.test(key))
    throw new TaskAgentError('agent must be a connection key (o<grant id> or k<api key id>)')
  const a = await agentConnectionOf(redis, key)
  if (!a) throw new TaskAgentError('That agent connection does not exist any more')
  if (!actor.isAdmin && !same(a.user_id, actor.id))
    throw new TaskAgentError('You can hand tasks only to your own agents')
  const owner = (await db('nivaro_users').where({ id: a.user_id }).first('status')) as
    | { status: string }
    | undefined
  if (owner?.status !== 'active')
    throw new TaskAgentError('That agent acts for someone who is not active')
  return a
}

/** "Claude Code (Rob Lee's agent)" — the line a task's history and UI use. */
export function agentLabel(a: Pick<AgentConnection, 'name' | 'user_name'>): string {
  return a.user_name ? `${a.name} (${a.user_name}'s agent)` : a.name
}
