/**
 * #1160 — the windows offered by "Compare two windows". Pure (now is passed in), local time.
 * Every window ends no later than `now`.
 */
export type WindowPresetId =
  | 'hour-vs-last-week'
  | 'hour-vs-previous'
  | 'morning-vs-afternoon'
  | 'today-vs-yesterday'
export interface WindowPair {
  a: { from: Date; to: Date; label: string }
  b: { from: Date; to: Date; label: string }
}

export const WINDOW_PRESETS: Array<{ id: WindowPresetId; label: string }> = [
  { id: 'hour-vs-last-week', label: 'This hour vs the same hour last week' },
  { id: 'hour-vs-previous', label: 'Last hour vs the hour before' },
  { id: 'morning-vs-afternoon', label: 'Morning vs afternoon' },
  { id: 'today-vs-yesterday', label: 'Today so far vs yesterday at this time' }
]

const H = 3600_000
const at = (base: Date, h: number) => {
  const d = new Date(base)
  d.setHours(h, 0, 0, 0)
  return d
}

export function windowPreset(id: WindowPresetId, now = new Date()): WindowPair {
  const t = now.getTime()
  switch (id) {
    case 'hour-vs-last-week':
      return {
        a: {
          from: new Date(t - 7 * 24 * H - H),
          to: new Date(t - 7 * 24 * H),
          label: 'Same hour last week'
        },
        b: { from: new Date(t - H), to: now, label: 'Last hour' }
      }
    case 'hour-vs-previous':
      return {
        a: { from: new Date(t - 2 * H), to: new Date(t - H), label: 'The hour before' },
        b: { from: new Date(t - H), to: now, label: 'Last hour' }
      }
    case 'morning-vs-afternoon': {
      // Before noon there is no afternoon yet today: compare yesterday's.
      const day = now.getHours() < 12 ? new Date(t - 24 * H) : now
      const afternoonEnd = at(day, 17).getTime() > t ? now : at(day, 17)
      const prefix = day === now ? '' : 'Yesterday '
      return {
        a: { from: at(day, 8), to: at(day, 12), label: `${prefix}08:00–12:00`.trim() },
        b: {
          from: at(day, 12),
          to: afternoonEnd,
          label: `${prefix}12:00–${afternoonEnd === now ? 'now' : '17:00'}`.trim()
        }
      }
    }
    case 'today-vs-yesterday': {
      const midnight = at(now, 0)
      return {
        a: {
          from: new Date(midnight.getTime() - 24 * H),
          to: new Date(t - 24 * H),
          label: 'Yesterday until this time'
        },
        b: { from: midnight, to: now, label: 'Today so far' }
      }
    }
  }
}

/** `<input type="datetime-local">` value for a Date (local time, minutes). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A window longer than a day, empty or reversed is refused before asking the server. */
export function pairProblem(p: {
  a: { from: Date; to: Date }
  b: { from: Date; to: Date }
}): string | null {
  for (const [name, w] of [
    ['A', p.a],
    ['B', p.b]
  ] as const) {
    if (!Number.isFinite(w.from.getTime()) || !Number.isFinite(w.to.getTime()))
      return `Window ${name} needs a start and an end`
    if (w.to <= w.from) return `Window ${name} ends before it starts`
    if (w.to.getTime() - w.from.getTime() > 24 * H) return `Window ${name} can be 24 hours at most`
  }
  return null
}
