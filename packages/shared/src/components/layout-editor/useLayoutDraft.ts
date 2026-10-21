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
 *   A structural op, undo or redo sends pending text first, so order holds;
 *   `flush()` sends it now (blur). Each batch carries its step label as `note`.
 * - Undo: one batch = one step. Its inverse is computed from the bundle just
 *   before the batch (inverseOps) and sent as a new batch. Every op has an
 *   exact inverse expressed in ops — none needs a snapshot restore:
 *   group_remove expands to group_create + group_move (its tabs) + move/place
 *   (its fields, with their full settings).
 * - A refetch never replaces the draft while anything is pending or typed; a
 *   refetched bundle with a new rev (someone else saved) clears undo/redo.
 *
 * Two modes (#2619). Autosave (above) sends every change as it is made.
 * Manual — the default every time the editor opens — holds changes as unsaved
 * steps folded into the draft locally; `save()` sends them all as ONE batch
 * (ops in order, note = their labels). Text folds at once (no pause needed)
 * and a burst in one box stays one step until blur. Unsaved steps undo by
 * popping (no request); undoing a saved step adds its inverse as an unsaved
 * step. A 409 on Save rebases: the unsaved steps are folded onto the fresh
 * bundle and kept for another Save; a step that no longer fits is dropped and
 * listed (`dropped`) for the admin to redo by hand (#2652). Autosave rebases
 * its queue the same way. Undo keeps every kept step, and a saved setting
 * change whose value nobody else touched since.
 */
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  /**
   * false = saved like any other batch but no undo step is pushed and the redo
   * stack is left alone — for changes whose inverse would be wrong (Make default:
   * undoing would leave the kind with no default, not bring the old one back).
   */
  undoable?: boolean
}

/** What a Save carries besides its ops when the layout asks for a change note (#2654). */
export interface SaveMeta {
  reason: string
  ticket?: string | null
}

/** One unsaved change: its label and ops (the unsaved list, crash recovery). */
export interface UnsavedStep {
  label: string
  ops: LayoutOp[]
}

export interface LayoutDraft {
  bundle: LayoutBundle | null
  /** Every change saves as it is made. Off (the default each time the editor opens): Save. */
  autosave: boolean
  /** Turning autosave on with unsaved changes saves them now. */
  setAutosave(on: boolean): void
  /** Changes made since the last Save (manual mode). */
  unsavedCount: number
  /** The unsaved changes as one ops list, in order (what Save would send). */
  unsavedOps(): LayoutOp[]
  /** The unsaved changes as steps, oldest first (#2629). */
  unsavedSteps: UnsavedStep[]
  /** The rev of the layout the unsaved steps sit on (the server's last confirmed bundle). */
  baseRev: string | null
  /** Labels of changes dropped when someone else saved first and they no longer fit (#2652). */
  dropped: string[]
  clearDropped(): void
  /** Re-apply steps (a recovered draft) as unsaved changes; the ones that no longer fit join `dropped`. */
  restore(steps: UnsavedStep[]): number
  /** Send every unsaved change as one batch; resolves once it landed or failed. */
  save(meta?: SaveMeta): Promise<void>
  /** Drop the unsaved changes: back to the last bundle the server confirmed. */
  discard(): void
  /** unsavedCount > 0 */
  dirty: boolean
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  undo(): void
  redo(): void
  /** Send typed text now instead of after the pause (blur). */
  flush(): void
  /**
   * Send typed text now, then resolve once nothing is queued or in flight
   * (saved, failed or conflicted alike). Hosts await it before re-reading
   * what the layout renders, so the refetch cannot beat the last save.
   * Resolves anyway after `timeoutMs` so a hung request never traps a caller.
   */
  whenIdle(timeoutMs?: number): Promise<void>
  canUndo: boolean
  canRedo: boolean
  status: DraftStatus
  error: string | null
  /** Label of the step undo / redo would reverse ("Move Status"), for the buttons' tips. */
  undoLabel: string | null
  redoLabel: string | null
  /**
   * This editing session's steps (#2618): `done` oldest first (what Undo walks back
   * through), `undone` nearest first (what Redo brings back). Lost on a conflict
   * or when someone else saves, like Undo itself.
   */
  session: SessionSteps
  /** Walk the session: -n = Undo n times, +n = Redo n times. */
  jump(delta: number): void
  isLoading: boolean
}

export interface SessionStep {
  label: string
  /** unsaved = waits for Save; saving = on its way; saved = on the server. */
  state: 'unsaved' | 'saving' | 'saved'
}
export interface SessionSteps {
  done: SessionStep[]
  undone: Array<{ label: string }>
}

export const layoutDraftKeys = {
  bundle: (layoutId: number) => ['layout-editor', 'bundle', layoutId] as const,
  versions: (layoutId: number) => ['layout-editor', 'versions', layoutId] as const
}

/**
 * Layout settings the overview (and the editor's layouts rail) reads: a batch
 * that changes none of them leaves every overview row as it was apart from its
 * shape counts, so it need not trigger the overview's references scan.
 */
const OVERVIEW_LAYOUT_KEYS = new Set([
  'name',
  'slug',
  'create_label',
  'create_hidden',
  'sort',
  'is_active',
  'conditions',
  'layout_type',
  'record_conditions',
  'parent_layout_id',
  'tab_mode'
])

/** Does this batch change how the overview describes or resolves layouts? Unknown (null) = yes. */
export function touchesOverview(ops: LayoutOp[] | null): boolean {
  if (!ops) return true
  return ops.some(
    (op) =>
      op.op === 'layout_update' &&
      Object.keys(op.patch ?? {}).some((k) => OVERVIEW_LAYOUT_KEYS.has(k))
  )
}

export const TEXT_DEBOUNCE_MS = 600
export const CONFLICT_MESSAGE = 'Someone else changed this layout — reloaded'
export const rebasedMessage = (n: number) =>
  `Someone else saved — your ${n} ${n === 1 ? 'change was' : 'changes were'} kept on top; Save again`
export const REBASE_FAILED_MESSAGE =
  'Someone else saved this layout and some of your changes no longer fit'
export const replayedMessage = (n: number) =>
  `Someone else saved — your ${n === 1 ? 'change was' : `${n} changes were`} replayed on top of theirs`
export const partlyRebasedMessage = (kept: number, dropped: number) =>
  `Someone else saved — ${kept} of your changes kept, ${dropped} no longer ${dropped === 1 ? 'fits' : 'fit'}: redo ${dropped === 1 ? 'it' : 'them'} by hand`
const NOTE_MAX = 250

/** The ops note of one Save: the step's label, or "3 changes: a, b, c" (truncated). */
export function saveNote(labels: string[]): string {
  if (labels.length === 0) return 'Save'
  if (labels.length === 1) return labels[0].slice(0, NOTE_MAX)
  const s = `${labels.length} changes: ${labels.join(', ')}`
  return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX - 1)}…` : s
}
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

/**
 * The ops refusals name raw keys (`No group "inv_basic"`); the top bar shows a
 * sentence an admin can read instead. Anything unrecognised passes through.
 */
export function humanizeOpError(message: string): string {
  if (/^No group "/.test(message)) return 'That section is no longer on this form'
  if (/^"[^"]*" is not placed in /.test(message)) return 'That field is no longer where it was'
  if (/^"[^"]*" is already in /.test(message)) return 'That field is already there'
  if (/^"[^"]*" is not on this form/.test(message)) return 'That item is no longer on this form'
  if (/^"[^"]*" is not a container/.test(message)) return 'Tabs can only go inside a tab group'
  if (/^"[^"]*" is a reserved name/.test(message)) return 'That name is reserved'
  if (/^A group "[^"]*" already exists/.test(message))
    return 'A section with that key already exists'
  if (/^Unknown setting "/.test(message)) return 'That setting can’t be saved on this form'
  return message
}

/** SDK errors carry `status` + `response` (body); axios nests `response.status` / `response.data`. */
export function parseSaveFailure(
  err: unknown,
  fallback = 'The layout could not be saved'
): SaveFailure {
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
    fallback
  return { status, message: humanizeOpError(message), bundle: parseBundle(body?.bundle) }
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

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const holds = (row: object, patch: object | undefined) =>
  Object.entries(patch ?? {}).every(([k, v]) => sameValue((row as Record<string, unknown>)[k], v))

/**
 * Does `b` still carry exactly what these setting changes set? Then their
 * undo (the previous values, keyed by target) is still exact after someone
 * else saved. Anything index-based (moves, places, removals) never is.
 */
export function stillMine(b: LayoutBundle, forward: LayoutOp[]): boolean {
  if (forward.length === 0) return false
  return forward.every((op) => {
    if (op.op === 'update_placement') {
      const row = findRow(b, op.at)
      return !!row && holds(row, op.patch)
    }
    if (op.op === 'group_update') {
      const g = b.groups.find((x) => x.key === op.key)
      return !!g && holds(g, op.patch)
    }
    if (op.op === 'layout_update') return holds(b.layout, op.patch)
    return false
  })
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

/** 'save' = one manual Save: its `parts` are the unsaved steps it carries. */
type BatchKind = 'do' | 'undo' | 'redo' | 'save'
interface Batch {
  id: number
  kind: BatchKind
  ops: LayoutOp[]
  /** The step's label, sent as the ops `note` (History shows it). */
  note: string
  parts?: Batch[]
  /** Manual-mode text step: the (target, setting) keys it edits, while its burst is open. */
  textKey?: string
  /** A Save's change note (#2654). */
  meta?: SaveMeta
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
  send(ops: LayoutOp[], baseRev: string, note: string, meta?: SaveMeta): Promise<LayoutBundle>
  /** A bundle the server confirmed — mirror it into the query cache. `ops` is the
   *  batch that produced it; null when it is the server's copy after a conflict. */
  saved(bundle: LayoutBundle, ops: LayoutOp[] | null): void
  /** A 409 without a usable bundle: fetch the layout again. */
  reload(): void
  notify(message: string): void
}

type View = Omit<
  LayoutDraft,
  | 'apply'
  | 'undo'
  | 'redo'
  | 'flush'
  | 'whenIdle'
  | 'isLoading'
  | 'setAutosave'
  | 'unsavedOps'
  | 'save'
  | 'discard'
  | 'clearDropped'
  | 'restore'
  | 'jump'
>

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
  /** Manual mode: steps folded into the draft, not sent yet (oldest first). */
  private unsaved: Batch[] = []
  private inFlight = false
  private text = new Map<string, TextEdit>()
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private outcome: 'idle' | 'saved' | 'error' | 'conflict' = 'idle'
  private error: string | null = null
  /** Undo / redo as they were when the first unsaved step was made: Discard puts them back. */
  private checkpoint: { undo: Step[]; redo: Step[] } | null = null
  /** Labels of steps a rebase could not replay (#2652). */
  private dropped: string[] = []
  private autosave: boolean
  private nextId = 1
  private listeners = new Set<() => void>()
  private idleWaiters: Array<() => void> = []
  private view: View

  constructor(
    private transport: DraftTransport,
    opts: { autosave?: boolean } = {}
  ) {
    this.autosave = opts.autosave ?? false
    this.view = this.buildView()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getView = (): View => this.view

  /**
   * A fetched bundle. Ignored while anything is pending or unsaved, so typing
   * and unsaved steps are never overwritten (Save rebases them on a 409). Our
   * own saves arrive here with the rev we already hold; a new rev means
   * someone else saved, and the undo steps (index-based inverses of the old
   * state) would undo over their change — so the history goes.
   */
  receive(bundle: LayoutBundle) {
    if (this.isBusy()) return
    if (this.server && this.server.rev === bundle.rev) return
    if (this.server) {
      this.undoStack = []
      this.redoStack = []
    }
    this.server = bundle
    this.draft = bundle
    this.emit()
  }

  apply(ops: LayoutOp[], opts?: ApplyOptions) {
    if (!this.draft || ops.length === 0) return
    const label = opts?.label ?? 'Edit'
    const edits = opts?.text ? textEdits(ops) : null
    if (edits) return this.autosave ? this.applyText(edits, label) : this.stageText(edits, label)

    this.flushText()
    this.markCheckpoint()
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
    const batch = this.add('do', ops, label)
    if (opts?.undoable !== false) {
      this.pushUndo({ label, forward: ops, inverse, batchId: batch.id })
      this.redoStack = []
    }
    this.refresh()
  }

  // Undo / redo pop the step before checking it still applies: a step that no
  // longer fits the draft is discarded with an error, not retried.
  undo() {
    this.flushText()
    this.markCheckpoint()
    const step = this.undoStack.pop()
    if (!step || !this.draft) return
    // Manual mode: the newest unsaved step simply goes (no request, nothing to save).
    const last = this.unsaved[this.unsaved.length - 1]
    if (!this.autosave && last && last.id === step.batchId) {
      this.unsaved.pop()
      this.clearOutcome()
      this.redoStack.push(step)
      this.refresh()
      return
    }
    try {
      applyLayoutOps(this.draft, step.inverse)
    } catch (e) {
      this.fail(`Could not undo: ${messageOf(e)}`)
      return
    }
    this.clearOutcome()
    step.batchId = this.add('undo', step.inverse, `Undo ${step.label}`).id
    this.redoStack.push(step)
    this.refresh()
  }

  redo() {
    this.flushText()
    this.markCheckpoint()
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
    step.batchId = this.add('redo', step.forward, `Redo ${step.label}`).id
    this.undoStack.push(step)
    this.refresh()
  }

  /** -n undoes n steps, +n redoes n; stops early when a step no longer applies. */
  jump(delta: number) {
    for (let i = 0; i < Math.abs(delta); i++) {
      if ((delta < 0 ? this.undoStack : this.redoStack).length === 0) return
      if (delta < 0) this.undo()
      else this.redo()
      if (this.outcome === 'error') return
    }
  }

  /** Send every pending text edit now (blur, unmount, before another op). Manual
   *  mode: ends the open text burst, so the next keystroke is a new step. */
  flushText() {
    this.closeText()
    for (const key of [...this.text.keys()]) this.flushTextKey(key)
  }

  /** Anything typed, queued, in flight or unsaved (an engine worth keeping). */
  isBusy() {
    return this.pending() || this.unsaved.length > 0
  }

  setAutosave(on: boolean) {
    if (on === this.autosave) return
    this.flushText()
    this.autosave = on
    if (on && this.unsaved.length > 0) void this.save()
    else this.emit()
  }

  unsavedOps(): LayoutOp[] {
    return this.unsaved.flatMap((b) => b.ops)
  }

  /**
   * Every unsaved step as one batch against the current rev. Resolves once
   * nothing is in flight (saved, failed or rebased alike) — `unsavedOps()` is
   * empty afterwards only when it landed.
   */
  save(meta?: SaveMeta): Promise<void> {
    this.flushText()
    if (this.unsaved.length > 0) {
      const parts = this.unsaved
      this.unsaved = []
      // Changes made while this Save is out checkpoint afresh; a refused Save
      // gives its steps back and Discard then rolls them back one by one.
      this.checkpoint = null
      // A Save still waiting behind another takes the new steps too.
      const waiting =
        this.queue.length > (this.inFlight ? 1 : 0) ? this.queue[this.queue.length - 1] : undefined
      if (waiting?.kind === 'save') {
        const all = [...(waiting.parts ?? []), ...parts]
        waiting.parts = all
        waiting.ops = all.flatMap((b) => b.ops)
        waiting.note = saveNote(all.map((b) => b.note))
        if (meta) waiting.meta = meta
      } else
        this.queue.push({
          id: this.nextId++,
          kind: 'save',
          ops: parts.flatMap((b) => b.ops),
          note: saveNote(parts.map((b) => b.note)),
          parts,
          meta
        })
      this.clearOutcome()
      this.refresh()
    }
    return this.whenIdle(60_000)
  }

  /** Drop the unsaved steps: the draft, Undo and Redo go back to the last save. */
  discard() {
    this.closeText()
    if (this.unsaved.length === 0 && this.dropped.length === 0) return
    if (this.checkpoint) {
      this.undoStack = this.checkpoint.undo
      this.redoStack = this.checkpoint.redo
      this.checkpoint = null
    } else for (const batch of [...this.unsaved].reverse()) this.rollback(batch)
    this.unsaved = []
    this.dropped = []
    this.outcome = 'idle'
    this.error = null
    this.refresh()
  }

  clearDropped() {
    if (this.dropped.length === 0) return
    this.dropped = []
    this.emit()
  }

  /**
   * Steps from a recovered draft (#2653), applied as new changes in order. A
   * step that no longer fits the layout is skipped and listed in `dropped`.
   * Returns how many were applied.
   */
  restore(steps: UnsavedStep[]): number {
    let applied = 0
    for (const s of steps) {
      if (!this.draft) break
      try {
        applyLayoutOps(this.draft, s.ops)
      } catch {
        this.dropped = [...this.dropped, s.label]
        continue
      }
      this.apply(s.ops, { label: s.label })
      applied += 1
    }
    this.emit()
    return applied
  }

  whenIdle(timeoutMs = 15_000): Promise<void> {
    this.flushText()
    if (!this.pending()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== finish)
        finish()
      }, timeoutMs)
      this.idleWaiters.push(finish)
    })
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

  /**
   * Manual-mode typing folds at once. Keystrokes in the same box(es) replace
   * the open step's ops, so a burst is one unsaved change and one undo step,
   * back to the value before its first keystroke.
   */
  private stageText(edits: Array<{ key: string; op: LayoutOp }>, label: string) {
    const draft = this.draft as LayoutBundle
    const ops = edits.map((e) => e.op)
    this.markCheckpoint()
    const textKey = edits.map((e) => e.key).join('\u0001')
    try {
      applyLayoutOps(draft, ops)
    } catch (e) {
      this.fail(messageOf(e))
      return
    }
    this.clearOutcome()
    const last = this.unsaved[this.unsaved.length - 1]
    const top = this.undoStack[this.undoStack.length - 1]
    if (last?.textKey === textKey && top?.batchId === last.id) {
      last.ops = ops
      top.forward = ops
    } else {
      this.closeText()
      const batch = this.add('do', ops, label)
      batch.textKey = textKey
      this.pushUndo({ label, forward: ops, inverse: inverseOps(draft, ops), batchId: batch.id })
    }
    this.redoStack = []
    this.refresh()
  }

  /** Before the first unsaved step changes Undo / Redo: remember them for Discard. */
  private markCheckpoint() {
    if (this.autosave || this.unsaved.length > 0) return
    this.checkpoint = {
      undo: this.undoStack.map((s) => ({ ...s })),
      redo: this.redoStack.map((s) => ({ ...s }))
    }
  }

  private closeText() {
    const last = this.unsaved[this.unsaved.length - 1]
    if (last?.textKey) last.textKey = undefined
  }

  private flushTextKey(key: string) {
    const edit = this.text.get(key)
    if (!edit) return
    clearTimeout(edit.timer)
    this.text.delete(key)
    const batch = this.enqueue('do', [edit.op], edit.label)
    this.pushUndo({
      label: edit.label,
      forward: [edit.op],
      inverse: edit.inverse ? [edit.inverse] : [],
      batchId: batch.id
    })
    this.refresh()
  }

  /** A step: sent now (autosave) or held as unsaved (manual). */
  private add(kind: BatchKind, ops: LayoutOp[], note: string): Batch {
    if (this.autosave) return this.enqueue(kind, ops, note)
    const batch: Batch = { id: this.nextId++, kind, ops, note }
    this.unsaved.push(batch)
    return batch
  }

  private enqueue(kind: BatchKind, ops: LayoutOp[], note: string): Batch {
    const batch: Batch = { id: this.nextId++, kind, ops, note }
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
    if (batch.kind === 'save') {
      for (const part of [...(batch.parts ?? [])].reverse()) this.rollback(part)
      return
    }
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

  /**
   * Fold `batches` onto `fresh` one by one: the ones that still fit (with
   * their inverses relative to it) and the ones that no longer do.
   */
  private refold(fresh: LayoutBundle, batches: Batch[]) {
    const kept: Batch[] = []
    const dropped: Batch[] = []
    const inverses = new Map<number, LayoutOp[]>()
    let b = fresh
    for (const s of batches) {
      try {
        const inverse = inverseOps(b, s.ops)
        b = applyLayoutOps(b, s.ops)
        inverses.set(s.id, inverse)
        kept.push(s)
      } catch {
        dropped.push(s)
      }
    }
    return { kept, dropped, inverses }
  }

  /**
   * After a rebase onto `fresh`: kept steps undo with their new inverses; a
   * step saved before keeps its undo only while every value it set still
   * stands (stillMine). Redo goes — it was relative to the old layout.
   */
  private rebaseUndo(fresh: LayoutBundle, inverses: Map<number, LayoutOp[]>, gone: Set<number>) {
    this.undoStack = this.undoStack.filter(
      (s) => inverses.has(s.batchId) || (!gone.has(s.batchId) && stillMine(fresh, s.forward))
    )
    for (const s of this.undoStack) s.inverse = inverses.get(s.batchId) ?? s.inverse
    this.redoStack = []
  }

  /**
   * Autosave: a batch refused as stale. Every queued batch (the refused one
   * first) is replayed on the server's layout and sent again; one that no
   * longer fits is dropped and listed. Without the server's layout: reload.
   */
  private conflict(bundle: LayoutBundle | null) {
    if (!bundle) {
      for (const t of this.text.values()) clearTimeout(t.timer)
      this.text.clear()
      this.queue = []
      this.undoStack = []
      this.redoStack = []
      this.transport.reload()
      this.outcome = 'conflict'
      this.error = null
      this.transport.notify(CONFLICT_MESSAGE)
      return
    }
    const r = this.refold(bundle, this.queue)
    this.queue = r.kept
    this.server = bundle
    this.transport.saved(bundle, null)
    this.rebaseUndo(bundle, r.inverses, new Set(r.dropped.map((d) => d.id)))
    this.dropped = [...this.dropped, ...r.dropped.map((d) => d.note)]
    this.outcome = 'idle'
    this.error = null
    this.transport.notify(
      r.dropped.length === 0
        ? replayedMessage(r.kept.length)
        : partlyRebasedMessage(r.kept.length, r.dropped.length)
    )
  }

  /**
   * A Save refused as stale: fold every step it (and anything queued after it)
   * carried onto the server's layout, one by one. The ones that fit stay
   * unsaved on top of it, with fresh inverses, for another Save; the ones
   * that no longer fit are dropped and listed for the admin to redo by hand.
   */
  private rebase(fresh: LayoutBundle | null) {
    const steps = [
      ...this.queue.flatMap((b) => (b.kind === 'save' ? (b.parts ?? []) : [b])),
      ...this.unsaved
    ]
    this.queue = []
    this.unsaved = steps
    this.checkpoint = null
    this.closeText()
    if (!fresh) {
      this.transport.reload()
      this.outcome = 'conflict'
      this.error = REBASE_FAILED_MESSAGE
      return
    }
    const r = this.refold(fresh, steps)
    this.unsaved = r.kept
    this.server = fresh
    this.transport.saved(fresh, null)
    this.rebaseUndo(fresh, r.inverses, new Set(r.dropped.map((d) => d.id)))
    this.dropped = [...this.dropped, ...r.dropped.map((d) => d.note)]
    this.outcome = 'idle'
    this.error = null
    this.transport.notify(
      r.dropped.length === 0
        ? rebasedMessage(r.kept.length)
        : partlyRebasedMessage(r.kept.length, r.dropped.length)
    )
  }

  /** Draft = server bundle + queued batches + unsaved steps + typed text; then send the next batch. */
  private refresh() {
    this.recompute()
    this.pump()
    this.emit()
  }

  private recompute() {
    if (!this.server) return
    let b = this.server
    const fold = (batches: Batch[], inFlightFirst: boolean) => {
      const kept: Batch[] = []
      const restored: Batch[] = []
      for (const [i, batch] of batches.entries()) {
        try {
          b = applyLayoutOps(b, batch.ops)
          kept.push(batch)
        } catch (e) {
          // In flight: the server decides. Queued: it no longer fits what was saved.
          if (i === 0 && inFlightFirst) kept.push(batch)
          else if (batch.kind === 'save') restored.push(...(batch.parts ?? []))
          else {
            this.rollback(batch)
            // A server refusal said first stays the message shown.
            this.error ??= messageOf(e)
            this.outcome = 'error'
          }
        }
      }
      return { kept, restored }
    }
    const q = fold(this.queue, this.inFlight)
    this.queue = q.kept
    // A queued Save that no longer fits goes back to unsaved, step by step.
    this.unsaved = fold([...q.restored, ...this.unsaved], false).kept
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
      .send(batch.ops, this.server.rev, batch.note, batch.meta)
      .then((bundle) => {
        this.server = bundle
        this.queue.shift()
        this.transport.saved(bundle, batch.ops)
        if (this.outcome !== 'error') this.outcome = 'saved'
      })
      .catch((err) => {
        const failure = parseSaveFailure(err)
        if (failure.status === 409 && batch.kind === 'save') this.rebase(failure.bundle)
        else if (failure.status === 409) this.conflict(failure.bundle)
        else if (batch.kind === 'save') {
          // A refused Save keeps every change it carried, unsaved, to fix or discard.
          this.queue.shift()
          this.unsaved = [...(batch.parts ?? []), ...this.unsaved]
          this.error = failure.message
          this.outcome = 'error'
        } else {
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

  private sessionSteps(): SessionSteps {
    const unsaved = new Set(this.unsaved.map((b) => b.id))
    const sending = new Set<number>()
    for (const b of this.queue) {
      sending.add(b.id)
      for (const p of b.parts ?? []) sending.add(p.id)
    }
    return {
      done: this.undoStack.map((s) => ({
        label: s.label,
        state: unsaved.has(s.batchId) ? 'unsaved' : sending.has(s.batchId) ? 'saving' : 'saved'
      })),
      undone: [...this.redoStack].reverse().map((s) => ({ label: s.label }))
    }
  }

  private buildView(): View {
    const top = this.undoStack[this.undoStack.length - 1]
    const lastText = [...this.text.values()].pop()
    return {
      bundle: this.draft,
      autosave: this.autosave,
      unsavedCount: this.unsaved.length,
      unsavedSteps: this.unsaved.map((b) => ({ label: b.note, ops: b.ops })),
      baseRev: this.server?.rev ?? null,
      dropped: this.dropped,
      dirty: this.unsaved.length > 0,
      canUndo: this.undoStack.length > 0 || this.text.size > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: lastText?.label ?? top?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
      session: this.sessionSteps(),
      status: this.pending() ? 'saving' : this.outcome,
      error: this.error
    }
  }

  private emit() {
    this.view = this.buildView()
    for (const fn of this.listeners) fn()
    if (this.idleWaiters.length > 0 && !this.pending()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

export interface LayoutDraftOptions {
  /**
   * Called for every bundle the server confirms, with the batch that produced
   * it (null after a conflict). Runs even after the editor unmounted, for the
   * batches it left in flight, so callers can refresh what reads the layout.
   */
  onSaved?: (bundle: LayoutBundle, ops: LayoutOp[] | null) => void
  /** Start with autosave on (default off). Kept across layout switches until unmount. */
  autosave?: boolean
}

interface Live {
  client: ReturnType<typeof useNivaroClient>
  qc: QueryClient
  onSaved?: LayoutDraftOptions['onSaved']
}

/**
 * Engines with unsent, unsaved or in-flight work, per query cache and layout.
 * A layout opened again (A → B → A) while its last save is still going reuses
 * that engine instead of starting a second one from the pre-save cache, whose
 * next batch would carry a stale rev and come back as a false conflict. An
 * editor closed with unsaved changes (a route change no prompt could stop)
 * finds them again when the layout reopens.
 */
const engines = new WeakMap<
  QueryClient,
  Map<number, { engine: LayoutDraftEngine; live: { current: Live } }>
>()

function engineFor(layoutId: number, current: Live, autosave: boolean) {
  let byId = engines.get(current.qc)
  if (!byId) {
    byId = new Map()
    engines.set(current.qc, byId)
  }
  const existing = byId.get(layoutId)
  if (existing?.engine.isBusy()) return existing
  const key = layoutDraftKeys.bundle(layoutId)
  const live = { current }
  const engine = new LayoutDraftEngine(
    {
      send: async (ops, baseRev, note, meta) => {
        const res = await live.current.client.request<unknown>(
          post(`/collection-layouts/${layoutId}/ops`, {
            ops,
            base_rev: baseRev,
            note,
            ...(meta ? { reason: meta.reason, ticket: meta.ticket ?? null } : {})
          })
        )
        const bundle = parseBundle(res)
        if (!bundle) throw new Error('The server answered without the saved layout')
        return bundle
      },
      saved: (bundle, ops) => {
        live.current.qc.setQueryData(key, bundle)
        live.current.onSaved?.(bundle, ops)
      },
      reload: () => {
        void live.current.qc.invalidateQueries({ queryKey: key })
      },
      notify: (message) => {
        toast.warning(message)
      }
    },
    { autosave }
  )
  const entry = { engine, live }
  byId.set(layoutId, entry)
  return entry
}

/**
 * One layout's bundle by id: the key the draft engine keeps current on every
 * save, so a parent layout read here is never older than its own editor's last
 * save. An unreadable body is an error, never a cached null.
 */
export function useLayoutBundle(layoutId: number | null, enabled = true) {
  const client = useNivaroClient()
  return useQuery<LayoutBundle>({
    queryKey: layoutDraftKeys.bundle(layoutId ?? 0),
    queryFn: async () => {
      const res = await client.request<unknown>(get(`/collection-layouts/${layoutId}/bundle`))
      const bundle = parseBundle(res)
      if (!bundle) throw new Error('The layout could not be read')
      return bundle
    },
    enabled: enabled && layoutId != null,
    staleTime: 15_000,
    refetchOnWindowFocus: false
  })
}

export function useLayoutDraft(layoutId: number, opts: LayoutDraftOptions = {}): LayoutDraft {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const query = useLayoutBundle(layoutId)
  // Autosave is per editing session: it survives a layout switch, not a remount.
  const [autosaveOn, setAutosaveOn] = useState(opts.autosave ?? false)

  const engineRef = useRef<{
    id: number
    qc: QueryClient
    engine: LayoutDraftEngine
    live: { current: Live }
  } | null>(null)
  if (!engineRef.current || engineRef.current.id !== layoutId || engineRef.current.qc !== qc) {
    engineRef.current = {
      id: layoutId,
      qc,
      ...engineFor(layoutId, { client, qc, onSaved: opts.onSaved }, autosaveOn)
    }
  }
  // Latest client/cache/callback for the engine's transport, without rebuilding the engine.
  engineRef.current.live.current = { client, qc, onSaved: opts.onSaved }
  const engine = engineRef.current.engine

  const view = useSyncExternalStore(engine.subscribe, engine.getView, engine.getView)

  useEffect(() => {
    if (query.data) engine.receive(query.data)
  }, [engine, query.data])

  // A reused engine (reopened layout) takes this session's mode.
  useEffect(() => {
    engine.setAutosave(autosaveOn)
  }, [engine, autosaveOn])

  // Typed text still waiting for its pause goes out when the editor closes or
  // switches layout (useSyncExternalStore drops the old engine's listener).
  useEffect(() => () => engine.flushText(), [engine])

  const apply = useCallback(
    (ops: LayoutOp[], opts?: ApplyOptions) => engine.apply(ops, opts),
    [engine]
  )
  const undo = useCallback(() => engine.undo(), [engine])
  const redo = useCallback(() => engine.redo(), [engine])
  const flush = useCallback(() => engine.flushText(), [engine])
  const whenIdle = useCallback((timeoutMs?: number) => engine.whenIdle(timeoutMs), [engine])
  const setAutosave = useCallback(
    (on: boolean) => {
      setAutosaveOn(on)
      engine.setAutosave(on)
    },
    [engine]
  )
  const unsavedOps = useCallback(() => engine.unsavedOps(), [engine])
  const save = useCallback((meta?: SaveMeta) => engine.save(meta), [engine])
  const discard = useCallback(() => engine.discard(), [engine])
  const clearDropped = useCallback(() => engine.clearDropped(), [engine])
  const restore = useCallback((steps: UnsavedStep[]) => engine.restore(steps), [engine])
  const jump = useCallback((delta: number) => engine.jump(delta), [engine])

  // A bundle that never loaded is an error, not an empty idle editor.
  const loadFailed = !view.bundle && query.error != null
  return {
    ...view,
    status: loadFailed ? 'error' : view.status,
    error:
      view.error ??
      (loadFailed ? parseSaveFailure(query.error, 'The layout could not be read').message : null),
    apply,
    undo,
    redo,
    flush,
    whenIdle,
    setAutosave,
    unsavedOps,
    save,
    discard,
    clearDropped,
    restore,
    jump,
    isLoading: query.isLoading
  }
}
