import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { selectInChunks } from './db-batch.js'

/**
 * Who a person id in the activity log IS, when the plain directory name is not enough — so
 * no list ever says a bare "Someone":
 *
 *   person       a named account                          → its name
 *   deleted      no nivaro_users row any more              → "<name> (deleted user)" from the
 *                (hard-deleted; its entries stay)            account's newest revision snapshot
 *                                                            (administrators), else "Deleted user"
 *   redacted     retention redacted it                     → "Redacted person" (never a name)
 *   placeholder  account_kind placeholder                  → "<name> (placeholder)"
 *   machine      account_kind integration | bot | service  → its name, else "Service account"
 *   unnamed      a row with no name and no email           → "Account with no name"
 *
 * Ids compare case-insensitively (SQL Server hands uniqueidentifiers back upper case; revision
 * items were stored either way). Read-only; one query per 500 ids, plus one for missing ones.
 */

export type PersonKind = 'person' | 'deleted' | 'redacted' | 'placeholder' | 'machine' | 'unnamed'

export interface PersonName {
  id: string
  /** The name we can show (null = only the kind label). */
  name: string | null
  kind: PersonKind
  /** account_kind of a machine account (integration | bot | service). */
  machine?: string
}

const MACHINE_WORD: Record<string, string> = {
  integration: 'Integration account',
  bot: 'Bot account',
  service: 'Service account'
}

/** The words a list shows for a person. Pure. */
export function personLabel(p: PersonName, opts: { revealDeletedName: boolean }): string {
  switch (p.kind) {
    case 'person':
      return p.name ?? 'Account with no name'
    case 'deleted':
      return opts.revealDeletedName && p.name ? `${p.name} (deleted user)` : 'Deleted user'
    case 'redacted':
      return 'Redacted person'
    case 'placeholder':
      return p.name ? `${p.name} (placeholder)` : 'Placeholder account'
    case 'machine':
      return p.name ?? MACHINE_WORD[p.machine ?? ''] ?? 'Service account'
    case 'unnamed':
      return 'Account with no name'
  }
}

/** The kind of a directory row (pure; exported for tests). */
export function kindOfRow(row: {
  first_name?: unknown
  last_name?: unknown
  email?: unknown
  is_redacted?: unknown
  account_kind?: unknown
}): PersonName['kind'] {
  if (row.is_redacted === true || row.is_redacted === 1) return 'redacted'
  const kind = typeof row.account_kind === 'string' ? row.account_kind : ''
  if (kind === 'placeholder') return 'placeholder'
  if (kind) return 'machine'
  if (!nameOf(row) && !row.email) return 'unnamed'
  return 'person'
}

function nameOf(row: { first_name?: unknown; last_name?: unknown }): string {
  return [row.first_name, row.last_name]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(' ')
}

function parse(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    const d = JSON.parse(v)
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** id (upper case) → who it is. */
export async function resolvePeople(ids: string[]): Promise<Map<string, PersonName>> {
  const out = new Map<string, PersonName>()
  const want = [...new Set(ids.map((i) => String(i ?? '').trim()).filter(Boolean))]
  if (want.length === 0) return out
  const withKind = await hasColumn('nivaro_users', 'account_kind').catch(() => false)
  const rows = (await selectInChunks(want, 500, (chunk) =>
    Promise.resolve(
      db('nivaro_users')
        .whereIn('id', chunk)
        .select(
          'id',
          'first_name',
          'last_name',
          'email',
          'is_redacted',
          ...(withKind ? ['account_kind'] : [])
        )
    )
  )) as Array<Record<string, unknown>>
  for (const r of rows) {
    const id = String(r.id).toUpperCase()
    const kind = kindOfRow(r)
    const name = kind === 'redacted' ? null : nameOf(r) || (r.email ? String(r.email) : '') || null
    out.set(id, {
      id,
      name,
      kind,
      ...(kind === 'machine' ? { machine: String(r.account_kind) } : {})
    })
  }
  const missing = want.filter((i) => !out.has(i.toUpperCase()))
  if (missing.length) {
    // Revision items were stored in either case: ask for both spellings.
    const spellings = [...new Set(missing.flatMap((i) => [i.toUpperCase(), i.toLowerCase()]))]
    const snaps = (await selectInChunks(spellings, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_revisions')
          .where('collection', 'nivaro_users')
          .whereIn('item', chunk)
          .orderBy('id', 'desc')
          .select('item', 'data')
      )
    ).catch(() => [])) as Array<{ item: string; data: unknown }>
    const newest = new Map<string, Record<string, unknown>>()
    for (const s of snaps) {
      const key = String(s.item).toUpperCase()
      if (newest.has(key)) continue
      const d = parse(s.data)
      if (d) newest.set(key, d)
    }
    for (const i of missing) {
      const id = i.toUpperCase()
      const snap = newest.get(id)
      const redacted = snap && (snap.is_redacted === true || snap.is_redacted === 1)
      const name = snap && !redacted ? nameOf(snap) || (snap.email ? String(snap.email) : '') : ''
      out.set(id, { id, name: name || null, kind: redacted ? 'redacted' : 'deleted' })
    }
  }
  return out
}

/** id (upper case) → label, for the lists that only need words. */
export async function personLabels(
  ids: string[],
  opts: { revealDeletedName: boolean }
): Promise<Map<string, string>> {
  const people = await resolvePeople(ids)
  return new Map([...people].map(([id, p]) => [id, personLabel(p, opts)]))
}
