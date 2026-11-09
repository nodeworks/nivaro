/**
 * Semantic colour roles for the Integrations console. Every hue rides the
 * host-overridable `--nvr-role-*` vars (QueryTable's COLOR_ROLES), with the
 * same desaturated dark fallbacks — never a bare hex in a component. Classes
 * are full literals so Tailwind's scanner sees them.
 */
import { plainObligationReason } from '../../../lib/obligation-reason-text'

export type Tone = 'negative' | 'warning' | 'positive' | 'info' | 'neutral'

export const TONE_TEXT: Record<Tone, string> = {
  negative:
    'text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]',
  warning:
    'text-[color:var(--nvr-role-warning,#b45309)] dark:text-[color:var(--nvr-role-warning-dark,#d4936a)]',
  positive:
    'text-[color:var(--nvr-role-positive,#15803d)] dark:text-[color:var(--nvr-role-positive-dark,#9fbf8a)]',
  info: 'text-[color:var(--nvr-role-info,#4f46e5)] dark:text-[color:var(--nvr-role-info-dark,#8fa6c9)]',
  neutral: 'text-muted-foreground'
}

/** Faint tinted surface for chips and banners — the hue's own text sits on it. */
export const TONE_SOFT: Record<Tone, string> = {
  negative:
    'bg-[color:color-mix(in_srgb,var(--nvr-role-negative,#dc2626)_9%,transparent)] dark:bg-[color:color-mix(in_srgb,var(--nvr-role-negative-dark,#e08383)_14%,transparent)]',
  warning:
    'bg-[color:color-mix(in_srgb,var(--nvr-role-warning,#b45309)_9%,transparent)] dark:bg-[color:color-mix(in_srgb,var(--nvr-role-warning-dark,#d4936a)_14%,transparent)]',
  positive:
    'bg-[color:color-mix(in_srgb,var(--nvr-role-positive,#15803d)_9%,transparent)] dark:bg-[color:color-mix(in_srgb,var(--nvr-role-positive-dark,#9fbf8a)_14%,transparent)]',
  info: 'bg-[color:color-mix(in_srgb,var(--nvr-role-info,#4f46e5)_8%,transparent)] dark:bg-[color:color-mix(in_srgb,var(--nvr-role-info-dark,#8fa6c9)_14%,transparent)]',
  neutral: 'bg-muted'
}

/** Solid fill (dots, bars). */
export const TONE_FILL: Record<Tone, string> = {
  negative:
    'bg-[color:var(--nvr-role-negative,#dc2626)] dark:bg-[color:var(--nvr-role-negative-dark,#e08383)]',
  warning:
    'bg-[color:var(--nvr-role-warning,#b45309)] dark:bg-[color:var(--nvr-role-warning-dark,#d4936a)]',
  positive:
    'bg-[color:var(--nvr-role-positive,#15803d)] dark:bg-[color:var(--nvr-role-positive-dark,#9fbf8a)]',
  info: 'bg-[color:var(--nvr-role-info,#4f46e5)] dark:bg-[color:var(--nvr-role-info-dark,#8fa6c9)]',
  neutral: 'bg-muted-foreground/40'
}

/** Hairline border in the hue. */
export const TONE_BORDER: Record<Tone, string> = {
  negative:
    'border-[color:color-mix(in_srgb,var(--nvr-role-negative,#dc2626)_35%,transparent)] dark:border-[color:color-mix(in_srgb,var(--nvr-role-negative-dark,#e08383)_35%,transparent)]',
  warning:
    'border-[color:color-mix(in_srgb,var(--nvr-role-warning,#b45309)_35%,transparent)] dark:border-[color:color-mix(in_srgb,var(--nvr-role-warning-dark,#d4936a)_35%,transparent)]',
  positive:
    'border-[color:color-mix(in_srgb,var(--nvr-role-positive,#15803d)_35%,transparent)] dark:border-[color:color-mix(in_srgb,var(--nvr-role-positive-dark,#9fbf8a)_35%,transparent)]',
  info: 'border-[color:color-mix(in_srgb,var(--nvr-role-info,#4f46e5)_35%,transparent)] dark:border-[color:color-mix(in_srgb,var(--nvr-role-info-dark,#8fa6c9)_35%,transparent)]',
  neutral: 'border-border'
}

/** Relative age without a calendar date: "4m", "3h", "12d", "7mo", "2y 3mo". */
export function ageOf(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const mins = Math.max(0, Math.floor((now - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 60) return `${days}d`
  const months = Math.floor(days / 30.44)
  if (months < 24) return `${months}mo`
  const years = Math.floor(months / 12)
  const rem = months - years * 12
  return rem > 0 ? `${years}y ${rem}mo` : `${years}y`
}

/** "4m ago" / "just now". */
export function agoText(iso: string | null | undefined): string {
  const a = ageOf(iso)
  if (!a) return 'never'
  return a === 'just now' ? a : `${a} ago`
}

export function exactTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleString()} · ${d.toISOString()}`
}

const ISO_STAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g
const UUID_RE = /:?\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/**
 * A problem line as people read it (army 8 b14): raw ISO stamps ("since
 * 2025-01-06T19:24:11.000Z") become a local date and time, a JSON error wrapper
 * (`{"message":"import_forecasts - "}`) becomes its message, and record / type
 * UUIDs inside a partner's error text are dropped. The raw text stays in the tip.
 */
export function plainDetail(text: string | null | undefined): string {
  // A ledger reason reads the same everywhere (obligation-reason-text, one source) — also
  // for a problem row stored before the server started sending the plain words.
  let t = plainObligationReason(String(text ?? '').trim())
  if (!t) return ''
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      const msg = o.message ?? o.error ?? o.detail
      if (typeof msg === 'string' && msg.trim()) t = msg.trim().replace(/\s*-\s*$/, '')
    } catch {
      /* not JSON — keep the text */
    }
  }
  t = t.replace(ISO_STAMP_RE, (iso) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
  })
  return t
    .replace(UUID_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
