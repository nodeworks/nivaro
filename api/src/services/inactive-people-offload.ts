import { suspensionReason } from './account-status.js'
import { tenantState } from './ai-tenant-state.js'
import {
  type InactiveUserLinks,
  type LinkSource,
  scanInactiveUserLinks
} from './inactive-user-links.js'
import { sharedGatedRead } from './read-gate.js'

/**
 * "People to offload" — suspended or redacted people who still hold work that has to be handed
 * on, ranked by how much. Built ON the Inactive people scan (services/inactive-user-links.ts),
 * counted with the tool's own default rules so the figure here equals the figure after the
 * click: seats and team places always count, record links only on OPEN work, audit stamps and
 * a person's own saved sets never do. Placeholders (import stand-ins) are not people to offload.
 *
 * Admin data: the route and the widget callers authorise first.
 */

export type OffloadBucket = 'seats' | 'teams' | 'tasks' | 'approvals' | 'records'

export interface OffloadPerson {
  id: string
  name: string
  email: string | null
  status: string | null
  reason: 'suspended' | 'redacted' | 'anonymised'
  /** When the account stopped being able to act, when anything recorded it. */
  since: string | null
  /** Why, in a sentence (the same text the user page shows). */
  why: string | null
  why_source: string | null
  total: number
  counts: Record<OffloadBucket, number>
  /** The biggest places the work sits, for the row's second line. */
  top: Array<{ source: string; label: string; collection_label: string; count: number }>
  /** The Inactive people tool, filtered to this person. */
  tool_path: string
}

export interface OffloadReport {
  people: OffloadPerson[]
  total_people: number
  total_items: number
  truncated: boolean
  generated_at: string
}

const MAX_PEOPLE = 50

/** Which column of the widget a source feeds; null = not work to hand on (audit stamps, own sets). */
export function bucketOf(s: Pick<LinkSource, 'key' | 'role' | 'scope'>): OffloadBucket | null {
  if (s.role === 'audit' || s.role === 'own') return null
  if (s.key === 'builtin:owner_seats') return 'seats'
  if (s.key === 'builtin:teams') return 'teams'
  if (s.key === 'builtin:tasks') return 'tasks'
  if (s.key === 'builtin:approvals') return 'approvals'
  return s.scope === 'open' ? 'records' : null
}

const emptyCounts = (): Record<OffloadBucket, number> => ({
  seats: 0,
  teams: 0,
  tasks: 0,
  approvals: 0,
  records: 0
})

/** Pure: the people with work to hand on, most work first (no `since`/`why` yet). */
export function offloadFromScan(scan: {
  sources: LinkSource[]
  users: InactiveUserLinks[]
}): OffloadPerson[] {
  const sources = new Map(scan.sources.map((s) => [s.key, s]))
  const out: OffloadPerson[] = []
  for (const u of scan.users) {
    if (u.user.reason === 'placeholder') continue
    const counts = emptyCounts()
    const top: OffloadPerson['top'] = []
    for (const l of u.links) {
      const s = sources.get(l.source)
      const bucket = s ? bucketOf(s) : null
      if (!s || !bucket) continue
      counts[bucket] += l.count
      top.push({
        source: s.key,
        label: s.label,
        collection_label: s.collection_label,
        count: l.count
      })
    }
    const total = Object.values(counts).reduce((a, n) => a + n, 0)
    if (total === 0) continue
    out.push({
      id: u.user.id,
      name: u.user.name,
      email: u.user.email,
      status: u.user.status,
      reason: u.user.reason as OffloadPerson['reason'],
      since: null,
      why: null,
      why_source: null,
      total,
      counts,
      top: top.sort((a, b) => b.count - a.count).slice(0, 3),
      tool_path: `/data-integrity?tab=people&person=${encodeURIComponent(u.user.id)}`
    })
  }
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

const cacheState = tenantState<{ at: number; value: Promise<OffloadReport> | null }>(() => ({
  at: 0,
  value: null
}))
const TTL_MS = 60_000

export function bustOffloadCache() {
  cacheState().value = null
}

/** The widget's data: one scan (cached 2 min underneath), `since`/`why` for the people shown. */
export async function loadOffloadReport(opts: { fresh?: boolean } = {}): Promise<OffloadReport> {
  const cache = cacheState()
  if (!opts.fresh && cache.value && Date.now() - cache.at < TTL_MS) return cache.value
  const run = sharedGatedRead('inactive-offload', 'overview', async () => {
    const scan = await scanInactiveUserLinks({ fresh: opts.fresh })
    const all = offloadFromScan(scan)
    const shown = all.slice(0, MAX_PEOPLE)
    // Why/when is read per person (activity + revisions): only for the rows on screen.
    for (let i = 0; i < shown.length; i += 5) {
      await Promise.all(
        shown.slice(i, i + 5).map(async (p) => {
          const r = await suspensionReason(p.id).catch(() => null)
          if (!r) return
          p.since = r.at
          p.why = r.text
          p.why_source = r.source
        })
      )
    }
    return {
      people: shown,
      total_people: all.length,
      total_items: all.reduce((a, p) => a + p.total, 0),
      truncated: all.length > shown.length,
      generated_at: new Date().toISOString()
    } satisfies OffloadReport
  }).then((r) => r.value)
  cache.at = Date.now()
  cache.value = run
  run.catch(() => {
    if (cache.value === run) cache.value = null
  })
  return run
}

/** Upper-cased ids of people who still hold work, with their totals — the notifier's "still own work". */
export async function offloadTotalsByUser(
  opts: { fresh?: boolean } = {}
): Promise<Map<string, number>> {
  const scan = await scanInactiveUserLinks({ fresh: opts.fresh })
  return new Map(offloadFromScan(scan).map((p) => [p.id.toUpperCase(), p.total]))
}
