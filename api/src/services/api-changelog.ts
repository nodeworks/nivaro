import type { GraphQLSchema } from 'graphql'
import { db } from '../db/index.js'

/**
 * API surface changelogs: GraphQL (#163) — type/field diffs on every schema
 * rebuild; REST (#315) — route inventory diffs per release. Removals are
 * flagged breaking and notify admins so integrations hear about it before
 * their calls start failing.
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
    void trackError({ source: 'server', route: 'api-changelog', message: `${subject}: ${message}`, severity: 'high' })
    const admins = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .limit(10)
      .select('u.id')) as Array<{ id: string }>
    for (const a of admins) {
      await db('nivaro_notifications').insert({
        recipient: a.id,
        subject: subject.slice(0, 255),
        status: 'inbox',
        timestamp: new Date(),
        sender: null,
        message: message.slice(0, 500),
        collection: null,
        item: null
      })
    }
  } catch {
    /* changelog must never break a rebuild */
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
      if (breaking) {
        await notifyAdminsOfBreak(
          'GraphQL schema change removed types or fields',
          `The rebuilt GraphQL schema removed ${lines.filter((l) => l.startsWith('-')).length} type(s)/field(s). Integrations querying them will now error. See /api/dev-tools/graphql-changelog.`
        )
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
    if (last) {
      const prev = new Set(JSON.parse(last.routes) as string[])
      const next = new Set(sorted)
      const lines: string[] = []
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
    if (breaking) {
      await notifyAdminsOfBreak(
        `Release ${version} removed REST routes`,
        `The new release removed routes that existed in the previous one — integrations calling them now 404. See /api/dev-tools/api-changelog.`
      )
    }
  } catch {
    /* best-effort */
  }
}
