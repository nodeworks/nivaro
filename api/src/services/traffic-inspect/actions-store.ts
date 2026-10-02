// api/src/services/traffic-inspect/actions-store.ts
/**
 * Investigation notebooks (#1212) — reads and writes of nivaro_traffic_investigations
 * (migration 390). Every read is scoped to the caller's map store (#1132), so an investigation
 * only ever opens where it was saved. A database behind 390 answers `ready: false` instead of
 * failing.
 */
import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { currentStoreId } from '../traffic-taps.js'

export const INVESTIGATIONS_TABLE = 'nivaro_traffic_investigations'
const LIST_LIMIT = 30
const PROBE_MISS_MS = 60_000
/** A hit is re-probed too, so a rolled-back table (down(), a pre-390 restore) turns into the designed 503 within minutes rather than raw SQL errors for the life of the process. */
const PROBE_HIT_MS = 5 * 60_000

const ready = new Map<string, { ok: boolean; at: number }>()

/** True once migration 390 has run here (a hit is re-probed after 5 min, a miss after 60 s). */
export async function investigationsReady(): Promise<boolean> {
  const scope = getTenantId() ?? ''
  const hit = ready.get(scope)
  if (hit && Date.now() - hit.at < (hit.ok ? PROBE_HIT_MS : PROBE_MISS_MS)) return hit.ok
  let ok = false
  try {
    ok = await db.schema.hasTable(INVESTIGATIONS_TABLE)
  } catch {
    ok = false
  }
  ready.set(scope, { ok, at: Date.now() })
  return ok
}

export interface InvestigationRecord {
  id: string
  title: string
  stack: string
  notes: string | null
  context: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString()
}

function personName(r: Record<string, unknown>): string | null {
  const full = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()
  if (full) return full
  return typeof r.email === 'string' ? r.email.split('@')[0] : null
}

function toRecord(r: Record<string, unknown>): InvestigationRecord {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    stack: String(r.stack ?? ''),
    notes: typeof r.notes === 'string' ? r.notes : null,
    context: typeof r.context === 'string' ? r.context : null,
    created_by: r.created_by ? String(r.created_by) : null,
    created_by_name: personName(r),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at)
  }
}

const COLS = [
  'i.id',
  'i.title',
  'i.stack',
  'i.notes',
  'i.created_by',
  'i.created_at',
  'i.updated_at',
  'u.first_name',
  'u.last_name',
  'u.email'
]

/** The newest investigations of this store (no context JSON — the list stays small). */
export async function listInvestigations(): Promise<InvestigationRecord[]> {
  const rows = (await db(`${INVESTIGATIONS_TABLE} as i`)
    .leftJoin('nivaro_users as u', 'u.id', 'i.created_by')
    .where('i.store', currentStoreId())
    .orderBy('i.updated_at', 'desc')
    .limit(LIST_LIMIT)
    .select(COLS)) as Array<Record<string, unknown>>
  return rows.map(toRecord)
}

/** One investigation of this store (with its context), or null. `id` must be validated first. */
export async function getInvestigation(id: string): Promise<InvestigationRecord | null> {
  const r = (await db(`${INVESTIGATIONS_TABLE} as i`)
    .leftJoin('nivaro_users as u', 'u.id', 'i.created_by')
    .where('i.id', id)
    .where('i.store', currentStoreId())
    .first([...COLS, 'i.context'])) as Record<string, unknown> | undefined
  return r ? toRecord(r) : null
}

export async function insertInvestigation(row: {
  id: string
  title: string
  stack: string
  notes: string | null
  context: string | null
  created_by: string | null
}): Promise<void> {
  const now = new Date()
  await db(INVESTIGATIONS_TABLE).insert({
    ...row,
    store: currentStoreId(),
    created_at: now,
    updated_at: now
  })
}

export async function updateInvestigation(
  id: string,
  patch: Partial<{ title: string; stack: string; notes: string | null; context: string | null }>
): Promise<void> {
  await db(INVESTIGATIONS_TABLE)
    .where({ id, store: currentStoreId() })
    .update({ ...patch, updated_at: new Date() })
}

export async function deleteInvestigation(id: string): Promise<void> {
  await db(INVESTIGATIONS_TABLE).where({ id, store: currentStoreId() }).del()
}
