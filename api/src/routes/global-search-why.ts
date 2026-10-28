import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { can, isAdminRole } from '../services/permissions.js'
import { withReadGate } from '../services/read-gate.js'
import {
  type AccessReason,
  compileAccessGates,
  explainIds,
  visibleIds
} from '../services/record-access.js'
import { getUser } from '../services/users.js'
import type { User } from '../types.js'
import { countMatches, searchCollectionPage } from './global-search.js'

/**
 * Search item 25 — "Why can't they find it?" (admin only).
 *
 *   GET /api/global-search/why?q=&user_id=[&collection=][&labels=1]
 *
 * Runs the global search's per-collection counts twice — as the administrator
 * asking (every row, every field) and as the named person (their role, row
 * filters, User Scopes and readable fields: the same countMatches the palette
 * tabs use) — and for each collection where the person finds fewer, takes up
 * to SAMPLE_SCAN of the administrator's matches, re-runs the person's access
 * gates over them (services/record-access.ts, the machinery behind
 * /access-explain and the explain_access tool) and explains up to
 * SAMPLES_EXPLAINED hidden ones. A match the gates let through but the
 * person's search still misses was found only in a field their role cannot
 * read — that is said too.
 *
 * Read-only by construction: it only counts and asks the gates. The asking
 * administrator sees record labels (they can read every record anyway); the
 * person evaluated is never told anything.
 */

const SAMPLE_SCAN = 50
const SAMPLES_EXPLAINED = 3
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export type WhyReasonType = AccessReason['type'] | 'fields'

export interface WhyReason {
  type: WhyReasonType
  message: string
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
  /** How many of the explained samples this reason covers. */
  samples: number
}

export interface WhySample {
  id: string
  label: string
  reasons: AccessReason[]
}

export interface WhyRow {
  collection: string
  display_name: string | null
  admin_count: number
  user_count: number
  /** admin_count − user_count (never below 0). */
  hidden: number
  reasons: WhyReason[]
  samples: WhySample[]
}

export interface WhyAnswer {
  q: string
  labels_only: boolean
  user: {
    id: string
    name: string
    email: string | null
    status: string | null
    role_name: string | null
    is_admin: boolean
  }
  totals: { admin: number; user: number; hidden: number }
  collections: WhyRow[]
}

/** Registered non-system collections — what an administrator's search covers. */
async function allCollections(): Promise<string[]> {
  const rows = (await db('nivaro_collections').select('collection')) as Array<{
    collection: string
  }>
  return rows
    .map((r) => r.collection)
    .filter((c) => IDENT_RE.test(c) && !/^nivaro_/i.test(c) && !/^directus_/i.test(c))
}

function reasonKey(r: AccessReason): string {
  return `${r.type}|${r.dimension ?? ''}`
}

/** One line per distinct reason across the samples, most common first. */
export function summarizeReasons(samples: WhySample[]): WhyReason[] {
  const by = new Map<string, WhyReason>()
  for (const s of samples) {
    const seen = new Set<string>()
    for (const r of s.reasons) {
      const key = reasonKey(r)
      if (seen.has(key)) continue
      seen.add(key)
      const hit = by.get(key)
      if (hit) {
        hit.samples++
        continue
      }
      by.set(key, {
        type: r.type,
        message: generalMessage(r),
        ...(r.dimension ? { dimension: r.dimension } : {}),
        ...(r.dimension_label ? { dimension_label: r.dimension_label } : {}),
        ...(r.allowed_values ? { allowed_values: r.allowed_values } : {}),
        samples: 1
      })
    }
  }
  return [...by.values()].sort((a, b) => b.samples - a.samples)
}

/** A reason in words about the person, not about one record. */
function generalMessage(r: AccessReason): string {
  switch (r.type) {
    case 'permission':
      return 'Their role cannot view these records at all.'
    case 'row_filter':
      return 'A row rule on their role hides these records.'
    case 'scope':
      return `Their ${r.dimension_label ?? 'access'} filter hides these records — they are limited to ${
        (r.allowed_values ?? []).join(', ') || '(none)'
      }.`
    case 'scope_strict':
      return `Their ${r.dimension_label ?? 'access'} filter is strict and these records have no ${
        r.dimension_label ?? 'such'
      } link, so all of them are hidden.`
    default:
      return r.message
  }
}

const FIELDS_REASON =
  'Some of these match only in a field their role cannot read, so their search does not find them by that text.'

export async function whyCantTheyFind(opts: {
  admin: User
  target: User
  targetIsAdmin: boolean
  q: string
  labelsOnly?: boolean
  collections?: string[]
}): Promise<{ totals: WhyAnswer['totals']; collections: WhyRow[] }> {
  const { admin, target, targetIsAdmin, q } = opts
  const labelsOnly = !!opts.labelsOnly
  const all = await allCollections()
  const scope = opts.collections?.length ? all.filter((c) => opts.collections!.includes(c)) : all

  const adminCounts = await countMatches(admin, all, q, scope, labelsOnly)
  const hitCollections = adminCounts.map((r) => r.collection)
  const userCounts = targetIsAdmin
    ? adminCounts
    : hitCollections.length
      ? await countMatches(target, hitCollections, q, hitCollections, labelsOnly)
      : []
  const userBy = new Map(userCounts.map((r) => [r.collection, r.count]))

  const rows: WhyRow[] = []
  for (const a of adminCounts) {
    const userCount = Math.min(a.count, userBy.get(a.collection) ?? 0)
    const row: WhyRow = {
      collection: a.collection,
      display_name: a.display_name,
      admin_count: a.count,
      user_count: userCount,
      hidden: Math.max(0, a.count - userCount),
      reasons: [],
      samples: []
    }
    if (row.hidden > 0 && !targetIsAdmin) await explainRow(row, admin, target, q, labelsOnly)
    rows.push(row)
  }
  rows.sort((x, y) => y.hidden - x.hidden || y.admin_count - x.admin_count)
  const sum = (f: (r: WhyRow) => number) => rows.reduce((n, r) => n + f(r), 0)
  return {
    totals: {
      admin: sum((r) => r.admin_count),
      user: sum((r) => r.user_count),
      hidden: sum((r) => r.hidden)
    },
    collections: rows
  }
}

async function explainRow(
  row: WhyRow,
  admin: User,
  target: User,
  q: string,
  labelsOnly: boolean
): Promise<void> {
  const c = row.collection
  if (!(await can(target, 'read', c).catch(() => false))) {
    row.reasons = [
      {
        type: 'permission',
        message: 'Their role cannot view these records at all.',
        samples: 0
      }
    ]
    return
  }
  const page = await searchCollectionPage(admin, [c], q, c, 0, SAMPLE_SCAN, labelsOnly).catch(
    () => ({ data: [] as Array<{ id: unknown; label: string }>, total: 0 })
  )
  const labelOf = new Map(page.data.map((h) => [String(h.id), h.label]))
  const ids = [...labelOf.keys()]
  if (ids.length === 0) return
  const gates = await compileAccessGates(target, c, { actingAdmin: false })
  const visible = await visibleIds(gates, ids)
  const gateHidden = ids.filter((id) => !visible.has(id))
  const explained = await explainIds(gates, gateHidden.slice(0, SAMPLES_EXPLAINED))
  row.samples = gateHidden.slice(0, SAMPLES_EXPLAINED).map((id) => ({
    id,
    label: labelOf.get(id) ?? id,
    reasons: explained.get(id) ?? []
  }))
  row.reasons = summarizeReasons(row.samples)

  // Rows the gates let through that their search still misses matched only in
  // a field they cannot read. Exact when their whole match list fits one page;
  // otherwise inferred when no sampled match was hidden by the gates at all.
  const passed = ids.filter((id) => visible.has(id))
  let fieldMisses = 0
  if (passed.length > 0) {
    const theirs = await searchCollectionPage(target, [c], q, c, 0, SAMPLE_SCAN, labelsOnly).catch(
      () => null
    )
    if (theirs && (theirs.total ?? Number.POSITIVE_INFINITY) <= SAMPLE_SCAN) {
      const found = new Set(theirs.data.map((h) => String(h.id)))
      fieldMisses = passed.filter((id) => !found.has(id)).length
    } else if (gateHidden.length === 0) {
      fieldMisses = row.hidden
    }
  }
  if (fieldMisses > 0) row.reasons.push({ type: 'fields', message: FIELDS_REASON, samples: 0 })
  if (row.reasons.length === 0)
    row.reasons.push({
      type: 'unknown',
      message:
        'The sampled matches are visible to them; the rest are further down the list. Open one with "Explain as user" on the record page to check it.',
      samples: 0
    })
}

export async function globalSearchWhyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/why', { preHandler: requireAdmin }, async (req, reply) => {
    const query = req.query as {
      q?: string
      user_id?: string
      collection?: string
      labels?: string
    }
    const q = (query.q ?? '').trim()
    if (q.length < 2 || q.length > 200)
      return reply.code(400).send({ error: 'Type 2 to 200 characters to search for' })
    const target = query.user_id ? await getUser(String(query.user_id)) : undefined
    if (!target) return reply.code(404).send({ error: 'User not found' })
    const collections = (query.collection ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => IDENT_RE.test(c))
      .slice(0, 40)
    const labelsOnly = query.labels === '1' || query.labels === 'true'
    const admin = req.user as User
    const targetIsAdmin = await isAdminRole(target).catch(() => false)
    const role = target.role
      ? ((await db('nivaro_roles').where({ id: target.role }).first('name')) as
          | { name?: string }
          | undefined)
      : undefined
    const t = target
    const name = `${t.first_name ?? ''} ${t.last_name ?? ''}`.trim() || t.email || String(t.id)
    // Two counts per collection over contains-LIKEs, then a few gate reads: one slot.
    const result = await withReadGate(
      String(admin.id),
      () => whyCantTheyFind({ admin, target, targetIsAdmin, q, labelsOnly, collections }),
      { label: 'global-search:why' }
    )
    const data: WhyAnswer = {
      q,
      labels_only: labelsOnly,
      user: {
        id: String(t.id),
        name,
        email: t.email ?? null,
        status: t.status ?? null,
        role_name: role?.name ?? null,
        is_admin: targetIsAdmin
      },
      ...result
    }
    return reply.send({ data })
  })
}
