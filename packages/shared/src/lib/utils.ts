import { type ClassValue, clsx } from 'clsx'
import * as LucideIcons from 'lucide-react'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date, opts?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...opts
  }).format(new Date(date))
}

export function formatDateTime(date: string | Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(date))
}

export function formatRelative(date: string | Date) {
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
  return n.toLocaleString('en-US')
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
