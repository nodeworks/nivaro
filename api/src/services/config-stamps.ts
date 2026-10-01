import { type ConfigStamp, onConfigStamp } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { instanceKey } from './instance-key.js'

/**
 * Config changes on the incident timeline (#1053).
 *
 * The driver seam already sees every configuration write (db/config-epoch.ts) and moves the
 * `__config__` epoch so every process clears its caches. This turns each such change into one
 * `config-epoch` activity row: which area (layout / pipeline / flow / schema / access …), which
 * tables, who, on which instance, and the activity row(s) of the save that caused it — so a
 * latency shift or a readiness drop can be read against "layout 2 saved 20 minutes ago".
 *
 * Only the process that made the write records it (other processes only see the number move).
 */

const AREAS: Array<[RegExp, string]> = [
  [/^nivaro_(collection_layouts|layout_field_assignments|field_groups)$/, 'layout'],
  [/^nivaro_workflow_/, 'pipeline'],
  [/^nivaro_(pipeline_owner_|user_groups|user_group_members)/, 'owners'],
  [/^nivaro_flow/, 'flow'],
  [/^nivaro_(fields|collections|relations)$/, 'schema'],
  [/^nivaro_(roles|policies|user_scopes|scope_dimensions|tree_permissions)$/, 'access'],
  [/^nivaro_(rules|field_rules|at_risk_rules|sla_rules|alert_definitions)$/, 'rules'],
  [/^nivaro_(custom_queries|widgets)$/, 'queries & widgets'],
  [/^nivaro_(webhooks|integration_contracts)$/, 'integrations'],
  [
    /^nivaro_(mail_templates|extension_settings|settings_overrides|ai_collection_settings)$/,
    'settings'
  ]
]

/** Exported for tests: the area a configuration table belongs to. */
export function configArea(table: string): string {
  for (const [re, area] of AREAS) if (re.test(table)) return area
  return table.startsWith('nivaro_') ? 'configuration' : 'schema'
}

/** Exported for tests: the timeline sentence for one stamp. */
export function describeStamp(
  stamp: ConfigStamp,
  who: string | null,
  causes: Array<{ id: number; action: string; collection: string | null; item: string | null }>,
  instance: string
): string {
  const areas = [...new Set(stamp.tables.map((t) => configArea(t.table)))]
  const what = stamp.manual
    ? 'Caches refreshed by hand'
    : `Configuration changed: ${areas.length ? areas.join(', ') : 'schema'}`
  const tables = stamp.tables
    .slice(0, 4)
    .map((t) => `${t.table}${t.writes > 1 ? ` ×${t.writes}` : ''}`)
    .join(', ')
  const by = who
    ? ` by ${who}`
    : stamp.manual
      ? ''
      : ' with no signed-in request (a script, migration or job)'
  const ddl = stamp.ddl ? ` · ${stamp.ddl} schema statement${stamp.ddl === 1 ? '' : 's'}` : ''
  const cause = causes.length
    ? ` — caused by ${causes
        .slice(0, 3)
        .map(
          (c) =>
            `${c.action} on ${c.collection ?? '?'}${c.item ? ` #${c.item}` : ''} (activity #${c.id})`
        )
        .join('; ')}`
    : ''
  const epoch = stamp.epoch != null ? `config epoch ${stamp.epoch}` : 'config epoch not moved'
  return `${what}${tables ? ` (${tables})` : ''}${by} on ${instance}${ddl}${cause} · ${epoch}`.slice(
    0,
    1900
  )
}

async function nameOf(userId: string | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const u = (await db('nivaro_users')
      .where('id', userId)
      .first('first_name', 'last_name', 'email')) as
      | { first_name?: string | null; last_name?: string | null; email?: string | null }
      | undefined
    if (!u) return null
    return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || null
  } catch {
    return null
  }
}

async function causesOf(
  stamp: ConfigStamp
): Promise<Array<{ id: number; action: string; collection: string | null; item: string | null }>> {
  if (stamp.manual || stamp.tables.length === 0) return []
  try {
    const from = new Date(Date.parse(stamp.from) - 5_000)
    const to = new Date(Date.parse(stamp.to) + 5_000)
    const rows = (await db('nivaro_activity')
      .whereBetween('timestamp', [from, to])
      .whereRaw("collection LIKE ? ESCAPE '\\'", ['nivaro\\_%'])
      .whereNotIn('action', ['read', 'login', 'config-epoch'])
      .modify((q) => {
        if (stamp.users.length) q.whereIn('user', stamp.users)
      })
      .orderBy('id', 'desc')
      .limit(5)
      .select('id', 'action', 'collection', 'item')) as Array<{
      id: number | string
      action: string
      collection: string | null
      item: string | null
    }>
    return rows.map((r) => ({ ...r, id: Number(r.id) }))
  } catch {
    return []
  }
}

let registered = false

export function registerConfigStamps(): void {
  if (registered) return
  registered = true
  onConfigStamp(async (stamp) => {
    // Give the save's own activity row a moment to land (it is written after the config write).
    await new Promise((r) => setTimeout(r, 1_500))
    const [who, causes] = await Promise.all([nameOf(stamp.users[0]), causesOf(stamp)])
    await logActivity({
      action: 'config-epoch',
      user: stamp.users[0] ?? null,
      collection: 'nivaro_cache_epochs',
      item: stamp.epoch != null ? String(stamp.epoch) : undefined,
      comment: describeStamp(stamp, who, causes, instanceKey()),
      origin: stamp.users.length ? 'person' : 'machine'
    })
  })
}
