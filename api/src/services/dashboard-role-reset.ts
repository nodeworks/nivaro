import { db } from '../db/index.js'
import { logActivity } from './activity.js'

// Role dashboard defaults, the people side: how many people in each role have
// saved their own dashboard layout (preferences.dashboard), and a reset that
// clears those layouts so the role's published default applies again. Each
// cleared layout is written to the activity log first — the restore path.

type Prefs = Record<string, unknown>

const parsePrefs = (raw: unknown): Prefs | null => {
  if (raw && typeof raw === 'object') return raw as Prefs
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Prefs) : null
  } catch {
    return null
  }
}

const hasLayout = (p: Prefs | null): boolean =>
  !!p && p.dashboard != null && typeof p.dashboard === 'object'

/** Per role: active people, and how many of them saved their own layout. */
export async function dashboardLayoutSummary(): Promise<
  Array<{ role: string; people: number; customized: number }>
> {
  const rows = (await db('nivaro_users')
    .whereNotNull('role')
    .where((w) => w.where('status', 'active').orWhereNull('status'))
    .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
    .select('role', 'preferences')) as Array<{ role: string; preferences: unknown }>
  const by = new Map<string, { people: number; customized: number }>()
  for (const r of rows) {
    const key = String(r.role).toUpperCase()
    const cur = by.get(key) ?? { people: 0, customized: 0 }
    cur.people++
    if (hasLayout(parsePrefs(r.preferences))) cur.customized++
    by.set(key, cur)
  }
  return [...by.entries()].map(([role, v]) => ({ role, ...v }))
}

/**
 * Clear the saved dashboard layout of everyone in `roleIds` (any status), so
 * their role's published default shows next time they open the dashboard.
 * Each person's previous layout goes to nivaro_activity first
 * (action `dashboard-layout-reset`, comment = the layout JSON).
 */
export async function resetDashboardLayouts(
  roleIds: string[],
  actorId: string
): Promise<{ reset: number }> {
  const ids = roleIds.map((r) => r.toUpperCase())
  if (ids.length === 0) return { reset: 0 }
  const rows = (await db('nivaro_users')
    .whereIn('role', ids)
    .where('preferences', 'like', '%"dashboard"%')
    .select('id', 'role', 'preferences')) as Array<{
    id: string
    role: string
    preferences: unknown
  }>
  let reset = 0
  for (const r of rows) {
    const prefs = parsePrefs(r.preferences)
    if (!prefs || !hasLayout(prefs)) continue
    const prior = prefs.dashboard
    const logged = await logActivity({
      action: 'dashboard-layout-reset',
      user: actorId,
      collection: 'nivaro_users',
      item: r.id,
      origin: 'person',
      comment: JSON.stringify({ role: r.role, prior })
    })
    // No log row, no reset: the log is the only way back.
    if (logged == null) continue
    const { dashboard: _drop, ...rest } = prefs
    await db('nivaro_users')
      .where({ id: r.id })
      .update({ preferences: JSON.stringify(rest) })
    reset++
  }
  return { reset }
}
