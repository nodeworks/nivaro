/**
 * The layout editor's draft: every surface edits a layout through `apply(ops)`.
 *
 * - Optimistic: the draft is the last server bundle with every unsent batch
 *   folded on top (the shared ops twin, so it matches what the API writes).
 * - One request at a time, each against the latest `rev`
 *   (POST /collection-layouts/:id/ops). A 409 means someone else saved: the
 *   draft is replaced by the server's bundle, pending work and the undo
 *   history are dropped. Any other failure rolls back that batch only.
 * - Text edits (`apply(ops, { label, text: true })`) wait for a 600 ms pause
 *   per (target, setting) and go out as one op; the draft shows each keystroke.
 *   A structural op, undo or redo sends pending text first, so order holds.
 * - Undo: one batch = one step. Its inverse is computed from the bundle just
 *   before the batch (inverseOps) and sent as a new batch. Every op has an
 *   exact inverse expressed in ops — none needs a snapshot restore:
 *   group_remove expands to group_create + group_move (its tabs) + move/place
 *   (its fields, with their full settings).
 * - A refetch never replaces the draft while anything is pending or typed.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  PLACEMENT_PATCH_KEYS,
  type PlacementKey,
  type PlacementPatch,
  type PlacementRow
} from '../../lib/layout-ops'

export type DraftStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

export interface ApplyOptions {
  label: string
  /** Typing: coalesced per (target, setting) and sent after a 600 ms pause. */
  text?: boolean
}

export interface LayoutDraft {
  bundle: LayoutBundle | null
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  status: DraftStatus
  error: string | null
  /** Label of the step undo / redo would reverse ("Move Status"), for the buttons' tips. */
  undoLabel: string | null
  redoLabel: string | null
  isLoading: boolean
}

export const layoutDraftKeys = {
  bundle: (layoutId: number) => ['layout-editor', 'bundle', layoutId] as const
}

export const TEXT_DEBOUNCE_MS = 600
export const CONFLICT_MESSAGE = 'Someone else changed this layout — reloaded'
const UNDO_LIMIT = 100

// ── Response parsing (the one place that knows the endpoint envelopes) ──────

/** GET /:id/bundle and POST /:id/ops answer a bare LayoutBundle; accept `{ data }` too. */
export function parseBundle(res: unknown): LayoutBundle | null {
  const isBundle = (x: unknown): x is LayoutBundle =>
    !!x &&
    typeof x === 'object' &&
    Array.isArray((x as LayoutBundle).groups) &&
    Array.isArray((x as LayoutBundle).placements) &&
    typeof (x as LayoutBundle).rev === 'string'
  if (isBundle(res)) return res
  const data = (res as { data?: unknown } | null)?.data
  return isBundle(data) ? data : null
}

export interface SaveFailure {
  status: number | null
  message: string
  /** On 409: the stored layout as it is now. */
  bundle: LayoutBundle | null
}

/** SDK errors carry `status` + `response` (body); axios nests `response.status` / `response.data`. */
export function parseSaveFailure(err: unknown): SaveFailure {
  const e = err as {
    status?: number
    message?: string
    response?: { status?: number; data?: unknown } & Record<string, unknown>
  }
  const status = e?.status ?? e?.response?.status ?? null
  const body = (e?.response?.data ?? e?.response) as
    | { error?: unknown; message?: unknown; bundle?: unknown }
    | undefined
  const message =
    (typeof body?.error === 'string' && body.error) ||
    (typeof body?.message === 'string' && body.message) ||
    (typeof e?.message === 'string' && e.message) ||
    'The layout could not be saved'
  return { status, message, bundle: parseBundle(body?.bundle) }
}

// ── Inverse ops ─────────────────────────────────────────────────────────────

// Renumbered copy: afterwards every row's `sort` is its index in its container.
const normalize = (b: LayoutBundle) => applyLayoutOps(b, [{ op: 'layout_update', patch: {} }])

const findRow = (b: LayoutBundle, at: PlacementKey) =>
  b.placements.find((p) => p.field === at.field && p.group_key === (at.group_key ?? null))

function placementPatch(row: PlacementRow): PlacementPatch {
  const patch: Record<string, unknown> = {}
  for (const k of PLACEMENT_PATCH_KEYS) patch[k] = row[k]
  return patch as PlacementPatch
}

function groupPatch(row: GroupRow): GroupPatch {
  const patch: Record<string, unknown> = {}
  for (const k of GROUP_PATCH_KEYS) patch[k] = row[k]
  return patch as GroupPatch
}

function previous(source: Record<string, unknown>, patch: object): Record<string, unknown> {
  const prev: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) prev[k] = source[k] === undefined ? null : source[k]
  return prev
}

/** The ops that undo one op, given the (normalized) bundle it applies to. */
function inverseOne(b: LayoutBundle, op: LayoutOp): LayoutOp[] {
  switch (op.op) {
    case 'place':
      return [{ op: 'remove', at: { field: op.field, group_key: op.group_key ?? null } }]
    case 'move': {
      const row = findRow(b, op.from)
      if (!row) return []
      return [
        {
          op: 'move',
          from: { field: row.field, group_key: op.to_group_key ?? null },
          to_group_key: row.group_key,
          index: row.sort
        }
      ]
    }
    case 'update_placement': {
      const row = findRow(b, op.at)
      if (!row) return []
      return [
        {
          op: 'update_placement',
          at: op.at,
          patch: previous(row as unknown as Record<string, unknown>, op.patch ?? {})
        }
      ]
    }
    case 'remove': {
      const row = findRow(b, op.at)
      if (!row) return []
      return [
        {
          op: 'place',
          field: row.field,
          group_key: row.group_key,
          index: row.sort,
          patch: placementPatch(row)
        }
      ]
    }
    case 'group_create':
      return [{ op: 'group_remove', key: op.key, placements: 'delete' }]
    case 'group_update': {
      const g = b.groups.find((x) => x.key === op.key)
      if (!g) return []
      return [
        {
          op: 'group_update',
          key: op.key,
          patch: previous(g as unknown as Record<string, unknown>, op.patch ?? {}) as GroupPatch
        }
      ]
    }
    case 'group_move': {
      const g = b.groups.find((x) => x.key === op.key)
      if (g) return [{ op: 'group_move', key: op.key, parent_key: g.parent_key, index: g.sort }]
      const slot = b.placements.find((p) => p.field === op.key && isCanvasSlot(p))
      return slot ? [{ op: 'group_move', key: op.key, parent_key: null, index: slot.sort }] : []
    }
    case 'group_remove': {
      const g = b.groups.find((x) => x.key === op.key)
      if (!g) return []
      const out: LayoutOp[] = [
        {
          op: 'group_create',
          key: g.key,
          label: g.label,
          group_type: g.type,
          parent_key: g.parent_key,
          index: g.sort,
          patch: groupPatch(g)
        }
      ]
      // Its tabs went to its place in the parent; bring them back in order.
      const tabs = b.groups.filter((x) => x.parent_key === g.key).sort((x, y) => x.sort - y.sort)
      tabs.forEach((t, i) => {
        out.push({ op: 'group_move', key: t.key, parent_key: g.key, index: i })
      })
      const fields = b.placements
        .filter((p) => p.group_key === g.key)
        .sort((x, y) => x.sort - y.sort)
      fields.forEach((p, i) => {
        // 'ungroup' moved a field to Ungrouped unless it was already there
        // (that duplicate was dropped); 'delete' dropped them all.
        const moved =
          op.placements === 'ungroup' &&
          !b.placements.some((x) => x.field === p.field && x.group_key === null)
        out.push(
          moved
            ? {
                op: 'move',
                from: { field: p.field, group_key: null },
                to_group_key: g.key,
                index: i
              }
            : { op: 'place', field: p.field, group_key: g.key, index: i, patch: placementPatch(p) }
        )
      })
      return out
    }
    case 'layout_update':
      return [{ op: 'layout_update', patch: previous(b.layout, op.patch ?? {}) }]
    default:
      return []
  }
}

/** Ops that turn applyLayoutOps(bundle, ops) back into bundle (row ids aside). */
export function inverseOps(bundle: LayoutBundle, ops: LayoutOp[]): LayoutOp[] {
  let b = normalize(bundle)
  let inverse: LayoutOp[] = []
  for (const op of ops) {
    inverse = [...inverseOne(b, op), ...inverse]
    b = applyLayoutOps(b, [op])
  }
  return inverse
}

// ── Draft engine ────────────────────────────────────────────────────────────

type BatchKind = 'do' | 'undo' | 'redo'
interface Batch {
  id: number
  kind: BatchKind
  ops: LayoutOp[]
}
interface Step {
  label: string
  forward: LayoutOp[]
  inverse: LayoutOp[]
  batchId: number
}
interface TextEdit {
  op: LayoutOp
  inverse: LayoutOp
  label: string
  timer: ReturnType<typeof setTimeout>
}

export interface DraftTransport {
  send(ops: LayoutOp[], baseRev: string): Promise<LayoutBundle>
  /** A bundle the server confirmed — mirror it into the query cache. */
  saved(bundle: LayoutBundle): void
  /** A 409 without a usable bundle: fetch the layout again. */
  reload(): void
  notify(message: string): void
}

type View = Omit<LayoutDraft, 'apply' | 'undo' | 'redo' | 'isLoading'>

/** Split a text apply into single-setting update ops keyed by (target, setting). */
function textEdits(ops: LayoutOp[]): Array<{ key: string; op: LayoutOp }> | null {
  const out: Array<{ key: string; op: LayoutOp }> = []
  for (const op of ops) {
    if (op.op === 'update_placement') {
      for (const [k, v] of Object.entries(op.patch ?? {}))
        out.push({
          key: `p\u0000${op.at.field}\u0000${op.at.group_key ?? ''}\u0000${k}`,
          op: { op: 'update_placement', at: op.at, patch: { [k]: v } }
        })
    } else if (op.op === 'group_update') {
      for (const [k, v] of Object.entries(op.patch ?? {}))
        out.push({
          key: `g\u0000${op.key}\u0000${k}`,
          op: { op: 'group_update', key: op.key, patch: { [k]: v } }
        })
    } else if (op.op === 'layout_update') {
      for (const [k, v] of Object.entries(op.patch ?? {}))
        out.push({ key: `l\u0000${k}`, op: { op: 'layout_update', patch: { [k]: v } } })
    } else return null
  }
  return out
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class LayoutDraftEngine {
  private server: LayoutBundle | null = null
  private draft: LayoutBundle | null = null
  private queue: Batch[] = []
  private inFlight = false
  private text = new Map<string, TextEdit>()
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private outcome: 'idle' | 'saved' | 'error' | 'conflict' = 'idle'
  private error: string | null = null
  private nextId = 1
  private listeners = new Set<() => void>()
  private view: View

  constructor(private transport: DraftTransport) {
    this.view = this.buildView()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getView = (): View => this.view

  /** A fetched bundle. Ignored while anything is pending, so typing is never overwritten. */
  receive(bundle: LayoutBundle) {
    if (this.pending()) return
    if (this.server && this.server.rev === bundle.rev) return
    this.server = bundle
    this.draft = bundle
    this.emit()
  }

  apply(ops: LayoutOp[], opts?: ApplyOptions) {
    if (!this.draft || ops.length === 0) return
    const label = opts?.label ?? 'Edit'
    const edits = opts?.text ? textEdits(ops) : null
    if (edits) return this.applyText(edits, label)

    this.flushText()
    const pre = this.draft
    let inverse: LayoutOp[]
    try {
      applyLayoutOps(pre, ops)
      inverse = inverseOps(pre, ops)
    } catch (e) {
      this.fail(messageOf(e))
      return
    }
    this.clearOutcome()
    const batch = this.enqueue('do', ops)
    this.pushUndo({ label, forward: ops, inverse, batchId: batch.id })
    this.redoStack = []
    this.refresh()
  }

  undo() {
    this.flushText()
    const step = this.undoStack.pop()
    if (!step || !this.draft) return
    try {
      applyLayoutOps(this.draft, step.inverse)
    } catch (e) {
      this.fail(`Could not undo: ${messageOf(e)}`)
      return
    }
    this.clearOutcome()
    step.batchId = this.enqueue('undo', step.inverse).id
    this.redoStack.push(step)
    this.refresh()
  }

  redo() {
    this.flushText()
    const step = this.redoStack.pop()
    if (!step || !this.draft) return
    try {
      applyLayoutOps(this.draft, step.forward)
      step.inverse = inverseOps(this.draft, step.forward)
    } catch (e) {
      this.fail(`Could not redo: ${messageOf(e)}`)
      return
    }
    this.clearOutcome()
    step.batchId = this.enqueue('redo', step.forward).id
    this.undoStack.push(step)
    this.refresh()
  }

  /** Send every pending text edit now (blur, unmount, before another op). */
  flushText() {
    for (const key of [...this.text.keys()]) this.flushTextKey(key)
  }

  private applyText(edits: Array<{ key: string; op: LayoutOp }>, label: string) {
    const draft = this.draft as LayoutBundle
    try {
      applyLayoutOps(
        draft,
        edits.map((e) => e.op)
      )
    } catch (e) {
      this.fail(messageOf(e))
      return
    }
    this.clearOutcome()
    for (const { key, op } of edits) {
      const existing = this.text.get(key)
      if (existing) clearTimeout(existing.timer)
      const timer = setTimeout(() => this.flushTextKey(key), TEXT_DEBOUNCE_MS)
      // The undo value is the one before the first keystroke of this burst.
      const inverse = existing?.inverse ?? inverseOps(draft, [op])[0]
      this.text.set(key, { op, inverse, label, timer })
    }
    this.redoStack = []
    this.refresh()
  }

  private flushTextKey(key: string) {
    const edit = this.text.get(key)
    if (!edit) return
    clearTimeout(edit.timer)
    this.text.delete(key)
    const batch = this.enqueue('do', [edit.op])
    this.pushUndo({
      label: edit.label,
      forward: [edit.op],
      inverse: edit.inverse ? [edit.inverse] : [],
      batchId: batch.id
    })
    this.refresh()
  }

  dispose() {
    this.flushText()
    this.listeners.clear()
  }

  private enqueue(kind: BatchKind, ops: LayoutOp[]): Batch {
    const batch = { id: this.nextId++, kind, ops }
    this.queue.push(batch)
    return batch
  }

  private pushUndo(step: Step) {
    this.undoStack.push(step)
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()
  }

  private pending() {
    return this.inFlight || this.queue.length > 0 || this.text.size > 0
  }

  private clearOutcome() {
    this.error = null
    if (this.outcome === 'error' || this.outcome === 'conflict') this.outcome = 'idle'
  }

  private fail(message: string) {
    this.error = message
    this.outcome = 'error'
    this.emit()
  }

  /** A batch the server refused: forget its step (or hand an undo/redo back). */
  private rollback(batch: Batch) {
    const take = (stack: Step[]) => {
      const i = stack.findIndex((s) => s.batchId === batch.id)
      return i < 0 ? null : stack.splice(i, 1)[0]
    }
    if (batch.kind === 'do') take(this.undoStack)
    else if (batch.kind === 'undo') {
      const step = take(this.redoStack)
      if (step) this.undoStack.push(step)
    } else {
      const step = take(this.undoStack)
      if (step) this.redoStack.push(step)
    }
  }

  private conflict(bundle: LayoutBundle | null) {
    for (const t of this.text.values()) clearTimeout(t.timer)
    this.text.clear()
    this.queue = []
    this.undoStack = []
    this.redoStack = []
    if (bundle) {
      this.server = bundle
      this.transport.saved(bundle)
    } else this.transport.reload()
    this.outcome = 'conflict'
    this.error = null
    this.transport.notify(CONFLICT_MESSAGE)
  }

  /** Draft = server bundle + queued batches + typed text; then send the next batch. */
  private refresh() {
    this.recompute()
    this.pump()
    this.emit()
  }

  private recompute() {
    if (!this.server) return
    let b = this.server
    const kept: Batch[] = []
    for (const [i, batch] of this.queue.entries()) {
      try {
        b = applyLayoutOps(b, batch.ops)
        kept.push(batch)
      } catch (e) {
        // In flight: the server decides. Queued: it no longer fits what was saved.
        if (i === 0 && this.inFlight) kept.push(batch)
        else {
          this.rollback(batch)
          this.error = messageOf(e)
          this.outcome = 'error'
        }
      }
    }
    this.queue = kept
    for (const [key, t] of this.text) {
      try {
        b = applyLayoutOps(b, [t.op])
      } catch {
        clearTimeout(t.timer)
        this.text.delete(key)
      }
    }
    this.draft = b
  }

  private pump() {
    if (this.inFlight || !this.server || this.queue.length === 0) return
    const batch = this.queue[0]
    this.inFlight = true
    this.transport
      .send(batch.ops, this.server.rev)
      .then((bundle) => {
        this.server = bundle
        this.queue.shift()
        this.transport.saved(bundle)
        if (this.outcome !== 'error') this.outcome = 'saved'
      })
      .catch((err) => {
        const failure = parseSaveFailure(err)
        if (failure.status === 409) this.conflict(failure.bundle)
        else {
          this.queue.shift()
          this.rollback(batch)
          this.error = failure.message
          this.outcome = 'error'
        }
      })
      .finally(() => {
        this.inFlight = false
        this.refresh()
      })
  }

  private buildView(): View {
    const top = this.undoStack[this.undoStack.length - 1]
    const lastText = [...this.text.values()].pop()
    return {
      bundle: this.draft,
      canUndo: this.undoStack.length > 0 || this.text.size > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: lastText?.label ?? top?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
      status: this.pending() ? 'saving' : this.outcome,
      error: this.error
    }
  }

  private emit() {
    this.view = this.buildView()
    for (const fn of this.listeners) fn()
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLayoutDraft(layoutId: number): LayoutDraft {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const queryKey = layoutDraftKeys.bundle(layoutId)

  const query = useQuery<LayoutBundle>({
    queryKey,
    queryFn: async () => {
      const res = await client.request<unknown>(get(`/collection-layouts/${layoutId}/bundle`))
      const bundle = parseBundle(res)
      if (!bundle) throw new Error('The layout could not be read')
      return bundle
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false
  })

  // Latest client/cache for the engine's transport, without rebuilding the engine.
  const live = useRef({ client, qc })
  live.current = { client, qc }

  const engineRef = useRef<{ id: number; engine: LayoutDraftEngine } | null>(null)
  if (!engineRef.current || engineRef.current.id !== layoutId) {
    engineRef.current?.engine.dispose()
    const key = layoutDraftKeys.bundle(layoutId)
    engineRef.current = {
      id: layoutId,
      engine: new LayoutDraftEngine({
        send: async (ops, baseRev) => {
          const res = await live.current.client.request<unknown>(
            post(`/collection-layouts/${layoutId}/ops`, { ops, base_rev: baseRev })
          )
          const bundle = parseBundle(res)
          if (!bundle) throw new Error('The server answered without the saved layout')
          return bundle
        },
        saved: (bundle) => live.current.qc.setQueryData(key, bundle),
        reload: () => {
          void live.current.qc.invalidateQueries({ queryKey: key })
        },
        notify: (message) => {
          toast.warning(message)
        }
      })
    }
  }
  const engine = engineRef.current.engine

  const view = useSyncExternalStore(engine.subscribe, engine.getView, engine.getView)

  useEffect(() => {
    if (query.data) engine.receive(query.data)
  }, [engine, query.data])

  // Typed text still waiting for its pause goes out when the editor closes.
  useEffect(() => () => engine.flushText(), [engine])

  const apply = useCallback(
    (ops: LayoutOp[], opts?: ApplyOptions) => engine.apply(ops, opts),
    [engine]
  )
  const undo = useCallback(() => engine.undo(), [engine])
  const redo = useCallback(() => engine.redo(), [engine])

  return { ...view, apply, undo, redo, isLoading: query.isLoading }
}
