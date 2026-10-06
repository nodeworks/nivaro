import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Inbound mapping versions (#1266, migration 402) — the layout-versions pattern
 * applied to inbound mappings.
 *
 *   - Captured on EVERY save (create, PATCH, fixture add / edit / delete): the
 *     state before the write and the state after it, so a mapping that predates
 *     versioning still gets its pre-edit state recorded. Best-effort — a
 *     snapshot failure never blocks the save it records.
 *   - Content-deduped against the newest version (timestamps dropped from the
 *     hash), so an unchanged re-save mints nothing.
 *   - Pruned to the newest KEEP versions per mapping.
 *   - Restore is ID-PRESERVING: the mapping row keeps its id and every fixture
 *     keeps its own id (they ride inside the JSON). It snapshots "before
 *     restore" first, so a restore can itself be undone.
 *   - A tenant behind migration 402 simply has no versions: every entry point
 *     probes the table first.
 */

const TABLE = 'nivaro_inbound_mapping_versions'
const KEEP = 30

/** The mapping columns a version carries — and a restore writes back. */
export const VERSIONED_COLUMNS = [
  'key',
  'label',
  'collection',
  'mode',
  'upsert_keys',
  'rules',
  'children',
  'fixtures',
  'response_template',
  'response_status',
  'is_active'
] as const

export type MappingSnapshot = { id: number } & Record<string, unknown>

let tableKnown: { at: number; ok: boolean } | null = null
export async function versionsAvailable(): Promise<boolean> {
  if (tableKnown?.ok) return true
  if (tableKnown && Date.now() - tableKnown.at < 60_000) return false
  const ok = await db.schema.hasTable(TABLE).catch(() => false)
  tableKnown = { at: Date.now(), ok }
  return ok
}

/** The versioned part of a mapping row (missing bench columns read null). */
export function snapshotOf(row: Record<string, unknown>): MappingSnapshot {
  const out: MappingSnapshot = { id: Number(row.id) }
  for (const c of VERSIONED_COLUMNS) {
    const v = row[c]
    out[c] = c === 'is_active' ? !!v : (v ?? null)
  }
  return out
}

/** Parse JSON-text columns so the hash and the diff compare values, not spellings. */
function normalized(snap: MappingSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of VERSIONED_COLUMNS) {
    const v = snap[c]
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        out[c] = JSON.parse(v)
        continue
      } catch {
        /* keep the raw text */
      }
    }
    out[c] = v ?? null
  }
  return out
}

export function hashSnapshot(snap: MappingSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(normalized(snap)))
    .digest('hex')
}

/** Capture the mapping's CURRENT state as a version (deduped). Never throws. */
export async function snapshotMappingVersion(
  mappingId: number,
  note: string,
  userId?: string | null
): Promise<number | null> {
  try {
    if (!(await versionsAvailable())) return null
    const row = (await db('nivaro_inbound_mappings').where({ id: mappingId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const snap = snapshotOf(row)
    const hash = hashSnapshot(snap)
    const latest = (await db(TABLE)
      .where({ mapping_id: mappingId })
      .orderBy('version', 'desc')
      .first('version', 'snapshot')) as { version: number; snapshot: string } | undefined
    if (latest) {
      try {
        if (hashSnapshot(JSON.parse(latest.snapshot) as MappingSnapshot) === hash) return null
      } catch {
        /* unparseable newest — capture a fresh one */
      }
    }
    const version = (latest?.version ?? 0) + 1
    await db(TABLE).insert({
      mapping_id: mappingId,
      version,
      snapshot: JSON.stringify(snap),
      note: note.slice(0, 255),
      created_by: userId ?? null,
      created_at: new Date()
    })
    const versions = (await db(TABLE)
      .where({ mapping_id: mappingId })
      .orderBy('version', 'desc')
      .select('id')) as Array<{ id: number }>
    if (versions.length > KEEP) {
      await db(TABLE)
        .whereIn(
          'id',
          versions.slice(KEEP).map((v) => v.id)
        )
        .delete()
    }
    return version
  } catch (err) {
    console.warn(`inbound mapping version snapshot failed for mapping ${mappingId}:`, err)
    return null
  }
}

export interface VersionSummary {
  id: number
  version: number
  note: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: Date | string
}

export async function listMappingVersions(mappingId: number): Promise<VersionSummary[]> {
  if (!(await versionsAvailable())) return []
  const rows = (await db(`${TABLE} as v`)
    .leftJoin('nivaro_users as u', 'u.id', 'v.created_by')
    .where('v.mapping_id', mappingId)
    .orderBy('v.version', 'desc')
    .select(
      'v.id',
      'v.version',
      'v.note',
      'v.created_by',
      'v.created_at',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    version: Number(r.version),
    note: (r.note as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null,
    created_by_name:
      [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.email as string | null) || null,
    created_at: r.created_at as Date
  }))
}

async function loadVersion(mappingId: number, versionId: number) {
  const row = (await db(TABLE).where({ id: versionId, mapping_id: mappingId }).first()) as
    | { id: number; version: number; snapshot: string; note: string | null; created_at: Date }
    | undefined
  if (!row) return null
  return { ...row, snap: JSON.parse(row.snapshot) as MappingSnapshot }
}

// ─── Diff ────────────────────────────────────────────────────────────────────

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}
export interface SetChange {
  added: string[]
  removed: string[]
  changed: Array<{ key: string; fields: string[] }>
}
export interface MappingDiff {
  settings: FieldChange[]
  rules: SetChange
  children: SetChange
  fixtures: SetChange
  response_template: { from: string | null; to: string | null } | null
  response_status: FieldChange[]
  total: number
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const asArray = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v)
    ? (v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>)
    : []

function diffKeyed(
  before: unknown,
  after: unknown,
  keyOf: (r: Record<string, unknown>, i: number) => string
): SetChange {
  const b = new Map(asArray(before).map((r, i) => [keyOf(r, i), r]))
  const a = new Map(asArray(after).map((r, i) => [keyOf(r, i), r]))
  const out: SetChange = { added: [], removed: [], changed: [] }
  for (const k of a.keys()) if (!b.has(k)) out.added.push(k)
  for (const [k, r] of b) {
    const cur = a.get(k)
    if (!cur) {
      out.removed.push(k)
      continue
    }
    const fields = [...new Set([...Object.keys(r), ...Object.keys(cur)])].filter(
      (f) => !same(r[f], cur[f])
    )
    if (fields.length) out.changed.push({ key: k, fields })
  }
  return out
}

const fixtureName = (r: Record<string, unknown>) =>
  `${String(r.name ?? 'Fixture')} (${String(r.id ?? '').slice(0, 8)})`

/** What changed from `before` to `after` — pure, so the route and tests share it. */
export function diffMappingSnapshots(before: MappingSnapshot, after: MappingSnapshot): MappingDiff {
  const b = normalized(before)
  const a = normalized(after)
  const settings: FieldChange[] = []
  for (const f of ['key', 'label', 'collection', 'mode', 'upsert_keys', 'is_active'] as const) {
    if (!same(b[f], a[f])) settings.push({ field: f, from: b[f] ?? null, to: a[f] ?? null })
  }
  const rules = diffKeyed(b.rules, a.rules, (r, i) => String(r.target ?? `#${i + 1}`))
  const children = diffKeyed(b.children, a.children, (r, i) =>
    String(r.target_field ?? `#${i + 1}`)
  )
  // Fixtures are matched by their own id — two fixtures may share a name.
  const fb = new Map(asArray(b.fixtures).map((r) => [String(r.id), r]))
  const fa = new Map(asArray(a.fixtures).map((r) => [String(r.id), r]))
  const fixtures: SetChange = { added: [], removed: [], changed: [] }
  for (const [id, r] of fa) if (!fb.has(id)) fixtures.added.push(fixtureName(r))
  for (const [id, r] of fb) {
    const cur = fa.get(id)
    if (!cur) {
      fixtures.removed.push(fixtureName(r))
      continue
    }
    const fields = ['name', 'payload', 'expect'].filter((f) => !same(r[f], cur[f]))
    if (fields.length) fixtures.changed.push({ key: fixtureName(cur), fields })
  }
  const tb = (b.response_template as string | null) ?? null
  const ta = (a.response_template as string | null) ?? null
  const response_template = tb === ta ? null : { from: tb, to: ta }
  const sb = (b.response_status ?? {}) as Record<string, unknown>
  const sa = (a.response_status ?? {}) as Record<string, unknown>
  const response_status: FieldChange[] = []
  for (const k of [...new Set([...Object.keys(sb), ...Object.keys(sa)])]) {
    if (!same(sb[k], sa[k]))
      response_status.push({ field: k, from: sb[k] ?? null, to: sa[k] ?? null })
  }
  const count = (s: SetChange) => s.added.length + s.removed.length + s.changed.length
  return {
    settings,
    rules,
    children,
    fixtures,
    response_template,
    response_status,
    total:
      settings.length +
      count(rules) +
      count(children) +
      count(fixtures) +
      (response_template ? 1 : 0) +
      response_status.length
  }
}

/**
 * Diff a version against the live mapping ('current') or another version.
 * The FROM side is the older state: version → current reads "what changed
 * since this version".
 */
export async function diffMappingVersion(
  mappingId: number,
  versionId: number,
  against: 'current' | number
): Promise<
  | (MappingDiff & {
      from: { version: number; note: string | null }
      to: { version: number | null; note: string | null }
    })
  | null
> {
  const from = await loadVersion(mappingId, versionId)
  if (!from) return null
  let toSnap: MappingSnapshot
  let to: { version: number | null; note: string | null }
  if (against === 'current') {
    const row = (await db('nivaro_inbound_mappings').where({ id: mappingId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    toSnap = snapshotOf(row)
    to = { version: null, note: 'current' }
  } else {
    const other = await loadVersion(mappingId, against)
    if (!other) return null
    toSnap = other.snap
    to = { version: other.version, note: other.note }
  }
  return {
    ...diffMappingSnapshots(from.snap, toSnap),
    from: { version: from.version, note: from.note },
    to
  }
}

export type RestoreOutcome =
  | { ok: true; version: number }
  | { ok: false; status: number; error: string }

/** Restore a version over the live mapping, id-preserving. */
export async function restoreMappingVersion(
  mappingId: number,
  versionId: number,
  userId?: string | null
): Promise<RestoreOutcome> {
  const v = await loadVersion(mappingId, versionId)
  if (!v) return { ok: false, status: 404, error: 'Version not found' }
  const live = (await db('nivaro_inbound_mappings').where({ id: mappingId }).first('id')) as
    | { id: number }
    | undefined
  if (!live) return { ok: false, status: 404, error: 'Mapping not found' }
  const key = v.snap.key as string | undefined
  if (key) {
    const clash = await db('nivaro_inbound_mappings')
      .where({ key })
      .whereNot({ id: mappingId })
      .first('id')
    if (clash)
      return {
        ok: false,
        status: 409,
        error: `Another mapping now uses the key "${key}" — rename it before restoring this version`
      }
  }
  await snapshotMappingVersion(mappingId, `before restore of v${v.version}`, userId)

  const patch: Record<string, unknown> = {}
  const present = (await db('nivaro_inbound_mappings').columnInfo()) as Record<string, unknown>
  for (const c of VERSIONED_COLUMNS) {
    if (!(c in present)) continue
    patch[c] = c === 'is_active' ? !!v.snap[c] : (v.snap[c] ?? null)
  }
  await db('nivaro_inbound_mappings')
    .where({ id: mappingId })
    .update({ ...patch, updated_at: new Date() })
  await snapshotMappingVersion(mappingId, `restored v${v.version}`, userId)
  return { ok: true, version: v.version }
}

/** The mapping DELETE route calls this first — the FK is NO ACTION. */
export async function deleteMappingVersions(mappingId: number): Promise<void> {
  if (!(await versionsAvailable())) return
  await db(TABLE).where({ mapping_id: mappingId }).delete()
}
