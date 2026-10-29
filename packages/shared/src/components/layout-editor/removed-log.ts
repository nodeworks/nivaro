import { useCallback, useMemo, useRef, useState } from 'react'
import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { fieldSpot } from './add-target'
import { sectionLabel } from './canvas-diff'
import type { DesignTarget } from './design-context'
import { placementPatchOf } from './inspector/model'
import { type Piece, restorePieceOps } from './restore-piece'
import { slotName } from './slot-names'
import { checked, refuse, type StructurePlan } from './structure-ops'
import type { ApplyOptions, LayoutDraft } from './useLayoutDraft'

/**
 * Recently removed (#3191): every field, panel and section taken off the form
 * in this editing session — the inspector's Remove, the trash zone, the
 * command bar, a join or unwrap — kept with the form as it was just before,
 * so the Add panel can put each back where it was in one click (restore-piece
 * against that snapshot: its settings, its section, its place). An entry
 * shows only while the thing is off the form, so Undo hides it and Redo
 * brings it back.
 */

export interface RemovedEntry {
  id: string
  piece: Piece
  /** The field's or section's label. */
  label: string
  /** "in Shipping", "section · 4 fields". */
  where: string
  /** The change that removed it ("Move Status to the trash"). */
  how: string
  /** The form just before the removal. */
  before: LayoutBundle
  at: number
}

export const REMOVED_KEEP = 25

let seq = 0

/**
 * What a batch takes off the form: placements gone from their section and
 * sections gone, each named once (a section's own fields and tabs ride with it).
 */
export function removalsIn(
  before: LayoutBundle,
  ops: LayoutOp[],
  how: string,
  fieldLabel: (field: string) => string = titleCase
): RemovedEntry[] {
  let after: LayoutBundle
  try {
    after = applyLayoutOps(before, ops)
  } catch {
    return []
  }
  const goneGroups = new Set<string>()
  for (const op of ops)
    if (
      op.op === 'group_remove' &&
      op.key !== UNGROUPED_KEY &&
      !after.groups.some((g) => g.key === op.key)
    )
      goneGroups.add(op.key)
  const placedAgain = new Set(ops.flatMap((op) => (op.op === 'place' ? [op.field] : [])))
  const out: RemovedEntry[] = []
  const now = Date.now()
  const under = (key: string | null): boolean => {
    let k = key
    while (k) {
      if (goneGroups.has(k)) return true
      k = before.groups.find((g) => g.key === k)?.parent_key ?? null
    }
    return false
  }
  for (const key of goneGroups) {
    const g = before.groups.find((x) => x.key === key)
    if (!g || under(g.parent_key)) continue
    const n = before.placements.filter((p) => p.group_key === key).length
    out.push({
      id: `r${++seq}`,
      piece: { kind: 'group', key },
      label: g.label || titleCase(g.key),
      where: n ? `section · ${n} ${n === 1 ? 'field' : 'fields'}` : 'section',
      how,
      before,
      at: now
    })
  }
  for (const op of ops) {
    if (op.op !== 'remove') continue
    const gk = op.at.group_key ?? null
    if (under(gk) || placedAgain.has(op.at.field)) continue
    if (after.placements.some((p) => p.field === op.at.field && p.group_key === gk)) continue
    if (!before.placements.some((p) => p.field === op.at.field && p.group_key === gk)) continue
    out.push({
      id: `r${++seq}`,
      piece: { kind: 'field', field: op.at.field, group_key: gk },
      label: op.at.field.startsWith('__') ? slotName(op.at.field) : fieldLabel(op.at.field),
      where:
        gk === HEADER_GROUP_KEY ? 'in the header strip' : `in ${sectionLabel(before.groups, gk)}`,
      how,
      before,
      at: now
    })
  }
  return out
}

/** Is the removed thing still off the form? */
export function stillRemoved(bundle: LayoutBundle, e: RemovedEntry): boolean {
  if (e.piece.kind === 'group') {
    const key = e.piece.key
    return !bundle.groups.some((g) => g.key === key)
  }
  const { field, group_key } = e.piece
  return !bundle.placements.some((p) => p.field === field && p.group_key === group_key)
}

/**
 * Put it back: restore-piece from the snapshot taken before it went. A field
 * whose section has gone since lands after the selection instead, with its
 * settings.
 */
export function putBackPlan(
  bundle: LayoutBundle,
  e: RemovedEntry,
  selected: DesignTarget | null
): StructurePlan {
  if (!stillRemoved(bundle, e)) return refuse(`${e.label} is already on the form`)
  try {
    const ops = restorePieceOps(bundle, e.before, e.piece)
    return checked(bundle, {
      ok: true,
      ops,
      label: `Put back ${e.label}`,
      notes: [],
      select:
        e.piece.kind === 'group'
          ? { kind: 'group', key: e.piece.key }
          : e.piece.group_key === HEADER_GROUP_KEY
            ? { kind: 'header', field: e.piece.field }
            : {
                kind: e.piece.field.startsWith('__') ? 'slot' : 'field',
                field: e.piece.field,
                group_key: e.piece.group_key
              }
    })
  } catch (err) {
    if (e.piece.kind === 'group') return refuse((err as Error).message)
    const { field, group_key } = e.piece
    const row = e.before.placements.find((p) => p.field === field && p.group_key === group_key)
    const spot = fieldSpot(bundle, selected, group_key === HEADER_GROUP_KEY ? 'header' : 'form')
    if (bundle.placements.some((p) => p.field === field && p.group_key === spot.group_key))
      return refuse(
        `Its section is gone and ${e.label} is already in ${sectionLabel(bundle.groups, spot.group_key)}`
      )
    return checked(bundle, {
      ok: true,
      ops: [
        {
          op: 'place',
          field,
          group_key: spot.group_key,
          index: spot.index,
          ...(row ? { patch: placementPatchOf(row) } : {})
        }
      ],
      label: `Put back ${e.label}`,
      notes: [`Its section is gone: it goes in ${sectionLabel(bundle.groups, spot.group_key)}`],
      select:
        spot.group_key === HEADER_GROUP_KEY
          ? { kind: 'header', field }
          : { kind: 'field', field, group_key: spot.group_key }
    })
  }
}

export interface RemovalLog {
  /** What is off the form now, newest first. */
  entries: RemovedEntry[]
  forget(id: string): void
}

/**
 * Wraps the draft: every apply is read for removals (against the bundle it
 * lands on), kept per layout for this editing session. The draft itself is
 * untouched.
 */
export function useRemovalLog(
  draft: LayoutDraft,
  layoutId: number,
  fieldLabel?: (field: string) => string
): { draft: LayoutDraft; removed: RemovalLog } {
  const [byLayout, setByLayout] = useState<Record<number, RemovedEntry[]>>({})
  // The bundle the next apply lands on (several can run before the next render).
  const liveRef = useRef<LayoutBundle | null>(draft.bundle)
  const seen = useRef<LayoutBundle | null>(draft.bundle)
  if (seen.current !== draft.bundle) {
    seen.current = draft.bundle
    liveRef.current = draft.bundle
  }
  const rawRef = useRef(draft)
  rawRef.current = draft
  const labelRef = useRef(fieldLabel)
  labelRef.current = fieldLabel
  const idRef = useRef(layoutId)
  idRef.current = layoutId

  const apply = useCallback((ops: LayoutOp[], opts?: ApplyOptions) => {
    const before = liveRef.current
    if (before && ops.some((op) => op.op === 'remove' || op.op === 'group_remove')) {
      const found = removalsIn(before, ops, opts?.label ?? 'Removed', labelRef.current)
      if (found.length) {
        const id = idRef.current
        setByLayout((m) => ({
          ...m,
          [id]: [...found.reverse(), ...(m[id] ?? [])].slice(0, REMOVED_KEEP)
        }))
      }
    }
    if (before) {
      try {
        liveRef.current = applyLayoutOps(before, ops)
      } catch {
        // The engine refuses it too; nothing changed.
      }
    }
    rawRef.current.apply(ops, opts)
  }, [])

  const forget = useCallback((id: string) => {
    const lid = idRef.current
    setByLayout((m) => ({ ...m, [lid]: (m[lid] ?? []).filter((e) => e.id !== id) }))
  }, [])

  const all = byLayout[layoutId]
  const bundle = draft.bundle
  const entries = useMemo(() => {
    if (!bundle || !all) return []
    // One row per piece: the newest removal of it.
    const seenKeys = new Set<string>()
    return all.filter((e) => {
      const k =
        e.piece.kind === 'group'
          ? `g:${e.piece.key}`
          : `f:${e.piece.field}:${e.piece.group_key ?? ''}`
      if (seenKeys.has(k)) return false
      seenKeys.add(k)
      return stillRemoved(bundle, e)
    })
  }, [all, bundle])

  const wrapped = useMemo<LayoutDraft>(() => ({ ...draft, apply }), [draft, apply])
  const removed = useMemo<RemovalLog>(() => ({ entries, forget }), [entries, forget])
  return { draft: wrapped, removed }
}
