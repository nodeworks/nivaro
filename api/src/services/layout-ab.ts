import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { selectInChunks } from './db-batch.js'
import { parseConditions } from './layout-patch.js'

/**
 * A/B layouts (#2614): two versions of a record form shown to different
 * halves of one role, compared on how long a save takes and how often a new
 * record is edited again soon after it was saved.
 *
 * No table: the test lives on the VARIANT layout's `conditions` JSON under
 * `ab` (beside `role_ids` and the pinned test records), so it versions with
 * the layout and needs no migration:
 *
 *   conditions.ab = { control_id, role_id, salt, started_at, started_by }
 *
 * While the control is still a record form of the same collection, the
 * variant leaves normal resolution entirely (rules, roles, default and order
 * never pick it). When /active picks the control for a non-admin member of
 * `role_id`, a stable hash of (salt, user id) puts that person in half 'a'
 * (keeps the control) or half 'b' (gets the variant): deterministic, the same
 * answer on every request, explainable by /explain. A link name (?layout=)
 * still opens either form as asked. Administrators always get the control.
 *
 * The usage beacon tags a session that belongs to the test (the person is in
 * the role, the form is their half's) and keeps its counts under a
 * `~ab:<salt>` key of that day's step_stats (services/layout-usage.ts), so
 * a restarted test (new salt) never mixes with an earlier one.
 */

export interface AbTest {
  control_id: number
  role_id: string
  /** Seeds the halves; a new test gets a new salt. */
  salt: string
  started_at: string
  started_by: string | null
}

export type AbHalf = 'a' | 'b'

const SALT = /^[A-Za-z0-9_-]{4,40}$/

/** The A/B test stored on a layout's conditions, or null when there is none (or it is malformed). */
export function parseAbTest(conditions: unknown): AbTest | null {
  const c = parseConditions(conditions) as Record<string, unknown> | null
  const ab = c?.ab as Record<string, unknown> | undefined
  if (!ab || typeof ab !== 'object' || Array.isArray(ab)) return null
  const control = Number(ab.control_id)
  const role = typeof ab.role_id === 'string' ? ab.role_id : ''
  const salt = typeof ab.salt === 'string' ? ab.salt : ''
  if (!Number.isInteger(control) || control <= 0 || !role || role.length > 64) return null
  if (!SALT.test(salt)) return null
  return {
    control_id: control,
    role_id: role,
    salt,
    started_at: typeof ab.started_at === 'string' ? ab.started_at : '',
    started_by: typeof ab.started_by === 'string' ? ab.started_by : null
  }
}

/** FNV-1a, 32 bit: small, stable across processes and versions. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Which half of the test a person is in: the same answer for the same person and test, always. */
export function abHalf(salt: string, userId: string): AbHalf {
  return fnv1a(`${salt}:${String(userId).toUpperCase()}`) % 2 === 1 ? 'b' : 'a'
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

/**
 * The variant rows among `candidates` whose test is live: the control is
 * another candidate (a record form of the same collection) and is not itself a
 * variant. A variant whose control is gone is an ordinary layout again.
 */
export function liveVariants(
  candidates: Record<string, unknown>[]
): Map<Record<string, unknown>, AbTest> {
  const tests = new Map<Record<string, unknown>, AbTest>()
  for (const row of candidates) {
    const t = parseAbTest(row.conditions)
    if (t && t.control_id !== Number(row.id)) tests.set(row, t)
  }
  const out = new Map<Record<string, unknown>, AbTest>()
  for (const [row, t] of tests) {
    const control = candidates.find((c) => Number(c.id) === t.control_id)
    if (control && !tests.has(control)) out.set(row, t)
  }
  return out
}

export interface AbApplied {
  control_id: number
  variant_id: number
  role_id: string
  /** The person's half; null when no person was given (explain as a role). */
  half: AbHalf | null
}

/**
 * The test that applies when resolution picked `picked` for this role: a live
 * variant of it for exactly this role. Admins (no role preference) never.
 */
export function abFor(
  picked: Record<string, unknown> | null,
  variants: Map<Record<string, unknown>, AbTest>,
  userRoleId: string | null | undefined,
  isAdmin: boolean,
  userId: string | null | undefined
): { variant: Record<string, unknown>; applied: AbApplied } | null {
  if (!picked || isAdmin || !userRoleId) return null
  for (const [variant, t] of variants) {
    if (t.control_id !== Number(picked.id) || !sameId(t.role_id, userRoleId)) continue
    return {
      variant,
      applied: {
        control_id: t.control_id,
        variant_id: Number(variant.id),
        role_id: t.role_id,
        half: userId ? abHalf(t.salt, userId) : null
      }
    }
  }
  return null
}

// ─── The tests of a collection (beacon tagging, overview) ───────────────────

export interface CollectionAbTest extends AbTest {
  variant_id: number
}

const testsMemo = new Map<string, { at: number; tests: CollectionAbTest[] }>()
const TESTS_TTL_MS = 60_000

/** Live tests on a collection's record forms (cached 60 s per tenant). */
export async function abTestsForCollection(collection: string): Promise<CollectionAbTest[]> {
  const key = `${getTenantId() ?? ''}|${collection}`
  const hit = testsMemo.get(key)
  if (hit && Date.now() - hit.at < TESTS_TTL_MS) return hit.tests
  const rows = (await db('nivaro_collection_layouts')
    .where({ collection })
    .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
    .select('id', 'conditions')) as Record<string, unknown>[]
  const tests = [...liveVariants(rows)].map(([row, t]) => ({ ...t, variant_id: Number(row.id) }))
  testsMemo.set(key, { at: Date.now(), tests })
  if (testsMemo.size > 1000) testsMemo.delete(testsMemo.keys().next().value as string)
  return tests
}

export function forgetAbTests(collection?: string): void {
  if (!collection) {
    testsMemo.clear()
    return
  }
  testsMemo.delete(`${getTenantId() ?? ''}|${collection}`)
}

/**
 * The test a usage event counts for (its salt), or null: the person is a
 * non-admin member of the test's role and the form is the one their half gets.
 */
export function abArmOf(
  tests: CollectionAbTest[],
  layoutId: number,
  user: { id?: unknown; role?: unknown } | null | undefined,
  isAdmin: boolean
): string | null {
  if (!user?.id || !user.role || isAdmin) return null
  for (const t of tests) {
    if (!sameId(t.role_id, user.role)) continue
    const half = abHalf(t.salt, String(user.id))
    if (layoutId === t.control_id && half === 'a') return t.salt
    if (layoutId === t.variant_id && half === 'b') return t.salt
  }
  return null
}

// ─── Arm counts kept in step_stats ──────────────────────────────────────────

/** One test's counts for one form on one day (`~ab:<salt>` in step_stats). */
export interface ArmStat {
  /** Sessions opened. */
  o: number
  /** Saves. */
  s: number
  /** New records left unfinished. */
  a: number
  /** Milliseconds on the form, all sessions. */
  ms: number
  /** Milliseconds from opening to saving, summed over the sessions that saved. */
  t: number
  /** Sessions that saved with a time. */
  tn: number
}

export const emptyArm = (): ArmStat => ({ o: 0, s: 0, a: 0, ms: 0, t: 0, tn: 0 })

export function parseArm(v: unknown): ArmStat {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const n = (k: string) => (Number.isFinite(Number(r[k])) ? Math.max(0, Number(r[k])) : 0)
  return { o: n('o'), s: n('s'), a: n('a'), ms: n('ms'), t: n('t'), tn: n('tn') }
}

export function addArm(into: ArmStat, add: ArmStat): ArmStat {
  return {
    o: into.o + add.o,
    s: into.s + add.s,
    a: into.a + add.a,
    ms: into.ms + add.ms,
    t: into.t + add.t,
    tn: into.tn + add.tn
  }
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface ArmResult {
  layout_id: number
  half: AbHalf
  /** Active members of the role in this half. */
  people: number
  opens: number
  saves: number
  abandons: number
  /** Saves per open (0-1), null with no opens. */
  save_rate: number | null
  /** Average milliseconds from opening the form to saving it, null before a timed save. */
  avg_save_ms: number | null
  timed_saves: number
  /** Records created by people in this half since the test started. */
  created: number
  /** Of those, records changed again within 24 hours. */
  edited_after_save: number
  /** Updates within 24 hours per created record. */
  edits_per_record: number | null
}

export interface AbCreation {
  item: string
  creator: string
  at: Date
}

/**
 * Edits after save per half: each created record goes to its creator's half;
 * an update within 24 hours of the creation counts as an edit after save.
 */
export function tallyCreations(
  salt: string,
  creations: AbCreation[],
  updates: Array<{ item: string; at: Date }>
): Record<AbHalf, { created: number; edited: number; edits: number }> {
  const byItem = new Map<string, Date[]>()
  for (const u of updates) {
    const list = byItem.get(u.item) ?? []
    list.push(u.at)
    byItem.set(u.item, list)
  }
  const out = {
    a: { created: 0, edited: 0, edits: 0 },
    b: { created: 0, edited: 0, edits: 0 }
  }
  for (const c of creations) {
    const half = out[abHalf(salt, c.creator)]
    half.created++
    const start = c.at.getTime()
    const n = (byItem.get(c.item) ?? []).filter((at) => {
      const t = at.getTime()
      return t > start && t <= start + 24 * 3_600_000
    }).length
    if (n > 0) half.edited++
    half.edits += n
  }
  return out
}

export function armResult(
  layoutId: number,
  half: AbHalf,
  people: number,
  stat: ArmStat,
  made: { created: number; edited: number; edits: number }
): ArmResult {
  return {
    layout_id: layoutId,
    half,
    people,
    opens: stat.o,
    saves: stat.s,
    abandons: stat.a,
    save_rate: stat.o > 0 ? Math.round((Math.min(stat.s, stat.o) / stat.o) * 1000) / 1000 : null,
    avg_save_ms: stat.tn > 0 ? Math.round(stat.t / stat.tn) : null,
    timed_saves: stat.tn,
    created: made.created,
    edited_after_save: made.edited,
    edits_per_record: made.created > 0 ? Math.round((made.edits / made.created) * 100) / 100 : null
  }
}

export interface AbResults {
  ready: boolean
  since: string
  a: ArmResult
  b: ArmResult
}

const MAX_CREATIONS = 5000
const ROLE_MEMBERS_CAP = 20_000

/** The halves' numbers since the test started (an expensive read: callers cache and gate it). */
export async function computeAbResults(opts: {
  collection: string
  test: AbTest
  variantId: number
  usageReady: boolean
  dailyTable: string
}): Promise<AbResults> {
  const { collection, test, variantId } = opts
  const startedAt = new Date(test.started_at)
  const since = Number.isNaN(startedAt.getTime()) ? new Date(0) : startedAt
  const sinceDay = since.toISOString().slice(0, 10)
  const metaKey = `~ab:${test.salt}`

  const stats: Record<AbHalf, ArmStat> = { a: emptyArm(), b: emptyArm() }
  if (opts.usageReady) {
    const rows = (await db(opts.dailyTable)
      .whereIn('layout_id', [test.control_id, variantId])
      .where('day', '>=', sinceDay)
      .select('layout_id', 'step_stats')) as Array<{ layout_id: number; step_stats: unknown }>
    for (const r of rows) {
      let meta: unknown = null
      try {
        meta =
          typeof r.step_stats === 'string'
            ? (JSON.parse(r.step_stats) as Record<string, unknown>)[metaKey]
            : null
      } catch {
        meta = null
      }
      if (meta == null) continue
      const half: AbHalf = Number(r.layout_id) === variantId ? 'b' : 'a'
      stats[half] = addArm(stats[half], parseArm(meta))
    }
  }

  const members = (await db('nivaro_users')
    .where({ role: test.role_id })
    .where((b) => b.where({ status: 'active' }).orWhereNull('status'))
    .limit(ROLE_MEMBERS_CAP)
    .select('id')) as Array<{ id: string }>
  const people = { a: 0, b: 0 }
  for (const m of members) people[abHalf(test.salt, String(m.id))]++

  const created = (await db('nivaro_activity as ca')
    .join('nivaro_users as u', 'u.id', 'ca.user')
    .where('ca.collection', collection)
    .where('ca.action', 'create')
    .where('ca.timestamp', '>=', since)
    .where('u.role', test.role_id)
    .orderBy('ca.id', 'desc')
    .limit(MAX_CREATIONS)
    .select('ca.item as item', 'ca.user as creator', 'ca.timestamp as at')) as Array<{
    item: unknown
    creator: unknown
    at: unknown
  }>
  const creations: AbCreation[] = created
    .filter((c) => c.item != null && c.creator != null)
    .map((c) => ({ item: String(c.item), creator: String(c.creator), at: new Date(String(c.at)) }))
  const items = [...new Set(creations.map((c) => c.item))]
  const updates = (
    await selectInChunks(
      items,
      1000,
      (chunk) =>
        db('nivaro_activity')
          .where({ collection, action: 'update' })
          .where('timestamp', '>=', since)
          .whereIn('item', chunk)
          .select('item', 'timestamp') as Promise<Array<{ item: unknown; timestamp: unknown }>>
    )
  ).map((u) => ({ item: String(u.item), at: new Date(String(u.timestamp)) }))
  const made = tallyCreations(test.salt, creations, updates)

  return {
    ready: opts.usageReady,
    since: since.toISOString(),
    a: armResult(test.control_id, 'a', people.a, stats.a, made.a),
    b: armResult(variantId, 'b', people.b, stats.b, made.b)
  }
}
