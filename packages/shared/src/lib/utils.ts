import { type ClassValue, clsx } from 'clsx'
import * as LucideIcons from 'lucide-react'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── User timezone preference (#31) ──────────────────────────────────────────
// Hosts call setDisplayTimezone from the user's preferences at startup; the
// shared date formatters then render wall-clock times in that zone. Null =
// the browser's own zone (historic behavior). getDisplayTimezone drives the
// "times shown in <zone>" badge when it differs from the browser.
let displayTimezone: string | null = null
export function setDisplayTimezone(tz: string | null): void {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
    } catch {
      return // invalid zone — keep the browser default rather than throwing
    }
  }
  displayTimezone = tz
}
export function getDisplayTimezone(): string | null {
  return displayTimezone
}
export function displayTimezoneDiffers(): boolean {
  if (!displayTimezone) return false
  try {
    return displayTimezone !== Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return false
  }
}

export function formatDate(date: string | Date, opts?: Intl.DateTimeFormatOptions) {
  // Date-only strings (bare yyyy-mm-dd or ISO at UTC midnight) anchor to
  // their stored calendar day — converting UTC midnight to local time shifts
  // them a day back for any viewer west of UTC.
  const dm =
    typeof date === 'string'
      ? date.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/)
      : null
  const d = dm ? new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])) : new Date(date)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    // Calendar-day values never shift zones; real timestamps follow the
    // user's preferred zone when one is set.
    ...(dm || !displayTimezone ? {} : { timeZone: displayTimezone }),
    ...opts
  }).format(d)
}

export function formatDateTime(date: string | Date) {
  return new Intl.DateTimeFormat('en-US', {
    ...(displayTimezone ? { timeZone: displayTimezone } : {}),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(date))
}

// Display preference setters (#229/#230/#411) — hosts hydrate from the
// user's preferences at startup; formatters below honor them.
let _timeDisplay: 'relative' | 'exact' = 'relative'
let _numberLocale = 'en-US'
let _compactNumbers = false
export function setTimeDisplay(mode: string | null | undefined): void {
  _timeDisplay = mode === 'exact' ? 'exact' : 'relative'
}
export function setNumberFormat(opts: { locale?: string; compact?: boolean } | null | undefined): void {
  if (opts?.locale) {
    try {
      new Intl.NumberFormat(opts.locale)
      _numberLocale = opts.locale
    } catch {
      /* unknown locale keeps the default */
    }
  } else {
    _numberLocale = 'en-US'
  }
  _compactNumbers = opts?.compact === true
}


/** Hours → the largest sensible unit: "45m", "18h", "3d 7h", "26d", "1mo 5d".
 *  "845h" is not a duration anyone can read — past a couple of days, people
 *  think in days; past a month, in months. */
export function humanHours(hours: number | null | undefined): string {
  if (hours == null || Number.isNaN(hours)) return '—'
  const h = Math.max(0, hours)
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  const days = h / 24
  if (days < 7) {
    const d = Math.floor(days)
    const rem = Math.round(h - d * 24)
    return rem > 0 ? `${d}d ${rem}h` : `${d}d`
  }
  if (days < 60) return `${Math.round(days)}d`
  const months = Math.floor(days / 30)
  const remDays = Math.round(days - months * 30)
  return remDays > 0 ? `${months}mo ${remDays}d` : `${months}mo`
}

export function formatRelative(date: string | Date) {
  // Timestamp pref (#229): 'exact' renders the full stamp everywhere the
  // relative form would have appeared.
  if (_timeDisplay === 'exact') return formatDateTime(date)
  const d = new Date(date)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(d)
}

export function titleCase(str: string) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function truncate(str: string, len = 60) {
  return str.length > len ? `${str.slice(0, len)}…` : str
}

/**
 * Options filter for every nivaro_users picker: mirrors listUsers() — redacted
 * accounts never appear, and suspended users cannot be PICKED (existing values
 * still display, since current-value lookups fetch by id with no filter).
 * Null-safe on status so a fresh install with unset statuses keeps working.
 */
export const ACTIVE_USER_OPTION_FILTER = {
  _and: [
    { is_redacted: { _eq: false } },
    { _or: [{ status: { _neq: 'suspended' } }, { status: { _null: true } }] }
  ]
}

/**
 * Select-choice display text. Legacy Directus schema imports store choice
 * labels as i18n keys ('$t:published') that Directus resolved through its own
 * translation bundle — Nivaro has no such bundle, so the raw key leaked into
 * dropdowns and read views. Strip the marker and humanize; plain labels pass
 * through untouched.
 */
export function choiceLabel(text: string | null | undefined): string {
  const s = String(text ?? '')
  if (!s.startsWith('$t:')) return s
  return titleCase(s.slice(3).replace(/-/g, '_'))
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  // Number prefs (#230/#411): per-user locale + compact notation.
  if (_compactNumbers && Math.abs(n) >= 10_000) {
    return new Intl.NumberFormat(_numberLocale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  }
  return n.toLocaleString(_numberLocale)
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function resolveCollectionIcon(
  iconName: string | null | undefined
): React.ElementType | null {
  if (!iconName) return null
  const pascal = iconName
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
  return (LucideIcons as Record<string, unknown>)[pascal] as React.ElementType | null
}
