import parityRows from '../parity-keys.json'
import { type LayoutKind, SECTIONS, SETTINGS } from '../settings/settings-registry'

/**
 * Every control of the layout editor as one searchable index (#2676 "where do
 * I turn off comments?"): Form settings from its registry (label, effect
 * sentence, search words), everything else — inspector tabs, the Add panel,
 * the canvas, the overview — from the parity checklist. Each key is stamped
 * on its control as `data-setting="<key>"`, which is what a jump finds.
 */

export type SettingHome = 'form_settings' | 'inspector' | 'add_panel' | 'canvas' | 'overview'

export interface SettingEntry {
  key: string
  label: string
  effect?: string
  keywords?: string
  home: SettingHome
  /** The Form settings section, inspector tab or panel part it sits in. */
  place: string
  /** "Form settings · Buttons & panels", "Inspector · Rules tab". */
  where: string
  types: LayoutKind[]
}

interface ParityRow {
  key: string
  label: string
  home: string | null
  tab_or_section: string | null
  status: string
  layout_types?: string[]
}

const INSPECTOR_PART: Record<string, string> = {
  Group: 'Section inspector',
  Slot: 'Panel inspector',
  Widget: 'Widget inspector',
  'Header item': 'Header strip inspector',
  Subtitle: 'Subtitle inspector'
}

const HOME_WORDS: Record<string, string> = {
  add_panel: 'Add panel',
  canvas: 'Canvas',
  overview: 'Layouts overview'
}

function whereOf(home: SettingHome, place: string): string {
  if (home === 'form_settings') return `Form settings · ${place}`
  if (home === 'inspector')
    return (
      INSPECTOR_PART[place] ??
      (place === 'All tabs' ? 'Field inspector' : `Field inspector · ${place} tab`)
    )
  return `${HOME_WORDS[home] ?? home} · ${place}`
}

let built: SettingEntry[] | null = null

export function settingsIndex(): SettingEntry[] {
  if (built) return built
  const sectionTitle = new Map(SECTIONS.map((s) => [s.id, s.title]))
  const out: SettingEntry[] = SETTINGS.map((s) => {
    const place = sectionTitle.get(s.section) ?? s.section
    return {
      key: s.key,
      label: s.label,
      effect: s.effect,
      keywords: s.keywords,
      home: 'form_settings',
      place,
      where: whereOf('form_settings', place),
      types: s.types
    }
  })
  const have = new Set(out.map((e) => e.key))
  for (const r of parityRows as ParityRow[]) {
    if (r.status === 'retired' || !r.home || r.home === 'form_settings' || have.has(r.key)) continue
    // Rows the checklist keeps as a reminder of a missing editor are not findable controls.
    if (/no editor today/i.test(r.label)) continue
    const home = r.home as SettingHome
    const place = r.tab_or_section ?? ''
    out.push({
      key: r.key,
      label: r.label,
      home,
      place,
      where: whereOf(home, place),
      types: (r.layout_types ?? []) as LayoutKind[]
    })
    have.add(r.key)
  }
  built = out
  return out
}

// ── Search ───────────────────────────────────────────────────────────────────

const STOP = new Set(
  'a an and are be can could do does find for form get go have how i in is it its me my of on off or please set setting settings should switch that the there this to toggle turn want way what where which who why will with you your change make put let option options control enable disable'.split(
    ' '
  )
)

const SYNONYMS: Record<string, string> = {
  mandatory: 'required',
  compulsory: 'required',
  obligatory: 'required',
  optional: 'required',
  invisible: 'hide',
  hidden: 'hide',
  hiding: 'hide',
  readonly: 'read',
  editable: 'read',
  locked: 'lock',
  wide: 'width',
  size: 'width',
  title: 'label',
  name: 'label',
  rename: 'label',
  remark: 'comment',
  note: 'comment',
  tabs: 'tab',
  steps: 'step',
  wizard: 'step',
  print: 'pdf'
}

function stem(w: string): string {
  const s = w.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (SYNONYMS[s]) return SYNONYMS[s]
  if (s.length > 4 && s.endsWith('ies')) return `${s.slice(0, -3)}y`
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1)
  return s
}

const words = (text: string) =>
  text
    .split(/[\s._/:,;()“”"'?!·-]+/)
    .map(stem)
    .filter(Boolean)

/** The words of a question that carry meaning ("where do I turn off comments?" → comment). */
export function contentWords(query: string): string[] {
  return [...new Set(words(query).filter((w) => w.length > 1 && !STOP.has(w)))]
}

export interface SettingHit {
  entry: SettingEntry
  /** Share of the question's words the entry matched, 0..1. */
  score: number
}

/**
 * Deterministic search: every content word of the question is looked for in
 * the entry's label, effect, search words and key (word prefix match). Best
 * first; ties prefer label matches, Form settings, then shorter labels.
 */
export function searchSettings(query: string, kind?: LayoutKind, limit = 5): SettingHit[] {
  const q = contentWords(query)
  if (q.length === 0) return []
  const hits: Array<SettingHit & { labelHits: number }> = []
  for (const entry of settingsIndex()) {
    if (kind && entry.types.length && !entry.types.includes(kind)) continue
    const labelWords = words(entry.label)
    const hay = [
      ...labelWords,
      ...words(entry.effect ?? ''),
      ...words(entry.keywords ?? ''),
      ...words(entry.key)
    ]
    const has = (list: string[], w: string) =>
      list.some((h) => h === w || (w.length >= 4 && h.startsWith(w)))
    const matched = q.filter((w) => has(hay, w)).length
    if (matched === 0) continue
    hits.push({
      entry,
      score: matched / q.length,
      labelHits: q.filter((w) => has(labelWords, w)).length
    })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.labelHits - a.labelHits ||
      Number(b.entry.home === 'form_settings') - Number(a.entry.home === 'form_settings') ||
      a.entry.label.length - b.entry.label.length
  )
  return hits.slice(0, limit).map(({ entry, score }) => ({ entry, score }))
}

/** A question that reads as "where is …" rather than a question about records and roles. */
export function isWhereQuestion(text: string): boolean {
  return /^\s*(where|how (do|can) i|how to|is there (a|an) (setting|option|toggle|way))\b/i.test(
    text
  )
}

export function settingEntry(key: string): SettingEntry | undefined {
  return settingsIndex().find((e) => e.key === key)
}
