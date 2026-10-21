// Layout text per language (#2665): a form's field labels and help text live
// in the placement's `overrides.i18n`, a section's label in the group's
// `i18n` (migration 465), both as `{ "<locale>": { label?, help?, draft? } }` —
// the shape AI translation drafts write too. `draft: true` = suggested, not yet
// approved: the record form ignores it and the overview counts it as missing.
// The record form shows the reader's language when the form has it, else the
// text as written. nivaro_field_translations is for record VALUES, not this.

export interface LayoutI18nEntry {
  label?: string
  help?: string
  /** Suggested (AI), not yet approved. */
  draft?: true
}

export type LayoutI18n = Record<string, LayoutI18nEntry>

/** A stored i18n map (object or JSON text); anything malformed reads as none. */
export function readLayoutI18n(v: unknown): LayoutI18n {
  let raw = v
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: LayoutI18n = {}
  for (const [loc, texts] of Object.entries(raw as Record<string, unknown>)) {
    if (!texts || typeof texts !== 'object' || Array.isArray(texts)) continue
    const src = texts as Record<string, unknown>
    const e: LayoutI18nEntry = {}
    for (const k of ['label', 'help'] as const) {
      const t = src[k]
      if (typeof t === 'string' && t.trim()) e[k] = t
    }
    if (!e.label && !e.help) continue
    if (src.draft === true) e.draft = true
    out[loc] = e
  }
  return out
}

/** The map with one text set (empty clears it); undefined when nothing is left.
 *  A draft stays a draft until it is approved. */
export function withLayoutText(
  map: LayoutI18n,
  locale: string,
  key: 'label' | 'help',
  value: string
): LayoutI18n | undefined {
  const entry: LayoutI18nEntry = { ...(map[locale] ?? {}) }
  if (value.trim()) entry[key] = value
  else delete entry[key]
  const next: LayoutI18n = { ...map }
  if (entry.label || entry.help) next[locale] = entry
  else delete next[locale]
  return Object.keys(next).length ? next : undefined
}

/** The map with `locale`'s draft approved (shown from now on). */
export function approveLayoutText(map: LayoutI18n, locale: string): LayoutI18n {
  const { draft: _draft, ...rest } = map[locale] ?? {}
  return { ...map, [locale]: rest }
}

/** The language the record form reads in: the person's chosen admin language,
 *  else the page's, else the browser's. Lower-case, as stored. */
export function formLocale(): string {
  let pick: string | null = null
  try {
    pick = globalThis.localStorage?.getItem('nivaro_admin_locale') ?? null
  } catch {
    pick = null
  }
  if (!pick && typeof document !== 'undefined') pick = document.documentElement.lang || null
  if (!pick && typeof navigator !== 'undefined') pick = navigator.language || null
  return (pick ?? 'en').toLowerCase()
}

/** The translated text, matching `pt-br` then `pt`; null when the form has none. */
export function layoutText(map: LayoutI18n, locale: string, key: 'label' | 'help'): string | null {
  const live = Object.keys(map).filter((k) => !map[k].draft)
  const exact = live.find((k) => k.toLowerCase() === locale)
  const base = locale.split(/[-_]/)[0]
  const loose = exact ?? live.find((k) => k.toLowerCase().split(/[-_]/)[0] === base)
  return (loose && map[loose]?.[key]) || null
}

/** A field-config row with its label and help text in `locale` (when the form has them). */
export function translateFieldRow<
  T extends { label?: string | null; note?: string | null; _overrides?: unknown }
>(row: T, locale: string): T {
  const ov = row._overrides
  const raw =
    ov && typeof ov === 'object' && !Array.isArray(ov) ? (ov as { i18n?: unknown }).i18n : null
  if (!raw) return row
  const map = readLayoutI18n(raw)
  const label = row.label === '' ? null : layoutText(map, locale, 'label')
  const note = layoutText(map, locale, 'help')
  if (!label && !note) return row
  return { ...row, ...(label ? { label } : {}), ...(note ? { note } : {}) }
}

/** A group row with its label in `locale` (when the form has it). */
export function translateGroup<T extends { label?: string | null; i18n?: unknown }>(
  group: T,
  locale: string
): T {
  if (!group.i18n) return group
  const label = layoutText(readLayoutI18n(group.i18n), locale, 'label')
  return label ? { ...group, label } : group
}
