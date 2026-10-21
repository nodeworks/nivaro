import type { LayoutBundle, PlacementRow } from '../layout-ops-apply.js'
import { HEADER_GROUP_KEY, UNGROUPED_KEY } from '../layout-ops-apply.js'
import { type AiImage, asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Visual critique (#2690): the editor renders its canvas to a picture (no
 * preview record, typed values masked) and measures every section on it; the
 * model comments on density, hierarchy and alignment, each comment pinned to
 * the section it concerns (a canvas mark in the editor).
 *
 * Providers that cannot read images (the OpenAI-compatible gateway shim drops
 * them) get the structure and the measured geometry only — the answer says
 * which. Geometry checks that need no model run first and always.
 */

export const FORM_TARGET = '__form__'
const MAX_SECTIONS = 80
const MAX_COMMENTS = 25
/** ~1.5 MB of base64 — a downscaled JPEG of a form fits easily. */
export const MAX_IMAGE_CHARS = 2_000_000

export type CritiqueTopic = 'density' | 'hierarchy' | 'alignment' | 'other'

export interface SectionGeometry {
  key: string
  x: number
  y: number
  w: number
  h: number
  /** Distinct rows of fields the canvas drew. */
  rows: number
}

export interface CritiqueSection {
  key: string
  label: string
  type: string
  parent: string | null
  depth: number
  collapsed: boolean
  fields: number
  /** Column spans per row as the 12-column grid lays them out. */
  rows: number[][]
  longest_label: number
  geometry: SectionGeometry | null
}

export interface CritiqueComment {
  id: string
  /** A group key, `__ungrouped__`, or `__form__` for the whole form. */
  section: string
  topic: CritiqueTopic
  severity: 'high' | 'medium' | 'low'
  comment: string
  suggestion: string | null
  source: 'rules' | 'ai'
}

const num = (v: unknown, max = 100_000) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0
}

/** The client's measurements, keyed by section; unknown keys dropped. */
export function cleanGeometry(raw: unknown, keys: Set<string>): Map<string, SectionGeometry> {
  const out = new Map<string, SectionGeometry>()
  for (const r of asArray(raw).slice(0, 200)) {
    const o = r as Record<string, unknown>
    const key = String(o?.key ?? '')
    if (!keys.has(key) || out.has(key)) continue
    out.set(key, {
      key,
      x: num(o.x),
      y: num(o.y),
      w: num(o.w),
      h: num(o.h),
      rows: num(o.rows, 500)
    })
  }
  return out
}

/** A data: URI the client sent → an image block, or null when it is not one we accept. */
export function imageFromDataUri(uri: unknown): AiImage | null {
  if (typeof uri !== 'string' || uri.length > MAX_IMAGE_CHARS) return null
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(uri)
  return m ? { media_type: m[1] as AiImage['media_type'], data: m[2] } : null
}

function spanOf(p: PlacementRow): number {
  const n = Number(p.col_span)
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 12
}

/** Rows of the 12-column grid: spans packed left to right, a new row when the next does not fit. */
export function gridRows(spans: number[]): number[][] {
  const rows: number[][] = []
  let cur: number[] = []
  let used = 0
  for (const s of spans) {
    if (used + s > 12 && cur.length) {
      rows.push(cur)
      cur = []
      used = 0
    }
    cur.push(s)
    used += s
  }
  if (cur.length) rows.push(cur)
  return rows
}

export function critiqueSections(
  bundle: LayoutBundle,
  labelOf: (field: string) => string,
  geometry: Map<string, SectionGeometry>
): CritiqueSection[] {
  const visibleIn = (key: string | null) =>
    bundle.placements
      .filter(
        (p) =>
          (p.group_key ?? null) === key &&
          !p.field.startsWith('__') &&
          p.widget_id == null &&
          p.is_visible !== false
      )
      .sort((a, b) => a.sort - b.sort)
  const depthOf = (key: string | null): number => {
    let d = 0
    let k = key
    while (k && d < 6) {
      k = bundle.groups.find((g) => g.key === k)?.parent_key ?? null
      if (k) d++
    }
    return d
  }
  const out: CritiqueSection[] = []
  const add = (
    key: string,
    label: string,
    type: string,
    parent: string | null,
    collapsed: boolean,
    gk: string | null
  ) => {
    const ps = visibleIn(gk)
    out.push({
      key,
      label,
      type,
      parent,
      depth: depthOf(parent) + (parent ? 1 : 0),
      collapsed,
      fields: ps.length,
      rows: gridRows(ps.map(spanOf)),
      longest_label: ps.reduce((m, p) => Math.max(m, labelOf(p.field).length), 0),
      geometry: geometry.get(key) ?? null
    })
  }
  const groups = [...bundle.groups].sort((a, b) => a.sort - b.sort)
  for (const g of groups) {
    if (g.key === HEADER_GROUP_KEY) continue
    if (g.key === UNGROUPED_KEY) {
      if (visibleIn(null).length) add(UNGROUPED_KEY, 'Ungrouped', 'ungrouped', null, false, null)
      continue
    }
    add(g.key, g.label || titleCase(g.key), g.type, g.parent_key ?? null, !!g.is_collapsed, g.key)
  }
  return out.slice(0, MAX_SECTIONS)
}

const DENSE_FIELDS = 14
const RAGGED_MIN_ROWS = 3

/** Density and alignment signals the bundle already shows — no model needed. */
export function critiqueRuleComments(sections: CritiqueSection[]): CritiqueComment[] {
  const out: CritiqueComment[] = []
  const add = (c: Omit<CritiqueComment, 'id' | 'source'>) =>
    out.push({ ...c, id: `rules:${out.length}`, source: 'rules' })
  for (const s of sections) {
    if (s.fields >= DENSE_FIELDS && s.rows.every((r) => r.length === 1))
      add({
        section: s.key,
        topic: 'density',
        severity: 'medium',
        comment: `"${s.label}" stacks ${s.fields} full-width fields — a long scroll with lots of empty space to the right.`,
        suggestion: 'Put short fields side by side (half or third width), or split the section.'
      })
    const ragged = s.rows.filter((r) => r.reduce((a, b) => a + b, 0) < 12 && r.length > 0)
    if (s.rows.length >= RAGGED_MIN_ROWS && ragged.length >= Math.ceil(s.rows.length / 2))
      add({
        section: s.key,
        topic: 'alignment',
        severity: 'low',
        comment: `Most rows in "${s.label}" do not fill the width, so the right edge is ragged.`,
        suggestion: 'Use widths that add up to a full row (½ + ½, ⅓ + ⅓ + ⅓).'
      })
    if (s.fields === 1 && s.type === 'section' && !s.parent)
      add({
        section: s.key,
        topic: 'hierarchy',
        severity: 'low',
        comment: `"${s.label}" is a whole section for one field.`,
        suggestion: 'Fold it into the section before or after it.'
      })
  }
  return out
}

export const CRITIQUE_SYSTEM = `You are a product designer reviewing a data-entry form as it is laid out on screen. You may get a picture of the form and always get its structure: sections (key, label, nesting, field count, the 12-column width of each row) and where each section sits on the canvas in pixels.
Comment on DENSITY (crowded or wasteful areas, scrolling), HIERARCHY (whether the order and nesting of sections reads clearly, what deserves to come first) and ALIGNMENT (ragged rows, inconsistent widths, labels that will not line up). Answer with ONE JSON object and nothing else:
{"summary":"<two sentences>","comments":[{"section":"<section key, or ${FORM_TARGET} for the whole form>","topic":"density"|"hierarchy"|"alignment"|"other","severity":"high"|"medium"|"low","comment":"<one sentence in plain words>","suggestion":"<one concrete change>"}]}
Rules: use only section keys from the input. At most ${MAX_COMMENTS} comments, most important first. Do not repeat the rule comments you are given. Never comment on the data shown.`

export function buildCritiquePrompt(input: {
  layout: string
  layout_type: string
  steps: boolean
  canvas: { w: number; h: number } | null
  sections: CritiqueSection[]
  ruleComments: CritiqueComment[]
  hasImage: boolean
}): string {
  return JSON.stringify({
    form: input.layout,
    kind: input.layout_type,
    shown_as_steps: input.steps || undefined,
    picture_attached: input.hasImage,
    canvas_px: input.canvas ?? undefined,
    sections: input.sections.map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      inside: s.parent ?? undefined,
      collapsed: s.collapsed || undefined,
      fields: s.fields,
      row_widths: s.rows.length ? s.rows : undefined,
      longest_label_chars: s.longest_label || undefined,
      at: s.geometry
        ? {
            x: s.geometry.x,
            y: s.geometry.y,
            w: s.geometry.w,
            h: s.geometry.h,
            rows: s.geometry.rows
          }
        : undefined
    })),
    rule_comments: input.ruleComments.map((c) => c.comment)
  })
}

const TOPICS = new Set<CritiqueTopic>(['density', 'hierarchy', 'alignment', 'other'])
const SEVERITY = new Set(['high', 'medium', 'low'])

export function parseCritiqueAnswer(
  text: string,
  sectionKeys: Set<string>
): { summary: string | null; comments: CritiqueComment[]; dropped: string[] } {
  const json = parseJsonLoose(text)
  const dropped: string[] = []
  if (!json) return { summary: null, comments: [], dropped }
  const comments: CritiqueComment[] = []
  for (const raw of asArray(json.comments)) {
    if (comments.length >= MAX_COMMENTS) break
    const o = raw as Record<string, unknown>
    const section = String(o?.section ?? '')
    if (section !== FORM_TARGET && !sectionKeys.has(section)) {
      if (section) dropped.push(section)
      continue
    }
    const comment = cleanText(o.comment, 300)
    if (!comment) continue
    comments.push({
      id: `ai:${comments.length}`,
      section,
      topic: TOPICS.has(o.topic as CritiqueTopic) ? (o.topic as CritiqueTopic) : 'other',
      severity: SEVERITY.has(String(o.severity))
        ? (String(o.severity) as CritiqueComment['severity'])
        : 'medium',
      comment,
      suggestion: cleanText(o.suggestion, 300),
      source: 'ai'
    })
  }
  return { summary: cleanText(json.summary, 500), comments, dropped: [...new Set(dropped)] }
}
