import { useCallback, useRef, useState } from 'react'
import { useLiveOps } from './live-ops'

/**
 * Config editors and shared dashboards follow each other (rt4 #14 / #18).
 *
 * The server pokes `cfg-<kind>:<id>` when a write changes that pipeline, flow, rule, external
 * API, payload template, dashboard or report (api services/config-watch.ts): `{ part, by? }` —
 * what moved (a state, a step, a widget …) and, for the administrator editors only, who. Never a
 * value: the page re-reads through its own route.
 *
 *   const { change, clear } = useConfigWatch('flow', id, { meId: user.id })
 *   <ConfigChangeStrip change={change} onShow={() => { refetch(); clear() }} />
 *
 * A dashboard viewer passes `onChange` and re-reads quietly instead of showing a strip.
 */

export type ConfigWatchKind =
  | 'pipeline'
  | 'flow'
  | 'rule'
  | 'external-api'
  | 'payload'
  | 'dashboard'
  | 'report'

export interface ConfigChange {
  by: { id: string; name: string } | null
  part: string
  /** When the latest change was heard (ms). */
  at: number
  /** Changes heard since the strip was last cleared. */
  count: number
}

export function configWatchTopic(kind: ConfigWatchKind, id: string | number): string {
  return `cfg-${kind}:${id}`
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** Fold one poke into the change being shown (pure; exported for tests). */
export function foldConfigChange(
  cur: ConfigChange | null,
  detail: { part?: unknown; by?: unknown },
  now: number
): ConfigChange {
  const part = typeof detail.part === 'string' && detail.part ? detail.part : 'several'
  const rawBy = detail.by as { id?: unknown; name?: unknown } | null | undefined
  const by =
    rawBy && rawBy.id != null
      ? { id: String(rawBy.id), name: typeof rawBy.name === 'string' ? rawBy.name : 'Someone' }
      : null
  if (!cur) return { by, part, at: now, count: 1 }
  const sameWho = sameId(cur.by?.id, by?.id) || (!cur.by && !by)
  return {
    by: sameWho ? by : null,
    part: cur.part === part ? part : 'several',
    at: now,
    count: cur.count + 1
  }
}

export interface ConfigWatchOptions {
  /** The signed-in person: their own saves (any tab) never raise the strip. */
  meId?: string | null
  enabled?: boolean
  /** Called for every change by someone else (after the client-side coalescing). */
  onChange?: (change: ConfigChange) => void
}

export function useConfigWatch(
  kind: ConfigWatchKind,
  id: string | number | null | undefined,
  opts: ConfigWatchOptions = {}
): { change: ConfigChange | null; clear: () => void } {
  const [change, setChange] = useState<ConfigChange | null>(null)
  const current = useRef<ConfigChange | null>(null)
  const topic = id != null && id !== '' ? configWatchTopic(kind, id) : null
  const { meId, onChange } = opts
  useLiveOps(
    topic,
    (detail) => {
      if (detail?.by && sameId((detail.by as { id?: unknown }).id, meId)) return
      const next = foldConfigChange(current.current, detail ?? {}, Date.now())
      current.current = next
      setChange(next)
      onChange?.(next)
    },
    { enabled: opts.enabled !== false, debounceMs: 250 }
  )
  const clear = useCallback(() => {
    current.current = null
    setChange(null)
  }, [])
  return { change, clear }
}

const PART_TEXT: Record<string, string> = {
  state: 'changed a state',
  transition: 'changed a transition',
  owners: 'changed the owners',
  binding: 'changed a collection binding',
  step: 'changed a step',
  settings: 'changed the settings',
  endpoint: 'changed an endpoint',
  version: 'restored an earlier version',
  draft: 'changed the draft',
  published: 'published a new version',
  widget: 'changed a widget',
  several: 'made changes'
}

/** "1 min ago" from a time heard (ms). */
export function configAgoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return `${h} h ago`
}

/** "Beth changed a state 1 min ago" (pure; exported for tests). */
export function configChangeText(c: ConfigChange, now: number): string {
  const who = c.by?.name || 'Someone'
  const what =
    c.count > 1 && c.part !== 'several'
      ? PART_TEXT.several
      : (PART_TEXT[c.part] ?? PART_TEXT.several)
  return `${who} ${what} ${configAgoText(c.at, now)}`
}

// ── Shared dashboards and reports (rt4 #18) ──────────────────────────────────

/** Keys that only place a widget on the grid — a move never needs the widget's figures again. */
const LAYOUT_KEYS = new Set([
  'x',
  'y',
  'w',
  'h',
  'col',
  'row',
  'width',
  'height',
  'sort',
  'updated_at'
])

function widgetSignature(w: Record<string, unknown>): string {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(w).sort()) if (!LAYOUT_KEYS.has(k)) out[k] = w[k]
  try {
    return JSON.stringify(out)
  } catch {
    return String(Math.random())
  }
}

/**
 * Widgets whose figures must be read again after the owner's edit: the ones whose definition
 * (type, source, filters, title …) changed — a moved or resized widget keeps its figures, and a
 * new widget reads its own the first time it renders. Pure; exported for tests.
 */
export function changedWidgetIds(
  before: Array<Record<string, unknown>> | null | undefined,
  after: Array<Record<string, unknown>> | null | undefined
): string[] {
  const prev = new Map((before ?? []).map((w) => [String(w.id), widgetSignature(w)]))
  const out: string[] = []
  for (const w of after ?? []) {
    const id = String(w.id)
    const was = prev.get(id)
    if (was != null && was !== widgetSignature(w)) out.push(id)
  }
  return out
}

// ── Their version beside yours (rt4 #14) ─────────────────────────────────────

export interface ConfigFieldDiff {
  key: string
  label: string
  theirs: string
  mine: string
  /** Code-like (URL, key, JSON): shown in monospace; plain text is not. */
  code: boolean
}

const looksLikeCode = (v: unknown) =>
  v != null &&
  v !== '' &&
  (typeof v === 'object' ||
    (typeof v === 'string' &&
      /^(https?:\/\/|[{[])|^[\w.-]+$/.test(v) &&
      !/\s/.test(v) &&
      /[/:._-]/.test(v)))

function shown(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  let s: string
  try {
    s = JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

const canon = (v: unknown): string => {
  if (v == null || v === '') return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * The fields where someone else's saved copy differs from the form being edited, in the order
 * `labels` lists them (pure; exported for tests). Values are shown as short text, never edited.
 */
export function diffConfigFields(
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  labels: Record<string, string>
): ConfigFieldDiff[] {
  const out: ConfigFieldDiff[] = []
  for (const [key, label] of Object.entries(labels)) {
    if (canon(mine[key]) === canon(theirs[key])) continue
    out.push({
      key,
      label,
      theirs: shown(theirs[key]),
      mine: shown(mine[key]),
      code: looksLikeCode(theirs[key]) || looksLikeCode(mine[key])
    })
  }
  return out
}

// ── No silent overwrite ──────────────────────────────────────────────────────

/** The header a whole-object save carries: the `updated_at` the editor loaded. */
export const CONFIG_BASE_REV_HEADER = 'x-nivaro-base-rev'

export function configBaseRevHeaders(
  updatedAt: string | Date | null | undefined
): Record<string, string> {
  if (!updatedAt) return {}
  const t = new Date(updatedAt)
  return Number.isFinite(t.getTime()) ? { [CONFIG_BASE_REV_HEADER]: t.toISOString() } : {}
}

/** A save refused because someone else saved first (409 CONFIG_STALE), from axios or the SDK. */
export function isConfigStale(err: unknown): boolean {
  const e = err as {
    status?: number
    code?: string
    response?: { status?: number; data?: { code?: string }; code?: string }
    data?: { code?: string }
  } | null
  if (!e) return false
  const code = e.response?.data?.code ?? e.response?.code ?? e.data?.code ?? e.code
  return code === 'CONFIG_STALE'
}
