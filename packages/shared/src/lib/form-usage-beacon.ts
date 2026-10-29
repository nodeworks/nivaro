/**
 * Form usage events (#2597/#2598) — one per form session, sent when the form
 * closes, batched, to POST /api/layout-usage/beacon. Fire and forget: usage
 * telemetry must never affect the form it measures.
 *
 * Transport as in rum.ts: sendBeacon survives pagehide but cannot carry an
 * Authorization header, so a bearer-token host takes a keepalive fetch.
 */

export interface FormUsageEvent {
  layout_id: number
  collection: string
  /** Saved record id; null for a new record. */
  item: string | null
  /** The session's first event (counts the open, the person, the record). */
  open: boolean
  saved: boolean
  abandoned_step: string | null
  steps: Record<string, number>
  /** Sections first shown / opened since this session's last event (#2730). */
  sections?: { shown: string[]; opened: string[] }
  /** On a save: milliseconds from opening the form to the save (#2614). */
  save_ms?: number | null
  /** Saves refused since the last event (#3185): how many, and the fields each named. */
  refused?: SaveRefusals
}

/** Field → refusals in this chunk: required and empty, or another rule broken. */
export interface SaveRefusals {
  tries: number
  fields: Record<string, { required: number; invalid: number }>
}

export interface BeaconTransport {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

const queue: FormUsageEvent[] = []
let transport: BeaconTransport | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false

const MAX_BATCH = 20
const FLUSH_MS = 15_000

export function flushFormUsage(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!transport || queue.length === 0) return
  const { apiBase, authHeaders, credentials } = transport
  while (queue.length) {
    const body = JSON.stringify({ events: queue.splice(0, MAX_BATCH) })
    try {
      const url = `${apiBase}/layout-usage/beacon`
      const bearer = Object.keys(authHeaders).length > 0
      const ok =
        !bearer &&
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
      if (!ok) {
        void fetch(url, {
          method: 'POST',
          credentials,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body,
          keepalive: true
        }).catch(() => {})
      }
    } catch {
      // never let telemetry throw
    }
  }
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('pagehide', flushFormUsage)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushFormUsage()
  })
}

export function queueFormUsage(ev: FormUsageEvent, t: BeaconTransport): void {
  transport = t
  queue.push(ev)
  listen()
  if (queue.length >= MAX_BATCH) flushFormUsage()
  else if (!timer) timer = setTimeout(flushFormUsage, FLUSH_MS)
}

/** Tests only. */
export function _formUsageQueue(): FormUsageEvent[] {
  return queue
}

/**
 * Time per step for one form session. `now` is injectable for tests. Time
 * only runs while the page is visible.
 */
export class StepClock {
  private steps: Record<string, number> = {}
  private current: string
  private since: number | null

  constructor(step: string, now: number, visible = true) {
    this.current = step
    this.since = visible ? now : null
  }

  private settle(now: number) {
    if (this.since == null) return
    const ms = Math.max(0, now - this.since)
    if (ms > 0) this.steps[this.current] = (this.steps[this.current] ?? 0) + ms
    this.since = now
  }

  step(key: string, now: number) {
    if (key === this.current) return
    this.settle(now)
    this.current = key
  }

  pause(now: number) {
    this.settle(now)
    this.since = null
  }

  resume(now: number) {
    if (this.since == null) this.since = now
  }

  get currentStep(): string {
    return this.current
  }

  /** The time so far in this chunk, without starting afresh. */
  peek(now: number): number {
    const running = this.since == null ? 0 : Math.max(0, now - this.since)
    return Object.values(this.steps).reduce((a, b) => a + b, 0) + running
  }

  /** The time so far, and start counting afresh (the clock keeps running). */
  take(now: number): { steps: Record<string, number>; total: number } {
    this.settle(now)
    const steps = this.steps
    this.steps = {}
    return { steps, total: Object.values(steps).reduce((a, b) => a + b, 0) }
  }
}

/**
 * Refused saves in one form session (#3185): each refusal counts once, and
 * each field it names once per refusal. Text from the form decides the kind:
 * a required field left empty, or any other rule.
 */
export class RefusalTally {
  private tries = 0
  private fields: SaveRefusals['fields'] = {}

  note(errors: Record<string, string>, kind?: 'required' | 'invalid') {
    const keys = Object.keys(errors).filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))
    if (keys.length === 0) return
    this.tries++
    for (const k of keys.slice(0, 60)) {
      if (!this.fields[k]) this.fields[k] = { required: 0, invalid: 0 }
      const t = this.fields[k]
      const msg = errors[k] ?? ''
      const required =
        kind === 'required' ||
        (kind == null &&
          (msg === 'This field is required' || /^At least one .+ is required$/.test(msg)))
      if (required) t.required++
      else t.invalid++
    }
  }

  /** What to send, and start counting afresh; null when nothing was refused. */
  take(): SaveRefusals | null {
    if (this.tries === 0) return null
    const out = { tries: this.tries, fields: this.fields }
    this.tries = 0
    this.fields = {}
    return out
  }

  /** Put an unsent chunk back (the event was not sent). */
  restore(r: SaveRefusals | null) {
    if (!r) return
    this.tries += r.tries
    for (const [k, v] of Object.entries(r.fields)) {
      if (!this.fields[k]) this.fields[k] = { required: 0, invalid: 0 }
      const t = this.fields[k]
      t.required += v.required
      t.invalid += v.invalid
    }
  }
}

/** A session shorter than this that saved nothing is a remount, not a use. */
export const MIN_SESSION_MS = 400
/** A new record left within this long was not really started: no abandon. */
export const MIN_ABANDON_MS = 3000

/**
 * The event a session sends, or null when there is nothing worth sending.
 * `total` is the time in this chunk, `elapsed` the whole session's; `final`
 * = the form closed (a page going hidden sends a chunk and carries on, and
 * never counts as an abandon).
 */
export function sessionEvent(s: {
  layoutId: number
  collection: string
  item: string | null
  openSent: boolean
  saved: boolean
  step: string
  steps: Record<string, number>
  total: number
  elapsed: number
  final: boolean
  /** Sections first shown / opened since the last event (#2730). */
  sections?: { shown: string[]; opened: string[] }
  /** Milliseconds from opening the form to the save, when it saved (#2614). */
  saveMs?: number | null
  /** Saves refused since the last event (#3185). */
  refused?: SaveRefusals | null
}): FormUsageEvent | null {
  const refused = s.refused && s.refused.tries > 0 ? s.refused : null
  if (!s.saved && !refused && !s.openSent && s.elapsed < MIN_SESSION_MS) return null
  if (!s.saved && !refused && s.openSent && s.total <= 0) return null
  const ev: FormUsageEvent = {
    layout_id: s.layoutId,
    collection: s.collection,
    item: s.item,
    open: !s.openSent,
    saved: s.saved,
    abandoned_step:
      s.final && s.item == null && !s.saved && s.elapsed >= MIN_ABANDON_MS ? s.step : null,
    steps: s.steps
  }
  if (s.sections && (s.sections.shown.length || s.sections.opened.length)) ev.sections = s.sections
  if (s.saved && s.saveMs != null && s.saveMs > 0) ev.save_ms = Math.round(s.saveMs)
  if (refused) ev.refused = refused
  return ev
}

// ─── Section use (#2730) ────────────────────────────────────────────────────

export interface SectionUse {
  layoutId: number
  collection: string
  /** 'shown' = the section rendered; 'opened' = the person expanded it or worked in it. */
  kind: 'shown' | 'opened'
  key: string
}

const sectionListeners = new Set<(u: SectionUse) => void>()
// Sections mount (and report) before the form's own effect subscribes: the
// last few seconds of reports replay to a new listener.
const recentSections: Array<SectionUse & { at: number }> = []
const REPLAY_MS = 5000

/** A form section says it was shown or used (GroupSection); the open form's session listens. */
export function reportSectionUse(u: SectionUse): void {
  const now = Date.now()
  recentSections.push({ ...u, at: now })
  while (
    recentSections.length > 200 ||
    (recentSections[0] && now - recentSections[0].at > REPLAY_MS)
  )
    recentSections.shift()
  for (const l of sectionListeners) {
    try {
      l(u)
    } catch {
      // never let telemetry throw
    }
  }
}

export function onSectionUse(listener: (u: SectionUse) => void): () => void {
  const now = Date.now()
  for (const r of recentSections) if (r.kind === 'shown' && now - r.at <= REPLAY_MS) listener(r)
  sectionListeners.add(listener)
  return () => {
    sectionListeners.delete(listener)
  }
}

/** A session's section keys not yet sent; marks them sent. */
export class SectionTally {
  private shown = new Set<string>()
  private opened = new Set<string>()
  private sentShown = new Set<string>()
  private sentOpened = new Set<string>()

  note(kind: 'shown' | 'opened', key: string) {
    if (kind === 'opened') {
      this.shown.add(key)
      this.opened.add(key)
    } else this.shown.add(key)
  }

  pending(): { shown: string[]; opened: string[] } {
    return {
      shown: [...this.shown].filter((k) => !this.sentShown.has(k)),
      opened: [...this.opened].filter((k) => !this.sentOpened.has(k))
    }
  }

  markSent(p: { shown: string[]; opened: string[] }) {
    for (const k of p.shown) this.sentShown.add(k)
    for (const k of p.opened) this.sentOpened.add(k)
  }
}
