import { createHash } from 'node:crypto'
import type { GraphQLSchema } from 'graphql'
import { db } from '../db/index.js'
import { chainFields } from './chain-columns.js'
import { getApp } from './io-holder.js'
import { notificationRowMeta, notifyUser } from './notification-channels.js'
import { rawWriterReason, reasonColumn } from './notification-reason.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * API surface changelogs: GraphQL (#163) — type/field diffs on every schema
 * rebuild; REST (#315) — route inventory diffs per release. Removals are
 * flagged breaking in the log. Admins are notified only when a removal hits
 * something a partner (API key / machine account) actually called in the
 * request log's window — a dropped table nobody queries is not news.
 */

function snapshotGraphQL(schema: GraphQLSchema): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const typeMap = schema.getTypeMap()
  for (const [name, type] of Object.entries(typeMap)) {
    if (name.startsWith('__')) continue
    const t = type as { getFields?: () => Record<string, unknown> }
    if (typeof t.getFields === 'function') {
      out[name] = Object.keys(t.getFields()).sort()
    } else {
      out[name] = []
    }
  }
  return out
}

function diffSnapshots(
  prev: Record<string, string[]>,
  next: Record<string, string[]>
): { lines: string[]; breaking: boolean } {
  const lines: string[] = []
  let breaking = false
  for (const name of Object.keys(next)) {
    if (!prev[name]) lines.push(`+ type ${name}`)
  }
  for (const name of Object.keys(prev)) {
    if (!next[name]) {
      lines.push(`- type ${name}`)
      breaking = true
      continue
    }
    const prevFields = new Set(prev[name])
    const nextFields = new Set(next[name])
    for (const f of nextFields) if (!prevFields.has(f)) lines.push(`+ ${name}.${f}`)
    for (const f of prevFields) {
      if (!nextFields.has(f)) {
        lines.push(`- ${name}.${f}`)
        breaking = true
      }
    }
  }
  return { lines, breaking }
}

async function notifyAdminsOfBreak(subject: string, message: string): Promise<void> {
  try {
    // Deduped issue for the ops surface + direct inbox rows for admins.
    const { trackError } = await import('./error-tracking.js')
    void trackError({
      source: 'server',
      route: 'api-changelog',
      message: `${subject}: ${message}`,
      severity: 'high'
    })
    const admins = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .limit(10)
      .select('u.id')) as Array<{ id: string }>
    const app = getApp()
    for (const a of admins) {
      if (app) {
        // Through notifyUser (#782) — a breaking API change is critical for
        // an admin: always_inbox, target = the API changelog.
        await notifyUser(app, a.id, {
          subject: subject.slice(0, 255),
          message: message.slice(0, 500),
          category: 'system',
          always_inbox: true,
          target: { kind: 'external', url: '/analytics/api', action: 'review' },
          source: { kind: 'api_changelog', label: 'GraphQL schema change' },
          why: 'You are an administrator; a schema change can break an integration.'
        })
        continue
      }
      await db('nivaro_notifications').insert({
        ...(await chainFields('nivaro_notifications')),
        recipient: a.id,
        subject: subject.slice(0, 255),
        status: 'inbox',
        timestamp: new Date(),
        sender: null,
        message: message.slice(0, 500),
        collection: null,
        item: null,
        ...notificationRowMeta({ subject, category: 'system' }),
        ...(await reasonColumn(
          rawWriterReason({
            path: {
              kind: 'api_changelog',
              text: 'You are an administrator; a schema change can break an integration.',
              label: null,
              id: null
            },
            category: 'system',
            ruleText: 'Schema changes are always posted to administrators.',
            layer: 'system'
          })
        ))
      })
    }
  } catch {
    /* changelog must never break a rebuild */
  }
}

/** The removed half of a diff ("- …" lines), order-free, as one hash. */
export function removedSetHash(lines: readonly string[]): string {
  const removed = lines.filter((l) => l.startsWith('-')).sort()
  return createHash('sha1').update(removed.join('\n')).digest('hex')
}

interface RedisLike {
  get(k: string): Promise<string | null>
  set(k: string, v: string, ...args: (string | number)[]): Promise<unknown>
}

const lastNotified = new Map<string, string>()
const BREAK_NOTICE_TTL_S = 90 * 24 * 3600

/**
 * army6 L53 — "GraphQL schema change removed 170 type(s)…" reached every admin
 * after EVERY staging rebuild: the nightly restore puts the schema log back, so
 * the same removal is found again each morning. Admins are told about a removed
 * set once; the same set again stays quiet. The last told hash lives in Redis
 * (outside the restored database, per tenant), with this process's memory as
 * the fallback when Redis is not there.
 */
export async function shouldNotifyBreak(
  kind: 'graphql' | 'rest',
  lines: readonly string[],
  redis: RedisLike | null = (getApp() as unknown as { redis?: RedisLike } | null)?.redis ?? null
): Promise<boolean> {
  const hash = removedSetHash(lines)
  const key = `nvr:schema-break:${currentTenantKey()}:${kind}`
  if (lastNotified.get(key) === hash) return false
  lastNotified.set(key, hash)
  if (!redis) return true
  try {
    if ((await redis.get(key)) === hash) return false
    await redis.set(key, hash, 'EX', BREAK_NOTICE_TTL_S)
  } catch {
    // Redis trouble: this process's memory is all there is.
  }
  return true
}

/** The removed half of a GraphQL diff as `type X` / `X.field` keys. */
export function removedKeys(lines: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const l of lines) if (l.startsWith('- ')) out.add(l.slice(2).trim())
  return out
}

interface BreakFinding {
  severity: string
  caller: string
  collection: string
  field: string | null
  message: string
}

/**
 * The partner break findings THIS removal caused (pre-existing breaks are the
 * readiness check's business, not a fresh notice). A finding counts when the
 * diff removed its type, its `Type.field`, its root field, or a field of the
 * same name on another type (M2M row types carry the target's fields).
 */
export function findingsHitByRemoval<T extends BreakFinding>(
  findings: readonly T[],
  removed: ReadonlySet<string>
): T[] {
  if (removed.size === 0) return []
  const removedFieldNames = new Set<string>()
  for (const k of removed) {
    if (k.startsWith('type ')) continue
    const dot = k.lastIndexOf('.')
    if (dot > 0) removedFieldNames.add(k.slice(dot + 1))
  }
  return findings.filter((f) => {
    if (f.severity !== 'break') return false
    if (f.collection === '(graphql)') {
      return (
        !!f.field &&
        (removed.has(`Query.${f.field}`) ||
          removed.has(`Mutation.${f.field}`) ||
          removed.has(`Subscription.${f.field}`))
      )
    }
    if (removed.has(`type ${f.collection}`)) return true
    if (!f.field) return false
    return removed.has(`${f.collection}.${f.field}`) || removedFieldNames.has(f.field)
  })
}

/** Partner breaks caused by this GraphQL removal; [] when the check can't run. */
async function partnerBreaksFrom(lines: readonly string[]): Promise<BreakFinding[]> {
  try {
    const { runInBackgroundPool } = await import('../db/pool-context.js')
    const { checkDependencies } = await import('./partner-dependencies.js')
    const r = await runInBackgroundPool(() => checkDependencies({ fresh: true }))
    return findingsHitByRemoval(r.findings, removedKeys(lines))
  } catch {
    return []
  }
}

/** Removed REST routes ("- GET /x") a partner called in the logged window. */
export function routesUsedByPartners(
  lines: readonly string[],
  used: ReadonlyArray<{ method: string; path: string }>
): string[] {
  const calls = used.map((e) => ({
    method: e.method.toUpperCase(),
    path: e.path.replace(/\/$/, '')
  }))
  const out: string[] = []
  for (const l of lines) {
    if (!l.startsWith('- ')) continue
    const route = l.slice(2).trim()
    const sp = route.indexOf(' ')
    if (sp < 0) continue
    const method = route.slice(0, sp).toUpperCase()
    // Fastify template → pattern: `:param` is one segment (matches a logged `{id}`), `*` the rest.
    const pattern = new RegExp(
      `^${route
        .slice(sp + 1)
        .replace(/\/$/, '')
        .split('/')
        .map((seg) =>
          seg === '*'
            ? '.*'
            : seg.startsWith(':')
              ? '[^/]+'
              : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
        .join('/')}$`
    )
    if (calls.some((c) => (c.method === method || method === 'ALL') && pattern.test(c.path)))
      out.push(route)
  }
  return out
}

async function partnerRoutesHit(lines: readonly string[]): Promise<string[]> {
  try {
    const { runInBackgroundPool } = await import('../db/pool-context.js')
    const { dependencyMap } = await import('./partner-dependencies.js')
    const map = await runInBackgroundPool(() => dependencyMap(14, { fresh: true }))
    return routesUsedByPartners(
      lines,
      map.callers.filter((c) => c.partner).flatMap((c) => c.endpoints)
    )
  } catch {
    return []
  }
}

/** Record the GraphQL schema shape; diff + notify on change (#163). */
export async function recordGraphQLSchema(schema: GraphQLSchema): Promise<void> {
  try {
    const snapshot = snapshotGraphQL(schema)
    const last = (await db('nivaro_graphql_schema_log').orderBy('id', 'desc').first()) as
      | { snapshot: string }
      | undefined
    const prev = last ? (JSON.parse(last.snapshot) as Record<string, string[]>) : null
    if (prev) {
      const { lines, breaking } = diffSnapshots(prev, snapshot)
      if (lines.length === 0) return // unchanged — no log spam per rebuild
      await db('nivaro_graphql_schema_log').insert({
        at: new Date(),
        snapshot: JSON.stringify(snapshot),
        diff: lines.slice(0, 200).join('\n'),
        breaking
      })
      if (breaking && (await shouldNotifyBreak('graphql', lines))) {
        const hits = await partnerBreaksFrom(lines)
        if (hits.length > 0) {
          const callers = [...new Set(hits.map((h) => h.caller))]
          await notifyAdminsOfBreak(
            `GraphQL change breaks ${callers.length === 1 ? callers[0] : `${callers.length} integrations`}`,
            `The rebuilt GraphQL schema removed something an integration called recently: ${hits
              .slice(0, 3)
              .map((h) => h.message)
              .join('; ')}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ''}.`
          )
        }
      }
    } else {
      await db('nivaro_graphql_schema_log').insert({
        at: new Date(),
        snapshot: JSON.stringify(snapshot),
        diff: null,
        breaking: false
      })
    }
    // Retention: newest 50 entries.
    const old = (await db('nivaro_graphql_schema_log')
      .orderBy('id', 'desc')
      .offset(50)
      .limit(100)
      .select('id')) as Array<{ id: number }>
    if (old.length > 0)
      await db('nivaro_graphql_schema_log')
        .whereIn(
          'id',
          old.map((o) => o.id)
        )
        .del()
  } catch {
    /* best-effort */
  }
}

/** Record the REST route inventory per release; diff on version change (#315). */
export async function recordRestRoutes(version: string, routes: string[]): Promise<void> {
  try {
    const sorted = [...new Set(routes)].sort()
    const last = (await db('nivaro_api_changelog').orderBy('id', 'desc').first()) as
      | { version: string; routes: string }
      | undefined
    if (last?.version === version) return // same release — nothing to record
    let diff: string | null = null
    let breaking = false
    const lines: string[] = []
    if (last) {
      const prev = new Set(JSON.parse(last.routes) as string[])
      const next = new Set(sorted)
      for (const r of next) if (!prev.has(r)) lines.push(`+ ${r}`)
      for (const r of prev) {
        if (!next.has(r)) {
          lines.push(`- ${r}`)
          breaking = true
        }
      }
      diff = lines.slice(0, 300).join('\n') || null
    }
    await db('nivaro_api_changelog').insert({
      version,
      at: new Date(),
      routes: JSON.stringify(sorted),
      diff,
      breaking
    })
    if (breaking && (await shouldNotifyBreak('rest', lines))) {
      const used = await partnerRoutesHit(lines)
      if (used.length > 0) {
        await notifyAdminsOfBreak(
          `Release ${version} removed REST routes an integration calls`,
          `The new release removed routes an integration called recently, so those calls now 404: ${used
            .slice(0, 3)
            .join('; ')}${used.length > 3 ? ` (+${used.length - 3} more)` : ''}.`
        )
      }
    }
  } catch {
    /* best-effort */
  }
}
