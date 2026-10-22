import { api } from '@/lib/api'
import type { ChaosRun, ChaosRunEvent, FaultTarget } from './api'

/**
 * Game days (#2852), scribe marks (#2853) and blind mode (#2854) — types mirroring
 * api/src/services/chaos/gameday-plan.ts and the fetchers of routes/chaos-gameday.ts.
 */

export type InjectKind = 'fault' | 'announce' | 'checkpoint'

export interface GamedayInject {
  id: string
  at_s: number
  kind: InjectKind
  label: string
  fault?: {
    fault_key: string
    target?: FaultTarget
    params?: Record<string, number | string | boolean>
    seconds?: number
  }
  preset_id?: string | null
  text?: string
}

export interface GamedayPlan {
  title: string
  starts_at: string
  duration_min: number
  lead: string
  scribe: string | null
  responders: string[]
  blind: boolean
  auto_start: boolean
  channel: boolean
  reminders_min: number[]
  repeat: 'none' | 'monthly'
  notes: string
  injects: GamedayInject[]
}

export type NoteMark = 'noticed' | 'found_cause' | 'fixed' | 'declared'

export const MARK_LABEL: Record<NoteMark, string> = {
  noticed: 'Noticed',
  found_cause: 'Found cause',
  fixed: 'Fixed',
  declared: 'Declared incident'
}

export interface NotePoints {
  first_fault_at: string | null
  ttd_s: number | null
  ttc_s: number | null
  ttf_s: number | null
  notes: number
}

export interface GamedayDetail {
  run: ChaosRun
  events: ChaosRunEvent[]
  children: ChaosRun[]
  people: Array<{ id: string; name: string }>
  points: NotePoints
  blind: { on: boolean; revealed: boolean }
}

export const gamedayKeys = {
  list: ['chaos', 'gamedays'] as const,
  detail: (id: string) => ['chaos', 'gameday', id] as const,
  template: ['chaos', 'gameday-template'] as const,
  notes: (runId: string) => ['chaos', 'notes', runId] as const
}

export const planOf = (run: ChaosRun) => run.meta.plan as GamedayPlan

export const fetchGamedays = () => api.get('/chaos/gamedays').then((r) => r.data.data as ChaosRun[])
export const fetchGameday = (id: string) =>
  api.get(`/chaos/gamedays/${id}`).then((r) => r.data.data as GamedayDetail)
export const fetchTemplate = () =>
  api
    .get('/chaos/gamedays/template')
    .then((r) => r.data.data as { plan: GamedayPlan; kill_task: string | null })
export const saveGameday = (plan: GamedayPlan, id?: string | null) =>
  (id ? api.patch(`/chaos/gamedays/${id}`, plan) : api.post('/chaos/gamedays', plan)).then(
    (r) => r.data.data as { run: ChaosRun; warnings: string[] }
  )
export const gamedayAction = (
  id: string,
  action: 'start' | 'end' | 'cancel' | 'reveal' | 'step',
  body: Record<string, unknown> = {}
) => api.post(`/chaos/gamedays/${id}/${action}`, body).then((r) => r.data.data)
export const fetchNotes = (runId: string) =>
  api
    .get(`/chaos/runs/${runId}/notes`)
    .then((r) => r.data.data as { run_id: string; notes: ChaosRunEvent[]; points: NotePoints })
export const addNote = (runId: string, body: { mark?: NoteMark | null; text?: string | null }) =>
  api.post(`/chaos/runs/${runId}/notes`, body).then((r) => r.data.data as ChaosRunEvent)

/** The server's plan errors on a 400 (every one, not just the first). */
export const planErrorsOf = (e: unknown): string[] | null => {
  const d = (e as { response?: { data?: { code?: string; details?: { errors?: string[] } } } })
    ?.response?.data
  return d?.code === 'CHAOS_PLAN' && Array.isArray(d.details?.errors) ? d.details.errors : null
}

// ─── Eastern time ─────────────────────────────────────────────────────────────

const ET = 'America/New_York'

function etParts(ms: number) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute }
}

/** `2026-11-10` + `14:00` read as Eastern time → ISO (DST-aware). */
export function easternToIso(date: string, time: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!dm || !tm) return null
  const [y, m, d, h, min] = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]]
  let guess = Date.UTC(y, m - 1, d, h + 5, min)
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess)
    const diff = Date.UTC(y, m - 1, d, h, min) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess).toISOString()
}

/** ISO → the Eastern date and time inputs. */
export function isoToEastern(iso: string): { date: string; time: string } {
  const p = etParts(Date.parse(iso))
  const pad = (n: number) => String(n).padStart(2, '0')
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.min)}` }
}

/** "2:00 PM ET · Tue, Nov 10" */
export function fmtEastern(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' })
  const day = d.toLocaleDateString('en-US', {
    timeZone: ET,
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  return `${time} ET · ${day}`
}

/** `+mm:ss` ⇄ seconds. */
export function fmtOffset(s: number): string {
  const v = Math.max(0, Math.round(s))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}
export function parseOffset(raw: string): number | null {
  const m = /^\+?\s*(\d{1,3})(?::(\d{1,2}))?$/.exec(raw.trim())
  if (!m) return null
  const sec = m[2] == null ? 0 : +m[2]
  return sec < 60 ? +m[1] * 60 + sec : null
}

/** "1 min 30 s" for time-to-detect figures. */
export function fmtDuration(s: number | null): string {
  if (s == null) return '—'
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s` : `${m} min`
}
