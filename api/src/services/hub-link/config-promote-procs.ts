import { createHash } from 'node:crypto'
import type { SnapshotRow } from '../config-inventory.js'

/**
 * Hub config promotion — app-managed procedures go through their ONE writer
 * (services/managed-procedures: saveAndDeployManaged / markManagedDropped + deploy), never the
 * row copier: the target gets a new version of its own, its own deploy record (the source's
 * deployed_* columns never travel), and an undo puts the previous body back the same way — a
 * procedure the promotion added is dropped through the managed path (tracked as dropped), so
 * nothing is left deployed but untracked. Matched by name (case-insensitive).
 */

export type ProcOp = 'add' | 'change' | 'drop'

export interface ProcCurrent {
  name: string
  body: string
  body_hash: string
  version: number
  description: string | null
  dropped: boolean
}

export interface ProcPlanItem {
  name: string
  op: ProcOp
  /** The body to save (add / change). */
  body: string | null
  description: string | null
  before: ProcCurrent | null
}

export interface ProcRefusal {
  code: 'PROC_IMPORT_OWNED' | 'ROW_UNMATCHED'
  table: string
  key: string
  label: string | null
  reason: string
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const bodyHash = (s: string) => createHash('sha256').update(norm(s)).digest('hex')

/** Pure: what the source's procedure rows would do here. */
export function planProcs(
  source: Record<string, SnapshotRow>,
  current: ProcCurrent[],
  importOwned: Set<string>,
  deletes: boolean
): { items: ProcPlanItem[]; refusals: ProcRefusal[] } {
  const byName = new Map(current.map((c) => [c.name.toLowerCase(), c]))
  const seen = new Set<string>()
  const items: ProcPlanItem[] = []
  const refusals: ProcRefusal[] = []
  for (const [key, row] of Object.entries(source)) {
    const name = typeof row.data.name === 'string' ? row.data.name.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      refusals.push({
        code: 'ROW_UNMATCHED',
        table: 'nivaro_managed_procedures',
        key,
        label: name || null,
        reason: 'The source procedure has no usable name'
      })
      continue
    }
    const lower = name.toLowerCase()
    seen.add(lower)
    if (importOwned.has(lower)) {
      refusals.push({
        code: 'PROC_IMPORT_OWNED',
        table: 'nivaro_managed_procedures',
        key,
        label: name,
        reason: `${name} is owned by an import definition on the target; its import writes it there`
      })
      continue
    }
    const before = byName.get(lower) ?? null
    const dropped = row.data.dropped_at != null && row.data.dropped_at !== ''
    const body = typeof row.data.body === 'string' ? row.data.body : ''
    const description = typeof row.data.description === 'string' ? row.data.description : null
    if (dropped) {
      if (before && !before.dropped)
        items.push({ name: before.name, op: 'drop', body: null, description: null, before })
      continue
    }
    if (!body.trim()) continue
    if (!before) {
      items.push({ name, op: 'add', body, description, before: null })
      continue
    }
    if (
      before.dropped ||
      bodyHash(before.body) !== bodyHash(body) ||
      (before.description ?? null) !== description
    )
      items.push({ name: before.name, op: 'change', body, description, before })
  }
  if (deletes)
    for (const c of current)
      if (!c.dropped && !seen.has(c.name.toLowerCase()) && !importOwned.has(c.name.toLowerCase()))
        items.push({ name: c.name, op: 'drop', body: null, description: null, before: c })
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { items, refusals }
}

/** Pure: what the plan hash binds (each item and the version it replaces). */
export function procsRef(items: ProcPlanItem[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        items.map((i) => [
          i.name.toLowerCase(),
          i.op,
          i.body == null ? null : bodyHash(i.body),
          i.description,
          i.before ? [i.before.version, i.before.body_hash, i.before.dropped] : null
        ])
      )
    )
    .digest('hex')
}

/** The rows the plan view shows for procedures (bodies capped). */
export function procPreviewTable(items: ProcPlanItem[]) {
  const cap = (s: string | null) => (s == null ? null : s.length > 300 ? `${s.slice(0, 300)}…` : s)
  return {
    table: 'nivaro_managed_procedures',
    inserts: items.filter((i) => i.op === 'add').length,
    updates: items.filter((i) => i.op === 'change').length,
    deletes: items.filter((i) => i.op === 'drop').length,
    unchanged: 0,
    more: 0,
    dropped_columns: [] as string[],
    rows: items.slice(0, 50).map((i) => ({
      key: i.name,
      op: i.op === 'add' ? 'insert' : i.op === 'drop' ? 'delete' : 'update',
      label: i.name,
      fields:
        i.op === 'drop'
          ? [{ field: 'body', now: cap(i.before?.body ?? null), was: null }]
          : [
              {
                field: 'body',
                now: cap(i.before?.dropped ? null : (i.before?.body ?? null)),
                was: cap(i.body)
              }
            ]
    }))
  }
}

/** One procedure as the promotion left it: undo puts `before` back through the same writer. */
export interface ProcDone {
  name: string
  op: ProcOp
  before: ProcCurrent | null
  /** The version the promotion wrote (undo refuses STALE when it moved on). */
  after_version: number | null
  ok: boolean
  reason: string | null
}

export interface ProcWriter {
  current(name: string): Promise<ProcCurrent | null>
  save(name: string, body: string, description: string | null, note: string): Promise<number>
  drop(name: string): Promise<number | null>
}

/** Applies the items in order; one failure never stops the rest (each is reported). */
export async function applyProcs(
  items: ProcPlanItem[],
  w: ProcWriter,
  note: string,
  onEach?: (done: ProcDone[]) => Promise<void>
): Promise<ProcDone[]> {
  const out: ProcDone[] = []
  for (const i of items) {
    try {
      const v =
        i.op === 'drop'
          ? await w.drop(i.name)
          : await w.save(i.name, i.body ?? '', i.description, note)
      out.push({
        name: i.name,
        op: i.op,
        before: i.before,
        after_version: v,
        ok: true,
        reason: null
      })
    } catch (err) {
      out.push({
        name: i.name,
        op: i.op,
        before: i.before,
        after_version: null,
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 300) : 'failed'
      })
    }
    if (onEach) await onEach(out)
  }
  return out
}

/** Undo: STALE names (a procedure changed since) — checked for all before any is written. */
export async function staleProcs(done: ProcDone[], w: ProcWriter): Promise<string[]> {
  const out: string[] = []
  for (const d of done) {
    if (!d.ok) continue
    const c = await w.current(d.name)
    if ((c?.version ?? null) !== d.after_version) out.push(d.name)
  }
  return out
}

/** Undo the procedures a promotion wrote, newest first, through the same writer. */
export async function undoProcs(
  done: ProcDone[],
  w: ProcWriter,
  note: string
): Promise<ProcDone[]> {
  const out: ProcDone[] = []
  for (const d of [...done].reverse()) {
    if (!d.ok) continue
    try {
      let v: number | null
      if (!d.before || d.before.dropped) v = await w.drop(d.name)
      else v = await w.save(d.name, d.before.body, d.before.description, note)
      out.push({ ...d, after_version: v, ok: true, reason: null })
    } catch (err) {
      out.push({
        ...d,
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 300) : 'failed'
      })
    }
  }
  return out
}

/** The managed-procedure writer of this app (services/managed-procedures), lazily imported. */
export function managedWriter(by: string): ProcWriter {
  return {
    async current(name) {
      const { getManagedProcedure } = await import('../managed-procedures/store.js')
      const r = await getManagedProcedure(name)
      return r
        ? {
            name: r.name,
            body: r.body,
            body_hash: r.body_hash,
            version: r.version,
            description: r.description,
            dropped: r.dropped_at != null
          }
        : null
    },
    async save(name, body, description, note) {
      const { saveAndDeployManaged } = await import('../managed-procedures/deploy.js')
      const out = await saveAndDeployManaged({ name, body, note, userId: null, description, by })
      return out.version
    },
    async drop(name) {
      const { getManagedProcedure, markManagedDropped } = await import(
        '../managed-procedures/store.js'
      )
      const { deployManagedProcedure } = await import('../managed-procedures/deploy.js')
      if (!(await getManagedProcedure(name))) return null
      const row = await markManagedDropped(name, null)
      const res = await deployManagedProcedure(name, { by })
      if (res.action === 'failed') throw new Error(res.reason ?? 'The drop failed')
      return row.version
    }
  }
}
