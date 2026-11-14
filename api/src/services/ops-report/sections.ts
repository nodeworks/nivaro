/**
 * Daily operations report — sections an extension adds (#ops-report, idea 8).
 *
 * Core knows nothing about an instance's business; an extension registers a section through
 * `ctx.opsReport.registerSection(key, title, build)` and the digest calls it for each window.
 * A section's rows are numbers (with an optional 7-day average); each row also becomes a KPI
 * `<key>.<row key>` so trends and Compare chart it like any core number.
 */
export interface OpsSectionRow {
  /** Stable id for the KPI (`requested_usd`); defaults to the label slugged. */
  key?: string
  label: string
  value: number
  unit?: 'ms' | 'usd' | 'count' | 'pct'
  week_avg?: number | null
  note?: string
  /** An app path the row opens (`/environments/changed-here`); the report shows "Open". */
  href?: string
  /** Which way is good for this number (Compare colours it). */
  better?: 'up' | 'down' | null
}

export interface OpsSectionWindow {
  day: string
  start: Date
  end: Date
  tz: string
}

export type OpsSectionBuilder = (win: OpsSectionWindow) => Promise<OpsSectionRow[]>

interface Registered {
  key: string
  title: string
  build: OpsSectionBuilder
}

const sections = new Map<string, Registered>()

const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/

export function registerOpsSection(key: string, title: string, build: OpsSectionBuilder): void {
  if (!KEY_RE.test(key)) throw new Error(`ops report section key "${key}" must be lower_snake_case`)
  if (typeof build !== 'function') throw new Error('ops report section needs a build function')
  sections.set(key, { key, title: String(title).slice(0, 80), build })
}

export function slugKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'value'
  )
}

/** Every registered section for one window; a failing section is left out, never the report. */
export async function buildSections(win: OpsSectionWindow): Promise<
  Array<{
    key: string
    title: string
    rows: Array<Required<Pick<OpsSectionRow, 'key'>> & OpsSectionRow>
  }>
> {
  const out = []
  for (const s of sections.values()) {
    try {
      const rows = (await s.build(win)).slice(0, 30).map((r) => ({
        ...r,
        key: KEY_RE.test(r.key ?? '') ? (r.key as string) : slugKey(r.label),
        value: Number.isFinite(Number(r.value)) ? Number(r.value) : 0,
        href:
          typeof r.href === 'string' && /^\/[^/\\]/.test(r.href) ? r.href.slice(0, 300) : undefined
      }))
      out.push({ key: s.key, title: s.title, rows })
    } catch {
      /* one extension's failure never costs the report */
    }
  }
  return out
}

/** Tests only. */
export function _clearOpsSections(): void {
  sections.clear()
}
