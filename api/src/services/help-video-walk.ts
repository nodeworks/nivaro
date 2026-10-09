// Recorded clicks and the guided walk ("Show me on this page") built from them.
//
// A click is `{ t_ms, x, y }` (recording time, frame fractions) and, when the
// recorder captured its own tab, what was clicked: the element's accessible
// name, role, nearest stable `data-*` hook, the help-video page key of the
// screen and the path. The client mirror lives in
// packages/shared/src/components/help-videos/walk/ — keep the limits in step.
//
// Privacy: the recorder never sends what was typed or an input's value (only
// its label) and records only the position inside `.nvr-no-record`. This
// module re-checks the shapes and lengths; it cannot know what text means.

import { sourceToEdited, type VideoEdits } from './help-video-edits.js'

export interface RecordedClick {
  t_ms: number
  x: number
  y: number
  label?: string
  role?: string
  hook?: string
  page_key?: string
  path?: string
  /** The app's origin (`https://host`), so a walk only links to its own screens. */
  origin?: string
}

export const CLICK_LIMITS = {
  /** Clicks kept per recording (the earliest win). */
  clicks: 2000,
  label: 80,
  role: 24,
  hook: 140,
  pageKey: 100,
  path: 300,
  /** 31 minutes: a recording may run a little past the 30:00 limit. */
  maxMs: 31 * 60_000,
  /** Microphone levels: one per 100 ms. */
  levels: 31 * 60 * 10
}

const ROLE_RE = /^[a-z]{1,24}$/
// `data-name` or `data-name=value`; the value never holds a quote or newline.
const HOOK_RE = /^data-[a-z0-9][a-z0-9_-]{0,59}(=[^"\n\r\\]{0,79})?$/
const PAGE_RE = /^[A-Za-z0-9_.:-]{1,100}$/
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]{1,80}(:\d{1,5})?$/

/** Whitespace collapsed and trimmed, cut at `max` characters. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max).trimEnd() : t
}

/** A path without its query or hash (they can carry search text). */
function cleanPath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const p = v.split(/[?#]/)[0].trim()
  if (!p.startsWith('/') || p.startsWith('//') || p.length > CLICK_LIMITS.path) return undefined
  return /[\s<>"'\\]/.test(p) ? undefined : p
}

const frac = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000

/**
 * The recorder's clicks as stored: anything that is not a click is dropped,
 * times and positions are clamped, the target fields are checked and cut to
 * length, the list is sorted and capped. Null stays null (capture was off).
 */
export function normalizeClicks(raw: unknown): RecordedClick[] | null {
  if (raw == null || !Array.isArray(raw)) return null
  const out: RecordedClick[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const t = Number(o.t_ms)
    const x = Number(o.x)
    const y = Number(o.y)
    if (![t, x, y].every(Number.isFinite) || t < 0 || t > CLICK_LIMITS.maxMs) continue
    const click: RecordedClick = { t_ms: Math.round(t), x: frac(x), y: frac(y) }
    const label = text(o.label, CLICK_LIMITS.label)
    if (label) click.label = label
    if (typeof o.role === 'string' && ROLE_RE.test(o.role)) click.role = o.role
    if (typeof o.hook === 'string' && o.hook.length <= CLICK_LIMITS.hook && HOOK_RE.test(o.hook))
      click.hook = o.hook
    if (typeof o.page_key === 'string' && PAGE_RE.test(o.page_key)) click.page_key = o.page_key
    const path = cleanPath(o.path)
    if (path) click.path = path
    if (typeof o.origin === 'string' && ORIGIN_RE.test(o.origin)) click.origin = o.origin
    out.push(click)
  }
  out.sort((a, b) => a.t_ms - b.t_ms)
  return out.slice(0, CLICK_LIMITS.clicks)
}

/** Microphone levels as stored: numbers 0–1 (two decimals), capped. */
export function normalizeLevels(raw: unknown): number[] | null {
  if (raw == null || !Array.isArray(raw)) return null
  return raw.slice(0, CLICK_LIMITS.levels).map((v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : 0
  })
}

export interface WalkStep {
  label: string
  role: string | null
  hook: string | null
  page_key: string | null
  path: string | null
  origin: string | null
  /** Where the step happens in the finished (edited) video. */
  edited_ms: number
  /** A callout or box shown around the click, else null. */
  text: string | null
}

/** A callout/box this close (source time) to a click explains it. */
export const STEP_TEXT_WINDOW_MS = 2000
/** The same target clicked again this soon is one step (a double click). */
const REPEAT_MS = 1000
const MAX_STEPS = 200

const sameTarget = (a: RecordedClick, b: RecordedClick) =>
  a.label === b.label &&
  (a.role ?? null) === (b.role ?? null) &&
  (a.hook ?? null) === (b.hook ?? null)

/**
 * The guided walk of a version: its labelled clicks that viewers see (inside
 * a kept piece), in order, each with the text of the nearest callout or box
 * within two seconds. A callout explains one click: when several clicks are
 * near the same one, the closest (in time, then on screen) gets its text.
 * Unlabelled clicks are left out; a repeat of the same target within a second
 * is one step.
 */
export function buildWalkSteps(edits: VideoEdits, rawClicks: unknown): WalkStep[] {
  const clicks = normalizeClicks(rawClicks) ?? []
  const notes = edits.annotations.filter(
    (a) => (a.type === 'callout' || a.type === 'box' || a.type === 'step') && a.text.trim()
  )
  const kept: Array<{ c: RecordedClick; edited: number }> = []
  let prev: RecordedClick | null = null
  for (const c of clicks) {
    if (!c.label) continue
    const edited = sourceToEdited(edits, c.t_ms)
    if (edited === null) continue
    const repeat = prev && sameTarget(prev, c) && c.t_ms - prev.t_ms <= REPEAT_MS
    prev = c
    if (repeat) continue
    kept.push({ c, edited })
    if (kept.length >= MAX_STEPS) break
  }
  // Each note goes to its nearest kept click: smallest gap, then distance.
  const owner = new Map<number, { step: number; gap: number; dist: number }>()
  kept.forEach(({ c }, i) => {
    notes.forEach((a, n) => {
      const gap =
        c.t_ms < a.start_ms ? a.start_ms - c.t_ms : c.t_ms > a.end_ms ? c.t_ms - a.end_ms : 0
      if (gap > STEP_TEXT_WINDOW_MS) return
      const dist = Math.hypot(a.rect.x + a.rect.w / 2 - c.x, a.rect.y + a.rect.h / 2 - c.y)
      const cur = owner.get(n)
      if (!cur || gap < cur.gap || (gap === cur.gap && dist < cur.dist))
        owner.set(n, { step: i, gap, dist })
    })
  })
  // A click owning several notes shows the closest one.
  const textOf = new Map<number, { gap: number; dist: number; text: string }>()
  for (const [n, o] of owner) {
    const cur = textOf.get(o.step)
    if (!cur || o.gap < cur.gap || (o.gap === cur.gap && o.dist < cur.dist))
      textOf.set(o.step, { gap: o.gap, dist: o.dist, text: notes[n].text.trim() })
  }
  return kept.map(({ c, edited }, i) => ({
    label: c.label as string,
    role: c.role ?? null,
    hook: c.hook ?? null,
    page_key: c.page_key ?? null,
    path: c.path ?? null,
    origin: c.origin ?? null,
    edited_ms: edited,
    text: textOf.get(i)?.text ?? null
  }))
}
